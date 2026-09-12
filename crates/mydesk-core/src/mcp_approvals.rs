//! Explicit, bounded approvals for the local MCP bridge.
//!
//! An MCP client is not implicitly trusted with an operator's indexed agent
//! transcripts.  The desktop app grants a short-lived, scoped bearer token
//! after a person has selected a source/range.  Only a hash is persisted; the
//! raw token is returned exactly once to the caller that requested it.

use crate::WorkspacePaths;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const MAX_MCP_APPROVAL_TTL_SECONDS: i64 = 15 * 60;
pub const MAX_MCP_APPROVAL_CHARS: usize = 48_000;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct McpApprovalRequest {
    /// Allowed values are `search_sessions`, `get_messages`,
    /// `resolve_reference`, and explicitly-authorized `mome_recall`.
    pub operations: Vec<String>,
    pub query: Option<String>,
    pub workspace_id: Option<String>,
    pub checkout_id: Option<String>,
    pub providers: Vec<String>,
    pub provider: Option<String>,
    pub session_id: Option<String>,
    pub start_ordinal: Option<i64>,
    pub end_ordinal: Option<i64>,
    pub max_chars: usize,
    pub expires_in_seconds: i64,
    #[serde(default = "default_single_use")]
    pub single_use: bool,
}

fn default_single_use() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct McpApprovalGrant {
    pub approval_id: String,
    /// This is intentionally returned only when a desktop command creates the
    /// grant. Never write it to disk, telemetry, or the audit table.
    pub approval_token: String,
    pub expires_at: String,
    pub max_chars: usize,
    pub single_use: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct McpApprovalAttempt {
    pub operation: String,
    pub query: Option<String>,
    pub workspace_id: Option<String>,
    pub checkout_id: Option<String>,
    pub providers: Vec<String>,
    pub provider: Option<String>,
    pub session_id: Option<String>,
    pub start_ordinal: Option<i64>,
    pub end_ordinal: Option<i64>,
    /// The worst-case number of message characters the caller has asked us to
    /// expose. The budget is reserved before returning transcript text.
    pub requested_chars: usize,
}

#[derive(Clone, Debug)]
pub struct McpApprovalStore {
    path: PathBuf,
}

impl McpApprovalStore {
    pub fn for_paths(paths: &WorkspacePaths) -> Result<Self> {
        Self::open(paths.runtime_dir().join("mcp-approvals.sqlite"))
    }

    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let store = Self { path: path.into() };
        if let Some(parent) = store.path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating MCP approval store {}", parent.display()))?;
        }
        store.initialize()?;
        Ok(store)
    }

    pub fn grant(&self, request: McpApprovalRequest) -> Result<McpApprovalGrant> {
        validate_request(&request)?;
        let now = Utc::now();
        let expires_at = now + Duration::seconds(request.expires_in_seconds);
        let approval_id = format!("mcp-approval:{}", Uuid::new_v4());
        let raw_token = format!(
            "mobius_{}_{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        );
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO mcp_approvals (
                 approval_id, token_hash, issued_at, expires_at, operations_json,
                 query, workspace_id, checkout_id, providers_json, provider, session_id,
                 start_ordinal, end_ordinal, max_chars, remaining_chars, single_use, consumed
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, ?15, 0)",
            params![
                approval_id,
                hash_token(&raw_token),
                now.to_rfc3339(),
                expires_at.to_rfc3339(),
                serde_json::to_string(&request.operations)?,
                request.query,
                request.workspace_id,
                request.checkout_id,
                serde_json::to_string(&request.providers)?,
                request.provider,
                request.session_id,
                request.start_ordinal,
                request.end_ordinal,
                request.max_chars as i64,
                i64::from(request.single_use),
            ],
        )?;
        self.audit(&approval_id, "grant", "granted", 0, None)?;
        Ok(McpApprovalGrant {
            approval_id,
            approval_token: raw_token,
            expires_at: expires_at.to_rfc3339(),
            max_chars: request.max_chars,
            single_use: request.single_use,
        })
    }

    /// Validate a bearer token and consume the requested transcript budget.
    /// The transaction makes a one-time approval non-replayable even when the
    /// desktop and MCP server are separate processes.
    pub fn authorize(&self, token: &str, attempt: &McpApprovalAttempt) -> Result<String> {
        if token.trim().is_empty() {
            bail!("MCP message access needs an explicit desktop approval token");
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = transaction
            .query_row(
                "SELECT approval_id, expires_at, operations_json, query, workspace_id, checkout_id,
                        providers_json, provider, session_id, start_ordinal, end_ordinal,
                        max_chars, remaining_chars, single_use, consumed
                 FROM mcp_approvals WHERE token_hash = ?1",
                [hash_token(token)],
                |row| {
                    Ok(ApprovalRow {
                        approval_id: row.get(0)?,
                        expires_at: row.get(1)?,
                        operations: serde_json::from_str(&row.get::<_, String>(2)?)
                            .unwrap_or_default(),
                        query: row.get(3)?,
                        workspace_id: row.get(4)?,
                        checkout_id: row.get(5)?,
                        providers: serde_json::from_str(&row.get::<_, String>(6)?)
                            .unwrap_or_default(),
                        provider: row.get(7)?,
                        session_id: row.get(8)?,
                        start_ordinal: row.get(9)?,
                        end_ordinal: row.get(10)?,
                        max_chars: row.get::<_, i64>(11)? as usize,
                        remaining_chars: row.get::<_, i64>(12)? as usize,
                        single_use: row.get::<_, i64>(13)? != 0,
                        consumed: row.get::<_, i64>(14)? != 0,
                    })
                },
            )
            .optional()?;
        let Some(row) = row else {
            bail!("MCP approval is missing or invalid");
        };
        let decision = authorize_row(&row, attempt);
        match decision {
            Ok(()) => {
                let remaining = row.remaining_chars.saturating_sub(attempt.requested_chars);
                transaction.execute(
                    "UPDATE mcp_approvals SET remaining_chars = ?2, consumed = CASE WHEN single_use = 1 THEN 1 ELSE consumed END WHERE approval_id = ?1",
                    params![row.approval_id, remaining as i64],
                )?;
                transaction.execute(
                    "INSERT INTO mcp_approval_audit(approval_id, occurred_at, operation, outcome, chars, detail)
                     VALUES(?1, ?2, ?3, 'approved', ?4, NULL)",
                    params![row.approval_id, Utc::now().to_rfc3339(), attempt.operation, attempt.requested_chars as i64],
                )?;
                transaction.commit()?;
                Ok(row.approval_id)
            }
            Err(error) => {
                transaction.execute(
                    "INSERT INTO mcp_approval_audit(approval_id, occurred_at, operation, outcome, chars, detail)
                     VALUES(?1, ?2, ?3, 'rejected', ?4, ?5)",
                    params![row.approval_id, Utc::now().to_rfc3339(), attempt.operation, attempt.requested_chars as i64, error.to_string()],
                )?;
                transaction.commit()?;
                Err(error)
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn connection(&self) -> Result<Connection> {
        let connection = Connection::open(&self.path)
            .with_context(|| format!("opening MCP approval store {}", self.path.display()))?;
        connection.busy_timeout(std::time::Duration::from_secs(3))?;
        Ok(connection)
    }

    fn initialize(&self) -> Result<()> {
        let connection = self.connection()?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS mcp_approvals (
                approval_id TEXT PRIMARY KEY,
                token_hash TEXT NOT NULL UNIQUE,
                issued_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                operations_json TEXT NOT NULL,
                query TEXT,
                workspace_id TEXT,
                checkout_id TEXT,
                providers_json TEXT NOT NULL,
                provider TEXT,
                session_id TEXT,
                start_ordinal INTEGER,
                end_ordinal INTEGER,
                max_chars INTEGER NOT NULL,
                remaining_chars INTEGER NOT NULL,
                single_use INTEGER NOT NULL,
                consumed INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS mcp_approval_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                approval_id TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                operation TEXT NOT NULL,
                outcome TEXT NOT NULL,
                chars INTEGER NOT NULL,
                detail TEXT
             );",
        )?;
        Ok(())
    }

    fn audit(
        &self,
        approval_id: &str,
        operation: &str,
        outcome: &str,
        chars: usize,
        detail: Option<&str>,
    ) -> Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO mcp_approval_audit(approval_id, occurred_at, operation, outcome, chars, detail)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![approval_id, Utc::now().to_rfc3339(), operation, outcome, chars as i64, detail],
        )?;
        Ok(())
    }
}

