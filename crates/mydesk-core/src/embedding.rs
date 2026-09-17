//! Optional local embeddings for Mome.
//!
//! Vectors are a regenerable derived index. Session transcripts remain the
//! authority. Semantic ranking is opt-in, talks only to localhost Ollama, and
//! fails open to BM25.

use crate::{
    Database, MomeSemanticStatus,
    database_mome::MomeChunkMatch,
    mome::{estimate_tokens, truncate_to_tokens},
};
use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpStream,
    time::Duration,
};

pub const DEFAULT_OLLAMA_MODEL: &str = "nomic-embed-text";
const DEFAULT_OLLAMA_HOST: &str = "127.0.0.1:11434";
const RRF_K: f32 = 60.0;
const EMBED_TIMEOUT: Duration = Duration::from_secs(8);
const PROBE_TIMEOUT: Duration = Duration::from_millis(400);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SemanticPolicy {
    pub enabled: bool,
    pub model: String,
    pub host: String,
}

impl Default for SemanticPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            model: DEFAULT_OLLAMA_MODEL.into(),
            host: DEFAULT_OLLAMA_HOST.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct SemanticStatusReport {
    pub enabled: bool,
    pub model: String,
    pub host: String,
    pub reachable: bool,
    pub model_present: bool,
    pub embedded_chunks: i64,
    pub indexed_chunks: i64,
    pub coverage: String,
    pub note: String,
}

impl Database {
    pub(crate) fn migrate_mome_embeddings(&self, connection: &Connection) -> Result<()> {
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS mome_embeddings (
                chunk_id TEXT PRIMARY KEY,
                model TEXT NOT NULL,
                dim INTEGER NOT NULL,
                vector BLOB NOT NULL,
                content_hash TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS mome_embeddings_model_idx
                ON mome_embeddings(model);
            CREATE TABLE IF NOT EXISTS mome_semantic_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        )?;
        Ok(())
    }

    pub fn semantic_policy(&self) -> Result<SemanticPolicy> {
        let connection = self.connection()?;
        let enabled: Option<String> = connection
            .query_row(
                "SELECT value FROM mome_semantic_state WHERE key = 'enabled'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let model: Option<String> = connection
            .query_row(
                "SELECT value FROM mome_semantic_state WHERE key = 'model'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(SemanticPolicy {
            enabled: enabled.as_deref() == Some("true"),
            model: model.unwrap_or_else(|| DEFAULT_OLLAMA_MODEL.into()),
            host: DEFAULT_OLLAMA_HOST.into(),
        })
    }

    pub fn set_semantic_enabled(&self, enabled: bool, model: Option<&str>) -> Result<SemanticPolicy> {
        let mut policy = self.semantic_policy()?;
        policy.enabled = enabled;
        if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
            policy.model = model.trim().to_string();
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO mome_semantic_state(key, value) VALUES('enabled', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [if enabled { "true" } else { "false" }],
        )?;
        transaction.execute(
            "INSERT INTO mome_semantic_state(key, value) VALUES('model', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [&policy.model],
        )?;
        transaction.commit()?;
        Ok(policy)
    }

    pub fn semantic_status_report(&self) -> Result<SemanticStatusReport> {
        let policy = self.semantic_policy()?;
        let (reachable, model_present) = probe_ollama(&policy.host, &policy.model);
        let connection = self.connection()?;
        let indexed_chunks: i64 = connection
            .query_row("SELECT COUNT(*) FROM mome_chunks", [], |row| row.get(0))
            .unwrap_or(0);
        let embedded_chunks: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM mome_embeddings WHERE model = ?1",
                [&policy.model],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let coverage = if indexed_chunks == 0 {
            "empty"
        } else if embedded_chunks == 0 {
            "none"
        } else if embedded_chunks < indexed_chunks {
            "partial"
        } else {
            "full"
        }
        .to_string();
        Ok(SemanticStatusReport {
            enabled: policy.enabled,
            model: policy.model,
            host: policy.host,
            reachable,
            model_present,
            embedded_chunks,
            indexed_chunks,
            coverage,
            note: if !policy.enabled {
                "Semantic ranking is off. Recall stays lexical BM25.".into()
            } else if !reachable || !model_present {
                "Enabled, but the local Ollama model is not ready. Recall fails open to lexical.".into()
            } else {
                "Enabled. Selected indexed chunks may be sent to localhost Ollama.".into()
            },
        })
    }

