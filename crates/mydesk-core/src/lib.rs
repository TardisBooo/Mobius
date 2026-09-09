//! Local-first domain layer for MyDesk.
//!
//! The crate deliberately keeps source transcripts immutable. It owns only the
//! normalized context index and content authored through MyDesk (notes, boards,
//! wiki snapshots, and managed skill manifests).

pub mod database;
mod database_mome;
mod database_v2;
pub mod domain;
pub mod mcp_approvals;
pub mod mentions;
pub mod model;
pub mod mome;
pub mod note_mounts;
pub mod paths;
pub mod providers;
pub mod service;
pub mod session_maps;
pub mod skills;
pub mod sources;
pub mod trajectory;
pub mod vault;
pub mod workspace_identity;

pub use database::Database;
pub use domain::*;
pub use mcp_approvals::{
    MAX_MCP_APPROVAL_CHARS, MAX_MCP_APPROVAL_TTL_SECONDS, McpApprovalAttempt, McpApprovalGrant,
    McpApprovalRequest, McpApprovalStore,
};
pub use model::*;
pub use mome::MomeRecall;
pub use note_mounts::{MountInfo, NoteFileInfo};
pub use paths::WorkspacePaths;
pub use providers::{
    ProviderIndexProviderReport, ProviderIndexReport, ProviderIndexRootReport, ProviderIndexer,
    SessionAdapter, SessionAdapterRegistry,
};
pub use service::MyDesk;
pub use session_maps::{SessionMapCatalog, SessionMapEntry, SessionMapLoadReport};
pub use sources::{
    ApprovedSessionSources, AutoSourceSuppression, SessionSourceRoot, add_manual_session_source,
    auto_discover_session_sources, load_approved_session_sources, remove_approved_session_source,
    save_approved_session_sources, suggested_session_roots,
};
pub use workspace_identity::{GitIdentity, PathIdentity, inspect_path_identity, inspect_workspace};
