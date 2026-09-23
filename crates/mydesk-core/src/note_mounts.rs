use crate::{Database, WorkspacePaths};
use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

fn title_cache() -> &'static Mutex<HashMap<String, (String, String)>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, (String, String)>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

// A single unusually large source must not silently starve every source that
// follows it in the library.  The status returned with a snapshot makes a
// limit visible to the UI instead of leaving a plausible-but-incomplete tree.
const MAX_FILES_PER_SOURCE: usize = 5_000;
use walkdir::WalkDir;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MountInfo {
    pub id: String,
    pub library_id: String,
    pub virtual_path: String,
    pub real_path: String,
    pub access: String,
    pub watcher_mode: String,
    pub state: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct NoteFileInfo {
    pub id: String,
    pub mount_id: Option<String>,
    pub title: String,
    pub virtual_path: String,
    pub real_path: String,
    pub read_only: bool,
    pub modified_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct TextDocumentSnapshot {
    pub content: String,
    pub revision: String,
    pub encoding: String,
    pub line_ending: String,
}

const MAX_EDITABLE_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;

fn decode_text_document(bytes: &[u8]) -> Result<(String, &'static str)> {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Ok((String::from_utf8(bytes[3..].to_vec())?, "utf8-bom"));
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        anyhow::ensure!((bytes.len() - 2) % 2 == 0, "invalid UTF-16 document");
        return Ok((String::from_utf16(&units)?, "utf16-le"));
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        anyhow::ensure!((bytes.len() - 2) % 2 == 0, "invalid UTF-16 document");
        return Ok((String::from_utf16(&units)?, "utf16-be"));
    }
    Ok((String::from_utf8(bytes.to_vec())?, "utf8"))
}

fn document_revision(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn read_text_document(path: &Path, notes_dir: &Path, mounts: &[MountInfo]) -> Result<TextDocumentSnapshot> {
    let canonical = path.canonicalize()?;
    anyhow::ensure!(is_note_extension(&canonical), "not a Markdown or text document");
    anyhow::ensure!(note_path_is_in_libraries(&canonical, notes_dir, mounts), "document is outside approved libraries");
    anyhow::ensure!(fs::metadata(&canonical)?.len() <= MAX_EDITABLE_DOCUMENT_BYTES, "document exceeds the 8 MiB editor limit");
    let bytes = fs::read(&canonical)?;
    let (content, encoding) = decode_text_document(&bytes)?;
    let line_ending = if content.contains("\r\n") { "crlf" } else { "lf" };
    Ok(TextDocumentSnapshot { content, revision: document_revision(&bytes), encoding: encoding.into(), line_ending: line_ending.into() })
}

pub fn write_mounted_text_document(
    path: &Path,
    notes_dir: &Path,
    mounts: &[MountInfo],
    expected_revision: &str,
    content: &str,
) -> Result<TextDocumentSnapshot> {
    let canonical = path.canonicalize()?;
    anyhow::ensure!(is_note_extension(&canonical), "not a Markdown or text document");
    anyhow::ensure!(!path_is_under(&canonical, notes_dir), "private notes use the vault save operation");
    anyhow::ensure!(mounts.iter().any(|mount| mount.access == "read_write" && path_is_under(&canonical, Path::new(&mount.real_path))), "document is not in a writable mount");
    anyhow::ensure!(content.len() as u64 <= MAX_EDITABLE_DOCUMENT_BYTES, "document exceeds the 8 MiB editor limit");
    let current = read_text_document(&canonical, notes_dir, mounts)?;
    anyhow::ensure!(current.revision == expected_revision, "document changed outside Möbius; reload or save a copy before writing");
    let normalized = content.replace("\r\n", "\n");
    let text = if current.line_ending == "crlf" { normalized.replace('\n', "\r\n") } else { normalized };
    let bytes = match current.encoding.as_str() {
        "utf8-bom" => [&[0xef, 0xbb, 0xbf][..], text.as_bytes()].concat(),
        "utf16-le" => [&[0xff, 0xfe][..], &text.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>()].concat(),
        "utf16-be" => [&[0xfe, 0xff][..], &text.encode_utf16().flat_map(u16::to_be_bytes).collect::<Vec<_>>()].concat(),
        _ => text.into_bytes(),
    };
    let parent = canonical.parent().ok_or_else(|| anyhow::anyhow!("document has no parent"))?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.write_all(&bytes)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    anyhow::ensure!(document_revision(&fs::read(&canonical)?) == expected_revision, "document changed during save; reload before writing");
    fs::rename(temporary.path(), &canonical)?;
    read_text_document(&canonical, notes_dir, mounts)
}

/// Runtime-only result of scanning one persisted mount.  `MountInfo` is the
/// user's configuration; this describes what was actually observable during
/// one scan and is deliberately not written back into that configuration.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MountScanStatus {
    pub mount_id: String,
    pub state: String,
    pub file_count: usize,
    pub truncated: bool,
    pub unreadable_entries: usize,
}

/// A coherent library projection.  Mount registration and discovered files
/// always come from the same scan, so a UI never has to combine one request's
/// mount list with another request's file list.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct NoteLibrarySnapshot {
    pub snapshot_id: String,
    pub scanned_at: String,
    pub mounts: Vec<MountInfo>,
    pub files: Vec<NoteFileInfo>,
    pub mount_statuses: Vec<MountScanStatus>,
}