    pub fn sync_mome_embeddings(&self) -> Result<SemanticStatusReport> {
        let policy = self.semantic_policy()?;
        if !policy.enabled {
            return self.semantic_status_report();
        }
        let (reachable, model_present) = probe_ollama(&policy.host, &policy.model);
        if !reachable || !model_present {
            return self.semantic_status_report();
        }
        let pending = self.pending_embedding_chunks(&policy.model)?;
        for (chunk_id, content_hash, content) in pending.into_iter().take(64) {
            match embed_texts(&policy.host, &policy.model, &[content]) {
                Ok(mut vectors) => {
                    if let Some(vector) = vectors.pop() {
                        self.store_embedding(&chunk_id, &policy.model, &content_hash, &vector)?;
                    }
                }
                Err(_) => break,
            }
        }
        self.semantic_status_report()
    }

    fn pending_embedding_chunks(&self, model: &str) -> Result<Vec<(String, String, String)>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"SELECT c.id, c.content_hash, c.content
               FROM mome_chunks c
               LEFT JOIN mome_embeddings e
                 ON e.chunk_id = c.id AND e.model = ?1 AND e.content_hash = c.content_hash
               WHERE e.chunk_id IS NULL
               ORDER BY c.indexed_at DESC
               LIMIT 128"#,
        )?;
        let rows = statement.query_map([model], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn store_embedding(
        &self,
        chunk_id: &str,
        model: &str,
        content_hash: &str,
        vector: &[f32],
    ) -> Result<()> {
        let blob = encode_vector(vector);
        self.connection()?.execute(
            r#"INSERT INTO mome_embeddings(chunk_id, model, dim, vector, content_hash, updated_at)
               VALUES(?1, ?2, ?3, ?4, ?5, datetime('now'))
               ON CONFLICT(chunk_id) DO UPDATE SET
                 model = excluded.model,
                 dim = excluded.dim,
                 vector = excluded.vector,
                 content_hash = excluded.content_hash,
                 updated_at = excluded.updated_at"#,
            params![chunk_id, model, vector.len() as i64, blob, content_hash],
        )?;
        Ok(())
    }

    pub(crate) fn rerank_mome_chunks(
        &self,
        query: &str,
        lexical: Vec<MomeChunkMatch>,
        policy: &SemanticPolicy,
    ) -> Result<(Vec<MomeChunkMatch>, MomeSemanticStatus, Option<String>, Option<String>)> {
        if lexical.is_empty() {
            return Ok((
                lexical,
                MomeSemanticStatus::LexicalOnlyNoSemanticBackendConfigured,
                None,
                None,
            ));
        }
        if !policy.enabled {
            return Ok((
                lexical,
                MomeSemanticStatus::LexicalOnlyNoSemanticBackendConfigured,
                Some("none".into()),
                None,
            ));
        }
        let report = self.semantic_status_report()?;
        if !report.reachable || !report.model_present || report.embedded_chunks == 0 {
            return Ok((
                lexical,
                MomeSemanticStatus::SemanticUnavailable,
                Some(report.coverage),
                Some("local embedding model is not ready".into()),
            ));
        }
        let query_vectors = match embed_texts(&policy.host, &policy.model, &[query.to_string()]) {
            Ok(vectors) if !vectors.is_empty() => vectors,
            _ => {
                return Ok((
                    lexical,
                    MomeSemanticStatus::SemanticUnavailable,
                    Some(report.coverage),
                    Some("query embedding failed; lexical results returned".into()),
                ));
            }
        };
        let query_vec = &query_vectors[0];
        let semantic_ids = self.top_semantic_chunk_ids(&policy.model, query_vec, 48)?;
        if semantic_ids.is_empty() {
            return Ok((
                lexical,
                MomeSemanticStatus::SemanticUnavailable,
                Some(report.coverage),
                Some("no stored embeddings matched the query dimension".into()),
            ));
        }
        let lexical_ids: Vec<String> = lexical
            .iter()
            .map(|item| format!("{}:{}", item.session_record_id, item.content_hash))
            .collect();
        let fused = fuse_rrf(&lexical_ids, &semantic_ids);
        let mut by_key: std::collections::HashMap<String, MomeChunkMatch> = lexical
            .into_iter()
            .map(|item| {
                (
                    format!("{}:{}", item.session_record_id, item.content_hash),
                    item,
                )
            })
            .collect();
        let extra = self.chunks_by_ids(&semantic_ids)?;
        for item in extra {
            by_key
                .entry(format!("{}:{}", item.session_record_id, item.content_hash))
                .or_insert(item);
        }
        let mut ranked = fused
            .into_iter()
            .filter_map(|(key, score)| by_key.remove(&key).map(|item| (score, item)))
            .collect::<Vec<_>>();
        ranked.sort_by(|left, right| {
            right
                .0
                .partial_cmp(&left.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok((
            ranked.into_iter().map(|(_, item)| item).collect(),
            MomeSemanticStatus::HybridReady,
            Some(report.coverage),
            None,
        ))
    }

    fn top_semantic_chunk_ids(&self, model: &str, query: &[f32], limit: usize) -> Result<Vec<String>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"SELECT e.chunk_id, e.dim, e.vector, c.session_id, c.content_hash
               FROM mome_embeddings e
               INNER JOIN mome_chunks c ON c.id = e.chunk_id
               WHERE e.model = ?1"#,
        )?;
        let rows = statement.query_map([model], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        let mut scored = Vec::new();
        for row in rows {
            let (_chunk_id, dim, blob, session_id, content_hash) = row?;
            if dim as usize != query.len() {
                continue;
            }
            let vector = decode_vector(&blob, dim as usize);
            if vector.len() != query.len() {
                continue;
            }
            scored.push((cosine(query, &vector), format!("{session_id}:{content_hash}")));
        }
        scored.sort_by(|left, right| {
            right
                .0
                .partial_cmp(&left.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(scored
            .into_iter()
            .take(limit)
            .map(|(_, key)| key)
            .collect())
    }

    fn chunks_by_ids(&self, keys: &[String]) -> Result<Vec<MomeChunkMatch>> {
        let mut found = Vec::new();
        let connection = self.connection()?;
        for key in keys {
            let Some((session_id, content_hash)) = key.split_once(':') else {
                continue;
            };
            let mut statement = connection.prepare(
                r#"SELECT s.provider, s.provider_session_id, s.id, c.start_ordinal, c.end_ordinal,
                          c.content_hash, c.content
                   FROM mome_chunks c
                   INNER JOIN sessions s ON s.id = c.session_id
                   WHERE c.session_id = ?1 AND c.content_hash = ?2
                   LIMIT 1"#,
            )?;
            if let Some(item) = statement
                .query_row(params![session_id, content_hash], |row| {
                    let provider: String = row.get(0)?;
                    let provider_session_id: String = row.get(1)?;
                    let start: i64 = row.get(3)?;
                    let end: i64 = row.get(4)?;
                    Ok(MomeChunkMatch {
                        provider: provider.parse().unwrap_or_default(),
                        citation: format!(
                            "@session:{provider}/{provider_session_id}#m{start}-m{end}"
                        ),
                        provider_session_id,
                        session_record_id: row.get(2)?,
                        start_ordinal: start,
                        end_ordinal: end,
                        content_hash: row.get(5)?,
                        content: row.get(6)?,
                    })
                })
                .optional()?
            {
                found.push(item);
            }
        }
        Ok(found)
    }
}

pub fn fuse_rrf(lexical: &[String], semantic: &[String]) -> Vec<(String, f32)> {
    let mut scores: std::collections::HashMap<String, f32> = std::collections::HashMap::new();
    for (rank, id) in lexical.iter().enumerate() {
        *scores.entry(id.clone()).or_default() += 1.0 / (RRF_K + rank as f32 + 1.0);
    }
    for (rank, id) in semantic.iter().enumerate() {
        *scores.entry(id.clone()).or_default() += 1.0 / (RRF_K + rank as f32 + 1.0);
    }
    let mut ranked: Vec<_> = scores.into_iter().collect();
    ranked.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    ranked
}

pub fn cosine(left: &[f32], right: &[f32]) -> f32 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for (a, b) in left.iter().zip(right) {
        dot += a * b;
        na += a * a;
        nb += b * b;
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

fn encode_vector(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|value| value.to_le_bytes()).collect()
}

fn decode_vector(blob: &[u8], dim: usize) -> Vec<f32> {
    blob.chunks_exact(4)
        .take(dim)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap_or([0; 4])))
        .collect()
}

fn probe_ollama(host: &str, model: &str) -> (bool, bool) {
    match http_json(host, "GET", "/api/tags", None, PROBE_TIMEOUT) {
        Ok(value) => {
            let present = value
                .get("models")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|item| item.get("name").and_then(Value::as_str))
                .any(|name| name == model || name.starts_with(&format!("{model}:")));
            (true, present)
        }
        Err(_) => (false, false),
    }
}

fn embed_texts(host: &str, model: &str, texts: &[String]) -> Result<Vec<Vec<f32>>> {
    let body = serde_json::to_vec(&json!({"model": model, "input": texts}))?;
    let value = http_json(host, "POST", "/api/embed", Some(&body), EMBED_TIMEOUT)?;
    let embeddings = value
        .get("embeddings")
        .and_then(Value::as_array)
        .context("ollama embed: missing embeddings")?;
    if embeddings.len() != texts.len() {
        anyhow::bail!("ollama embed: unexpected batch size");
    }
    embeddings
        .iter()
        .map(|row| {
            row.as_array()
                .context("ollama embed: vector is not an array")
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_f64)
                        .map(|item| item as f32)
                        .collect::<Vec<f32>>()
                })
        })
        .collect()
}

