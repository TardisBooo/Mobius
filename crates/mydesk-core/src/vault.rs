use crate::{BoardDocument, ContextKind, NoteDraft, TrashItem, WikiDraft, WorkspacePaths};
use anyhow::{Context, Result};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};
use tempfile::NamedTempFile;

#[derive(Clone, Debug)]
pub struct Vault {
    paths: WorkspacePaths,
}

impl Vault {
    pub fn new(paths: WorkspacePaths) -> Self {
        Self { paths }
    }

    pub fn write_note(&self, draft: &NoteDraft) -> Result<(String, PathBuf, Option<PathBuf>)> {
        self.paths.ensure_layout()?;
        let slug = slug_for(&draft.title);
        let destination = self.paths.notes_dir().join(format!("{slug}.md"));
        self.write_note_to(&slug, &destination, draft)
    }

    /// Update an existing vault note without deriving a new filename from its
    /// title. This is deliberately separate from `write_note`: renaming a
    /// note in the editor must not leave a second copy behind.
    pub fn update_note(
        &self,
        destination: &Path,
        draft: &NoteDraft,
    ) -> Result<(String, PathBuf, Option<PathBuf>)> {
        self.paths.ensure_layout()?;
        let slug = destination
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .context("a vault note must have a filename")?
            .to_string();
        self.write_note_to(&slug, destination, draft)
    }

    fn write_note_to(
        &self,
        slug: &str,
        destination: &Path,
        draft: &NoteDraft,
    ) -> Result<(String, PathBuf, Option<PathBuf>)> {
        let snapshot = self.snapshot_if_exists("notes", slug, destination)?;

        let tags = draft.tags.join(", ");
        let sources = draft.source_ids.join(", ");
        let project = draft.project_slug.as_deref().unwrap_or("");
        let content = format!(
            "---\ntitle: {}\nproject: {}\ntags: [{}]\nsources: [{}]\nupdated_at: {}\n---\n\n# {}\n\n{}\n",
            yaml_scalar(&draft.title),
            yaml_scalar(project),
            tags,
            sources,
            chrono::Utc::now().to_rfc3339(),
            draft.title.trim(),
            draft.body.trim()
        );
        write_atomic(&destination, content.as_bytes())?;
        Ok((slug.to_string(), destination.to_path_buf(), snapshot))
    }

    pub fn write_board(&self, board: &BoardDocument) -> Result<(PathBuf, Option<PathBuf>)> {
        self.paths.ensure_layout()?;
        // A canvas filename must stay stable when the user renames its title.
        // The UUID is also safe as a filename and prevents a rename from leaving
        // two independently editable copies of the same board in the library.
        let slug = slug_for(&board.id);
        let destination = self.paths.boards_dir().join(format!("{slug}.board.json"));
        let snapshot = self.snapshot_if_exists("boards", &slug, &destination)?;
        write_atomic(&destination, serde_json::to_vec_pretty(board)?.as_slice())?;
        Ok((destination, snapshot))
    }

    pub fn write_wiki(&self, draft: &WikiDraft) -> Result<(String, PathBuf, Option<PathBuf>)> {
        self.paths.ensure_layout()?;
        let slug = slug_for(&draft.title);
        let destination = self.paths.wiki_dir().join(format!("{slug}.md"));
        let snapshot = self.snapshot_if_exists("wiki", &slug, &destination)?;
        let tags = draft.tags.join(", ");
        let sources = draft.source_ids.join(", ");
        let project = draft.project_slug.as_deref().unwrap_or("");
        let content = format!(
            "---\ntitle: {}\nproject: {}\ntags: [{}]\nsources: [{}]\nupdated_at: {}\nkind: wiki\n---\n\n# {}\n\n{}\n",
            yaml_scalar(&draft.title),
            yaml_scalar(project),
            tags,
            sources,
            chrono::Utc::now().to_rfc3339(),
            draft.title.trim(),
            draft.body.trim()
        );
        write_atomic(&destination, content.as_bytes())?;
        Ok((slug, destination, snapshot))
    }

    pub fn read_markdown(&self, slug: &str) -> Result<String> {
        let path = self.paths.notes_dir().join(format!("{slug}.md"));
        fs::read_to_string(&path).with_context(|| format!("reading note {}", path.display()))
    }

    /// Move a private note into a relative notes-vault folder. Mounted files
    /// never reach this method, so a drag operation cannot mutate a source
    /// library by accident.
    pub fn move_note(&self, path: &Path, destination: &str) -> Result<(PathBuf, PathBuf)> {
        self.paths.ensure_layout()?;
        let root = self.paths.notes_dir().canonicalize()?;
        let source = path.canonicalize()?;
        if !source.starts_with(&root) || !is_note_file(&source) {
            anyhow::bail!("only private Markdown notes can be moved");
        }
        let relative = safe_relative_path(destination)?;
        let destination_dir = root.join(relative);
        fs::create_dir_all(&destination_dir)?;
        let destination_path = destination_dir.join(source.file_name().context("note has no filename")?);
        if destination_path == source {
            return Ok((source.clone(), destination_path));
        }
        if destination_path.exists() {
            anyhow::bail!("a note with this filename already exists in the destination folder");
        }
        fs::rename(&source, &destination_path).with_context(|| {
            format!("moving {} to {}", source.display(), destination_path.display())
        })?;
        Ok((source, destination_path))
    }

