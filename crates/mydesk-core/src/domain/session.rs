use crate::AgentKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Indexed,
    Running,
    Completed,
    NeedsInput,
    SourceUnavailable,
    PathUnresolved,
    Unknown,
}

impl SessionState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Indexed => "indexed",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::NeedsInput => "needs_input",
            Self::SourceUnavailable => "source_unavailable",
            Self::PathUnresolved => "path_unresolved",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionCapability {
    Inspect,
    NativeResume,
    Reply,
    Interrupt,
    Archive,
    Delete,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Session {
    pub id: String,
    pub provider: AgentKind,
    pub provider_session_id: String,
    pub checkout_id: Option<String>,
    pub title: String,
    pub state: SessionState,
    pub capabilities: Vec<SessionCapability>,
    pub source_path: String,
    pub source_available: bool,
    pub started_at: Option<String>,
    pub updated_at: String,
    pub metadata: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
    Tool,
    System,
    Developer,
    Unknown,
}

impl MessageRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
            Self::System => "system",
            Self::Developer => "developer",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub ordinal: i64,
    pub role: MessageRole,
    pub kind: String,
    pub content: String,
    pub timestamp: Option<String>,
    pub source_locator: Value,
    pub redacted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MatchRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct MessageMatch {
    pub message: Message,
    pub ranges: Vec<MatchRange>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct SessionQuery {
    pub query: String,
    pub workspace_id: Option<String>,
    pub checkout_id: Option<String>,
    pub providers: Vec<AgentKind>,
    pub limit: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct SessionSearchHit {
    pub session: Session,
    pub message: Option<Message>,
    pub ranges: Vec<MatchRange>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Artifact {
    pub id: String,
    pub session_id: String,
    pub message_id: Option<String>,
    pub kind: String,
    pub path: Option<String>,
    pub metadata: Value,
}
