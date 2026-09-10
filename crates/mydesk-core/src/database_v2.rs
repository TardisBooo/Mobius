use crate::{
    AgentKind, Artifact, Checkout, CheckoutKind, Database, HandoffDraft, HandoffPackage,
    MatchRange, Message, MessageMatch, MessageRole, PathMapping, RelayChain, RelayEdge, RelayGraph,
    RelayMode, Session,
    SessionCapability, SessionQuery, SessionSearchHit, SessionState, Workspace, WorkspacePaths,
    WorkspaceStatus,
};
use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{
    Connection, OptionalExtension, TransactionBehavior, params, params_from_iter,
    types::Value as SqlValue,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::Path, str::FromStr};

pub const TARGET_SCHEMA_VERSION: i64 = 3;
const V2_SCHEMA_VERSION: i64 = 2;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MigrationInspection {
    pub database_path: String,
    pub database_exists: bool,
    pub current_version: i64,
    pub target_version: i64,
    pub backup_required: bool,
    pub backup_directory: String,
}

impl Database {
    pub(crate) fn ensure_v2_indexes(&self, connection: &Connection) -> Result<()> {
        connection.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS sessions_source_path_idx ON sessions(source_path);
            CREATE TABLE IF NOT EXISTS internal_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        )?;
        Ok(())
    }

    pub fn ensure_message_search_indexes(&self) -> Result<()> {
        let connection = self.connection()?;
        let current: Option<String> = connection
            .query_row(
                "SELECT value FROM internal_metadata WHERE key = 'message_search_layout'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        drop(connection);
        if current.as_deref() != Some("message-rowid-v1") {
            self.rebuild_message_search_indexes()?;
        }
        Ok(())
    }

    pub fn inspect_migration(paths: &WorkspacePaths) -> Result<MigrationInspection> {
        let path = paths.database_path();
        let exists = path.is_file();
        let current_version = if exists {
            let connection =
                Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .with_context(|| format!("opening {} read-only", path.display()))?;
            schema_version(&connection)?
        } else {
            0
        };
        Ok(MigrationInspection {
            database_path: path.display().to_string(),
            database_exists: exists,
            current_version,
            target_version: TARGET_SCHEMA_VERSION,
            backup_required: exists && current_version < TARGET_SCHEMA_VERSION,
            backup_directory: paths.migration_backup_dir().display().to_string(),
        })
    }

    pub fn schema_version(&self) -> Result<i64> {
        schema_version(&self.connection()?)
    }

    pub(crate) fn prepare_v2_migration(
        &self,
        connection: &Connection,
        paths: &WorkspacePaths,
        existed: bool,
    ) -> Result<()> {
        if !existed || schema_version(connection)? >= TARGET_SCHEMA_VERSION {
            return Ok(());
        }
        fs::create_dir_all(paths.migration_backup_dir())?;
        let stamp = Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
        let backup = paths
            .migration_backup_dir()
            .join(format!("mydesk-before-v2-{stamp}.sqlite"));
        connection
            .execute("VACUUM INTO ?1", [backup.display().to_string()])
            .with_context(|| format!("creating migration backup {}", backup.display()))?;
        Ok(())
    }

    pub(crate) fn migrate_v2(&self, connection: &Connection) -> Result<()> {
        if schema_version(connection)? >= V2_SCHEMA_VERSION {
            return Ok(());
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(include_str!("schema-v2.sql"))?;
        transaction.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
            params![V2_SCHEMA_VERSION, Utc::now().to_rfc3339()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn upsert_workspace(&self, workspace: &Workspace) -> Result<()> {
        self.connection()?.execute(
            r#"
            INSERT INTO workspaces (
                id, display_name, canonical_path, git_identity, user_status, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                display_name = excluded.display_name,
                canonical_path = excluded.canonical_path,
                git_identity = excluded.git_identity,
                updated_at = excluded.updated_at
            "#,
            params![
                workspace.id,
                workspace.display_name,
                workspace.canonical_path,
                workspace.git_identity,
                workspace.status.as_str(),
                workspace.created_at,
                workspace.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_workspaces_v2(&self) -> Result<Vec<Workspace>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, display_name, canonical_path, git_identity, user_status, created_at, updated_at
            FROM workspaces
            ORDER BY CASE user_status WHEN 'working' THEN 0 ELSE 1 END, updated_at DESC, display_name
            "#,
        )?;
        let rows = statement.query_map([], |row| {
            let status: String = row.get(4)?;
            Ok(Workspace {
                id: row.get(0)?,
                display_name: row.get(1)?,
                canonical_path: row.get(2)?,
                git_identity: row.get(3)?,
                status: if status == "paused" {
                    WorkspaceStatus::Paused
                } else {
                    WorkspaceStatus::Working
                },
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing V2 workspaces")
    }

    pub fn set_workspace_status(&self, id: &str, status: WorkspaceStatus) -> Result<bool> {
        let changed = self.connection()?.execute(
            "UPDATE workspaces SET user_status = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, status.as_str(), Utc::now().to_rfc3339()],
        )?;
        Ok(changed == 1)
    }

    pub fn upsert_checkout(&self, checkout: &Checkout) -> Result<()> {
        self.connection()?.execute(
            r#"
            INSERT INTO checkouts (
                id, workspace_id, kind, canonical_path, branch, head, git_common_dir,
                dirty, ahead, behind, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                kind = excluded.kind,
                canonical_path = excluded.canonical_path,
                branch = excluded.branch,
                head = excluded.head,
                git_common_dir = excluded.git_common_dir,
                dirty = excluded.dirty,
                ahead = excluded.ahead,
                behind = excluded.behind,
                updated_at = excluded.updated_at
            "#,
            params![
                checkout.id,
                checkout.workspace_id,
                checkout.kind.as_str(),
                checkout.canonical_path,
                checkout.branch,
                checkout.head,
                checkout.git_common_dir,
                checkout.dirty,
                checkout.ahead,
                checkout.behind,
                checkout.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_checkouts(&self, workspace_id: &str) -> Result<Vec<Checkout>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, workspace_id, kind, canonical_path, branch, head, git_common_dir,
                   dirty, ahead, behind, updated_at
            FROM checkouts WHERE workspace_id = ?1
            ORDER BY CASE kind WHEN 'main' THEN 0 WHEN 'worktree' THEN 1 ELSE 2 END, canonical_path
            "#,
        )?;
        let rows = statement.query_map([workspace_id], |row| {
            let kind: String = row.get(2)?;
            Ok(Checkout {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                kind: match kind.as_str() {
                    "main" => CheckoutKind::Main,
                    "worktree" => CheckoutKind::Worktree,
                    _ => CheckoutKind::Directory,
                },
                canonical_path: row.get(3)?,
                branch: row.get(4)?,
                head: row.get(5)?,
                git_common_dir: row.get(6)?,
                dirty: row.get(7)?,
                ahead: row.get(8)?,
                behind: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing V2 checkouts")
    }

    pub fn get_checkout(&self, id: &str) -> Result<Option<Checkout>> {
        let connection = self.connection()?;
        connection
            .query_row(
                r#"SELECT id, workspace_id, kind, canonical_path, branch, head, git_common_dir,
                      dirty, ahead, behind, updated_at FROM checkouts WHERE id = ?1"#,
                [id],
                |row| {
                    let kind: String = row.get(2)?;
                    Ok(Checkout {
                        id: row.get(0)?,
                        workspace_id: row.get(1)?,
                        kind: match kind.as_str() {
                            "main" => CheckoutKind::Main,
                            "worktree" => CheckoutKind::Worktree,
                            _ => CheckoutKind::Directory,
                        },
                        canonical_path: row.get(3)?,
                        branch: row.get(4)?,
                        head: row.get(5)?,
                        git_common_dir: row.get(6)?,
                        dirty: row.get(7)?,
                        ahead: row.get(8)?,
                        behind: row.get(9)?,
                        updated_at: row.get(10)?,
                    })
                },
            )
            .optional()
            .context("reading checkout")
    }

    pub fn reconcile_checkouts(&self, workspace_id: &str, checkouts: &[Checkout]) -> Result<()> {
        if checkouts
            .iter()
            .any(|item| item.workspace_id != workspace_id)
        {
            anyhow::bail!("cannot reconcile checkouts from another workspace");
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = {
            let mut statement =
                transaction.prepare("SELECT id FROM checkouts WHERE workspace_id = ?1")?;
            statement
                .query_map([workspace_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for checkout in checkouts {
            transaction.execute(
                r#"INSERT INTO checkouts (
                    id, workspace_id, kind, canonical_path, branch, head, git_common_dir,
                    dirty, ahead, behind, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                ON CONFLICT(id) DO UPDATE SET
                    workspace_id = excluded.workspace_id,
                    kind = excluded.kind,
                    canonical_path = excluded.canonical_path,
                    branch = excluded.branch,
                    head = excluded.head,
                    git_common_dir = excluded.git_common_dir,
                    dirty = excluded.dirty,
                    ahead = excluded.ahead,
                    behind = excluded.behind,
                    updated_at = excluded.updated_at"#,
                params![
                    checkout.id,
                    checkout.workspace_id,
                    checkout.kind.as_str(),
                    checkout.canonical_path,
                    checkout.branch,
                    checkout.head,
                    checkout.git_common_dir,
                    checkout.dirty,
                    checkout.ahead,
                    checkout.behind,
                    checkout.updated_at,
                ],
            )?;
        }
        let retained = checkouts
            .iter()
            .map(|item| item.id.as_str())
            .collect::<HashSet<_>>();
        for stale_id in existing
            .into_iter()
            .filter(|id| !retained.contains(id.as_str()))
        {
            transaction.execute("DELETE FROM checkouts WHERE id = ?1", [stale_id])?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn upsert_path_mapping(&self, mapping: &PathMapping) -> Result<()> {
        self.connection()?.execute(
            r#"
            INSERT INTO path_mappings (id, old_path, new_path, source_path, status, discovered_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(id) DO UPDATE SET
                old_path = excluded.old_path,
                new_path = excluded.new_path,
                source_path = excluded.source_path,
                status = excluded.status,
                discovered_at = excluded.discovered_at
            "#,
            params![
                mapping.id,
                mapping.old_path,
                mapping.new_path,
                mapping.source_path,
                mapping.status,
                mapping.discovered_at,
            ],
        )?;
        Ok(())
    }

    pub fn upsert_session(&self, session: &Session) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stale_rowids = {
            let mut statement = transaction.prepare(
                r#"SELECT m.rowid FROM messages m
                   INNER JOIN sessions s ON s.id = m.session_id
                   WHERE s.source_path = ?1 AND s.id <> ?2"#,
            )?;
            statement
                .query_map(params![session.source_path, session.id], |row| {
                    row.get::<_, i64>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for rowid in stale_rowids {
            transaction.execute("DELETE FROM message_fts_word WHERE rowid = ?1", [rowid])?;
            transaction.execute("DELETE FROM message_fts_trigram WHERE rowid = ?1", [rowid])?;
        }
        transaction.execute(
            "DELETE FROM sessions WHERE source_path = ?1 AND id <> ?2",
            params![session.source_path, session.id],
        )?;
        transaction.execute(
            r#"
            INSERT INTO sessions (
                id, provider, provider_session_id, checkout_id, title, state,
                capabilities_json, source_path, source_available, started_at, updated_at, metadata_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(id) DO UPDATE SET
                provider_session_id = excluded.provider_session_id,
                checkout_id = excluded.checkout_id,
                title = excluded.title,
                state = excluded.state,
                capabilities_json = excluded.capabilities_json,
                source_path = excluded.source_path,
                source_available = excluded.source_available,
                started_at = excluded.started_at,
                updated_at = excluded.updated_at,
                metadata_json = excluded.metadata_json
            "#,
            params![
                session.id,
                session.provider.to_string(),
                session.provider_session_id,
                session.checkout_id,
                session.title,
                session.state.as_str(),
                serde_json::to_string(&session.capabilities)?,
                session.source_path,
                session.source_available,
                session.started_at,
                session.updated_at,
                serde_json::to_string(&session.metadata)?,
            ],
        )?;
        if let (Some(checkout_id), Some(handoff_id)) = (
            session.checkout_id.as_deref(),
            session.metadata.get("mobius_handoff_id").and_then(|value| value.as_str()),
        ) {
            // Link only a packet explicitly observed in the target transcript.
            // Provider/cwd alone cannot identify which session took over.
            transaction.execute(
                r#"UPDATE relay_edges SET target_session_id = ?1
                   WHERE id = (
                     SELECT re.id FROM relay_edges re
                     INNER JOIN handoff_packages hp ON hp.id = re.handoff_id
                     WHERE re.target_session_id IS NULL
                       AND hp.target_provider = ?2
                       AND hp.target_checkout_id = ?3
                       AND hp.id = ?4
                       AND re.source_session_id <> ?1
                     ORDER BY re.created_at DESC LIMIT 1
                   )"#,
                params![session.id, session.provider.to_string(), checkout_id, handoff_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn get_session(&self, id: &str) -> Result<Option<Session>> {
        let connection = self.connection()?;
        connection
            .query_row(
                r#"SELECT id, provider, provider_session_id, checkout_id, title, state,
                          capabilities_json, source_path, source_available, started_at, updated_at,
                          metadata_json FROM sessions WHERE id = ?1"#,
                [id],
                session_from_row,
            )
            .optional()
            .context("reading session")
    }

    pub fn session_id_for_source(&self, source: &str) -> Result<Option<String>> {
        Ok(self.connection()?.query_row(
            "SELECT id FROM sessions WHERE source_path = ?1 ORDER BY id LIMIT 1",
            [source], |row| row.get(0),
        ).optional()?)
    }

    pub fn sessions_for_source_audit(&self) -> Result<Vec<Session>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, provider, provider_session_id, checkout_id, title, state,
             capabilities_json, source_path, source_available, started_at, updated_at,
             metadata_json FROM sessions")?;
        Ok(statement.query_map([], session_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn update_session_source(&self, session: &Session) -> Result<()> {
        self.connection()?.execute(
            "UPDATE sessions SET source_path = ?2, source_available = ?3, metadata_json = ?4, capabilities_json = ?5 WHERE id = ?1",
            params![session.id, session.source_path, session.source_available, serde_json::to_string(&session.metadata)?, serde_json::to_string(&session.capabilities)?],
        )?;
        Ok(())
    }

    pub fn get_provider_session(
        &self,
        provider: &str,
        provider_session_id: &str,
    ) -> Result<Option<Session>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"SELECT id, provider, provider_session_id, checkout_id, title, state,
                      capabilities_json, source_path, source_available, started_at, updated_at,
                      metadata_json FROM sessions WHERE provider = ?1 AND provider_session_id = ?2 AND source_available = 1
                      ORDER BY updated_at DESC, source_path ASC LIMIT 2"#,
        )?;
        let matches = statement
            .query_map(params![provider, provider_session_id], session_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("reading provider session")?;
        match matches.len() {
            0 => Ok(None),
            1 => Ok(matches.into_iter().next()),
            _ => anyhow::bail!(
                "@session:{provider}/{provider_session_id} is ambiguous across multiple approved local sources; select the exact source session in M\u{f6}bius before copying context"
            ),
        }
    }

    pub fn list_session_artifacts(&self, session_id: &str) -> Result<Vec<Artifact>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT id, session_id, message_id, kind, path, metadata_json FROM artifacts WHERE session_id = ?1 ORDER BY id")?;
        let rows = statement.query_map([session_id], |row| {
            let metadata: String = row.get(5)?;
            Ok(Artifact {
                id: row.get(0)?,
                session_id: row.get(1)?,
                message_id: row.get(2)?,
                kind: row.get(3)?,
                path: row.get(4)?,
                metadata: serde_json::from_str(&metadata).unwrap_or_default(),
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing artifacts")
    }

    pub fn session_source_unchanged(
        &self,
        source_path: &str,
        source_version: &str,
    ) -> Result<bool> {
        let connection = self.connection()?;
        let stored: Option<String> = connection
            .query_row(
                "SELECT COALESCE(json_extract(metadata_json, '$.source_version'), '') FROM sessions WHERE source_path = ?1 LIMIT 1",
                [source_path],
                |row| row.get(0),
            )
            .optional()?;
        Ok(stored.as_deref() == Some(source_version))
    }

    pub fn find_checkout_by_path(&self, path: &Path) -> Result<Option<String>> {
        let expected = normalize_catalog_path(&path.display().to_string());
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT id, canonical_path FROM checkouts")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, stored) = row?;
            if normalize_catalog_path(&stored) == expected {
                return Ok(Some(id));
            }
        }
        Ok(None)
    }

    /// Binds an already-indexed, read-only transcript to a checkout that was
    /// discovered from the transcript's existing CWD. This changes only the
    /// Möbius catalogue database; it never changes the provider source.
    pub fn set_session_checkout(&self, session_id: &str, checkout_id: Option<&str>) -> Result<()> {
        let connection = self.connection()?;
        connection
            .execute(
                "UPDATE sessions SET checkout_id = ?2 WHERE id = ?1",
                params![session_id, checkout_id],
            )
            .context("binding session to discovered checkout")?;
        Ok(())
    }

    /// Internal catalogue enumeration for post-index workspace aggregation.
    /// Deliberately unbounded: a first local discovery must not silently omit
    /// old sessions merely because the UI has a pagination limit.
    pub fn list_all_sessions_for_aggregation(&self) -> Result<Vec<Session>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"SELECT id, provider, provider_session_id, checkout_id, title, state,
                      capabilities_json, source_path, source_available, started_at, updated_at,
                      metadata_json FROM sessions ORDER BY updated_at DESC"#,
        )?;
        statement
            .query_map([], session_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("enumerating sessions for workspace aggregation")
    }

    pub fn query_sessions(&self, query: &SessionQuery) -> Result<Vec<SessionSearchHit>> {
        let limit = query.limit.clamp(1, 200);
        if !query.query.trim().is_empty() {
            let mut output = Vec::new();
            // Scope the FTS query *before* applying its result limit.  A global
            // `LIMIT` followed by a Rust-side checkout filter made a perfectly
            // valid older workspace look empty whenever newer sessions from
            // other projects filled that initial window.
            for matched in self.search_session_messages_scoped(query, limit)? {
                let Some(session) = self.get_session(&matched.message.session_id)? else {
                    continue;
                };
                output.push(SessionSearchHit {
                    session,
                    message: Some(matched.message),
                    ranges: matched.ranges,
                });
                if output.len() == limit {
                    break;
                }
            }
            // Session identifiers and titles are control-plane metadata, not
            // transcript text. Include them as a secondary, scoped lookup so
            // an exact `@session` picker can find a known id even when that
            // id never appeared in a message body.
            if output.len() < limit {
                for session in self.search_session_metadata_scoped(query, limit - output.len())? {
                    if output
                        .iter()
                        .any(|hit: &SessionSearchHit| hit.session.id == session.id)
                    {
                        continue;
                    }
                    output.push(SessionSearchHit {
                        session,
                        message: None,
                        ranges: Vec::new(),
                    });
                }
            }
            return Ok(output);
        }
        let connection = self.connection()?;
        let (scope, mut parameters) = session_scope_sql(query, "s");
        let sql = format!(
            r#"SELECT s.id, s.provider, s.provider_session_id, s.checkout_id, s.title, s.state,
                      s.capabilities_json, s.source_path, s.source_available, s.started_at, s.updated_at,
                      s.metadata_json FROM sessions s {scope} ORDER BY s.updated_at DESC LIMIT ?"#,
        );
        parameters.push(SqlValue::Integer(limit as i64));
        let mut statement = connection.prepare(&sql)?;
        let sessions = statement
            .query_map(params_from_iter(parameters.iter()), session_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut output = Vec::new();
        for session in sessions {
            output.push(SessionSearchHit {
                session,
                message: None,
                ranges: Vec::new(),
            });
        }
        Ok(output)
    }

    fn search_session_metadata_scoped(
        &self,
        query: &SessionQuery,
        limit: usize,
    ) -> Result<Vec<Session>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let escaped = query
            .query
            .trim()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{escaped}%");
        let (scope, mut parameters) = session_scope_sql(query, "s");
        let where_clause = if scope.is_empty() {
            "WHERE (lower(s.title) LIKE lower(?) ESCAPE '\\' OR lower(s.provider_session_id) LIKE lower(?) ESCAPE '\\' OR lower(s.source_path) LIKE lower(?) ESCAPE '\\')".to_string()
        } else {
            format!(
                "{scope} AND (lower(s.title) LIKE lower(?) ESCAPE '\\' OR lower(s.provider_session_id) LIKE lower(?) ESCAPE '\\' OR lower(s.source_path) LIKE lower(?) ESCAPE '\\')"
            )
        };
        parameters.push(SqlValue::Text(pattern.clone()));
        parameters.push(SqlValue::Text(pattern.clone()));
        parameters.push(SqlValue::Text(pattern));
        parameters.push(SqlValue::Integer(limit.min(200) as i64));
        let sql = format!(
            r#"SELECT s.id, s.provider, s.provider_session_id, s.checkout_id, s.title, s.state,
                      s.capabilities_json, s.source_path, s.source_available, s.started_at, s.updated_at,
                      s.metadata_json FROM sessions s {where_clause} ORDER BY s.updated_at DESC LIMIT ?"#,
        );
        let connection = self.connection()?;
        let mut statement = connection.prepare(&sql)?;
        statement
            .query_map(params_from_iter(parameters.iter()), session_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("searching session metadata")
    }

    /// Search message rows while applying the workspace/checkout/provider
    /// scope in SQLite.  This makes a project selection a reliable catalogue
    /// relationship rather than a best-effort UI-side post-filter.
    fn search_session_messages_scoped(
        &self,
        query: &SessionQuery,
        limit: usize,
    ) -> Result<Vec<MessageMatch>> {
        let needle = query.query.trim();
        if needle.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let use_trigram = needle.chars().count() >= 3;
        let (scope, mut parameters) = session_scope_sql(query, "s");
        let mut where_clause = if use_trigram {
            "WHERE f.content MATCH ?".to_string()
        } else {
            "WHERE m.redacted = 0 AND m.role != 'tool' AND instr(lower(m.content), lower(?)) > 0"
                .to_string()
        };
        if !scope.is_empty() {
            where_clause.push_str(" AND ");
            where_clause.push_str(scope.trim_start_matches(" WHERE "));
        }
        let sql = if use_trigram {
            format!(
                r#"SELECT m.id, m.session_id, m.ordinal, m.role, m.kind, m.content, m.timestamp,
                          m.source_locator_json, m.redacted
                   FROM message_fts_trigram f
                   INNER JOIN messages m ON m.id = f.message_id
                   INNER JOIN sessions s ON s.id = m.session_id
                   {where_clause}
                   ORDER BY m.timestamp DESC, m.session_id, m.ordinal LIMIT ?"#,
            )
        } else {
            format!(
                r#"SELECT m.id, m.session_id, m.ordinal, m.role, m.kind, m.content, m.timestamp,
                          m.source_locator_json, m.redacted
                   FROM messages m
                   INNER JOIN sessions s ON s.id = m.session_id
                   {where_clause}
                   ORDER BY m.timestamp DESC, m.session_id, m.ordinal LIMIT ?"#,
            )
        };
        let match_query = if use_trigram {
            // Treat a multi-word search as explicit term intersection instead
            // of one brittle literal phrase. This keeps FTS useful for
            // prompts such as "architecture migration" while preserving the
            // ordinary one-term substring path for short queries.
            message_fts_query(needle)
        } else {
            needle.to_string()
        };
        let mut all_parameters = vec![SqlValue::Text(match_query)];
        all_parameters.append(&mut parameters);
        all_parameters.push(SqlValue::Integer(limit as i64));
        let connection = self.connection()?;
        let mut statement = connection.prepare(&sql)?;
        let messages = statement
            .query_map(params_from_iter(all_parameters.iter()), message_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(messages
            .into_iter()
            .map(|message| MessageMatch {
                ranges: match_ranges(&message.content, needle),
                message,
            })
            .collect())
    }

    pub fn replace_session_messages(&self, session_id: &str, messages: &[Message]) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM message_fts_word WHERE session_id = ?1",
            [session_id],
        )?;
        transaction.execute(
            "DELETE FROM message_fts_trigram WHERE session_id = ?1",
            [session_id],
        )?;
        transaction.execute("DELETE FROM messages WHERE session_id = ?1", [session_id])?;
        for message in messages {
            if message.session_id != session_id {
                anyhow::bail!("message {} belongs to a different session", message.id);
            }
            transaction.execute(
                r#"INSERT INTO messages (
                    id, session_id, ordinal, role, kind, content, timestamp,
                    source_locator_json, redacted
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
                params![
                    message.id,
                    message.session_id,
                    message.ordinal,
                    message.role.as_str(),
                    message.kind,
                    message.content,
                    message.timestamp,
                    serde_json::to_string(&message.source_locator)?,
                    message.redacted,
                ],
            )?;
            if !message.redacted && message.role != MessageRole::Tool {
                transaction.execute(
                    "INSERT INTO message_fts_word(message_id, session_id, content) VALUES (?1, ?2, ?3)",
                    params![message.id, message.session_id, message.content],
                )?;
                transaction.execute(
                    "INSERT INTO message_fts_trigram(message_id, session_id, content) VALUES (?1, ?2, ?3)",
                    params![message.id, message.session_id, message.content],
                )?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn replace_session_messages_without_search(
        &self,
        session_id: &str,
        messages: &[Message],
    ) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let rowids = {
            let mut statement =
                transaction.prepare("SELECT rowid FROM messages WHERE session_id = ?1")?;
            statement
                .query_map([session_id], |row| row.get::<_, i64>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for rowid in rowids {
            transaction.execute("DELETE FROM message_fts_word WHERE rowid = ?1", [rowid])?;
            transaction.execute("DELETE FROM message_fts_trigram WHERE rowid = ?1", [rowid])?;
        }
        transaction.execute("DELETE FROM messages WHERE session_id = ?1", [session_id])?;
        for message in messages {
            if message.session_id != session_id {
                anyhow::bail!("message {} belongs to a different session", message.id);
            }
            transaction.execute(
                r#"INSERT INTO messages (
                    id, session_id, ordinal, role, kind, content, timestamp,
                    source_locator_json, redacted
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
                params![
                    message.id,
                    message.session_id,
                    message.ordinal,
                    message.role.as_str(),
                    message.kind,
                    message.content,
                    message.timestamp,
                    serde_json::to_string(&message.source_locator)?,
                    message.redacted,
                ],
            )?;
            if !message.redacted && message.role != MessageRole::Tool {
                let rowid = transaction.last_insert_rowid();
                transaction.execute(
                    "INSERT INTO message_fts_word(rowid, message_id, session_id, content) VALUES (?1, ?2, ?3, ?4)",
                    params![rowid, message.id, message.session_id, message.content],
                )?;
                transaction.execute(
                    "INSERT INTO message_fts_trigram(rowid, message_id, session_id, content) VALUES (?1, ?2, ?3, ?4)",
                    params![rowid, message.id, message.session_id, message.content],
                )?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn rebuild_message_search_indexes(&self) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute("DELETE FROM message_fts_word", [])?;
        transaction.execute("DELETE FROM message_fts_trigram", [])?;
        transaction.execute(
            r#"INSERT INTO message_fts_word(rowid, message_id, session_id, content)
               SELECT rowid, id, session_id, content FROM messages
               WHERE redacted = 0 AND role <> 'tool'"#,
            [],
        )?;
        transaction.execute(
            r#"INSERT INTO message_fts_trigram(rowid, message_id, session_id, content)
               SELECT rowid, id, session_id, content FROM messages
               WHERE redacted = 0 AND role <> 'tool'"#,
            [],
        )?;
        transaction.execute(
            r#"INSERT INTO internal_metadata(key, value)
               VALUES ('message_search_layout', 'message-rowid-v1')
               ON CONFLICT(key) DO UPDATE SET value = excluded.value"#,
            [],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn list_session_messages(&self, session_id: &str) -> Result<Vec<Message>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"SELECT id, session_id, ordinal, role, kind, content, timestamp,
                      source_locator_json, redacted
               FROM messages WHERE session_id = ?1 ORDER BY ordinal"#,
        )?;
        let rows = statement.query_map([session_id], message_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing session messages")
    }

    pub fn search_session_messages(&self, query: &str, limit: usize) -> Result<Vec<MessageMatch>> {
        let needle = query.trim();
        if needle.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let connection = self.connection()?;
        let use_trigram = needle.chars().count() >= 3;
        let sql = if use_trigram {
            r#"SELECT m.id, m.session_id, m.ordinal, m.role, m.kind, m.content, m.timestamp,
                      m.source_locator_json, m.redacted
               FROM message_fts_trigram f INNER JOIN messages m ON m.id = f.message_id
               WHERE f.content MATCH ?1
               ORDER BY m.timestamp DESC, m.session_id, m.ordinal LIMIT ?2"#
        } else {
            r#"SELECT id, session_id, ordinal, role, kind, content, timestamp,
                      source_locator_json, redacted FROM messages
               WHERE redacted = 0 AND role != 'tool' AND instr(lower(content), lower(?1)) > 0
               ORDER BY timestamp DESC, session_id, ordinal LIMIT ?2"#
        };
        let mut statement = connection.prepare(sql)?;
        let match_query = if use_trigram {
            format!("\"{}\"", needle.replace('"', "\"\""))
        } else {
            needle.to_string()
        };
        let messages = statement
            .query_map(params![match_query, limit as i64], message_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(messages
            .into_iter()
            .map(|message| MessageMatch {
                ranges: match_ranges(&message.content, needle),
                message,
            })
            .collect())
    }

    pub fn preview_handoff(
        &self,
        source_session_id: &str,
        target_provider: &str,
        target_checkout_id: &str,
        mode: RelayMode,
        message_ids: &[String],
    ) -> Result<HandoffDraft> {
        let session = self
            .get_session(source_session_id)?
            .ok_or_else(|| anyhow::anyhow!("source session not found: {source_session_id}"))?;
        if message_ids.is_empty() {
            anyhow::bail!("select one or more source messages before creating a context package");
        }
        let available = self.list_session_messages(source_session_id)?;
        let wanted = message_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let selected = available
            .into_iter()
            .filter(|message| wanted.contains(message.id.as_str()))
            .collect::<Vec<_>>();
        if selected.is_empty() {
            anyhow::bail!("handoff needs at least one message");
        }
        let transcript = selected
            .iter()
            .map(|message| {
                serde_json::json!({
                    "ref": format!("@session:{}/{}#m{}", session.provider, session.provider_session_id, message.ordinal),
                    "role": message.role.as_str(),
                    "content": message.content
                })
            })
            .collect::<Vec<_>>();
        let payload = serde_json::json!({
            "goal": session.title,
            "source": { "provider": session.provider, "session_id": session.provider_session_id },
            "transcript": transcript,
            "instructions": "Continue from the cited source messages. Verify the current worktree before changing files."
        });
        let token_estimate = serde_json::to_string(&payload)?.chars().count().div_ceil(4) as i64;
        Ok(HandoffDraft {
            source_session_id: source_session_id.to_string(),
            target_provider: target_provider.to_string(),
            target_checkout_id: target_checkout_id.to_string(),
            mode,
            message_ids: selected.into_iter().map(|message| message.id).collect(),
            payload,
            token_estimate,
        })
    }

    pub fn seal_handoff(&self, draft: &HandoffDraft) -> Result<HandoffPackage> {
        let handoff = HandoffPackage {
            id: format!("handoff:{}", uuid::Uuid::new_v4()),
            source_session_id: draft.source_session_id.clone(),
            target_provider: draft.target_provider.clone(),
            target_checkout_id: draft.target_checkout_id.clone(),
            mode: draft.mode.clone(),
            payload: draft.payload.clone(),
            token_estimate: draft.token_estimate,
            created_at: Utc::now().to_rfc3339(),
        };
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO handoff_packages(id, source_session_id, target_provider, target_checkout_id, mode, payload_json, token_estimate, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![handoff.id, handoff.source_session_id, handoff.target_provider, handoff.target_checkout_id, handoff.mode.as_str(), serde_json::to_string(&handoff.payload)?, handoff.token_estimate, handoff.created_at],
        )?;
        for (position, message_id) in draft.message_ids.iter().enumerate() {
            transaction.execute(
                "INSERT INTO handoff_sources(handoff_id, message_id, artifact_id, position) VALUES (?1, ?2, NULL, ?3)",
                params![handoff.id, message_id, position as i64],
            )?;
        }
        transaction.commit()?;
        Ok(handoff)
    }

    pub fn list_handoff_packages(&self, limit: usize) -> Result<Vec<HandoffPackage>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, source_session_id, target_provider, target_checkout_id, mode, payload_json, token_estimate, created_at FROM handoff_packages ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([limit.clamp(1, 500) as i64], handoff_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing handoff packages")
    }

    pub fn relay_graph_for_workspace(&self, workspace_id: &str) -> Result<RelayGraph> {
        let connection = self.connection()?;
        let mut chain_statement = connection.prepare(
            "SELECT id, workspace_id, checkout_id, title, created_at, updated_at FROM relay_chains WHERE workspace_id = ?1 ORDER BY updated_at DESC",
        )?;
        let chains = chain_statement
            .query_map([workspace_id], |row| {
                Ok(RelayChain {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    checkout_id: row.get(2)?,
                    title: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut edge_statement = connection.prepare(
            r#"SELECT re.id, re.chain_id, re.source_session_id, re.target_session_id, re.handoff_id, re.relation, re.created_at
               FROM relay_edges re INNER JOIN relay_chains rc ON rc.id = re.chain_id
               WHERE rc.workspace_id = ?1 ORDER BY re.created_at"#,
        )?;
        let edges = edge_statement
            .query_map([workspace_id], |row| {
                let relation: String = row.get(5)?;
                Ok(RelayEdge {
                    id: row.get(0)?,
                    chain_id: row.get(1)?,
                    source_session_id: row.get(2)?,
                    target_session_id: row.get(3)?,
                    handoff_id: row.get(4)?,
                    relation: if relation == "parallel" { RelayMode::Parallel } else { RelayMode::TakeOver },
                    created_at: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut handoff_statement = connection.prepare(
            r#"SELECT DISTINCT hp.id, hp.source_session_id, hp.target_provider, hp.target_checkout_id, hp.mode, hp.payload_json, hp.token_estimate, hp.created_at
               FROM handoff_packages hp
               INNER JOIN relay_edges re ON re.handoff_id = hp.id
               INNER JOIN relay_chains rc ON rc.id = re.chain_id
               WHERE rc.workspace_id = ?1 ORDER BY hp.created_at"#,
        )?;
        let handoffs = handoff_statement
            .query_map([workspace_id], handoff_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(RelayGraph { chains, edges, handoffs })
    }

    pub fn get_handoff_package(&self, id: &str) -> Result<Option<HandoffPackage>> {
        self.connection()?
            .query_row(
                "SELECT id, source_session_id, target_provider, target_checkout_id, mode, payload_json, token_estimate, created_at FROM handoff_packages WHERE id = ?1",
                [id],
                handoff_from_row,
            )
            .optional()
            .context("reading handoff package")
    }

    /// Adds an immutable edge to Möbius' own relay graph. The target session
    /// remains pending until the target Harness writes and the read-only index
    /// discovers its native session; source transcripts are never modified.
    pub fn record_relay_edge(&self, handoff: &HandoffPackage, workspace_id: &str) -> Result<String> {
        let now = Utc::now().to_rfc3339();
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing_chain: Option<String> = transaction
            .query_row(
                "SELECT chain_id FROM relay_edges WHERE target_session_id = ?1 ORDER BY created_at DESC LIMIT 1",
                [&handoff.source_session_id],
                |row| row.get(0),
            )
            .optional()?;
        let chain_id = existing_chain.clone().unwrap_or_else(|| format!("relay:{}", uuid::Uuid::new_v4()));
        let edge_id = format!("edge:{}", uuid::Uuid::new_v4());
        if existing_chain.is_none() {
            transaction.execute(
                "INSERT INTO relay_chains(id, workspace_id, checkout_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![chain_id, workspace_id, handoff.target_checkout_id, format!("{} → {}", handoff.source_session_id, handoff.target_provider), now],
            )?;
        } else {
            transaction.execute("UPDATE relay_chains SET updated_at = ?2 WHERE id = ?1", params![chain_id, now])?;
        }
        transaction.execute(
            "INSERT INTO relay_edges(id, chain_id, source_session_id, target_session_id, handoff_id, relation, created_at) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6)",
            params![edge_id, chain_id, handoff.source_session_id, handoff.id, handoff.mode.as_str(), now],
        )?;
        transaction.commit()?;
        Ok(edge_id)
    }
}

fn handoff_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HandoffPackage> {
    let mode: String = row.get(4)?;
    let payload: String = row.get(5)?;
    Ok(HandoffPackage {
        id: row.get(0)?,
        source_session_id: row.get(1)?,
        target_provider: row.get(2)?,
        target_checkout_id: row.get(3)?,
        mode: if mode == "parallel" {
            RelayMode::Parallel
        } else {
            RelayMode::TakeOver
        },
        payload: serde_json::from_str(&payload).unwrap_or_default(),
        token_estimate: row.get(6)?,
        created_at: row.get(7)?,
    })
}

fn message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    let role: String = row.get(3)?;
    let source_locator: String = row.get(7)?;
    Ok(Message {
        id: row.get(0)?,
        session_id: row.get(1)?,
        ordinal: row.get(2)?,
        role: match role.as_str() {
            "user" => MessageRole::User,
            "assistant" => MessageRole::Assistant,
            "tool" => MessageRole::Tool,
            "system" => MessageRole::System,
            "developer" => MessageRole::Developer,
            _ => MessageRole::Unknown,
        },
        kind: row.get(4)?,
        content: row.get(5)?,
        timestamp: row.get(6)?,
        source_locator: serde_json::from_str(&source_locator).unwrap_or_default(),
        redacted: row.get(8)?,
    })
}

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    let provider: String = row.get(1)?;
    let state: String = row.get(5)?;
    let capabilities: String = row.get(6)?;
    let metadata: String = row.get(11)?;
    Ok(Session {
        id: row.get(0)?,
        provider: AgentKind::from_str(&provider).unwrap_or_default(),
        provider_session_id: row.get(2)?,
        checkout_id: row.get(3)?,
        title: row.get(4)?,
        state: match state.as_str() {
            "indexed" => SessionState::Indexed,
            "running" => SessionState::Running,
            "completed" => SessionState::Completed,
            "needs_input" => SessionState::NeedsInput,
            "source_unavailable" => SessionState::SourceUnavailable,
            "path_unresolved" => SessionState::PathUnresolved,
            _ => SessionState::Unknown,
        },
        capabilities: serde_json::from_str::<Vec<SessionCapability>>(&capabilities)
            .unwrap_or_default(),
        source_path: row.get(7)?,
        source_available: row.get(8)?,
        started_at: row.get(9)?,
        updated_at: row.get(10)?,
        metadata: serde_json::from_str(&metadata).unwrap_or_default(),
    })
}

/// Builds an SQL predicate for the stable catalogue links between a session,
/// checkout, and workspace.  The alias is internal/static at every call site;
/// all user-selected IDs remain bound SQLite parameters.
fn session_scope_sql(query: &SessionQuery, session_alias: &str) -> (String, Vec<SqlValue>) {
    // Keep retired catalogue rows recoverable, but exclude them from active UI/search.
    let mut clauses = vec![format!("{session_alias}.provider <> 'apodex'")];
    let mut parameters = Vec::new();
    if let Some(checkout_id) = query
        .checkout_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        clauses.push(format!("{session_alias}.checkout_id = ?"));
        parameters.push(SqlValue::Text(checkout_id.to_string()));
    }
    if let Some(workspace_id) = query
        .workspace_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        clauses.push(format!(
            "EXISTS (SELECT 1 FROM checkouts c WHERE c.id = {session_alias}.checkout_id AND c.workspace_id = ?)"
        ));
        parameters.push(SqlValue::Text(workspace_id.to_string()));
    }
    if !query.providers.is_empty() {
        let placeholders = vec!["?"; query.providers.len()].join(", ");
        clauses.push(format!("{session_alias}.provider IN ({placeholders})"));
        parameters.extend(
            query
                .providers
                .iter()
                .map(|provider| SqlValue::Text(provider.as_str().to_string())),
        );
    }
    if clauses.is_empty() {
        (String::new(), parameters)
    } else {
        (format!(" WHERE {}", clauses.join(" AND ")), parameters)
    }
}

fn normalize_catalog_path(value: &str) -> String {
    value
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_ascii_lowercase()
}

fn message_fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn match_ranges(haystack: &str, needle: &str) -> Vec<MatchRange> {
    let terms = needle
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .collect::<Vec<_>>();
    let terms = if terms.is_empty() {
        vec![needle]
    } else {
        terms
    };
    let mut ranges = Vec::new();
    for term in terms {
        if term.is_empty() {
            continue;
        }
        if !term.is_ascii() {
            // `str::match_indices` on the original haystack gives byte-safe
            // locations for CJK and other Unicode terms.
            ranges.extend(
                haystack
                    .match_indices(term)
                    .map(|(start, value)| MatchRange {
                        start,
                        end: start + value.len(),
                    }),
            );
            continue;
        }
        let lowercase = haystack.to_lowercase();
        let lowercase_term = term.to_lowercase();
        let mut offset = 0;
        while let Some(index) = lowercase[offset..].find(&lowercase_term) {
            let start = offset + index;
            let end = start + lowercase_term.len();
            ranges.push(MatchRange { start, end });
            offset = end;
        }
    }
    ranges.sort_by_key(|range| (range.start, range.end));
    ranges.dedup_by_key(|range| (range.start, range.end));
    ranges
}

fn schema_version(connection: &Connection) -> Result<i64> {
    let has_table: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if has_table.is_none() {
        return Ok(0);
    }
    connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .context("reading schema version")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentKind, SessionState, WorkspacePaths};
    use std::{fs, path::Path};

    fn paths(root: &Path) -> WorkspacePaths {
        WorkspacePaths {
            workspace_root: root.join("workspace"),
            data_root: root.join("data"),
            artifacts_root: root.join("artifacts"),
            catalog_root: root.join("catalog"),
        }
    }

    #[test]
    fn new_database_has_v2_schema_without_backup() {
        let temporary = tempfile::tempdir().expect("temp");
        let paths = paths(temporary.path());
        let database = Database::open(&paths).expect("open V2 database");
        assert_eq!(database.schema_version().expect("version"), 3);
        assert_eq!(
            fs::read_dir(paths.migration_backup_dir())
                .expect("backups")
                .count(),
            0
        );
    }

    #[test]
    fn existing_v1_database_is_backed_up_before_v2() {
        let temporary = tempfile::tempdir().expect("temp");
        let paths = paths(temporary.path());
        paths.ensure_layout().expect("layout");
        let connection = Connection::open(paths.database_path()).expect("v1 connection");
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);\
                 INSERT INTO schema_migrations VALUES(1, 'test');\
                 CREATE TABLE legacy_marker(value TEXT NOT NULL);\
                 INSERT INTO legacy_marker VALUES('preserve-me');",
            )
            .expect("create v1");
        drop(connection);

        let database = Database::open(&paths).expect("migrate");
        assert_eq!(database.schema_version().expect("version"), 3);
        let backups = fs::read_dir(paths.migration_backup_dir())
            .expect("backup dir")
            .collect::<Result<Vec<_>, _>>()
            .expect("backup entries");
        assert_eq!(backups.len(), 1);
        let backup = Connection::open(backups[0].path()).expect("open backup");
        let marker: String = backup
            .query_row("SELECT value FROM legacy_marker", [], |row| row.get(0))
            .expect("legacy marker");
        assert_eq!(marker, "preserve-me");
        assert_eq!(schema_version(&backup).expect("backup version"), 1);
        let v2_table: Option<i64> = backup
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("inspect backup");
        assert!(v2_table.is_none());
        drop(backup);
        drop(database);
        Database::open(&paths).expect("repeat migration");
        assert_eq!(
            fs::read_dir(paths.migration_backup_dir())
                .expect("backup dir after repeat")
                .count(),
            1
        );
    }

    #[test]
    fn workspace_status_is_only_changed_explicitly() {
        let temporary = tempfile::tempdir().expect("temp");
        let database = Database::open(&paths(temporary.path())).expect("database");
        let now = Utc::now().to_rfc3339();
        database
            .upsert_workspace(&Workspace {
                id: "workspace:one".into(),
                display_name: "One".into(),
                canonical_path: r"E:\Workspaces\One".into(),
                git_identity: None,
                status: WorkspaceStatus::Working,
                created_at: now.clone(),
                updated_at: now,
            })
            .expect("upsert workspace");
        assert!(
            database
                .set_workspace_status("workspace:one", WorkspaceStatus::Paused)
                .expect("set status")
        );
        assert_eq!(
            database.list_workspaces_v2().expect("list")[0].status,
            WorkspaceStatus::Paused
        );
        database
            .upsert_workspace(&Workspace {
                id: "workspace:one".into(),
                display_name: "Renamed".into(),
                canonical_path: r"E:\Workspaces\One".into(),
                git_identity: None,
                status: WorkspaceStatus::Working,
                created_at: Utc::now().to_rfc3339(),
                updated_at: Utc::now().to_rfc3339(),
            })
            .expect("refresh workspace");
        let refreshed = &database.list_workspaces_v2().expect("list refreshed")[0];
        assert_eq!(refreshed.display_name, "Renamed");
        assert_eq!(refreshed.status, WorkspaceStatus::Paused);
    }

    #[test]
    fn session_messages_are_replaced_and_return_match_ranges() {
        let temporary = tempfile::tempdir().expect("temp");
        let database = Database::open(&paths(temporary.path())).expect("database");
        let session = Session {
            id: "session:one".into(),
            provider: AgentKind::Codex,
            provider_session_id: "one".into(),
            checkout_id: None,
            title: "Feature work".into(),
            state: SessionState::Indexed,
            capabilities: Vec::new(),
            source_path: r"C:\sessions\one.jsonl".into(),
            source_available: true,
            started_at: None,
            updated_at: Utc::now().to_rfc3339(),
            metadata: serde_json::json!({}),
        };
        database.upsert_session(&session).expect("session");
        database
            .replace_session_messages(
                &session.id,
                &[Message {
                    id: "message:one".into(),
                    session_id: session.id.clone(),
                    ordinal: 0,
                    role: MessageRole::Assistant,
                    kind: "text".into(),
                    content: "The cache invalidation bug is fixed.".into(),
                    timestamp: None,
                    source_locator: serde_json::json!({"line": 4}),
                    redacted: false,
                }],
            )
            .expect("messages");
        let hits = database
            .search_session_messages("invalidation", 10)
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(
            &hits[0].message.content[hits[0].ranges[0].start..hits[0].ranges[0].end],
            "invalidation"
        );
    }

    #[test]
    fn provider_session_lookup_rejects_ambiguous_native_ids() {
        let temporary = tempfile::tempdir().expect("temp");
        let database = Database::open(&paths(temporary.path())).expect("database");
        for (id, source_path) in [
            ("session:duplicate:one", r"C:\\first\\session.jsonl"),
            ("session:duplicate:two", r"C:\\second\\session.jsonl"),
        ] {
            database
                .upsert_session(&Session {
                    id: id.into(),
                    provider: AgentKind::Codex,
                    provider_session_id: "same-native-id".into(),
                    checkout_id: None,
                    title: "Duplicated native session".into(),
                    state: SessionState::Indexed,
                    capabilities: vec![SessionCapability::Inspect],
                    source_path: source_path.into(),
                    source_available: true,
                    started_at: None,
                    updated_at: Utc::now().to_rfc3339(),
                    metadata: serde_json::json!({}),
                })
                .expect("upsert duplicate source");
        }

        let error = database
            .get_provider_session("codex", "same-native-id")
            .expect_err("duplicate native ids must not resolve silently");
        assert!(error.to_string().contains("ambiguous"));
    }

    #[test]
    fn workspace_and_checkout_session_queries_apply_scope_before_pagination() {
        let temporary = tempfile::tempdir().expect("temp");
        let database = Database::open(&paths(temporary.path())).expect("database");
        let created_at = "2026-01-01T00:00:00Z".to_string();
        database
            .upsert_workspace(&Workspace {
                id: "workspace:target".into(),
                display_name: "Target".into(),
                canonical_path: temporary.path().join("target").display().to_string(),
                git_identity: None,
                status: WorkspaceStatus::Working,
                created_at: created_at.clone(),
                updated_at: created_at.clone(),
            })
            .expect("target workspace");
        database
            .upsert_workspace(&Workspace {
                id: "workspace:other".into(),
                display_name: "Other".into(),
                canonical_path: temporary.path().join("other").display().to_string(),
                git_identity: None,
                status: WorkspaceStatus::Working,
                created_at: created_at.clone(),
                updated_at: created_at.clone(),
            })
            .expect("other workspace");
        for (id, workspace_id) in [
            ("checkout:target", "workspace:target"),
            ("checkout:other", "workspace:other"),
        ] {
            database
                .upsert_checkout(&Checkout {
                    id: id.into(),
                    workspace_id: workspace_id.into(),
                    kind: CheckoutKind::Directory,
                    canonical_path: temporary.path().join(id).display().to_string(),
                    branch: None,
                    head: None,
                    git_common_dir: None,
                    dirty: false,
                    ahead: 0,
                    behind: 0,
                    updated_at: created_at.clone(),
                })
                .expect("checkout");
        }
        let target = Session {
            id: "session:target".into(),
            provider: AgentKind::Codex,
            provider_session_id: "target".into(),
            checkout_id: Some("checkout:target".into()),
            title: "Older target session".into(),
            state: SessionState::Indexed,
            capabilities: vec![SessionCapability::Inspect],
            source_path: "target.jsonl".into(),
            source_available: true,
            started_at: None,
            updated_at: "2020-01-01T00:00:00Z".into(),
            metadata: serde_json::json!({"cwd": "target"}),
        };
        database.upsert_session(&target).expect("target session");
        database
            .replace_session_messages(
                &target.id,
                &[Message {
                    id: "message:target".into(),
                    session_id: target.id.clone(),
                    ordinal: 1,
                    role: MessageRole::User,
                    kind: "text".into(),
                    content: "find the workspace bridge".into(),
                    timestamp: Some("2020-01-01T00:00:00Z".into()),
                    source_locator: serde_json::json!({}),
                    redacted: false,
                }],
            )
            .expect("target message");

        // These sessions are all newer than target. Previously the global
        // unscoped `LIMIT 1000` hid target from an otherwise valid checkout.
        for index in 0..1_005 {
            let id = format!("session:other:{index}");
            let session = Session {
                id: id.clone(),
                provider: if index % 2 == 0 {
                    AgentKind::Claude
                } else {
                    AgentKind::Grok
                },
                provider_session_id: format!("other-{index}"),
                checkout_id: Some("checkout:other".into()),
                title: format!("Newer unrelated {index}"),
                state: SessionState::Indexed,
                capabilities: vec![SessionCapability::Inspect],
                source_path: format!("other-{index}.jsonl"),
                source_available: true,
                started_at: None,
                updated_at: format!("2026-02-01T00:00:{:02}Z", index % 60),
                metadata: serde_json::json!({}),
            };
            database.upsert_session(&session).expect("other session");
            if index < 5 {
                database
                    .replace_session_messages(
                        &session.id,
                        &[Message {
                            id: format!("message:other:{index}"),
                            session_id: session.id.clone(),
                            ordinal: 1,
                            role: MessageRole::User,
                            kind: "text".into(),
                            content: "find the workspace bridge".into(),
                            timestamp: Some(format!("2026-02-01T00:00:{:02}Z", index)),
                            source_locator: serde_json::json!({}),
                            redacted: false,
                        }],
                    )
                    .expect("other message");
            }
        }

        let by_checkout = database
            .query_sessions(&SessionQuery {
                checkout_id: Some("checkout:target".into()),
                limit: 10,
                ..SessionQuery::default()
            })
            .expect("query checkout");
        assert_eq!(by_checkout.len(), 1);
        assert_eq!(by_checkout[0].session.id, target.id);

        let by_workspace_and_provider = database
            .query_sessions(&SessionQuery {
                workspace_id: Some("workspace:target".into()),
                providers: vec![AgentKind::Codex],
                limit: 10,
                ..SessionQuery::default()
            })
            .expect("query workspace");
        assert_eq!(by_workspace_and_provider.len(), 1);
        assert_eq!(by_workspace_and_provider[0].session.id, target.id);

        let scoped_search = database
            .query_sessions(&SessionQuery {
                query: "workspace bridge".into(),
                checkout_id: Some("checkout:target".into()),
                limit: 10,
                ..SessionQuery::default()
            })
            .expect("search checkout");
        assert_eq!(scoped_search.len(), 1);
        assert_eq!(scoped_search[0].session.id, target.id);
    }

    #[test]
    fn handoff_selection_is_immutable_and_queryable() {
        let temporary = tempfile::tempdir().expect("temp");
        let database = Database::open(&paths(temporary.path())).expect("database");
        let now = Utc::now().to_rfc3339();
        database
            .upsert_workspace(&Workspace {
                id: "workspace:relay".into(),
                display_name: "Relay".into(),
                canonical_path: temporary.path().display().to_string(),
                git_identity: None,
                status: WorkspaceStatus::Working,
                created_at: now.clone(),
                updated_at: now.clone(),
            })
            .expect("workspace");
        database
            .upsert_checkout(&Checkout {
                id: "checkout:relay".into(),
                workspace_id: "workspace:relay".into(),
                kind: CheckoutKind::Main,
                canonical_path: temporary.path().display().to_string(),
                branch: Some("main".into()),
                head: None,
                git_common_dir: None,
                dirty: false,
                ahead: 0,
                behind: 0,
                updated_at: now.clone(),
            })
            .expect("checkout");
        let session = Session {
            id: "session:relay".into(),
            provider: AgentKind::Codex,
            provider_session_id: "provider-relay".into(),
            checkout_id: Some("checkout:relay".into()),
            title: "Continue feature".into(),
            state: SessionState::Indexed,
            capabilities: vec![SessionCapability::Inspect],
            source_path: "source.jsonl".into(),
            source_available: true,
            started_at: None,
            updated_at: now,
            metadata: serde_json::json!({}),
        };
        database.upsert_session(&session).expect("session");
        database
            .replace_session_messages(
                &session.id,
                &[
                    Message {
                        id: "message:keep".into(),
                        session_id: session.id.clone(),
                        ordinal: 1,
                        role: MessageRole::Assistant,
                        kind: "text".into(),
                        content: "Architecture decision".into(),
                        timestamp: None,
                        source_locator: serde_json::json!({"line": 1}),
                        redacted: false,
                    },
                    Message {
                        id: "message:skip".into(),
                        session_id: session.id.clone(),
                        ordinal: 2,
                        role: MessageRole::Tool,
                        kind: "text".into(),
                        content: "Noisy output".into(),
                        timestamp: None,
                        source_locator: serde_json::json!({"line": 2}),
                        redacted: false,
                    },
                ],
            )
            .expect("messages");
        assert!(
            database
                .preview_handoff(
                    &session.id,
                    "claude",
                    "checkout:relay",
                    RelayMode::TakeOver,
                    &[],
                )
                .is_err()
        );
        let draft = database
            .preview_handoff(
                &session.id,
                "claude",
                "checkout:relay",
                RelayMode::TakeOver,
                &["message:keep".into()],
            )
            .expect("preview");
        assert_eq!(draft.message_ids, vec!["message:keep"]);
        assert!(
            draft
                .payload
                .to_string()
                .contains("@session:codex/provider-relay#m1")
        );
        let sealed = database.seal_handoff(&draft).expect("seal");
        assert_eq!(
            database.get_handoff_package(&sealed.id).expect("get"),
            Some(sealed.clone())
        );
        assert_eq!(database.list_handoff_packages(10).expect("list"), vec![sealed.clone()]);
        let edge = database.record_relay_edge(&sealed, "workspace:relay").expect("relay edge");
        let connection = database.connection().expect("connection");
        let pending: Option<String> = connection.query_row(
            "SELECT target_session_id FROM relay_edges WHERE id = ?1",
            [&edge], |row| row.get(0),
        ).expect("pending edge");
        assert!(pending.is_none());
        drop(connection);

        let mut target = Session {
            id: "session:relay-target".into(), provider: AgentKind::Claude,
            provider_session_id: "provider-relay-target".into(), checkout_id: Some("checkout:relay".into()),
            title: "Continued feature".into(), state: SessionState::Indexed,
            capabilities: vec![SessionCapability::Inspect], source_path: "target.jsonl".into(),
            source_available: true, started_at: None, updated_at: Utc::now().to_rfc3339(), metadata: serde_json::json!({}),
        };
        database.upsert_session(&target).expect("target session");
        let connection = database.connection().expect("connection");
        let resolved: Option<String> = connection.query_row(
            "SELECT target_session_id FROM relay_edges WHERE id = ?1",
            [&edge], |row| row.get(0),
        ).expect("resolved edge");
        assert!(resolved.is_none(), "same-provider sessions are not evidence of a handoff");
        drop(connection);
        target.metadata = serde_json::json!({"mobius_handoff_id": sealed.id});
        database.upsert_session(&target).expect("explicit target marker");
        let graph = database.relay_graph_for_workspace("workspace:relay").expect("graph");
        assert_eq!(graph.chains.len(), 1);
        assert_eq!(graph.handoffs, vec![sealed]);
        assert_eq!(graph.edges[0].target_session_id.as_deref(), Some(target.id.as_str()));
    }

    #[test]
    fn checkout_reconciliation_removes_only_stale_catalog_rows() {
        let temporary = tempfile::tempdir().expect("temp");
        let database = Database::open(&paths(temporary.path())).expect("database");
        let now = Utc::now().to_rfc3339();
        database
            .upsert_workspace(&Workspace {
                id: "workspace:one".into(),
                display_name: "One".into(),
                canonical_path: r"E:\Workspaces\One".into(),
                git_identity: None,
                status: WorkspaceStatus::Working,
                created_at: now.clone(),
                updated_at: now.clone(),
            })
            .expect("workspace");
        let checkout = |id: &str| Checkout {
            id: id.into(),
            workspace_id: "workspace:one".into(),
            kind: CheckoutKind::Worktree,
            canonical_path: format!(r"E:\Workspaces\One\{id}"),
            branch: None,
            head: None,
            git_common_dir: None,
            dirty: false,
            ahead: 0,
            behind: 0,
            updated_at: now.clone(),
        };
        database
            .reconcile_checkouts("workspace:one", &[checkout("one"), checkout("stale")])
            .expect("initial reconciliation");
        database
            .reconcile_checkouts("workspace:one", &[checkout("one")])
            .expect("second reconciliation");
        assert_eq!(
            database
                .list_checkouts("workspace:one")
                .expect("list")
                .len(),
            1
        );
    }
}
