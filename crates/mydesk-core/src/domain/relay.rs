use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelayMode {
    TakeOver,
    Parallel,
}

impl RelayMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::TakeOver => "take_over",
            Self::Parallel => "parallel",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct RelayChain {
    pub id: String,
    pub workspace_id: String,
    pub checkout_id: Option<String>,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct HandoffPackage {
    pub id: String,
    pub source_session_id: String,
    pub target_provider: String,
    pub target_checkout_id: String,
    pub mode: RelayMode,
    pub payload: Value,
    pub token_estimate: i64,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct RelayEdge {
    pub id: String,
    pub chain_id: String,
    pub source_session_id: String,
    pub target_session_id: Option<String>,
    pub handoff_id: String,
    pub relation: RelayMode,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct HandoffDraft {
    pub source_session_id: String,
    pub target_provider: String,
    pub target_checkout_id: String,
    pub mode: RelayMode,
    pub message_ids: Vec<String>,
    pub payload: Value,
    pub token_estimate: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct RelayGraph {
    pub chains: Vec<RelayChain>,
    pub edges: Vec<RelayEdge>,
    pub handoffs: Vec<HandoffPackage>,
}