#[derive(Debug)]
struct ApprovalRow {
    approval_id: String,
    expires_at: String,
    operations: Vec<String>,
    query: Option<String>,
    workspace_id: Option<String>,
    checkout_id: Option<String>,
    providers: Vec<String>,
    provider: Option<String>,
    session_id: Option<String>,
    start_ordinal: Option<i64>,
    end_ordinal: Option<i64>,
    max_chars: usize,
    remaining_chars: usize,
    single_use: bool,
    consumed: bool,
}

fn validate_request(request: &McpApprovalRequest) -> Result<()> {
    if request.operations.is_empty()
        || request.operations.iter().any(|operation| {
            !matches!(
                operation.as_str(),
                "search_sessions" | "get_messages" | "resolve_reference" | "mome_recall" | "read_session_range" | "commit_handoff"
            )
        })
    {
        bail!("approval requires one or more supported message-access operations");
    }
    if request.expires_in_seconds <= 0 || request.expires_in_seconds > MAX_MCP_APPROVAL_TTL_SECONDS
    {
        bail!("approval TTL must be between 1 and {MAX_MCP_APPROVAL_TTL_SECONDS} seconds");
    }
    if request.max_chars == 0 || request.max_chars > MAX_MCP_APPROVAL_CHARS {
        bail!("approval character budget must be 1..={MAX_MCP_APPROVAL_CHARS}");
    }
    if request
        .operations
        .iter()
        .any(|value| value == "search_sessions" || value == "mome_recall")
        && (request
            .query
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
            || request.providers.is_empty())
    {
        bail!("search approval needs an exact query and at least one selected provider");
    }
    if request
        .operations
        .iter()
        .any(|value| value != "search_sessions" && value != "mome_recall")
        && (request
            .provider
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
            || request
                .session_id
                .as_deref()
                .is_none_or(|value| value.trim().is_empty()))
    {
        bail!("message approval needs one exact provider and session id");
    }
    if request
        .operations
        .iter()
        .any(|value| value == "get_messages" || value == "resolve_reference")
        && (request.start_ordinal.is_none() || request.end_ordinal.is_none())
    {
        bail!("message approval needs one explicit inclusive message range");
    }
    if request.operations.iter().any(|value| value == "read_session_range" || value == "commit_handoff")
        && request.query.as_deref().is_none_or(|q| q.trim().is_empty()) {
        bail!("source read approval requires an exact byte-range fingerprint");
    }
    if let (Some(start), Some(end)) = (request.start_ordinal, request.end_ordinal) {
        if start < 0 || end < start || end - start > 200 {
            bail!("approved message range must be ordered and at most 200 messages");
        }
    }
    Ok(())
}