fn http_json(
    host: &str,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    timeout: Duration,
) -> Result<Value> {
    let mut stream = TcpStream::connect(host)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let payload = body.unwrap_or(b"");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    stream.write_all(request.as_bytes())?;
    if !payload.is_empty() {
        stream.write_all(payload)?;
    }
    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    let text = String::from_utf8_lossy(&response);
    let body = text
        .split("\r\n\r\n")
        .nth(1)
        .or_else(|| text.split("\n\n").nth(1))
        .unwrap_or(&text);
    serde_json::from_str(body.trim()).context("decoding Ollama JSON")
}

pub fn pack_sources(
    ranked: Vec<MomeChunkMatch>,
    max_tokens: usize,
    max_sessions: usize,
) -> (Vec<crate::MomeSource>, usize) {
    let mut sources = Vec::new();
    let mut used = 0usize;
    for candidate in ranked {
        if sources.len() == max_sessions
            || sources.iter().any(|source: &crate::MomeSource| {
                source.session_record_id == candidate.session_record_id
            })
        {
            continue;
        }
        let remaining = max_tokens.saturating_sub(used);
        if remaining == 0 {
            break;
        }
        let (text, estimated_tokens) = truncate_to_tokens(&candidate.content, remaining);
        if text.is_empty() {
            continue;
        }
        used += estimated_tokens;
        let _ = estimate_tokens(&text);
        sources.push(crate::MomeSource {
            provider: candidate.provider,
            session_id: candidate.provider_session_id,
            session_record_id: candidate.session_record_id,
            start_ordinal: candidate.start_ordinal,
            end_ordinal: candidate.end_ordinal,
            citation: candidate.citation,
            content_hash: candidate.content_hash,
            text,
            estimated_tokens,
        });
    }
    (sources, used)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rrf_keeps_items_present_in_only_one_list() {
        let fused = fuse_rrf(
            &["a".into(), "b".into()],
            &["c".into(), "a".into()],
        );
        let ids: Vec<_> = fused.iter().map(|(id, _)| id.as_str()).collect();
        assert!(ids.contains(&"a"));
        assert!(ids.contains(&"b"));
        assert!(ids.contains(&"c"));
        assert_eq!(ids[0], "a");
    }

    #[test]
    fn cosine_is_one_for_identical_vectors() {
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert_eq!(cosine(&[1.0], &[1.0, 0.0]), 0.0);
    }
}