impl Database {
    pub fn add_note_mount(
        &self,
        path: &Path,
        virtual_path: &str,
        access: &str,
    ) -> Result<MountInfo> {
        if !matches!(access, "read_only" | "read_write") {
            anyhow::bail!("mount access must be read_only or read_write");
        }
        let canonical = path
            .canonicalize()
            .with_context(|| format!("mounting {}", path.display()))?;
        if !canonical.is_dir() {
            anyhow::bail!("mount path is not a directory");
        }
        let virtual_path = virtual_path.trim().trim_matches(['/', '\\']);
        if virtual_path.is_empty() {
            anyhow::bail!("Library name cannot be empty");
        }
        let existing_mounts = self.list_note_mounts()?;
        if let Some(existing) = existing_mounts
            .iter()
            .find(|mount| mount.virtual_path.eq_ignore_ascii_case(virtual_path))
        {
            if same_mount_path(Path::new(&existing.real_path), &canonical)
                && existing.access == access
            {
                return Ok(existing.clone());
            }
            anyhow::bail!(
                "A different folder already uses this library name. Choose another name."
            );
        }
        if let Some(existing) = existing_mounts
            .iter()
            .find(|mount| mount_paths_overlap(Path::new(&mount.real_path), &canonical))
        {
            anyhow::bail!(
                "This folder overlaps with the existing '{}' library. A source can appear only once; unmount the existing source before mounting a nested folder.",
                existing.virtual_path
            );
        }
        let now = Utc::now().to_rfc3339();
        let library_id = "note-library:default";
        let connection = self.connection()?;
        connection.execute(
            "INSERT OR IGNORE INTO note_libraries(id, name, root_path, created_at) VALUES (?1, 'Möbius', ?2, ?3)",
            params![library_id, canonical.display().to_string(), now],
        )?;
        let id = format!("mount:{}", uuid::Uuid::new_v4());
        connection.execute(
            "INSERT INTO mounts(id, library_id, virtual_path, real_path, access, watcher_mode, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'auto', 'connected', ?6, ?6)",
            params![id, library_id, virtual_path.trim_matches(['/', '\\']), canonical.display().to_string(), access, now],
        )?;
        self.list_note_mounts()?
            .into_iter()
            .find(|mount| mount.id == id)
            .ok_or_else(|| anyhow::anyhow!("new mount could not be read"))
    }

    pub fn list_note_mounts(&self) -> Result<Vec<MountInfo>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, library_id, virtual_path, real_path, access, watcher_mode, state, created_at, updated_at FROM mounts ORDER BY virtual_path",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(MountInfo {
                id: row.get(0)?,
                library_id: row.get(1)?,
                virtual_path: row.get(2)?,
                real_path: row.get(3)?,
                access: row.get(4)?,
                watcher_mode: row.get(5)?,
                state: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing note mounts")
    }

    pub fn remove_note_mount(&self, id: &str) -> Result<bool> {
        Ok(self
            .connection()?
            .execute("DELETE FROM mounts WHERE id = ?1", [id])?
            == 1)
    }
}

pub fn list_note_files(paths: &WorkspacePaths, mounts: &[MountInfo]) -> Result<Vec<NoteFileInfo>> {
    Ok(list_note_library_snapshot(paths, mounts)?.files)
}