fn authorize_row(row: &ApprovalRow, attempt: &McpApprovalAttempt) -> Result<()> {
    if DateTime::parse_from_rfc3339(&row.expires_at)
        .map(|expiry| expiry.with_timezone(&Utc) <= Utc::now())
        .unwrap_or(true)
    {
        bail!("MCP approval has expired");
    }
    if row.single_use && row.consumed {
        bail!("MCP approval was already consumed");
    }
    if !row
        .operations
        .iter()
        .any(|operation| operation == &attempt.operation)
    {
        bail!("MCP approval does not allow this operation");
    }
    if row.query != attempt.query
        || row.workspace_id != attempt.workspace_id
        || row.checkout_id != attempt.checkout_id
    {
        bail!("MCP request falls outside the approved search scope");
    }
    if !attempt
        .providers
        .iter()
        .all(|provider| row.providers.iter().any(|allowed| allowed == provider))
    {
        bail!("MCP request includes a provider outside the approved scope");
    }
    if row.provider != attempt.provider || row.session_id != attempt.session_id {
        bail!("MCP request targets a session outside the approved scope");
    }
    if let Some(start) = row.start_ordinal {
        if attempt.start_ordinal.unwrap_or(-1) < start {
            bail!("MCP request starts before the approved message range");
        }
    }
    if let Some(end) = row.end_ordinal {
        if attempt.end_ordinal.unwrap_or(i64::MAX) > end {
            bail!("MCP request ends after the approved message range");
        }
    }
    if attempt.requested_chars == 0
        || attempt.requested_chars > row.max_chars
        || attempt.requested_chars > row.remaining_chars
    {
        bail!("MCP request exceeds the approved character budget");
    }
    Ok(())
}

fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn search_request() -> McpApprovalRequest {
        McpApprovalRequest {
            operations: vec!["search_sessions".into()],
            query: Some("media import".into()),
            workspace_id: Some("workspace:demo".into()),
            checkout_id: Some("checkout:main".into()),
            providers: vec!["codex".into()],
            provider: None,
            session_id: None,
            start_ordinal: None,
            end_ordinal: None,
            max_chars: 400,
            expires_in_seconds: 60,
            single_use: true,
        }
    }

    #[test]
    fn rejects_missing_expired_scope_and_budget_approvals() {
        let temporary = tempfile::tempdir().expect("temporary approval store");
        let store =
            McpApprovalStore::open(temporary.path().join("approvals.sqlite")).expect("store");
        let grant = store.grant(search_request()).expect("grant");
        let exact = McpApprovalAttempt {
            operation: "search_sessions".into(),
            query: Some("media import".into()),
            workspace_id: Some("workspace:demo".into()),
            checkout_id: Some("checkout:main".into()),
            providers: vec!["codex".into()],
            provider: None,
            session_id: None,
            start_ordinal: None,
            end_ordinal: None,
            requested_chars: 100,
        };
        assert!(store.authorize("missing", &exact).is_err());
        let mut outside = exact.clone();
        outside.providers = vec!["claude".into()];
        assert!(store.authorize(&grant.approval_token, &outside).is_err());
        let mut over_budget = exact.clone();
        over_budget.requested_chars = 401;
        assert!(
            store
                .authorize(&grant.approval_token, &over_budget)
                .is_err()
        );
        assert!(store.authorize(&grant.approval_token, &exact).is_ok());
        assert!(
            store.authorize(&grant.approval_token, &exact).is_err(),
            "single use"
        );
    }

    #[test]
    fn rejects_expired_grant() {
        let temporary = tempfile::tempdir().expect("temporary approval store");
        let store =
            McpApprovalStore::open(temporary.path().join("approvals.sqlite")).expect("store");
        let grant = store.grant(search_request()).expect("grant");
        let connection = Connection::open(store.path()).expect("open db");
        connection
            .execute(
                "UPDATE mcp_approvals SET expires_at = ?2 WHERE approval_id = ?1",
                params![
                    grant.approval_id,
                    (Utc::now() - Duration::seconds(1)).to_rfc3339()
                ],
            )
            .expect("expire grant");
        let attempt = McpApprovalAttempt {
            operation: "search_sessions".into(),
            query: Some("media import".into()),
            workspace_id: Some("workspace:demo".into()),
            checkout_id: Some("checkout:main".into()),
            providers: vec!["codex".into()],
            provider: None,
            session_id: None,
            start_ordinal: None,
            end_ordinal: None,
            requested_chars: 1,
        };
        assert!(store.authorize(&grant.approval_token, &attempt).is_err());
    }

    #[test]
    fn mome_recall_needs_the_same_exact_query_and_provider_scope() {
        let temporary = tempfile::tempdir().expect("temporary approval store");
        let store =
            McpApprovalStore::open(temporary.path().join("approvals.sqlite")).expect("store");
        let mut request = search_request();
        request.operations = vec!["mome_recall".into()];
        request.max_chars = 4_800;
        let grant = store.grant(request).expect("Mome grant");
        let exact = McpApprovalAttempt {
            operation: "mome_recall".into(),
            query: Some("media import".into()),
            workspace_id: Some("workspace:demo".into()),
            checkout_id: Some("checkout:main".into()),
            providers: vec!["codex".into()],
            provider: None,
            session_id: None,
            start_ordinal: None,
            end_ordinal: None,
            requested_chars: 4_800,
        };
        assert!(store.authorize(&grant.approval_token, &exact).is_ok());

        let grant = store
            .grant(search_request_for_mome())
            .expect("second Mome grant");
        let mut different_query = exact;
        different_query.query = Some("different query".into());
        assert!(
            store
                .authorize(&grant.approval_token, &different_query)
                .is_err()
        );
    }

    fn search_request_for_mome() -> McpApprovalRequest {
        let mut request = search_request();
        request.operations = vec!["mome_recall".into()];
        request.max_chars = 4_800;
        request
    }
}
