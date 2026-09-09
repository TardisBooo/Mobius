use crate::{
    AgentKind, Database, Message, MessageRole, MomeRecallRequest,
    mome::{estimate_tokens, is_cjk},
};
use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{
    Connection, OptionalExtension, TransactionBehavior, params, params_from_iter, types::Value,
};
use sha2::{Digest, Sha256};
use std::str::FromStr;

const MOME_SCHEMA_VERSION: i64 = 3;
const CHUNK_CHARACTER_TARGET: usize = 1_800;

#[derive(Clone, Debug)]
pub(crate) struct MomeChunkMatch {
    pub provider: AgentKind,
    pub provider_session_id: String,
    pub session_record_id: String,
    pub start_ordinal: i64,
    pub end_ordinal: i64,
    pub content_hash: String,
    pub content: String,
    pub citation: String,
}

#[derive(Debug)]
struct ChunkDraft {
    start_ordinal: i64,
    end_ordinal: i64,
    content: String,
}

impl Database {
    pub(crate) fn migrate_mome_schema(&self, connection: &Connection) -> Result<()> {
        let version: i64 = connection.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        if version >= MOME_SCHEMA_VERSION {
            return Ok(());
        }
        let mut writable = self.connection()?;
        let transaction = writable.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS mome_session_state (
                session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                source_hash TEXT NOT NULL,
                indexed_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mome_chunks (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                start_ordinal INTEGER NOT NULL,
                end_ordinal INTEGER NOT NULL,
                content TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                estimated_tokens INTEGER NOT NULL,
                indexed_at TEXT NOT NULL,
                UNIQUE(session_id, start_ordinal, end_ordinal, content_hash)
            );
            CREATE INDEX IF NOT EXISTS mome_chunks_session_idx
                ON mome_chunks(session_id, start_ordinal);
            CREATE VIRTUAL TABLE IF NOT EXISTS mome_chunk_fts USING fts5(
                chunk_id UNINDEXED,
                session_record_id UNINDEXED,
                content,
                cjk_bigrams,
                title,
                tokenize = 'unicode61 remove_diacritics 2'
            );
            INSERT OR IGNORE INTO schema_migrations(version, applied_at)
            VALUES (3, datetime('now'));
            "#,
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Rebuild only changed session-derived chunks. The source is the already
    /// indexed `messages` table, never a Harness JSONL file.
    pub(crate) fn sync_mome_chunks(&self) -> Result<()> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT id, title FROM sessions ORDER BY id")?;
        let sessions = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        drop(connection);

        for (session_id, title) in sessions {
            let messages = self.list_session_messages(&session_id)?;
            let source_hash = session_hash(&title, &messages);
            let connection = self.connection()?;
            let existing: Option<String> = connection
                .query_row(
                    "SELECT source_hash FROM mome_session_state WHERE session_id = ?1",
                    [&session_id],
                    |row| row.get(0),
                )
                .optional()?;
            drop(connection);
            if existing.as_deref() == Some(source_hash.as_str()) {
                continue;
            }
            self.replace_mome_session_chunks(&session_id, &title, &source_hash, &messages)?;
        }
        let connection = self.connection()?;
        connection.execute(
            "DELETE FROM mome_chunk_fts WHERE chunk_id NOT IN (SELECT id FROM mome_chunks)",
            [],
        )?;
        Ok(())
    }

    fn replace_mome_session_chunks(
        &self,
        session_id: &str,
        title: &str,
        source_hash: &str,
        messages: &[Message],
    ) -> Result<()> {
        let chunks = make_chunks(messages);
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM mome_chunk_fts WHERE session_record_id = ?1",
            [session_id],
        )?;
        transaction.execute(
            "DELETE FROM mome_chunks WHERE session_id = ?1",
            [session_id],
        )?;
        for (position, chunk) in chunks.iter().enumerate() {
            let content_hash = sha256(&chunk.content);
            let id = format!("mome:{}:{}:{}", session_id, position, &content_hash[..16]);
            transaction.execute(
                "INSERT INTO mome_chunks(id, session_id, start_ordinal, end_ordinal, content, content_hash, estimated_tokens, indexed_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![id, session_id, chunk.start_ordinal, chunk.end_ordinal, chunk.content, content_hash, estimate_tokens(&chunk.content) as i64, Utc::now().to_rfc3339()],
            )?;
            transaction.execute(
                "INSERT INTO mome_chunk_fts(chunk_id, session_record_id, content, cjk_bigrams, title) VALUES(?1, ?2, ?3, ?4, ?5)",
                params![id, session_id, chunk.content, cjk_bigrams(&chunk.content), title],
            )?;
        }
        transaction.execute(
            "INSERT INTO mome_session_state(session_id, source_hash, indexed_at) VALUES(?1, ?2, ?3) ON CONFLICT(session_id) DO UPDATE SET source_hash = excluded.source_hash, indexed_at = excluded.indexed_at",
            params![session_id, source_hash, Utc::now().to_rfc3339()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn search_mome_chunks(
        &self,
        request: &MomeRecallRequest,
        limit: usize,
    ) -> Result<Vec<MomeChunkMatch>> {
        let fts_query = mome_fts_query(&request.query);
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }
        let mut values = vec![Value::Text(fts_query)];
        let mut provider_where = String::new();
        if !request.providers.is_empty() {
            provider_where = format!(
                " AND s.provider IN ({})",
                std::iter::repeat_n("?", request.providers.len())
                    .collect::<Vec<_>>()
                    .join(",")
            );
            values.extend(
                request
                    .providers
                    .iter()
                    .map(|provider| Value::Text(provider.to_string())),
            );
        }
        // Scope is a rank preference, not a hidden filter: an explicitly
        // approved Mome recall may search all indexed sessions.
        let checkout_preference = request.checkout_id.clone().unwrap_or_default();
        let workspace_preference = request.workspace_id.clone().unwrap_or_default();
        values.push(Value::Text(checkout_preference));
        values.push(Value::Text(workspace_preference));
        values.push(Value::Integer(limit.clamp(1, 200) as i64));
        let sql = format!(
            r#"SELECT s.provider, s.provider_session_id, s.id, c.start_ordinal, c.end_ordinal,
                      c.content_hash, c.content
               FROM mome_chunk_fts f
               INNER JOIN mome_chunks c ON c.id = f.chunk_id
               INNER JOIN sessions s ON s.id = c.session_id
               LEFT JOIN checkouts co ON co.id = s.checkout_id
               WHERE mome_chunk_fts MATCH ? AND s.provider <> 'apodex' {provider_where}
               ORDER BY CASE WHEN s.checkout_id = ? THEN 0
                             WHEN co.workspace_id = ? THEN 1 ELSE 2 END,
                        bm25(mome_chunk_fts, 1.0, 0.8, 0.35) ASC,
                        s.updated_at DESC, c.start_ordinal ASC
               LIMIT ?"#,
        );
        let connection = self.connection()?;
        let mut statement = connection.prepare(&sql)?;
        statement
            .query_map(params_from_iter(values.iter()), |row| {
                let provider: String = row.get(0)?;
                let provider_session_id: String = row.get(1)?;
                let start: i64 = row.get(3)?;
                let end: i64 = row.get(4)?;
                Ok(MomeChunkMatch {
                    provider: AgentKind::from_str(&provider).unwrap_or_default(),
                    citation: format!("@session:{provider}/{provider_session_id}#m{start}-m{end}"),
                    provider_session_id,
                    session_record_id: row.get(2)?,
                    start_ordinal: start,
                    end_ordinal: end,
                    content_hash: row.get(5)?,
                    content: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("searching local Mome chunks")
    }
}

fn make_chunks(messages: &[Message]) -> Vec<ChunkDraft> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut start = None;
    let mut end = 0;
    for message in messages.iter().filter(|message| {
        !message.redacted && message.role != MessageRole::Tool && !message.content.trim().is_empty()
    }) {
        let labelled = format!(
            "[{} m{}]\n{}\n",
            message.role.as_str(),
            message.ordinal,
            message.content.trim()
        );
        if !current.is_empty()
            && current.chars().count() + labelled.chars().count() > CHUNK_CHARACTER_TARGET
        {
            chunks.push(ChunkDraft {
                start_ordinal: start.unwrap_or(end),
                end_ordinal: end,
                content: current.trim_end().to_string(),
            });
            current.clear();
            start = None;
        }
        if start.is_none() {
            start = Some(message.ordinal);
        }
        end = message.ordinal;
        current.push_str(&labelled);
    }
    if !current.trim().is_empty() {
        chunks.push(ChunkDraft {
            start_ordinal: start.unwrap_or(end),
            end_ordinal: end,
            content: current.trim_end().to_string(),
        });
    }
    chunks
}

fn session_hash(title: &str, messages: &[Message]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(title.as_bytes());
    for message in messages
        .iter()
        .filter(|message| !message.redacted && message.role != MessageRole::Tool)
    {
        hasher.update(message.ordinal.to_le_bytes());
        hasher.update(message.role.as_str().as_bytes());
        hasher.update(message.content.as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn sha256(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

/// Bigrams make CJK substring queries useful with the standard SQLite FTS5
/// tokenizer without requiring an ICU extension or a cloud segmentation API.
fn cjk_bigrams(value: &str) -> String {
    let characters = value.chars().collect::<Vec<_>>();
    characters
        .windows(2)
        .filter(|pair| is_cjk(pair[0]) && is_cjk(pair[1]))
        .map(|pair| format!("{}{}", pair[0], pair[1]))
        .collect::<Vec<_>>()
        .join(" ")
}

fn mome_fts_query(query: &str) -> String {
    let mut terms = query
        .split(|character: char| !character.is_alphanumeric() && !is_cjk(character))
        .filter(|term| !term.is_empty())
        .map(|term| term.replace('"', ""))
        .collect::<Vec<_>>();
    let cjk = cjk_bigrams(query)
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    terms.extend(cjk);
    terms.sort();
    terms.dedup();
    terms
        .into_iter()
        .map(|term| format!("\"{term}\""))
        .collect::<Vec<_>>()
        .join(" OR ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MessageRole, Session, SessionState, WorkspacePaths};
    use std::path::Path;

    fn paths(root: &Path) -> WorkspacePaths {
        WorkspacePaths {
            workspace_root: root.join("workspace"),
            data_root: root.join("data"),
            artifacts_root: root.join("artifacts"),
            catalog_root: root.join("catalog"),
        }
    }

    #[test]
    fn mome_sync_is_local_chunked_cjk_searchable_and_incremental() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let database = Database::open(&paths(temporary.path())).expect("database");
        let session = Session {
            id: "session:one".into(),
            provider: AgentKind::Codex,
            provider_session_id: "native-1".into(),
            checkout_id: None,
            title: "支付 migration".into(),
            state: SessionState::Indexed,
            capabilities: vec![],
            source_path: "immutable.jsonl".into(),
            source_available: true,
            started_at: None,
            updated_at: "2026-01-01T00:00:00Z".into(),
            metadata: serde_json::json!({}),
        };
        database.upsert_session(&session).expect("session");
        database
            .replace_session_messages(
                &session.id,
                &[Message {
                    id: "message:one".into(),
                    session_id: session.id.clone(),
                    ordinal: 7,
                    role: MessageRole::Assistant,
                    kind: "text".into(),
                    content: "修复支付流程的数据库迁移和回滚。".into(),
                    timestamp: None,
                    source_locator: serde_json::json!({}),
                    redacted: false,
                }],
            )
            .expect("message");
        database.sync_mome_chunks().expect("sync");
        let hits = database
            .search_mome_chunks(
                &MomeRecallRequest {
                    query: "支付流程".into(),
                    ..MomeRecallRequest::default()
                },
                10,
            )
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].citation, "@session:codex/native-1#m7-m7");
        let before: i64 = database
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM mome_chunks", [], |row| row.get(0))
            .unwrap();
        database.sync_mome_chunks().expect("idempotent sync");
        let after: i64 = database
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM mome_chunks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn recall_is_bounded_to_three_cited_sessions_and_reports_lexical_fallback() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let database = Database::open(&paths(temporary.path())).expect("database");
        for number in 0..4 {
            let session = Session {
                id: format!("session:{number}"),
                provider: AgentKind::Codex,
                provider_session_id: format!("native-{number}"),
                checkout_id: None,
                title: format!("Migration {number}"),
                state: SessionState::Indexed,
                capabilities: vec![],
                source_path: format!("immutable-{number}.jsonl"),
                source_available: true,
                started_at: None,
                updated_at: format!("2026-01-01T00:00:0{number}Z"),
                metadata: serde_json::json!({}),
            };
            database.upsert_session(&session).expect("session");
            database
                .replace_session_messages(
                    &session.id,
                    &[Message {
                        id: format!("message:{number}"),
                        session_id: session.id.clone(),
                        ordinal: number,
                        role: MessageRole::Assistant,
                        kind: "text".into(),
                        content: format!("Migration context {number}: keep citations bounded."),
                        timestamp: None,
                        source_locator: serde_json::json!({}),
                        redacted: false,
                    }],
                )
                .expect("message");
        }
        let response = crate::MomeRecall::new(&database)
            .recall(&MomeRecallRequest {
                query: "Migration context".into(),
                max_tokens: Some(2_000),
                ..MomeRecallRequest::default()
            })
            .expect("recall");
        assert_eq!(response.max_tokens, crate::MAX_MOME_TOKENS);
        assert!(response.estimated_tokens <= crate::MAX_MOME_TOKENS);
        assert_eq!(response.retrieval_mode, "lexical_bm25");
        assert_eq!(
            response.semantic_status,
            crate::MomeSemanticStatus::LexicalOnlyNoSemanticBackendConfigured
        );
        assert_eq!(response.sources.len(), crate::MAX_MOME_SESSION_SOURCES);
        assert!(response.sources.iter().all(|source| {
            source.citation.starts_with("@session:codex/native-") && source.citation.contains("#m")
        }));
    }
}
