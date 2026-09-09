use crate::{Database, WorkspacePaths};
use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
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
        if let Some(existing) = self.list_note_mounts()?.into_iter().find(|mount| mount.virtual_path == virtual_path) {
            if Path::new(&existing.real_path) == canonical && existing.access == access {
                return Ok(existing);
            }
            anyhow::bail!("A different folder already uses this library name. Choose another name.");
        }
        let now = Utc::now().to_rfc3339();
        let library_id = "note-library:default";
        let connection = self.connection()?;
        connection.execute(
            "INSERT OR IGNORE INTO note_libraries(id, name, root_path, created_at) VALUES (?1, 'MyDesk', ?2, ?3)",
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
    let mut files = Vec::new();
    collect_note_root(&paths.notes_dir(), None, "MyDesk", false, &mut files);
    for mount in mounts {
        collect_note_root(
            Path::new(&mount.real_path),
            Some(&mount.id),
            &mount.virtual_path,
            mount.access == "read_only",
            &mut files,
        );
    }
    files.sort_by(|left, right| {
        right
            .modified_at
            .cmp(&left.modified_at)
            .then_with(|| left.virtual_path.cmp(&right.virtual_path))
    });
    files.truncate(5000);
    Ok(files)
}

fn collect_note_root(
    root: &Path,
    mount_id: Option<&str>,
    prefix: &str,
    read_only: bool,
    output: &mut Vec<NoteFileInfo>,
) {
    if !root.is_dir() {
        return;
    }
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if output.len() >= 5000 || !entry.file_type().is_file() || entry.file_type().is_symlink() {
            continue;
        }
        let extension = entry
            .path()
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(extension.as_str(), "md" | "markdown" | "txt") {
            continue;
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
            id: format!("note-file:{}", stable_path(entry.path())),
            mount_id: mount_id.map(str::to_string),
            title: entry
                .path()
                .file_stem()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Untitled".into()),
            virtual_path,
            real_path: entry.path().display().to_string(),
            read_only,
            modified_at,
        });
    }
}

fn stable_path(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(path.display().to_string().to_ascii_lowercase().as_bytes());
    hex::encode(hasher.finalize())[..24].to_string()
}

pub fn read_note_file(path: &Path, known: &[NoteFileInfo]) -> Result<String> {
    let canonical = path.canonicalize()?;
    let allowed = known
        .iter()
        .any(|file| Path::new(&file.real_path).canonicalize().ok().as_ref() == Some(&canonical));
    if !allowed {
        anyhow::bail!("note path is outside configured libraries");
    }
    fs::read_to_string(&canonical).with_context(|| format!("reading {}", canonical.display()))
}