pub fn list_note_library_snapshot(
    paths: &WorkspacePaths,
    mounts: &[MountInfo],
) -> Result<NoteLibrarySnapshot> {
    let mut files = Vec::new();
    collect_note_root(&paths.notes_dir(), None, "Möbius", false, &mut files);
    let mut mount_statuses = Vec::with_capacity(mounts.len());
    for mount in mounts {
        let scan = collect_note_root(
            Path::new(&mount.real_path),
            Some(&mount.id),
            &mount.virtual_path,
            mount.access == "read_only",
            &mut files,
        );
        mount_statuses.push(MountScanStatus {
            mount_id: mount.id.clone(),
            state: scan.state().to_string(),
            file_count: scan.file_count,
            truncated: scan.truncated,
            unreadable_entries: scan.unreadable_entries,
        });
    }
    // Explorer order is path identity, not mtime. Sorting by mtime made every
    // metadata tick look like a different tree to the renderer fingerprint.
    files.sort_by(|left, right| left.virtual_path.cmp(&right.virtual_path));
    Ok(NoteLibrarySnapshot {
        snapshot_id: format!("library-snapshot:{}", uuid::Uuid::new_v4()),
        scanned_at: Utc::now().to_rfc3339(),
        mounts: mounts.to_vec(),
        files,
        mount_statuses,
    })
}

#[derive(Default)]
struct RootScan {
    source_available: bool,
    file_count: usize,
    truncated: bool,
    unreadable_entries: usize,
}

impl RootScan {
    fn state(&self) -> &'static str {
        if !self.source_available {
            "unavailable"
        } else if self.truncated || self.unreadable_entries > 0 {
            "partial"
        } else {
            "ready"
        }
    }
}

fn collect_note_root(
    root: &Path,
    mount_id: Option<&str>,
    prefix: &str,
    read_only: bool,
    output: &mut Vec<NoteFileInfo>,
) -> RootScan {
    let mut scan = RootScan::default();
    if !root.is_dir() {
        return scan;
    }
    scan.source_available = true;
    for candidate in WalkDir::new(root).follow_links(false).into_iter() {
        let entry = match candidate {
            Ok(entry) => entry,
            Err(_) => {
                scan.unreadable_entries += 1;
                continue;
            }
        };
        if !entry.file_type().is_file() || entry.file_type().is_symlink() {
            continue;
        }
        let extension = entry
            .path()
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let is_text = matches!(extension.as_str(), "md" | "markdown" | "txt");
        if !is_text && !matches!(extension.as_str(), "pdf" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif") {
            continue;
        }
        if scan.file_count >= MAX_FILES_PER_SOURCE {
            scan.truncated = true;
            break;
        }
        let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
        let virtual_path = format!(
            "{}/{}",
            prefix.trim_matches('/'),
            relative.display().to_string().replace('\\', "/")
        );
        let modified_at = fs::metadata(entry.path())
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .map(|time| chrono::DateTime::<Utc>::from(time).to_rfc3339());
        output.push(NoteFileInfo {
            // The source identity is part of the note identity.  A stale or
            // overlapping mount must never collide with a tab from another
            // source merely because both happen to expose the same file.
            id: format!(
                "note-file:{}:{}",
                mount_id.unwrap_or("private"),
                stable_path(entry.path())
            ),
            mount_id: mount_id.map(str::to_string),
            // Explorer labels come from a path+mtime cache. Opening every
            // file on each scan is what echoed into the native watcher and
            // made the tree look like it had changed.
            title: if is_text { cached_note_title(entry.path(), modified_at.as_deref()) } else { entry.path().file_stem().map(|value| value.to_string_lossy().into_owned()).unwrap_or_else(|| "Untitled".into()) },
            virtual_path,
            real_path: entry.path().display().to_string(),
            read_only: read_only || !is_text,
            modified_at,
        });
        scan.file_count += 1;
    }
    scan
}

fn mount_path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn same_mount_path(left: &Path, right: &Path) -> bool {
    mount_path_key(left) == mount_path_key(right)
}

fn mount_paths_overlap(left: &Path, right: &Path) -> bool {
    let left = mount_path_key(left);
    let right = mount_path_key(right);
    left == right
        || left
            .strip_prefix(&right)
            .is_some_and(|suffix| suffix.starts_with('\\'))
        || right
            .strip_prefix(&left)
            .is_some_and(|suffix| suffix.starts_with('\\'))
}