    pub fn history_dir(&self) -> PathBuf {
        self.paths.history_dir()
    }

    pub fn trash_note(&self, path: &Path) -> Result<TrashItem> {
        self.paths.ensure_layout()?;
        let root = self.paths.notes_dir().canonicalize()?;
        let source = path.canonicalize()?;
        if !source.starts_with(&root) || !is_note_file(&source) {
            anyhow::bail!("only private Markdown notes can be moved to trash");
        }
        let title = note_display_title(&source);
        self.move_to_trash(ContextKind::Note, &source, title)
    }

    pub fn trash_board(&self, board_id: &str) -> Result<TrashItem> {
        self.paths.ensure_layout()?;
        if board_id.is_empty() || !board_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) {
            anyhow::bail!("invalid board id");
        }
        let source = self
            .paths
            .boards_dir()
            .join(format!("{}.board.json", slug_for(board_id)))
            .canonicalize()?;
        if !source.is_file() {
            anyhow::bail!("board does not exist");
        }
        let title = fs::read(&source)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<BoardDocument>(&bytes).ok())
            .map(|board| board.title)
            .filter(|title| !title.trim().is_empty());
        self.move_to_trash(ContextKind::Board, &source, title)
    }

    pub fn list_trash(&self) -> Result<Vec<TrashItem>> {
        self.paths.ensure_layout()?;
        let mut items = Vec::new();
        for entry in fs::read_dir(self.paths.trash_dir())? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let manifest = entry.path().join("manifest.json");
            if let Ok(bytes) = fs::read(&manifest) {
                if let Ok(item) = serde_json::from_slice::<TrashItem>(&bytes) {
                    items.push(item);
                }
            }
        }
        items.sort_by(|left, right| right.deleted_at.cmp(&left.deleted_at));
        Ok(items)
    }

    pub fn restore_trash(&self, id: &str) -> Result<TrashItem> {
        validate_trash_id(id)?;
        let directory = self.paths.trash_dir().join(id);
        let manifest_path = directory.join("manifest.json");
        let item: TrashItem = serde_json::from_slice(&fs::read(&manifest_path)?)?;
        if item.id != id {
            anyhow::bail!("trash identity mismatch");
        }
        let original = PathBuf::from(&item.original_path);
        let allowed_root = match item.kind {
            ContextKind::Note => self.paths.notes_dir().canonicalize()?,
            ContextKind::Board => self.paths.boards_dir().canonicalize()?,
            _ => anyhow::bail!("unsupported trash item kind"),
        };
        let parent = original.parent().context("trash item has no parent")?;
        validate_restore_target(&original, &parent, &allowed_root)?;
        fs::create_dir_all(parent)?;
        let payload = directory.join("payload");
        fs::rename(&payload, &original)?;
        fs::remove_dir_all(&directory)?;
        Ok(item)
    }

    pub fn purge_trash(&self, id: &str) -> Result<bool> {
        validate_trash_id(id)?;
        let directory = self.paths.trash_dir().join(id);
        if !directory.is_dir() {
            return Ok(false);
        }
        fs::remove_dir_all(directory)?;
        Ok(true)
    }

    fn move_to_trash(&self, kind: ContextKind, source: &Path, title: Option<String>) -> Result<TrashItem> {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let directory = self.paths.trash_dir().join(&id);
        fs::create_dir_all(&directory)?;
        let item = TrashItem {
            id: id.clone(),
            kind,
            title: title.unwrap_or_else(|| source.file_stem().and_then(|value| value.to_str()).unwrap_or("Untitled").to_string()),
            original_path: source.display().to_string(),
            deleted_at: chrono::Utc::now().to_rfc3339(),
        };
        if let Err(error) = fs::rename(source, directory.join("payload")) {
            let _ = fs::remove_dir_all(&directory);
            return Err(error.into());
        }
        if let Err(error) = fs::write(directory.join("manifest.json"), serde_json::to_vec_pretty(&item)?) {
            let _ = fs::rename(directory.join("payload"), source);
            let _ = fs::remove_dir_all(&directory);
            return Err(error.into());
        }
        Ok(item)
    }

    fn snapshot_if_exists(
        &self,
        category: &str,
        slug: &str,
        current: &Path,
    ) -> Result<Option<PathBuf>> {
        if !current.exists() {
            return Ok(None);
        }
        let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
        let snapshots = self.paths.history_dir().join(category).join(slug);
        fs::create_dir_all(&snapshots)
            .with_context(|| format!("creating snapshot directory {}", snapshots.display()))?;
        let extension = current
            .extension()
            .and_then(|item| item.to_str())
            .unwrap_or("bak");
        let destination = snapshots.join(format!(
            "{timestamp}-{}.{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8],
            extension
        ));
        fs::copy(current, &destination)
            .with_context(|| format!("creating recoverable snapshot {}", destination.display()))?;
        Ok(Some(destination))
    }
}

