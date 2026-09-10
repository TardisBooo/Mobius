use crate::{
    AgentKind, ContextHit, ContextKind, ContextRecord, HealthStatus, ProjectSummary, SearchRequest,
    WikiQueueItem, WorkspacePaths, sources::SourceFingerprint,
};
use anyhow::{Context, Result, bail};
use rusqlite::{
    Connection, OptionalExtension, TransactionBehavior, params, params_from_iter, types::Value,
};
use std::{path::PathBuf, str::FromStr};

#[derive(Clone, Debug)]
pub struct Database {
    path: PathBuf,
}

impl Database {
    pub fn open(paths: &WorkspacePaths) -> Result<Self> {
        paths.ensure_layout()?;
        let database = Self {
            path: paths.database_path(),
        };
        let existed = database.path.is_file()
            && std::fs::metadata(&database.path)
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false);
        let connection = database.connection()?;
        database.prepare_v2_migration(&connection, paths, existed)?;
        database.migrate(&connection)?;
        database.migrate_v2(&connection)?;
        database.migrate_mome_schema(&connection)?;
        database.ensure_v2_indexes(&connection)?;
        Ok(database)
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub fn upsert_context(&self, record: &ContextRecord) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            r#"
            INSERT INTO contexts (
                id, kind, agent, project_slug, title, body, summary, source_path,
                created_at, updated_at, metadata_json, deleted_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL)
            ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind,
                agent = excluded.agent,
                project_slug = excluded.project_slug,
                title = excluded.title,
                body = excluded.body,
                summary = excluded.summary,
                source_path = excluded.source_path,
                updated_at = excluded.updated_at,
                metadata_json = excluded.metadata_json,
                deleted_at = NULL
            "#,
            params![
                record.id,
                record.kind.as_str(),
                record.agent.as_ref().map(ToString::to_string),
                record.project_slug,
                record.title,
                record.body,
                record.summary,
                record.source_path,
                record.created_at,
                record.updated_at,
                serde_json::to_string(&record.metadata)?,
            ],
        )?;
        transaction.execute(
            "DELETE FROM context_fts WHERE context_id = ?1",
            [&record.id],
        )?;
        transaction.execute(
            "INSERT INTO context_fts (context_id, title, body, summary) VALUES (?1, ?2, ?3, ?4)",
            params![record.id, record.title, record.body, record.summary],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn get_context(&self, id: &str) -> Result<Option<ContextRecord>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, kind, agent, project_slug, title, body, summary, source_path,
                   created_at, updated_at, metadata_json
            FROM contexts WHERE id = ?1 AND deleted_at IS NULL
            "#,
        )?;
        let raw = statement.query_row([id], read_raw_context).optional()?;
        raw.map(raw_to_context).transpose()
    }

    pub fn search_contexts(&self, request: &SearchRequest) -> Result<Vec<ContextHit>> {
        if request.query.trim().is_empty() {
            return self.recent_contexts(request);
        }
        let fts_query = to_fts_query(&request.query);
        if fts_query.is_empty() {
            return self.recent_contexts(request);
        }

        let mut sql = String::from(
            r#"
            SELECT c.id, c.kind, c.agent, c.project_slug, c.title, c.summary,
                   snippet(context_fts, 2, '<mark>', '</mark>', '…', 18),
                   c.source_path, c.updated_at, bm25(context_fts)
            FROM context_fts
            INNER JOIN contexts c ON c.id = context_fts.context_id
            WHERE context_fts MATCH ? AND c.deleted_at IS NULL
            "#,
        );
        let mut values = vec![Value::Text(fts_query)];
        append_filter_sql(&mut sql, &mut values, request);
        sql.push_str(" ORDER BY bm25(context_fts) ASC LIMIT ?");
        values.push(Value::Integer(request.limit.clamp(1, 50) as i64));

        let connection = self.connection()?;
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), read_raw_hit)?;
        rows.map(|row| row.and_then(raw_to_hit))
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("mapping context search results")
    }

    pub fn list_projects(&self) -> Result<Vec<String>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT DISTINCT project_slug FROM contexts WHERE project_slug IS NOT NULL AND deleted_at IS NULL ORDER BY project_slug",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing projects")
    }

    pub fn list_project_summaries(&self) -> Result<Vec<ProjectSummary>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT project_slug, COUNT(*) AS item_count, MAX(updated_at) AS latest_at
            FROM contexts
            WHERE project_slug IS NOT NULL AND deleted_at IS NULL
            GROUP BY project_slug
            ORDER BY latest_at DESC, project_slug ASC
            "#,
        )?;
        let rows = statement.query_map([], |row| {
            Ok(ProjectSummary {
                slug: row.get(0)?,
                count: row.get(1)?,
                latest_at: row.get(2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing project summaries")
    }

    pub fn list_agent_summaries(&self) -> Result<Vec<crate::AgentSummary>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT agent, COUNT(*) AS item_count, MAX(updated_at) AS latest_at
            FROM contexts
            WHERE agent IS NOT NULL AND deleted_at IS NULL
            GROUP BY agent
            ORDER BY latest_at DESC, agent ASC
            "#,
        )?;
        let rows = statement.query_map([], |row| {
            let agent: String = row.get(0)?;
            Ok(crate::AgentSummary {
                agent: AgentKind::from_str(&agent).unwrap_or_default(),
                contexts: row.get(1)?,
                latest_at: row.get(2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing agent summaries")
    }

    pub fn health(&self) -> Result<HealthStatus> {
        let connection = self.connection()?;
        let count = |kind: Option<ContextKind>| -> Result<i64> {
            let sql = if kind.is_some() {
                "SELECT COUNT(*) FROM contexts WHERE deleted_at IS NULL AND kind = ?1"
            } else {
                "SELECT COUNT(*) FROM contexts WHERE deleted_at IS NULL"
            };
            let value = match kind {
                Some(kind) => connection.query_row(sql, [kind.as_str()], |row| row.get(0))?,
                None => connection.query_row(sql, [], |row| row.get(0))?,
            };
            Ok(value)
        };

        let indexed_sessions = connection
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap_or_else(|_| count(Some(ContextKind::Session)).unwrap_or_default());

        Ok(HealthStatus {
            database_path: self.path.display().to_string(),
            contexts: count(None)?,
            sessions: indexed_sessions,
            notes: count(Some(ContextKind::Note))?,
            boards: count(Some(ContextKind::Board))?,
            wiki_entries: count(Some(ContextKind::Wiki))?,
        })
    }

    pub fn record_snapshot(&self, subject_id: &str, path: &str) -> Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO snapshots (id, subject_id, path, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                uuid::Uuid::new_v4().to_string(),
                subject_id,
                path,
                chrono::Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn update_context_source_path(&self, id: &str, source_path: &str) -> Result<bool> {
        let changed = self.connection()?.execute(
            "UPDATE contexts SET source_path = ?2, updated_at = ?3 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, source_path, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(changed == 1)
    }

    pub fn soft_delete_context(&self, id: &str) -> Result<bool> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE contexts SET deleted_at = COALESCE(deleted_at, ?2) WHERE id = ?1",
            params![id, chrono::Utc::now().to_rfc3339()],
        )?;
        transaction.execute("DELETE FROM context_fts WHERE context_id = ?1", [id])?;
        transaction.commit()?;
        Ok(changed == 1)
    }

    pub fn restore_context(&self, id: &str) -> Result<bool> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE contexts SET deleted_at = NULL WHERE id = ?1",
            [id],
        )?;
        if changed == 1 {
            let record = transaction.query_row(
                r#"SELECT id, kind, agent, project_slug, title, body, summary, source_path,
                          created_at, updated_at, metadata_json
                   FROM contexts WHERE id = ?1"#,
                [id],
                read_raw_context,
            )?;
            transaction.execute("DELETE FROM context_fts WHERE context_id = ?1", [id])?;
            transaction.execute(
                "INSERT INTO context_fts (context_id, title, body, summary) VALUES (?1, ?2, ?3, ?4)",
                params![record.0, record.4, record.5, record.6],
            )?;
        }
        transaction.commit()?;
        Ok(changed == 1)
    }

    pub fn purge_context(&self, id: &str) -> Result<bool> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute("DELETE FROM context_fts WHERE context_id = ?1", [id])?;
        let deleted = transaction.execute("DELETE FROM contexts WHERE id = ?1", [id])?;
        transaction.commit()?;
        Ok(changed > 0 || deleted > 0)
    }

    pub fn source_is_current(&self, fingerprint: &SourceFingerprint) -> Result<bool> {
        let connection = self.connection()?;
        let metadata: Option<String> = connection
            .query_row(
                "SELECT metadata_json FROM contexts WHERE id = ?1 AND source_path = ?2 AND deleted_at IS NULL",
                params![fingerprint.id, fingerprint.source_path],
                |row| row.get(0),
            )
            .optional()?;
        let Some(metadata) = metadata else {
            return Ok(false);
        };
        let metadata: serde_json::Value = serde_json::from_str(&metadata)?;
        let unchanged_bytes = metadata
            .get("raw_bytes")
            .and_then(serde_json::Value::as_u64)
            == Some(fingerprint.raw_bytes);
        let unchanged_mtime = metadata
            .get("modified_unix_millis")
            .and_then(serde_json::Value::as_u64)
            == fingerprint.modified_unix_millis;
        Ok(unchanged_bytes && unchanged_mtime)
    }

    pub fn enqueue_wiki(&self, source_context_id: &str) -> Result<WikiQueueItem> {
        let item = WikiQueueItem {
            id: format!("wiki-queue:{}", uuid::Uuid::new_v4()),
            source_context_id: source_context_id.to_string(),
            state: "queued".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        let connection = self.connection()?;
        connection.execute(
            r#"
            INSERT INTO wiki_queue(id, source_context_id, state, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![
                item.id,
                item.source_context_id,
                item.state,
                item.created_at,
                item.updated_at,
            ],
        )?;
        Ok(item)
    }

    pub fn list_wiki_queue(&self) -> Result<Vec<WikiQueueItem>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, source_context_id, state, created_at, updated_at
            FROM wiki_queue
            ORDER BY CASE state WHEN 'queued' THEN 0 ELSE 1 END, updated_at DESC
            "#,
        )?;
        let rows = statement.query_map([], |row| {
            Ok(WikiQueueItem {
                id: row.get(0)?,
                source_context_id: row.get(1)?,
                state: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing wiki review queue")
    }

    pub fn review_wiki_queue(&self, id: &str, state: &str) -> Result<WikiQueueItem> {
        if !matches!(state, "accepted" | "dismissed" | "queued") {
            bail!("Invalid wiki review state {state}");
        }
        let updated_at = chrono::Utc::now().to_rfc3339();
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE wiki_queue SET state = ?1, updated_at = ?2 WHERE id = ?3",
            params![state, updated_at, id],
        )?;
        if changed == 0 {
            bail!("No wiki queue item matches {id}");
        }
        connection.query_row(
            "SELECT id, source_context_id, state, created_at, updated_at FROM wiki_queue WHERE id = ?1",
            [id],
            |row| {
                Ok(WikiQueueItem {
                    id: row.get(0)?,
                    source_context_id: row.get(1)?,
                    state: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .context("reading reviewed wiki queue item")
    }

    fn recent_contexts(&self, request: &SearchRequest) -> Result<Vec<ContextHit>> {
        let mut sql = String::from(
            r#"
            SELECT id, kind, agent, project_slug, title, summary, summary,
                   source_path, updated_at, 0.0
            FROM contexts c WHERE c.deleted_at IS NULL
            "#,
        );
        let mut values = Vec::new();
        append_filter_sql(&mut sql, &mut values, request);
        sql.push_str(" ORDER BY updated_at DESC LIMIT ?");
        values.push(Value::Integer(request.limit.clamp(1, 50) as i64));

        let connection = self.connection()?;
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), read_raw_hit)?;
        rows.map(|row| row.and_then(raw_to_hit))
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("mapping recent contexts")
    }

    pub(crate) fn connection(&self) -> Result<Connection> {
        let connection = Connection::open(&self.path)
            .with_context(|| format!("opening {}", self.path.display()))?;
        connection.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            PRAGMA temp_store = MEMORY;
            "#,
        )?;
        Ok(connection)
    }

    fn migrate(&self, connection: &Connection) -> Result<()> {
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS contexts (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                agent TEXT,
                project_slug TEXT,
                title TEXT NOT NULL,
                body TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                source_path TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                deleted_at TEXT
            );
            CREATE INDEX IF NOT EXISTS contexts_project_idx ON contexts(project_slug, updated_at DESC);
            CREATE INDEX IF NOT EXISTS contexts_kind_idx ON contexts(kind, updated_at DESC);
            CREATE INDEX IF NOT EXISTS contexts_agent_idx ON contexts(agent, updated_at DESC);

            CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
                context_id UNINDEXED,
                title,
                body,
                summary,
                tokenize = 'unicode61 remove_diacritics 2'
            );

            CREATE TABLE IF NOT EXISTS snapshots (
                id TEXT PRIMARY KEY,
                subject_id TEXT NOT NULL,
                path TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS snapshots_subject_idx ON snapshots(subject_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS wiki_queue (
                id TEXT PRIMARY KEY,
                source_context_id TEXT NOT NULL,
                state TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(source_context_id) REFERENCES contexts(id)
            );

            CREATE TABLE IF NOT EXISTS managed_skills (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                scope TEXT NOT NULL,
                target TEXT NOT NULL,
                source_path TEXT NOT NULL,
                destination_path TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                installed_at TEXT NOT NULL,
                UNIQUE(scope, target, destination_path)
            );

            INSERT OR IGNORE INTO schema_migrations(version, applied_at)
            VALUES (1, datetime('now'));
            "#,
        )?;
        Ok(())
    }
}

type RawContext = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
    String,
);

type RawHit = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    String,
    f64,
);

fn read_raw_context(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawContext> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
    ))
}

fn raw_to_context(raw: RawContext) -> Result<ContextRecord> {
    Ok(ContextRecord {
        id: raw.0,
        kind: ContextKind::from_str(&raw.1).unwrap_or_default(),
        agent: raw.2.and_then(|value| value.parse().ok()),
        project_slug: raw.3,
        title: raw.4,
        body: raw.5,
        summary: raw.6,
        source_path: raw.7,
        created_at: raw.8,
        updated_at: raw.9,
        metadata: serde_json::from_str(&raw.10).unwrap_or(serde_json::Value::Null),
    })
}

fn read_raw_hit(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawHit> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
    ))
}

fn raw_to_hit(raw: RawHit) -> rusqlite::Result<ContextHit> {
    Ok(ContextHit {
        id: raw.0,
        kind: ContextKind::from_str(&raw.1).unwrap_or_default(),
        agent: raw.2.and_then(|value| value.parse().ok()),
        project_slug: raw.3,
        title: raw.4,
        summary: raw.5,
        snippet: raw.6,
        source_path: raw.7,
        updated_at: raw.8,
        score: raw.9,
    })
}

fn append_filter_sql(sql: &mut String, values: &mut Vec<Value>, request: &SearchRequest) {
    if let Some(agent) = &request.filter.agent {
        sql.push_str(" AND c.agent = ?");
        values.push(Value::Text(agent.to_string()));
    }
    if let Some(project) = &request.filter.project_slug {
        sql.push_str(" AND c.project_slug = ?");
        values.push(Value::Text(project.clone()));
    }
    if let Some(kind) = &request.filter.kind {
        sql.push_str(" AND c.kind = ?");
        values.push(Value::Text(kind.to_string()));
    }
}

fn to_fts_query(query: &str) -> String {
    let terms = query
        .split_whitespace()
        .map(|term| {
            term.trim_matches(|character: char| {
                !character.is_alphanumeric() && character != '_' && character != '-'
            })
        })
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"", term.replace('"', "")))
        .collect::<Vec<_>>();
    terms.join(" AND ")
}
