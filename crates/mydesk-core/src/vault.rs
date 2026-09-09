use crate::{BoardDocument, NoteDraft, WikiDraft, WorkspacePaths};
use anyhow::{Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
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

    pub fn history_dir(&self) -> PathBuf {
        self.paths.history_dir()
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
