use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceStatus {
    Working,
    Paused,
}

impl WorkspaceStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::Paused => "paused",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckoutKind {
    Main,
    Worktree,
    Directory,
}

impl CheckoutKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Worktree => "worktree",
            Self::Directory => "directory",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Workspace {
    pub id: String,
    pub display_name: String,
    pub canonical_path: String,
    pub git_identity: Option<String>,
    pub status: WorkspaceStatus,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Checkout {
    pub id: String,
    pub workspace_id: String,
    pub kind: CheckoutKind,
    pub canonical_path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub git_common_dir: Option<String>,
    pub dirty: bool,
    pub ahead: i64,
    pub behind: i64,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PathMapping {
    pub id: String,
    pub old_path: String,
    pub new_path: String,
    pub source_path: String,
    pub status: Option<String>,
    pub discovered_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct WorkspaceInspection {
    pub workspace: Workspace,
    pub checkouts: Vec<Checkout>,
}
