use crate::vault::Vault;
use crate::{
    AgentKind, BoardDocument, Checkout, ContextKind, ContextRecord, Database, HealthStatus,
    NoteDraft, ProviderIndexReport, ProviderIndexer, SearchRequest, WikiDraft, WikiQueueItem,
    TrashItem, WorkspaceInspection, WorkspacePaths, WorkspaceStatus, inspect_workspace, mentions,
    sources::{self, SessionIndexReport},
};
use anyhow::Result;
use serde_json::json;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct MyDesk {
    pub paths: WorkspacePaths,
    pub database: Database,
    vault: Vault,
}

impl MyDesk {
    pub fn open(paths: WorkspacePaths) -> Result<Self> {
        paths.ensure_layout()?;
        let database = Database::open(&paths)?;
        let vault = Vault::new(paths.clone());
        Ok(Self {
            paths,
            database,
            vault,
        })
    }

    pub fn initialize() -> Result<Self> {
        Self::open(WorkspacePaths::default())
    }

    pub fn health(&self) -> Result<HealthStatus> {
        self.database.health()
    }

    pub fn register_workspace(
        &self,
        path: &Path,
        display_name: Option<&str>,
    ) -> Result<WorkspaceInspection> {
        let inspection = self.register_workspace_catalogue(path, display_name)?;
        // A user can add a project after its local Harness sessions were
        // already indexed. Bind those existing read-only catalogue rows now;
        // do not make the project detail wait for a later full source refresh.
        self.associate_sessions_with_checkouts(&inspection.checkouts)?;
        Ok(inspection)
    }

    fn register_workspace_catalogue(
        &self,
        path: &Path,
        display_name: Option<&str>,
    ) -> Result<WorkspaceInspection> {
        let mut inspection = inspect_workspace(path, display_name)?;
        self.database.upsert_workspace(&inspection.workspace)?;
        self.database
            .reconcile_checkouts(&inspection.workspace.id, &inspection.checkouts)?;
        if let Some(persisted) = self
            .database
            .list_workspaces_v2()?
            .into_iter()
            .find(|workspace| workspace.id == inspection.workspace.id)
        {
            inspection.workspace = persisted;
        }
        Ok(inspection)
    }

    pub fn set_workspace_status(&self, id: &str, status: WorkspaceStatus) -> Result<bool> {
        self.database.set_workspace_status(id, status)
    }

    pub fn search(&self, request: &SearchRequest) -> Result<Vec<crate::ContextHit>> {
        self.database.search_contexts(request)
    }

    pub fn index_all_provider_sessions(&self) -> Result<ProviderIndexReport> {
        ProviderIndexer::new(&self.database, &self.paths).index_standard_roots()
    }

    /// Startup/refresh path for local Harnesses. Discovery is deliberately
    /// finite (known provider roots only), persists the source provenance in
    /// Möbius' manifest, then indexes every file under those approved roots.
    /// No Harness process is started and transcript sources remain read-only.
    pub fn refresh_local_harness_sessions(&self) -> Result<ProviderIndexReport> {
        crate::auto_discover_session_sources(&self.paths)?;
        let report = self.index_all_provider_sessions()?;
        self.aggregate_sessions_into_workspaces()?;
        Ok(report)
    }

    fn associate_sessions_with_checkouts(&self, checkouts: &[Checkout]) -> Result<()> {
        if checkouts.is_empty() {
            return Ok(());
        }
        for session in self.database.list_all_sessions_for_aggregation()? {
            let Some(cwd) = session.metadata.get("cwd").and_then(|value| value.as_str()) else {
                continue;
            };
            let Ok(canonical) = Path::new(cwd).canonicalize() else {
                continue;
            };
            let Some(checkout_id) = checkout_for_cwd(checkouts, &canonical) else {
                continue;
            };
            self.database
                .set_session_checkout(&session.id, Some(&checkout_id))?;
        }
        Ok(())
    }