fn cached_note_title(path: &Path, modified_at: Option<&str>) -> String {
    let key = mount_path_key(path);
    let stamp = modified_at.unwrap_or_default().to_string();
    if let Ok(cache) = title_cache().lock() {
        if let Some((cached_stamp, title)) = cache.get(&key) {
            if cached_stamp == &stamp {
                return title.clone();
            }
        }
    }
    let title = note_title(path);
    if let Ok(mut cache) = title_cache().lock() {
        cache.insert(key, (stamp, title.clone()));
    }
    title
}

fn note_title(path: &Path) -> String {
    let fallback = path
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled".into());
    let Ok(file) = fs::File::open(path) else {
        return fallback;
    };
    for line in BufReader::new(file).lines().take(40).flatten() {
        let Some(value) = line.trim().strip_prefix("title:") else {
            continue;
        };
        let title = value.trim().trim_matches(['\"', '\'']).trim();
        if !title.is_empty() {
            return title.to_string();
        }
    }
    fallback
}

fn stable_path(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(mount_path_key(path).as_bytes());
    hex::encode(hasher.finalize())[..24].to_string()
}

pub fn note_is_private_vault_file(path: &Path, notes_dir: &Path) -> bool {
    is_note_extension(path) && path_is_under(path, notes_dir)
}

/// Authorize a single-file read from configured library roots.
///
/// VS Code's disk provider checks the path against watched roots; it does not
/// restat the whole tree. A full snapshot here would open every Markdown file
/// (title scan) and echo into the native watcher while the editor is resolving
/// a working copy.
pub fn read_note_file(path: &Path, notes_dir: &Path, mounts: &[MountInfo]) -> Result<String> {
    let canonical = path
        .canonicalize()
        .with_context(|| format!("reading {}", path.display()))?;
    if !is_note_extension(&canonical) {
        anyhow::bail!("note path is not a Markdown or text document");
    }
    if !note_path_is_in_libraries(&canonical, notes_dir, mounts) {
        anyhow::bail!("note path is outside configured libraries");
    }
    fs::read_to_string(&canonical).with_context(|| format!("reading {}", canonical.display()))
}

pub fn read_library_media_file(path: &Path, notes_dir: &Path, mounts: &[MountInfo]) -> Result<Vec<u8>> {
    let canonical = path.canonicalize()?;
    let extension = canonical.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    anyhow::ensure!(matches!(extension.as_str(), "pdf" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif"), "unsupported media format");
    anyhow::ensure!(note_path_is_in_libraries(&canonical, notes_dir, mounts), "media file is outside approved libraries");
    anyhow::ensure!(fs::metadata(&canonical)?.len() <= 15 * 1024 * 1024, "media file exceeds the 15 MiB preview limit");
    Ok(fs::read(&canonical)?)
}

fn note_path_is_in_libraries(path: &Path, notes_dir: &Path, mounts: &[MountInfo]) -> bool {
    if path_is_under(path, notes_dir) {
        return true;
    }
    mounts
        .iter()
        .any(|mount| path_is_under(path, Path::new(&mount.real_path)))
}

fn is_note_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "md" | "markdown" | "txt"
    )
}

fn path_is_under(child: &Path, parent: &Path) -> bool {
    let child = mount_path_key(&canonicalize_or_self(child));
    let parent = mount_path_key(&canonicalize_or_self(parent));
    child == parent
        || child
            .strip_prefix(&parent)
            .is_some_and(|suffix| suffix.starts_with('\\'))
}

