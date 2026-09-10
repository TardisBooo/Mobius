use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{convert::Infallible, fmt, str::FromStr};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Codex,
    Claude,
    Pi,
    Grok,
    // Decode existing catalogues without deleting or rewriting historical data.
    // This retired provider must never be offered as an active adapter.
    Apodex,
    #[default]
    Unknown,
}

impl AgentKind {
    pub const ALL: [Self; 5] = [
        Self::Codex,
        Self::Claude,
        Self::Pi,
        Self::Grok,
        Self::Unknown,
    ];

    pub fn is_supported(&self) -> bool {
        matches!(self, Self::Codex | Self::Claude | Self::Pi | Self::Grok)
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Pi => "pi",
            Self::Grok => "grok",
            Self::Apodex => "apodex",
            Self::Unknown => "unknown",
        }
    }
}

impl fmt::Display for AgentKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for AgentKind {
    type Err = Infallible;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Ok(match value.trim().to_ascii_lowercase().as_str() {
            "codex" => Self::Codex,
            "claude" | "claude-code" => Self::Claude,
            "pi" => Self::Pi,
            "grok" | "xai-grok" => Self::Grok,
            "apodex" => Self::Apodex,
            _ => Self::Unknown,
        })
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ContextKind {
    #[default]
    Session,
    Note,
    Board,
    Wiki,
    WebClip,
    Pdf,
    Command,
    Skill,
}

impl ContextKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Note => "note",
            Self::Board => "board",
            Self::Wiki => "wiki",
            Self::WebClip => "web_clip",
            Self::Pdf => "pdf",
            Self::Command => "command",
            Self::Skill => "skill",
        }
    }
}

impl fmt::Display for ContextKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for ContextKind {
    type Err = Infallible;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Ok(match value.trim().to_ascii_lowercase().as_str() {
            "session" => Self::Session,
            "note" => Self::Note,
            "board" => Self::Board,
            "wiki" => Self::Wiki,
            "web_clip" | "web" => Self::WebClip,
            "pdf" => Self::Pdf,
            "command" => Self::Command,
            "skill" => Self::Skill,
            _ => Self::Session,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ContextRecord {
    pub id: String,
    pub kind: ContextKind,
    pub agent: Option<AgentKind>,
    pub project_slug: Option<String>,
    pub title: String,
    pub body: String,
    pub summary: String,
    pub source_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub metadata: Value,
}

impl ContextRecord {
    pub fn new(id: impl Into<String>, kind: ContextKind, title: impl Into<String>) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: id.into(),
            kind,
            agent: None,
            project_slug: None,
            title: title.into(),
            body: String::new(),
            summary: String::new(),
            source_path: None,
            created_at: now.clone(),
            updated_at: now,
            metadata: Value::Null,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ContextHit {
    pub id: String,
    pub kind: ContextKind,
    pub agent: Option<AgentKind>,
    pub project_slug: Option<String>,
    pub title: String,
    pub summary: String,
    pub snippet: String,
    pub source_path: Option<String>,
    pub updated_at: String,
    pub score: f64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct SearchFilter {
    pub agent: Option<AgentKind>,
    pub project_slug: Option<String>,
    pub kind: Option<ContextKind>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SearchRequest {
    pub query: String,
    #[serde(default)]
    pub filter: SearchFilter,
    #[serde(default = "default_search_limit")]
    pub limit: usize,
}

const fn default_search_limit() -> usize {
    8
}

impl Default for SearchRequest {
    fn default() -> Self {
        Self {
            query: String::new(),
            filter: SearchFilter::default(),
            limit: default_search_limit(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MentionKind {
    Project,
    Session,
    Note,
    Board,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Mention {
    pub kind: MentionKind,
    pub reference: String,
    pub node: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NoteDraft {
    pub title: String,
    pub body: String,
    pub project_slug: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WikiDraft {
    pub title: String,
    pub body: String,
    pub project_slug: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BoardDocument {
    pub id: String,
    pub title: String,
    pub project_slug: Option<String>,
    pub data: Value,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct TrashItem {
    pub id: String,
    pub kind: ContextKind,
    pub title: String,
    pub original_path: String,
    pub deleted_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub source_path: String,
    pub source_kind: String,
    pub content_hash: String,
    pub scope: String,
    pub managed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HealthStatus {
    pub database_path: String,
    pub contexts: i64,
    pub sessions: i64,
    pub notes: i64,
    pub boards: i64,
    pub wiki_entries: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProjectSummary {
    pub slug: String,
    pub count: i64,
    pub latest_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AgentSummary {
    pub agent: AgentKind,
    pub contexts: i64,
    pub latest_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WikiQueueItem {
    pub id: String,
    pub source_context_id: String,
    pub state: String,
    pub created_at: String,
    pub updated_at: String,
}