    fn aggregate_sessions_into_workspaces(&self) -> Result<()> {
        // Multiple Harnesses (and many sessions from one Harness) commonly
        // share one CWD. Inspect each canonical directory at most once per
        // refresh; Git/worktree discovery is read-only but still expensive.
        let mut checkout_cache: HashMap<PathBuf, Option<String>> = HashMap::new();
        for session in self.database.list_all_sessions_for_aggregation()? {
            let Some(cwd) = session.metadata.get("cwd").and_then(|value| value.as_str()) else {
                continue;
            };
            let candidate = Path::new(cwd);
            // CWD originates from an already-approved transcript. We only
            // inspect an existing directory and write to the local catalogue;
            // inspect_workspace uses read-only Git commands.
            let Ok(canonical) = candidate.canonicalize() else {
                continue;
            };
            if !canonical.is_dir() {
                continue;
            }
            let checkout_id = if let Some(cached) = checkout_cache.get(&canonical) {
                cached.clone()
            } else {
                // This internal registration intentionally skips the targeted
                // association pass. The outer loop already owns all catalogue
                // sessions, so recursively rebinding the entire database for
                // every discovered CWD would be quadratic on large archives.
                let inspection = self.register_workspace_catalogue(&canonical, None)?;
                // A session may start from a subdirectory of a Git checkout.
                // Bind it to the deepest checkout returned by the inspector;
                // never guess a parent directory from transcript metadata.
                let discovered = checkout_for_cwd(&inspection.checkouts, &canonical);
                checkout_cache.insert(canonical.clone(), discovered.clone());
                discovered
            };
            if let Some(checkout_id) = checkout_id {
                self.database
                    .set_session_checkout(&session.id, Some(&checkout_id))?;
            }
        }
        Ok(())
    }

    /// Replace the approved read-only source manifest. Refreshes only inspect
    /// these folders; convention locations are never implicitly scanned.
    pub fn set_approved_session_sources(
        &self,
        roots: Vec<crate::SessionSourceRoot>,
    ) -> Result<crate::ApprovedSessionSources> {
        crate::save_approved_session_sources(&self.paths, roots)
    }

    pub fn approved_session_sources(&self) -> Result<crate::ApprovedSessionSources> {
        crate::load_approved_session_sources(&self.paths)
    }

    pub fn resolve_mentions(&self, input: &str) -> Result<Vec<crate::ContextHit>> {
        mentions::resolve_mentions(&self.database, input, 8)
    }

    /// Explicit local Mome recall over already-indexed catalogue messages.
    /// This does not inspect native transcript paths or start any background service.
    pub fn mome_recall(
        &self,
        request: &crate::MomeRecallRequest,
    ) -> Result<crate::MomeRecallResponse> {
        crate::MomeRecall::new(&self.database).recall(request)
    }

    pub fn create_or_update_note(&self, draft: NoteDraft) -> Result<ContextRecord> {
        let (slug, path, snapshot) = self.vault.write_note(&draft)?;
        self.record_note(draft, slug, path, snapshot)
    }