fn canonicalize_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Database, WorkspacePaths};

    fn paths(root: &Path) -> WorkspacePaths {
        WorkspacePaths {
            workspace_root: root.join("workspace"),
            data_root: root.join("data"),
            artifacts_root: root.join("artifacts"),
            catalog_root: root.join("catalog"),
        }
    }

    fn mount(id: &str, root: &Path) -> MountInfo {
        MountInfo {
            id: id.to_string(),
            library_id: "note-library:default".to_string(),
            virtual_path: "Reference".to_string(),
            real_path: root.canonicalize().unwrap().display().to_string(),
            access: "read_only".to_string(),
            watcher_mode: "auto".to_string(),
            state: "connected".to_string(),
            created_at: "2026-09-16T00:00:00Z".to_string(),
            updated_at: "2026-09-16T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn writable_mount_preserves_text_format_and_rejects_stale_saves() -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let paths = paths(temporary.path());
        paths.ensure_layout()?;
        let source = temporary.path().join("editable");
        fs::create_dir_all(&source)?;
        let document = source.join("memo.txt");
        fs::write(&document, [vec![0xef, 0xbb, 0xbf], b"first\r\nline".to_vec()].concat())?;
        let mut configured = mount("mount:editable", &source);
        let before = read_text_document(&document, &paths.notes_dir(), &[configured.clone()])?;
        assert_eq!(before.encoding, "utf8-bom");
        assert_eq!(before.line_ending, "crlf");
        assert!(write_mounted_text_document(&document, &paths.notes_dir(), &[configured.clone()], &before.revision, "changed").is_err());
        configured.access = "read_write".into();
        let after = write_mounted_text_document(&document, &paths.notes_dir(), &[configured.clone()], &before.revision, "changed\nline")?;
        assert_eq!(after.content, "changed\r\nline");
        assert!(fs::read(&document)?.starts_with(&[0xef, 0xbb, 0xbf]));
        assert!(write_mounted_text_document(&document, &paths.notes_dir(), &[configured], &before.revision, "stale").is_err());
        assert_eq!(read_text_document(&document, &paths.notes_dir(), &[]) .is_err(), true);
        Ok(())
    }

    #[test]
    fn media_is_listed_for_preview_but_never_editable() -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let paths = paths(temporary.path());
        paths.ensure_layout()?;
        let source = temporary.path().join("media");
        fs::create_dir_all(&source)?;
        let image = source.join("cover.png");
        let bytes = [137, 80, 78, 71, 13, 10, 26, 10];
        fs::write(&image, bytes)?;
        let mut configured = mount("mount:media", &source);
        configured.access = "read_write".into();
        let snapshot = list_note_library_snapshot(&paths, &[configured.clone()])?;
        let listed = snapshot.files.iter().find(|item| item.virtual_path.ends_with("cover.png")).unwrap();
        assert_eq!(listed.title, "cover");
        assert!(listed.read_only);
        assert_eq!(read_library_media_file(&image, &paths.notes_dir(), &[configured.clone()])?, bytes);
        assert!(read_library_media_file(&image, &paths.notes_dir(), &[]).is_err());
        assert!(write_mounted_text_document(&image, &paths.notes_dir(), &[configured], "irrelevant", "text").is_err());
        Ok(())
    }

    #[test]
    fn a_snapshot_replaces_removed_mount_files_and_reports_unavailable_sources() -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let paths = paths(temporary.path());
        paths.ensure_layout()?;
        let source = temporary.path().join("source");
        fs::create_dir_all(&source)?;
        fs::write(source.join("old.md"), "# old")?;
        let configured = mount("mount:fixture", &source);

        let first = list_note_library_snapshot(&paths, &[configured.clone()])?;
        assert!(first.files.iter().any(|file| file.title == "old"));
        assert_eq!(first.mount_statuses[0].state, "ready");

        fs::remove_file(source.join("old.md"))?;
        fs::write(source.join("new.md"), "# new")?;
        let second = list_note_library_snapshot(&paths, &[configured.clone()])?;
        assert!(second.files.iter().any(|file| file.title == "new"));
        assert!(!second.files.iter().any(|file| file.title == "old"));
        assert_ne!(first.snapshot_id, second.snapshot_id);

        fs::remove_dir_all(&source)?;
        let unavailable = list_note_library_snapshot(&paths, &[configured])?;
        assert!(unavailable.files.is_empty());
        assert_eq!(unavailable.mount_statuses[0].state, "unavailable");
        Ok(())
    }

    #[test]
    fn overlapping_source_roots_are_rejected() -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let paths = paths(temporary.path());
        let database = Database::open(&paths)?;
        let parent = temporary.path().join("source");
        let child = parent.join("nested");
        fs::create_dir_all(&child)?;
        database.add_note_mount(&parent, "Reference", "read_only")?;

        let error = database
            .add_note_mount(&child, "Nested", "read_only")
            .expect_err("a nested mount duplicates content from its parent");
        assert!(error.to_string().contains("overlaps"));
        Ok(())
    }

    #[test]
    fn reading_a_note_authorizes_the_path_without_rescanning_the_tree() -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let paths = paths(temporary.path());
        paths.ensure_layout()?;
        let notes = paths.notes_dir();
        fs::create_dir_all(&notes)?;
        let allowed = notes.join("open.md");
        fs::write(&allowed, "hello")?;
        let outside = temporary.path().join("outside.md");
        fs::write(&outside, "secret")?;

        assert_eq!(read_note_file(&allowed, &notes, &[])?, "hello");
        assert!(read_note_file(&outside, &notes, &[]).is_err());
        Ok(())
    }
}