fn is_note_file(path: &Path) -> bool {
    matches!(path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase().as_str(), "md" | "markdown" | "txt")
}

fn note_display_title(path: &Path) -> Option<String> {
    let contents = fs::read_to_string(path).ok()?;
    contents
        .lines()
        .take(40)
        .find_map(|line| line.trim().strip_prefix("title:").map(str::trim))
        .map(|value| value.trim_matches(['"', '\'']).trim().to_string())
        .filter(|value| !value.is_empty())
}

fn validate_trash_id(id: &str) -> Result<()> {
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        anyhow::bail!("invalid trash id");
    }
    Ok(())
}

fn validate_restore_target(original: &Path, parent: &Path, allowed_root: &Path) -> Result<()> {
    if original.exists() || !original.is_absolute() {
        anyhow::bail!("trash restore destination is unavailable");
    }
    let relative = original
        .strip_prefix(allowed_root)
        .map_err(|_| anyhow::anyhow!("trash restore destination is outside the private vault"))?;
    if relative.components().any(|component| !matches!(component, Component::Normal(_))) {
        anyhow::bail!("trash restore destination contains an unsafe path component");
    }
    let mut nearest = parent;
    while !nearest.exists() {
        nearest = nearest
            .parent()
            .ok_or_else(|| anyhow::anyhow!("trash restore destination has no existing ancestor"))?;
    }
    if !nearest.canonicalize()?.starts_with(allowed_root) {
        anyhow::bail!("trash restore destination is outside the private vault");
    }
    Ok(())
}

fn safe_relative_path(value: &str) -> Result<PathBuf> {
    let mut result = PathBuf::new();
    for component in value.replace('\\', "/").split('/') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." || component.contains(':') {
            anyhow::bail!("destination folder must stay inside the private notes vault");
        }
        result.push(component);
    }
    Ok(result)
}

fn write_atomic(destination: &Path, contents: &[u8]) -> Result<()> {
    let parent = destination
        .parent()
        .context("a vault document must have a parent directory")?;
    fs::create_dir_all(parent)?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    use std::io::Write;
    temporary.write_all(contents)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    let temporary_path = temporary.into_temp_path();
    fs::rename(&temporary_path, destination)
        .with_context(|| format!("atomically replacing {}", destination.display()))?;
    Ok(())
}

pub fn slug_for(title: &str) -> String {
    let mut slug = title
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        slug = format!("note-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    }
    if slug.len() > 80 {
        slug.truncate(80);
        slug = slug.trim_matches('-').to_string();
    }
    slug
}

#[cfg(test)]
mod trash_tests {
    use super::*;
    use serde_json::json;

    fn paths(root: &Path) -> WorkspacePaths {
        WorkspacePaths {
            workspace_root: root.join("workspace"),
            data_root: root.join("data"),
            artifacts_root: root.join("artifacts"),
            catalog_root: root.join("catalog"),
        }
    }

    #[test]
    fn private_note_move_and_restore_round_trip() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let paths = paths(temporary.path());
        paths.ensure_layout().expect("layout");
        let source = paths.notes_dir().join("design.md");
        fs::write(&source, "# Design\n\ncontent").expect("write note");
        let vault = Vault::new(paths.clone());

        let (_, moved) = vault.move_note(&source, "archive/2026").expect("move note");
        assert!(!source.exists());
        assert!(moved.ends_with("archive/2026/design.md"));
        assert!(moved.exists());

        let item = vault.trash_note(&moved).expect("trash note");
        assert!(!moved.exists());
        assert_eq!(vault.list_trash().expect("list trash").len(), 1);
        vault.restore_trash(&item.id).expect("restore note");
        assert!(moved.exists());
        assert!(vault.list_trash().expect("empty trash").is_empty());
    }

    #[test]
    fn mounted_or_outside_note_is_rejected() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let paths = paths(temporary.path());
        paths.ensure_layout().expect("layout");
        let outside = temporary.path().join("outside.md");
        fs::write(&outside, "not private").expect("write outside");
        let error = Vault::new(paths).trash_note(&outside).expect_err("outside note must be rejected");
        assert!(error.to_string().contains("private"));
    }

    #[test]
    fn board_trash_and_restore_round_trip() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let paths = paths(temporary.path());
        paths.ensure_layout().expect("layout");
        let board = BoardDocument {
            id: "board-123".into(),
            title: "Planning canvas".into(),
            project_slug: None,
            data: json!({"scene": {"nodes": []}}),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        let vault = Vault::new(paths.clone());
        let (source, _) = vault.write_board(&board).expect("write board");
        let item = vault.trash_board(&board.id).expect("trash board");
        assert!(!source.exists());
        assert_eq!(item.title, board.title);
        vault.restore_trash(&item.id).expect("restore board");
        assert!(source.exists());
    }
}

fn yaml_scalar(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::slug_for;

    #[test]
    fn creates_safe_slug() {
        assert_eq!(slug_for("Agent Memory / v1"), "agent-memory-v1");
        assert_eq!(slug_for("记忆"), "记忆");
    }
}