    /// Save a note in-place. The caller must pass a canonical file below the
    /// private notes vault; mounted libraries are intentionally excluded.
    pub fn update_vault_note(&self, path: &Path, draft: NoteDraft) -> Result<ContextRecord> {
        let root = self.paths.notes_dir().canonicalize()?;
        let target = path.canonicalize()?;
        if !target.starts_with(&root)
            || target
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case("md"))
                != Some(true)
        {
            anyhow::bail!("note update must stay inside the private Markdown vault");
        }
        let (slug, path, snapshot) = self.vault.update_note(&target, &draft)?;
        self.record_note(draft, slug, path, snapshot)
    }

    fn record_note(
        &self,
        draft: NoteDraft,
        slug: String,
        path: PathBuf,
        snapshot: Option<PathBuf>,
    ) -> Result<ContextRecord> {
        let now = chrono::Utc::now().to_rfc3339();
        let summary = summarize(&draft.body);
        let record = ContextRecord {
            id: format!("note:{slug}"),
            kind: ContextKind::Note,
            agent: None,
            project_slug: draft.project_slug.clone(),
            title: draft.title,
            body: draft.body,
            summary,
            source_path: Some(path.display().to_string()),
            created_at: now.clone(),
            updated_at: now,
            metadata: json!({
                "tags": draft.tags,
                "source_ids": draft.source_ids,
                "author": "user",
            }),
        };
        self.database.upsert_context(&record)?;
        if let Some(snapshot) = snapshot {
            self.database
                .record_snapshot(&record.id, &snapshot.display().to_string())?;
        }
        Ok(record)
    }

    pub fn save_board(&self, board: BoardDocument) -> Result<ContextRecord> {
        let (path, snapshot) = self.vault.write_board(&board)?;
        let record = ContextRecord {
            id: format!("board:{}", board.id),
            kind: ContextKind::Board,
            agent: None,
            project_slug: board.project_slug.clone(),
            title: board.title,
            body: serde_json::to_string(&board.data)?,
            summary: "Interactive knowledge board".to_string(),
            source_path: Some(path.display().to_string()),
            created_at: board.updated_at.clone(),
            updated_at: board.updated_at,
            metadata: board.data,
        };
        self.database.upsert_context(&record)?;
        if let Some(snapshot) = snapshot {
            self.database
                .record_snapshot(&record.id, &snapshot.display().to_string())?;
        }
        Ok(record)
    }

    pub fn move_note(&self, path: &Path, destination: &str) -> Result<(String, String)> {
        let (old_path, new_path) = self.vault.move_note(path, destination)?;
        let slug = old_path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| anyhow::anyhow!("note has no stable filename"))?;
        self.database
            .update_context_source_path(&format!("note:{slug}"), &new_path.display().to_string())?;
        Ok((old_path.display().to_string(), new_path.display().to_string()))
    }

    pub fn trash_note(&self, path: &Path) -> Result<TrashItem> {
        let item = self.vault.trash_note(path)?;
        let slug = Path::new(&item.original_path)
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| anyhow::anyhow!("note has no stable filename"))?;
        self.database.soft_delete_context(&format!("note:{slug}"))?;
        Ok(item)
    }

    pub fn trash_board(&self, board_id: &str) -> Result<TrashItem> {
        let item = self.vault.trash_board(board_id)?;
        self.database.soft_delete_context(&format!("board:{board_id}"))?;
        Ok(item)
    }

    pub fn list_trash(&self) -> Result<Vec<TrashItem>> {
        self.vault.list_trash()
    }

    pub fn restore_trash(&self, id: &str) -> Result<TrashItem> {
        let item = self.vault.list_trash()?.into_iter().find(|entry| entry.id == id).ok_or_else(|| anyhow::anyhow!("trash item not found"))?;
        let restored = self.vault.restore_trash(id)?;
        if let Some(context_id) = trash_context_id(&item) {
            self.database.restore_context(&context_id)?;
        }
        Ok(restored)
    }

    pub fn purge_trash(&self, id: &str) -> Result<bool> {
        let item = self.vault.list_trash()?.into_iter().find(|entry| entry.id == id);
        let purged = self.vault.purge_trash(id)?;
        if purged {
            if let Some(item) = item {
                if let Some(context_id) = trash_context_id(&item) {
                    self.database.purge_context(&context_id)?;
                }
            }
        }
        Ok(purged)
    }

    pub fn create_or_update_wiki(&self, draft: WikiDraft) -> Result<ContextRecord> {
        let (slug, path, snapshot) = self.vault.write_wiki(&draft)?;
        let now = chrono::Utc::now().to_rfc3339();
        let summary = summarize(&draft.body);
        let record = ContextRecord {
            id: format!("wiki:{slug}"),
            kind: ContextKind::Wiki,
            agent: None,
            project_slug: draft.project_slug.clone(),
            title: draft.title,
            body: draft.body,
            summary,
            source_path: Some(path.display().to_string()),
            created_at: now.clone(),
            updated_at: now,
            metadata: json!({
                "tags": draft.tags,
                "source_ids": draft.source_ids,
                "author": "user",
                "workflow": "manual-review",
            }),
        };
        self.database.upsert_context(&record)?;
        if let Some(snapshot) = snapshot {
            self.database
                .record_snapshot(&record.id, &snapshot.display().to_string())?;
        }
        Ok(record)
    }

    pub fn enqueue_wiki_review(&self, source_context_id: &str) -> Result<WikiQueueItem> {
        self.database.enqueue_wiki(source_context_id)
    }

    pub fn list_wiki_queue(&self) -> Result<Vec<WikiQueueItem>> {
        self.database.list_wiki_queue()
    }

    pub fn review_wiki_queue(&self, id: &str, state: &str) -> Result<WikiQueueItem> {
        self.database.review_wiki_queue(id, state)
    }

    pub fn import_session(&self, mut record: ContextRecord) -> Result<()> {
        record.kind = ContextKind::Session;
        if record.summary.is_empty() {
            record.summary = summarize(&record.body);
        }
        self.database.upsert_context(&record)
    }

    pub fn import_session_file(
        &self,
        path: &Path,
        agent: AgentKind,
        project_slug: Option<String>,
    ) -> Result<ContextRecord> {
        anyhow::ensure!(agent.is_supported(), "Unsupported session provider: {agent}");
        let record = sources::record_from_file(path, agent, project_slug)?;
        self.import_session(record.clone())?;
        Ok(record)
    }

    pub fn index_session_root(
        &self,
        root: &Path,
        agent: AgentKind,
        project_slug: Option<String>,
        limit: Option<usize>,
        offset: Option<usize>,
    ) -> Result<SessionIndexReport> {
        anyhow::ensure!(agent.is_supported(), "Unsupported session provider: {agent}");
        let (files, available) = sources::list_session_files(root, limit, offset)?;
        let mut report = SessionIndexReport {
            source_root: root.display().to_string(),
            agent: agent.clone(),
            available,
            offset: offset.unwrap_or_default().min(available),
            discovered: files.len(),
            indexed: 0,
            unchanged: 0,
            skipped: 0,
            records: Vec::new(),
        };

        for path in files {
            match sources::source_fingerprint(&path, agent.clone()).and_then(|fingerprint| {
                self.database
                    .source_is_current(&fingerprint)
                    .map(|current| (fingerprint, current))
            }) {
                Ok((_fingerprint, true)) => {
                    report.unchanged += 1;
                    continue;
                }
                Ok((_fingerprint, false)) => {}
                Err(error) => {
                    report.skipped += 1;
                    tracing::warn!(source = %path.display(), %error, "could not inspect source before read-only indexing");
                    continue;
                }
            }
            match self.import_session_file(&path, agent.clone(), project_slug.clone()) {
                Ok(record) => {
                    report.indexed += 1;
                    report.records.push(record.id);
                }
                Err(error) => {
                    report.skipped += 1;
                    tracing::warn!(source = %path.display(), %error, "skipped source during read-only indexing");
                }
            }
        }
        Ok(report)
    }
}

