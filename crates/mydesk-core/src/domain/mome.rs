use crate::AgentKind;
use serde::{Deserialize, Serialize};

/// The maximum context Mome may return for a single explicit recall.
pub const MAX_MOME_TOKENS: usize = 1_200;
/// A recall deliberately spans only a few independently-citable sessions.
pub const MAX_MOME_SESSION_SOURCES: usize = 3;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct MomeRecallRequest {
    pub query: String,
    pub workspace_id: Option<String>,
    pub checkout_id: Option<String>,
    #[serde(default)]
    pub providers: Vec<AgentKind>,
    /// Capped at [`MAX_MOME_TOKENS`].  This is an output budget, not a model
    /// prompt parameter, so callers cannot cause a full transcript export.
    pub max_tokens: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MomeSemanticStatus {
    /// This build has no semantic/vector backend configured. Recall is the
    /// local SQLite FTS/BM25 path only; it never infers that a model is absent
    /// merely because no semantic backend was invoked.
    LexicalOnlyNoSemanticBackendConfigured,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MomeSource {
    pub provider: AgentKind,
    pub session_id: String,
    pub session_record_id: String,
    pub start_ordinal: i64,
    pub end_ordinal: i64,
    /// Stable, copyable source locator. The provider transcript remains read-only.
    pub citation: String,
    pub content_hash: String,
    pub text: String,
    pub estimated_tokens: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MomeRecallResponse {
    pub query: String,
    pub retrieval_mode: String,
    pub semantic_status: MomeSemanticStatus,
    pub max_tokens: usize,
    pub estimated_tokens: usize,
    pub sources: Vec<MomeSource>,
}