fn trash_context_id(item: &TrashItem) -> Option<String> {
    let name = Path::new(&item.original_path).file_name()?.to_str()?;
    match item.kind {
        ContextKind::Note => Some(format!("note:{}", Path::new(name).file_stem()?.to_str()?)),
        ContextKind::Board => Some(format!("board:{}", name.strip_suffix(".board.json")?)),
        _ => None,
    }
}

fn checkout_for_cwd(checkouts: &[Checkout], canonical_cwd: &Path) -> Option<String> {
    // A session may start in a subdirectory. Bind only to the deepest checked
    // out root that actually contains it; never infer a parent from a path
    // string alone.
    checkouts
        .iter()
        .filter_map(|checkout| {
            Path::new(&checkout.canonical_path)
                .canonicalize()
                .ok()
                .filter(|checkout_path| canonical_cwd.starts_with(checkout_path))
                .map(|checkout_path| (checkout_path.components().count(), checkout.id.clone()))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, id)| id)
}

fn summarize(body: &str) -> String {
    let normalized = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut summary = normalized.chars().take(360).collect::<String>();
    if normalized.chars().count() > summary.chars().count() {
        summary.push('…');
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::MyDesk;
    use crate::{AgentKind, NoteDraft, SearchRequest, SessionQuery, SessionSourceRoot, WorkspacePaths};
    use std::{fs, path::Path};

    #[test]
    fn note_lifecycle_moves_and_recovers_search_context() -> anyhow::Result<()> {
        let temporary = tempfile::tempdir()?;
        let paths = WorkspacePaths {
            workspace_root: temporary.path().join("workspace-root"),
            data_root: temporary.path().join("data"),
            artifacts_root: temporary.path().join("artifacts"),
            catalog_root: temporary.path().join("catalog"),
        };
        let desk = MyDesk::open(paths)?;
        let record = desk.create_or_update_note(NoteDraft {
            title: "Lifecycle note".into(),
            body: "recoverable search marker".into(),
            project_slug: None,
            tags: vec![],
            source_ids: vec![],
        })?;
        let source = Path::new(record.source_path.as_deref().expect("note source"));
        let (_, moved) = desk.move_note(source, "archive/notes")?;
        assert!(!source.exists());
        assert!(Path::new(&moved).exists());
        assert_eq!(desk.database.get_context(&record.id)?.unwrap().source_path.as_deref(), Some(moved.as_str()));

        let trash = desk.trash_note(Path::new(&moved))?;
        assert!(!Path::new(&moved).exists());
        assert!(desk.database.get_context(&record.id)?.is_none());
        assert!(desk.search(&SearchRequest { query: "recoverable".into(), ..SearchRequest::default() })?.is_empty());

        desk.restore_trash(&trash.id)?;
        assert!(Path::new(&moved).exists());
        assert!(desk.database.get_context(&record.id)?.is_some());
        assert!(!desk.search(&SearchRequest { query: "recoverable".into(), ..SearchRequest::default() })?.is_empty());
        let second_trash = desk.trash_note(Path::new(&moved))?;
        assert!(desk.purge_trash(&second_trash.id)?);
        assert!(desk.database.get_context(&record.id)?.is_none());
        Ok(())
    }

    #[test]
    fn aggregates_an_indexed_existing_cwd_into_workspace_and_checkout() -> anyhow::Result<()> {
        let temporary = tempfile::tempdir()?;
        let workspace = temporary.path().join("workspace-from-session");
        let source_root = temporary.path().join("pi-sessions");
        fs::create_dir_all(&workspace)?;
        fs::create_dir_all(&source_root)?;
        fs::write(
            source_root.join("live-pi.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"11111111-1111-4111-8111-111111111111\",\"cwd\":\"{}\"}}\n{{\"type\":\"message\",\"id\":\"u1\",\"message\":{{\"role\":\"user\",\"content\":{{\"type\":\"text\",\"text\":\"aggregate this real cwd\"}}}}}}\n",
                workspace.display().to_string().replace('\\', "\\\\")
            ),
        )?;
        fs::write(
            source_root.join("live-pi-duplicate-cwd.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"22222222-2222-4222-8222-222222222222\",\"cwd\":\"{}\"}}\n{{\"type\":\"message\",\"id\":\"u2\",\"message\":{{\"role\":\"user\",\"content\":{{\"type\":\"text\",\"text\":\"same cwd second session\"}}}}}}\n",
                workspace.display().to_string().replace('\\', "\\\\")
            ),
        )?;
        let paths = WorkspacePaths {
            workspace_root: temporary.path().join("workspace-root"),
            data_root: temporary.path().join("data"),
            artifacts_root: temporary.path().join("artifacts"),
            catalog_root: temporary.path().join("catalog"),
        };
        let desk = MyDesk::open(paths)?;
        desk.set_approved_session_sources(vec![SessionSourceRoot {
            agent: AgentKind::Pi,
            path: source_root.display().to_string(),
            exists: true,
            mode: "fixture-approved".to_string(),
            provenance: "isolated test".to_string(),
        }])?;
        let report = desk.index_all_provider_sessions()?;
        assert_eq!(report.indexed, 2);
        desk.aggregate_sessions_into_workspaces()?;
        let sessions = desk.database.query_sessions(&SessionQuery {
            limit: 10,
            ..SessionQuery::default()
        })?;
        assert_eq!(sessions.len(), 2);
        assert!(
            sessions
                .iter()
                .all(|session| session.session.checkout_id.is_some())
        );
        assert_eq!(
            sessions[0].session.checkout_id,
            sessions[1].session.checkout_id
        );
        let workspaces = desk.database.list_workspaces_v2()?;
        assert_eq!(workspaces.len(), 1);
        assert_eq!(
            workspaces[0]
                .canonical_path
                .trim_start_matches(r"\\?\")
                .to_ascii_lowercase(),
            workspace
                .canonicalize()?
                .display()
                .to_string()
                .trim_start_matches(r"\\?\")
                .to_ascii_lowercase(),
        );
        Ok(())
    }

    #[test]
    fn registering_workspace_binds_preindexed_session_without_full_refresh() -> anyhow::Result<()> {
        let temporary = tempfile::tempdir()?;
        let workspace = temporary.path().join("registered-after-index");
        let source_root = temporary.path().join("pi-sessions");
        fs::create_dir_all(&workspace)?;
        fs::create_dir_all(&source_root)?;
        fs::write(
            source_root.join("session.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"33333333-3333-4333-8333-333333333333\",\"cwd\":\"{}\"}}\n{{\"type\":\"message\",\"id\":\"u1\",\"message\":{{\"role\":\"user\",\"content\":{{\"type\":\"text\",\"text\":\"associate immediately\"}}}}}}\n",
                workspace.display().to_string().replace('\\', "\\\\")
            ),
        )?;
        let paths = WorkspacePaths {
            workspace_root: temporary.path().join("workspace-root"),
            data_root: temporary.path().join("data"),
            artifacts_root: temporary.path().join("artifacts"),
            catalog_root: temporary.path().join("catalog"),
        };
        let desk = MyDesk::open(paths)?;
        desk.set_approved_session_sources(vec![SessionSourceRoot {
            agent: AgentKind::Pi,
            path: source_root.display().to_string(),
            exists: true,
            mode: "fixture-approved".to_string(),
            provenance: "isolated test".to_string(),
        }])?;
        let report = desk.index_all_provider_sessions()?;
        assert_eq!(report.indexed, 1, "{report:?}");
        let before = desk.database.query_sessions(&SessionQuery {
            limit: 8,
            ..SessionQuery::default()
        })?;
        assert_eq!(before.len(), 1);
        assert!(before[0].session.checkout_id.is_none());

        let inspection = desk.register_workspace(&workspace, None)?;
        let hits = desk.database.query_sessions(&SessionQuery {
            workspace_id: Some(inspection.workspace.id),
            limit: 8,
            ..SessionQuery::default()
        })?;
        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits[0].session.checkout_id.as_deref(),
            Some(inspection.checkouts[0].id.as_str())
        );
        Ok(())
    }
}
