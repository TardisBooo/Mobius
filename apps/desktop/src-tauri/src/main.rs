mod harness_launch;
use mydesk_core::{
    AgentSummary, BoardDocument, ContextRecord, HealthStatus, McpApprovalGrant, McpApprovalRequest,
    McpApprovalStore, Message, MomeRecallRequest, MomeRecallResponse, MyDesk, NoteDraft,
    NoteFileInfo, ProjectSummary, ProviderIndexReport, SearchRequest, SessionQuery,
    SessionSearchHit, SessionSourceRoot, SkillInfo, WikiDraft, WikiQueueItem, Workspace,
    WorkspaceInspection, WorkspaceStatus, HandoffDraft, RelayGraph, RelayMode,
    note_mounts::{list_note_files, read_note_file},
    skills::{
        ManagedSkillInstall, SkillDeployment, SkillHistoryEntry, discover_project_skills, discover_standard_skills,
        install_skill_from_catalogue, list_managed_installations, preview_install_from_catalogue,
        read_known_or_managed_skill_content, uninstall_skill, list_skill_history, restore_skill_history,
        write_managed_skill as write_managed_skill_file,
    },
};
use parking_lot::Mutex;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use regex::Regex;
use reqwest::{Client, header};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::IpAddr,
    path::{Component, Path, PathBuf},
    str::FromStr,
    sync::{Arc, OnceLock, mpsc},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

struct DesktopState {
    desk: MyDesk,
    mcp_approvals: McpApprovalStore,
    /// Both the background startup refresh and an explicit UI refresh take
    /// this lock. Manual refreshes wait their turn instead of indexing the
    /// same finite Harness roots concurrently.
    refresh_gate: Arc<tokio::sync::Mutex<()>>,
    /// Count queued and running refreshes. The UI reads this instead of
    /// guessing from a timer or relying only on an event it could miss.
    refresh_pending: Arc<Mutex<usize>>,
    terminals: Mutex<HashMap<String, TerminalProcess>>,
}

#[derive(Clone, Serialize)]
struct SessionRefreshCompleted {
    trigger: String,
    report: Option<ProviderIndexReport>,
    error: Option<String>,
}

const SESSION_REFRESH_COMPLETED_EVENT: &str = "mobius://session-refresh-complete";

#[derive(Clone, Serialize)]
struct SessionIndexStatus {
    running: bool,
}

fn queue_refresh(refresh_pending: &Arc<Mutex<usize>>) {
    *refresh_pending.lock() += 1;
}

fn finish_refresh(refresh_pending: &Arc<Mutex<usize>>) {
    let mut pending = refresh_pending.lock();
    *pending = pending.saturating_sub(1);
}

struct TerminalProcess {
    id: String,
    title: String,
    cwd: String,
    master: Box<dyn MasterPty + Send>,
    input: mpsc::Sender<Vec<u8>>,
    child: Box<dyn Child + Send + Sync>,
    created_at: String,
    output: Arc<Mutex<TerminalBuffer>>,
}

impl TerminalProcess {
    fn send_input(&self, data: &str) -> CommandResult<()> {
        if is_cursor_position_report(data) {
            return Ok(());
        }
        self.input
            .send(normalize_terminal_input(data).into_bytes())
            .map_err(command_error)
    }
}

#[derive(Clone, Serialize)]
struct TerminalOutput {
    terminal_id: String,
    sequence: u64,
    data: String,
}

#[derive(Default)]
struct TerminalBuffer {
    sequence: u64,
    data: String,
}

#[derive(Clone, Serialize)]
struct TerminalSnapshot {
    terminal_id: String,
    sequence: u64,
    data: String,
}

const MAX_TERMINAL_BUFFER_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Serialize)]
struct TerminalInfo {
    id: String,
    title: String,
    cwd: String,
    state: String,
    created_at: String,
}

#[derive(Clone, Deserialize)]
struct DesktopMcpApprovalRequest {
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
    expires_in_seconds: i64,
    #[serde(default = "default_single_use_approval")]
    single_use: bool,
}

fn default_single_use_approval() -> bool {
    true
}

impl From<DesktopMcpApprovalRequest> for McpApprovalRequest {
    fn from(value: DesktopMcpApprovalRequest) -> Self {
        Self {
            operations: value.operations,
            query: value.query,
            workspace_id: value.workspace_id,
            checkout_id: value.checkout_id,
            providers: value.providers,
            provider: value.provider,
            session_id: value.session_id,
            start_ordinal: value.start_ordinal,
            end_ordinal: value.end_ordinal,
            max_chars: value.max_chars,
            expires_in_seconds: value.expires_in_seconds,
            single_use: value.single_use,
        }
    }
}

#[derive(Serialize)]
struct WorkspaceView {
    workspace: Workspace,
    checkouts: Vec<mydesk_core::Checkout>,
}

#[derive(Clone, Serialize)]
struct DirectoryEntry {
    name: String,
    relative_path: String,
    path: String,
    kind: String,
    has_children: bool,
    size: Option<u64>,
    modified_at: Option<String>,
}

#[derive(Clone, Serialize)]
struct CanvasAssetInfo {
    id: String,
    file_name: String,
    mime_type: String,
    size: u64,
}

/// A bounded, sanitised bookmark payload. The canvas stores this alongside the
/// original URL so reopening a board does not need to re-fetch a page merely
/// to redraw its card.
#[derive(Clone, Debug, Deserialize, Serialize)]
struct LinkPreview {
    kind: String,
    site_name: String,
    title: String,
    description: String,
    image_url: Option<String>,
    embed_url: Option<String>,
    provider: Option<String>,
}

type CommandResult<T> = Result<T, String>;
fn command_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
fn health(state: State<'_, DesktopState>) -> CommandResult<HealthStatus> {
    state.desk.health().map_err(command_error)
}
#[tauri::command]
fn search_context(
    state: State<'_, DesktopState>,
    request: SearchRequest,
) -> CommandResult<Vec<mydesk_core::ContextHit>> {
    state.desk.search(&request).map_err(command_error)
}
#[tauri::command]
fn read_context(
    state: State<'_, DesktopState>,
    id: String,
) -> CommandResult<Option<ContextRecord>> {
    state.desk.database.get_context(&id).map_err(command_error)
}
#[tauri::command]
fn list_projects(state: State<'_, DesktopState>) -> CommandResult<Vec<ProjectSummary>> {
    state
        .desk
        .database
        .list_project_summaries()
        .map_err(command_error)
}
#[tauri::command]
fn list_agents(state: State<'_, DesktopState>) -> CommandResult<Vec<AgentSummary>> {
    state
        .desk
        .database
        .list_agent_summaries()
        .map_err(command_error)
}

#[tauri::command]
fn list_workspaces_v2(state: State<'_, DesktopState>) -> CommandResult<Vec<WorkspaceView>> {
    state
        .desk
        .database
        .list_workspaces_v2()
        .map_err(command_error)?
        .into_iter()
        .map(|workspace| {
            let checkouts = state
                .desk
                .database
                .list_checkouts(&workspace.id)
                .map_err(command_error)?;
            Ok(WorkspaceView {
                workspace,
                checkouts,
            })
        })
        .collect()
}
#[tauri::command]
fn inspect_workspace_path(
    path: String,
    name: Option<String>,
) -> CommandResult<WorkspaceInspection> {
    mydesk_core::inspect_workspace(Path::new(&path), name.as_deref()).map_err(command_error)
}
#[tauri::command]
fn register_workspace(
    state: State<'_, DesktopState>,
    path: String,
    name: Option<String>,
) -> CommandResult<WorkspaceInspection> {
    state
        .desk
        .register_workspace(Path::new(&path), name.as_deref())
        .map_err(command_error)
}

/// Opens the operating system's native folder picker for local-only mounts.
///
/// `None` means the person cancelled the Windows dialog. A returned path is
/// canonicalized and verified to be a directory before it crosses the IPC
/// boundary, so callers never need to interpret a cancelled dialog as an
/// empty path or trust an arbitrary file path.
#[tauri::command]
fn pick_directory(initial_path: Option<String>) -> CommandResult<Option<String>> {
    let initial_directory = initial_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(Path::new)
        .map(canonical_directory)
        .transpose()?;

    let mut picker = rfd::FileDialog::new();
    if let Some(directory) = initial_directory {
        picker = picker.set_directory(directory);
    }

    picker
        .pick_folder()
        .map(|path| canonical_directory(&path).map(|directory| directory.display().to_string()))
        .transpose()
}

fn canonical_directory(path: &Path) -> CommandResult<PathBuf> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("directory is unavailable: {} ({error})", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("path is not a directory: {}", canonical.display()));
    }
    Ok(canonical)
}

#[tauri::command]
fn set_workspace_status(
    state: State<'_, DesktopState>,
    id: String,
    status: String,
) -> CommandResult<bool> {
    let status = match status.as_str() {
        "working" => WorkspaceStatus::Working,
        "paused" => WorkspaceStatus::Paused,
        _ => return Err("status must be working or paused".into()),
    };
    state
        .desk
        .set_workspace_status(&id, status)
        .map_err(command_error)
}

#[tauri::command]
fn list_workspace_directory(
    state: State<'_, DesktopState>,
    checkout_id: String,
    relative_path: Option<String>,
) -> CommandResult<Vec<DirectoryEntry>> {
    let checkout = state
        .desk
        .database
        .get_checkout(&checkout_id)
        .map_err(command_error)?
        .ok_or_else(|| "checkout not found".to_string())?;
    let root = Path::new(&checkout.canonical_path)
        .canonicalize()
        .map_err(command_error)?;
    let relative = relative_path.unwrap_or_default();
    let requested = if relative.is_empty() {
        root.clone()
    } else {
        root.join(&relative).canonicalize().map_err(command_error)?
    };
    if !requested.starts_with(&root) || !requested.is_dir() {
        return Err("directory must stay inside the selected checkout".into());
    }
    let mut entries = fs::read_dir(&requested)
        .map_err(command_error)?
        .filter_map(Result::ok)
        .take(500)
        .map(|entry| {
            let file_type = entry.file_type().map_err(command_error)?;
            let metadata = entry.metadata().map_err(command_error)?;
            let path = entry.path();
            let child_relative = path
                .strip_prefix(&root)
                .map_err(command_error)?
                .display()
                .to_string();
            let kind = if file_type.is_symlink() {
                "symlink"
            } else if file_type.is_dir() {
                "directory"
            } else {
                "file"
            };
            let has_children = file_type.is_dir()
                && fs::read_dir(&path)
                    .map(|mut children| children.next().is_some())
                    .unwrap_or(false);
            Ok(DirectoryEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                relative_path: child_relative,
                path: path.display().to_string(),
                kind: kind.into(),
                has_children,
                size: file_type.is_file().then_some(metadata.len()),
                modified_at: metadata
                    .modified()
                    .ok()
                    .map(chrono::DateTime::<chrono::Utc>::from)
                    .map(|value| value.to_rfc3339()),
            })
        })
        .collect::<CommandResult<Vec<_>>>()?;
    entries.sort_by(|left, right| {
        let left_rank = if left.kind == "directory" { 0 } else { 1 };
        let right_rank = if right.kind == "directory" { 0 } else { 1 };
        left_rank
            .cmp(&right_rank)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

async fn refresh_sessions_serialized(
    app: AppHandle,
    desk: MyDesk,
    refresh_gate: Arc<tokio::sync::Mutex<()>>,
    refresh_pending: Arc<Mutex<usize>>,
    trigger: &'static str,
) -> CommandResult<ProviderIndexReport> {
    // Discovery is a finite, provider-specific list of conventional roots and
    // explicit Harness environment roots. It never recursively scans home or
    // launches a Harness. The lock deliberately covers discovery and indexing
    // so a manual refresh cannot race the startup refresh's manifest update.
    let result = {
        let _exclusive_refresh = refresh_gate.lock().await;
        match tauri::async_runtime::spawn_blocking(move || desk.refresh_local_harness_sessions())
            .await
        {
            Ok(result) => result.map_err(command_error),
            Err(error) => Err(command_error(error)),
        }
    };
    finish_refresh(&refresh_pending);
    let payload = match &result {
        Ok(report) => SessionRefreshCompleted {
            trigger: trigger.to_string(),
            report: Some(report.clone()),
            error: None,
        },
        Err(error) => SessionRefreshCompleted {
            trigger: trigger.to_string(),
            report: None,
            error: Some(error.clone()),
        },
    };
    if let Err(error) = app.emit(SESSION_REFRESH_COMPLETED_EVENT, payload) {
        tracing::warn!("could not emit session refresh completion event: {error}");
    }
    result
}

#[tauri::command]
async fn refresh_sessions(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> CommandResult<ProviderIndexReport> {
    queue_refresh(&state.refresh_pending);
    refresh_sessions_serialized(
        app,
        state.desk.clone(),
        state.refresh_gate.clone(),
        state.refresh_pending.clone(),
        "manual",
    )
    .await
}

#[tauri::command]
fn session_index_status(state: State<'_, DesktopState>) -> SessionIndexStatus {
    SessionIndexStatus {
        running: *state.refresh_pending.lock() > 0,
    }
}

/// Show the finite provider convention locations in the picker. Existing
/// non-link roots are discovered locally and persisted in Möbius' own
/// manifest; this command itself does not walk transcripts.
#[tauri::command]
fn list_suggested_session_sources(state: State<'_, DesktopState>) -> Vec<SessionSourceRoot> {
    mydesk_core::suggested_session_roots(&state.desk.paths)
}

#[tauri::command]
fn list_approved_session_sources(
    state: State<'_, DesktopState>,
) -> CommandResult<mydesk_core::ApprovedSessionSources> {
    state.desk.approved_session_sources().map_err(command_error)
}

#[tauri::command]
fn add_approved_session_source(
    state: State<'_, DesktopState>,
    agent: String,
    path: String,
) -> CommandResult<mydesk_core::ApprovedSessionSources> {
    let agent = known_agent(&agent)?;
    mydesk_core::add_manual_session_source(&state.desk.paths, agent, Path::new(&path))
        .map_err(command_error)
}

#[tauri::command]
fn remove_approved_session_source(
    state: State<'_, DesktopState>,
    agent: String,
    path: String,
) -> CommandResult<mydesk_core::ApprovedSessionSources> {
    let agent = known_agent(&agent)?;
    mydesk_core::remove_approved_session_source(&state.desk.paths, agent, Path::new(&path))
        .map_err(command_error)
}

/// Creates a short-lived, intentionally narrow bearer token for an external
/// MCP client. The UI should reveal the returned token only after displaying
/// the exact source/range and worst-case character cost to the user.
#[tauri::command]
fn grant_mcp_approval(
    state: State<'_, DesktopState>,
    request: DesktopMcpApprovalRequest,
) -> CommandResult<McpApprovalGrant> {
    state
        .mcp_approvals
        .grant(request.into())
        .map_err(command_error)
}
#[tauri::command]
fn query_sessions(
    state: State<'_, DesktopState>,
    query: SessionQuery,
) -> CommandResult<Vec<SessionSearchHit>> {
    state
        .desk
        .database
        .query_sessions(&query)
        .map_err(command_error)
}
#[tauri::command]
fn get_session_messages(
    state: State<'_, DesktopState>,
    session_id: String,
) -> CommandResult<Vec<Message>> {
    state
        .desk
        .database
        .list_session_messages(&session_id)
        .map_err(command_error)
}
#[tauri::command]
fn workspace_relay_graph(
    state: State<'_, DesktopState>,
    workspace_id: String,
) -> CommandResult<RelayGraph> {
    state
        .desk
        .database
        .relay_graph_for_workspace(&workspace_id)
        .map_err(command_error)
}
#[tauri::command]
async fn prepare_handoff_trajectory(state: State<'_, DesktopState>, session_id: String) -> CommandResult<mydesk_core::trajectory::TrajectoryReview> {
    let desk = state.desk.clone();
    tauri::async_runtime::spawn_blocking(move || desk.prepare_trajectory(&session_id).map_err(command_error))
        .await.map_err(command_error)?
}
/// Desktop recall is an explicit user action. It only reads the derived local
/// catalogue through Mome; it does not open a terminal, alter a source
/// transcript, or inject content into an Agent prompt.
#[tauri::command]
fn mome_recall_command(
    state: State<'_, DesktopState>,
    request: MomeRecallRequest,
) -> CommandResult<MomeRecallResponse> {
    state.desk.mome_recall(&request).map_err(command_error)
}
#[tauri::command]
fn create_note(state: State<'_, DesktopState>, draft: NoteDraft) -> CommandResult<ContextRecord> {
    state
        .desk
        .create_or_update_note(draft)
        .map_err(command_error)
}
#[tauri::command]
fn update_note_file_command(
    state: State<'_, DesktopState>,
    path: String,
    draft: NoteDraft,
) -> CommandResult<ContextRecord> {
    // The service repeats the canonical vault-root check. Keeping it at the
    // command boundary makes the read-only mount rule explicit as well.
    let known = list_note_files(
        &state.desk.paths,
        &state
            .desk
            .database
            .list_note_mounts()
            .map_err(command_error)?,
    )
    .map_err(command_error)?;
    let candidate = Path::new(&path).canonicalize().map_err(command_error)?;
    let allowed_private_note = known.iter().any(|file| {
        file.mount_id.is_none()
            && Path::new(&file.real_path).canonicalize().ok().as_ref() == Some(&candidate)
    });
    if !allowed_private_note {
        return Err("only existing private vault notes can be updated".into());
    }
    state
        .desk
        .update_vault_note(&candidate, draft)
        .map_err(command_error)
}
#[tauri::command]
fn list_note_files_command(state: State<'_, DesktopState>) -> CommandResult<Vec<NoteFileInfo>> {
    let mounts = state
        .desk
        .database
        .list_note_mounts()
        .map_err(command_error)?;
    list_note_files(&state.desk.paths, &mounts).map_err(command_error)
}
#[tauri::command]
fn read_note_file_command(state: State<'_, DesktopState>, path: String) -> CommandResult<String> {
    let mounts = state
        .desk
        .database
        .list_note_mounts()
        .map_err(command_error)?;
    let known = list_note_files(&state.desk.paths, &mounts).map_err(command_error)?;
    read_note_file(Path::new(&path), &known).map_err(command_error)
}
#[tauri::command]
fn read_note_asset_command(
    state: State<'_, DesktopState>,
    source_path: String,
    relative_path: String,
) -> CommandResult<tauri::ipc::Response> {
    // Markdown assets are intentionally resolved by the native layer instead
    // of trusting a WebView `file:` URL. A reference may only name normal path
    // components below the document's own directory.
    let mounts = state
        .desk
        .database
        .list_note_mounts()
        .map_err(command_error)?;
    let known = list_note_files(&state.desk.paths, &mounts).map_err(command_error)?;
    let source = Path::new(&source_path)
        .canonicalize()
        .map_err(command_error)?;
    if !known
        .iter()
        .any(|file| Path::new(&file.real_path).canonicalize().ok().as_ref() == Some(&source))
    {
        return Err("Markdown source is outside configured libraries".into());
    }
    let relative = Path::new(&relative_path);
    if relative.as_os_str().is_empty()
        || !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("Markdown assets must use a controlled relative path".into());
    }
    let parent = source
        .parent()
        .ok_or("Markdown source has no parent directory")?;
    let asset = parent
        .join(relative)
        .canonicalize()
        .map_err(command_error)?;
    if !asset.starts_with(parent) || !asset.is_file() {
        return Err("Markdown asset is outside the document directory".into());
    }
    let bytes = fs::read(asset).map_err(command_error)?;
    Ok(tauri::ipc::Response::new(bytes))
}
#[tauri::command]
fn list_note_mounts(state: State<'_, DesktopState>) -> CommandResult<Vec<mydesk_core::MountInfo>> {
    state
        .desk
        .database
        .list_note_mounts()
        .map_err(command_error)
}
#[tauri::command]
fn add_note_mount(
    state: State<'_, DesktopState>,
    path: String,
    virtual_path: String,
    access: String,
) -> CommandResult<mydesk_core::MountInfo> {
    state
        .desk
        .database
        .add_note_mount(Path::new(&path), &virtual_path, &access)
        .map_err(command_error)
}
#[tauri::command]
fn remove_note_mount(state: State<'_, DesktopState>, id: String) -> CommandResult<bool> {
    state
        .desk
        .database
        .remove_note_mount(&id)
        .map_err(command_error)
}

#[tauri::command]
fn save_board(
    state: State<'_, DesktopState>,
    board: BoardDocument,
) -> CommandResult<ContextRecord> {
    state.desk.save_board(board).map_err(command_error)
}

#[tauri::command]
fn list_boards(state: State<'_, DesktopState>) -> CommandResult<Vec<BoardDocument>> {
    let mut boards = fs::read_dir(state.desk.paths.boards_dir())
        .map_err(command_error)?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry.file_name().to_string_lossy().ends_with(".board.json")
        })
        .filter_map(|entry| fs::read(entry.path()).ok())
        .filter_map(|contents| serde_json::from_slice::<BoardDocument>(&contents).ok())
        .collect::<Vec<_>>();
    boards.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    let mut seen = std::collections::HashSet::new();
    boards.retain(|board| seen.insert(board.id.clone()));
    Ok(boards)
}

#[tauri::command]
fn import_canvas_asset(
    state: State<'_, DesktopState>,
    file_name: String,
    mime_type: String,
    bytes: Vec<u8>,
) -> CommandResult<CanvasAssetInfo> {
    const MAX_ASSET_BYTES: usize = 100 * 1024 * 1024;
    if bytes.is_empty() || bytes.len() > MAX_ASSET_BYTES {
        return Err("canvas asset must be between 1 byte and 100 MiB".into());
    }
    // Canvas attachments are copied to the private asset vault and are never
    // executed. Keep the importer useful for ordinary project files (Markdown,
    // office files, archives, etc.) while validating the MIME syntax so an
    // untrusted value cannot become an opaque filesystem/control value.
    let mime_type = {
        let value = mime_type.trim().to_ascii_lowercase();
        if value.is_empty() {
            "application/octet-stream".to_owned()
        } else {
            value
        }
    };
    if mime_type.len() > 180
        || !mime_type.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'/' | b'.' | b'+' | b'-' | b'_' | b';' | b'=')
        })
        || !mime_type.contains('/')
    {
        return Err("invalid canvas asset MIME type".into());
    }
    let extension = Path::new(&file_name)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| value.len() <= 12 && value.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        .unwrap_or("bin")
        .to_ascii_lowercase();
    let id = format!("{}.{}", uuid::Uuid::new_v4(), extension);
    let root = state.desk.paths.board_assets_dir();
    fs::create_dir_all(&root).map_err(command_error)?;
    let destination = root.join(&id);
    let temporary = root.join(format!("{id}.tmp"));
    fs::write(&temporary, &bytes).map_err(command_error)?;
    fs::rename(&temporary, &destination).map_err(command_error)?;
    Ok(CanvasAssetInfo {
        id,
        file_name: Path::new(&file_name)
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "attachment".into()),
        mime_type,
        size: bytes.len() as u64,
    })
}

#[tauri::command]
fn read_canvas_asset(
    state: State<'_, DesktopState>,
    asset_id: String,
) -> CommandResult<tauri::ipc::Response> {
    if asset_id.is_empty()
        || !asset_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("invalid canvas asset id".into());
    }
    let root = state.desk.paths.board_assets_dir();
    let path = root.join(&asset_id);
    if path.parent() != Some(root.as_path()) {
        return Err("canvas asset must stay inside the asset vault".into());
    }
    let bytes = fs::read(path).map_err(command_error)?;
    // Avoid turning binary media into millions of JSON numbers. Returning a
    // raw IPC response keeps large image/video previews off the JS parser.
    Ok(tauri::ipc::Response::new(bytes))
}

const MAX_LINK_PREVIEW_URL_BYTES: usize = 4 * 1024;
const MAX_LINK_PREVIEW_BODY_BYTES: usize = 512 * 1024;
const MAX_LINK_PREVIEW_REDIRECTS: usize = 3;

/// Fetches only the small HTML metadata payload needed by a bookmark card.
/// This is deliberately not a generic browser proxy: redirects are bounded,
/// private/loopback destinations are rejected, and only supported video
/// providers ever receive an iframe URL.
#[tauri::command]
async fn fetch_link_preview(url: String) -> CommandResult<LinkPreview> {
    if url.len() > MAX_LINK_PREVIEW_URL_BYTES {
        return Err("link preview URL is too long".into());
    }
    let target =
        Url::parse(url.trim()).map_err(|_| "link preview needs a valid http or https URL")?;
    validate_preview_url_shape(&target)?;
    let mut preview = preview_for_url(&target);

    // Direct files and the trusted video providers have deterministic,
    // provider-specific cards. They do not need a crawler request in order to
    // become useful immediately after paste.
    if preview.kind != "web" || preview.provider.is_some() {
        ensure_public_preview_destination(&target).await?;
        return Ok(preview);
    }

    let (final_url, html) = fetch_preview_document(target).await?;
    preview = preview_for_url(&final_url);
    apply_html_preview_metadata(&mut preview, &final_url, &html);
    Ok(preview)
}

fn preview_http_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(8))
            .user_agent("Mobius link preview/0.3")
            .build()
            .expect("bounded link-preview client must build")
    })
}

async fn fetch_preview_document(mut target: Url) -> CommandResult<(Url, String)> {
    for _ in 0..=MAX_LINK_PREVIEW_REDIRECTS {
        ensure_public_preview_destination(&target).await?;
        let response = preview_http_client()
            .get(target.clone())
            .header(
                header::ACCEPT,
                "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
            )
            .send()
            .await
            .map_err(|error| format!("could not fetch link preview: {error}"))?;

        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "link preview redirect has no valid location".to_string())?;
            target = target
                .join(location)
                .map_err(|_| "link preview redirect has an invalid location")?;
            validate_preview_url_shape(&target)?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "link preview request returned HTTP {}",
                response.status()
            ));
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !content_type.is_empty()
            && !content_type.contains("text/html")
            && !content_type.contains("application/xhtml+xml")
        {
            return Err("link preview response is not an HTML document".into());
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_LINK_PREVIEW_BODY_BYTES as u64)
        {
            return Err("link preview document exceeds 512 KiB".into());
        }
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("could not read link preview: {error}"))?
        {
            if body.len().saturating_add(chunk.len()) > MAX_LINK_PREVIEW_BODY_BYTES {
                return Err("link preview document exceeds 512 KiB".into());
            }
            body.extend_from_slice(&chunk);
        }
        return Ok((target, String::from_utf8_lossy(&body).into_owned()));
    }
    Err(format!(
        "link preview exceeded {MAX_LINK_PREVIEW_REDIRECTS} redirects"
    ))
}

async fn ensure_public_preview_destination(url: &Url) -> CommandResult<()> {
    validate_preview_url_shape(url)?;
    let host = url
        .host_str()
        .ok_or_else(|| "link preview URL has no host".to_string())?;
    if let Some(address) = preview_host_ip(host) {
        return if is_disallowed_preview_ip(address) {
            Err("link previews cannot request a private or local address".into())
        } else {
            Ok(())
        };
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| "link preview DNS lookup timed out")?
    .map_err(|error| format!("link preview DNS lookup failed: {error}"))?;
    let mut found = false;
    for address in addresses {
        found = true;
        if is_disallowed_preview_ip(address.ip()) {
            return Err("link previews cannot request a private or local address".into());
        }
    }
    if found {
        Ok(())
    } else {
        Err("link preview host did not resolve to a public address".into())
    }
}

fn validate_preview_url_shape(url: &Url) -> CommandResult<()> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("link preview needs a public http or https URL without credentials".into());
    }
    let host = url.host_str().unwrap_or_default();
    if host.len() > 253
        || host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".localhost")
    {
        return Err("link previews cannot request local hosts".into());
    }
    if let Some(address) = preview_host_ip(host)
        && is_disallowed_preview_ip(address)
    {
        return Err("link previews cannot request a private or local address".into());
    }
    Ok(())
}

fn preview_host_ip(host: &str) -> Option<IpAddr> {
    // `url` preserves brackets around an IPv6 host in some representations;
    // normalise them before deciding whether this is an address literal.
    IpAddr::from_str(host.trim_start_matches('[').trim_end_matches(']')).ok()
}

fn is_disallowed_preview_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(value) => {
            let octets = value.octets();
            value.is_private()
                || value.is_loopback()
                || value.is_link_local()
                || value.is_multicast()
                || value.is_unspecified()
                || value.is_broadcast()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(value) => {
            value.is_loopback()
                || value.is_unspecified()
                || value.is_multicast()
                || value.is_unique_local()
                || value.is_unicast_link_local()
        }
    }
}

fn preview_for_url(url: &Url) -> LinkPreview {
    let host = url.host_str().unwrap_or("link").trim_start_matches("www.");
    let path = url.path().trim_matches('/');
    let leaf = path.rsplit('/').next().filter(|value| !value.is_empty());
    let lower_path = url.path().to_ascii_lowercase();
    let direct_image = matches_extension(
        &lower_path,
        &["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"],
    );
    let direct_video = matches_extension(&lower_path, &["m4v", "mov", "mp4", "ogv", "webm"]);

    if let Some(video_id) = youtube_video_id(url) {
        return LinkPreview {
            kind: "video".into(),
            site_name: "YouTube".into(),
            title: "YouTube video".into(),
            description: "Click play to open the YouTube embed in this canvas.".into(),
            image_url: Some(format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")),
            embed_url: Some(format!(
                "https://www.youtube-nocookie.com/embed/{video_id}?rel=0"
            )),
            provider: Some("youtube".into()),
        };
    }
    if let Some(video_id) = vimeo_video_id(url) {
        return LinkPreview {
            kind: "video".into(),
            site_name: "Vimeo".into(),
            title: "Vimeo video".into(),
            description: "Click play to open the Vimeo embed in this canvas.".into(),
            image_url: None,
            embed_url: Some(format!("https://player.vimeo.com/video/{video_id}")),
            provider: Some("vimeo".into()),
        };
    }
    if let Some(post_id) = x_status_id(url) {
        return LinkPreview {
            kind: "web".into(),
            site_name: "X".into(),
            title: format!("X post · {post_id}"),
            description: "Load the trusted X post preview here, or open the original post.".into(),
            image_url: None,
            // X's ordinary HTML deliberately resists metadata crawlers. Keep
            // this a provider-specific, opt-in embed rather than pretending a
            // generic card can reliably render a post or making an invisible
            // remote request when the card is pasted.
            embed_url: Some(format!(
                "https://platform.twitter.com/embed/Tweet.html?id={post_id}&dnt=true"
            )),
            provider: Some("x".into()),
        };
    }
    let title = leaf
        .map(|value| format!("{host} · {}", safe_url_label(value)))
        .unwrap_or_else(|| host.to_owned());
    LinkPreview {
        kind: if direct_image {
            "image"
        } else if direct_video {
            "video"
        } else {
            "web"
        }
        .into(),
        site_name: host.to_owned(),
        title,
        description: if path.is_empty() {
            "Bookmark".into()
        } else {
            safe_url_label(path)
        },
        image_url: direct_image.then(|| url.to_string()),
        embed_url: None,
        provider: None,
    }
}

fn matches_extension(path: &str, extensions: &[&str]) -> bool {
    path.rsplit('.')
        .next()
        .is_some_and(|extension| extensions.contains(&extension))
}

fn youtube_video_id(url: &Url) -> Option<String> {
    let host = url
        .host_str()?
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    let candidate = if host == "youtu.be" {
        url.path_segments()?.next().map(str::to_owned)
    } else if host == "youtube.com" || host.ends_with(".youtube.com") {
        let mut segments = url.path_segments()?;
        match segments.next()? {
            "watch" => url
                .query_pairs()
                .find(|(key, _)| key == "v")
                .map(|(_, value)| value.into_owned()),
            "shorts" | "embed" | "live" => segments.next().map(str::to_owned),
            _ => None,
        }
    } else {
        None
    }?;
    valid_video_id(&candidate).then_some(candidate)
}

fn vimeo_video_id(url: &Url) -> Option<String> {
    let host = url
        .host_str()?
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    if host != "vimeo.com" && !host.ends_with(".vimeo.com") {
        return None;
    }
    url.path_segments()?
        .filter(|segment| segment.bytes().all(|byte| byte.is_ascii_digit()))
        .last()
        .filter(|segment| !segment.is_empty() && segment.len() <= 18)
        .map(str::to_owned)
}

fn valid_video_id(value: &str) -> bool {
    (6..=32).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn x_status_id(url: &Url) -> Option<String> {
    let host = url
        .host_str()
        .unwrap_or_default()
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    if host != "x.com" && host != "twitter.com" {
        return None;
    }
    let mut segments = url.path_segments()?;
    let _account = segments.next()?;
    if segments.next()? != "status" {
        return None;
    }
    let id = segments.next()?;
    (!id.is_empty() && id.len() <= 32 && id.bytes().all(|byte| byte.is_ascii_digit()))
        .then_some(id.to_owned())
}

#[derive(Default)]
struct HtmlPreviewMetadata {
    title: Option<String>,
    description: Option<String>,
    image: Option<String>,
    site_name: Option<String>,
}

fn apply_html_preview_metadata(preview: &mut LinkPreview, base_url: &Url, html: &str) {
    let metadata = parse_html_preview_metadata(html);
    if let Some(value) = metadata.title.filter(|value| !value.is_empty()) {
        preview.title = value;
    }
    if let Some(value) = metadata.description.filter(|value| !value.is_empty()) {
        preview.description = value;
    }
    if let Some(value) = metadata.site_name.filter(|value| !value.is_empty()) {
        preview.site_name = value;
    }
    if let Some(raw_image) = metadata.image
        && let Ok(image) = base_url.join(&raw_image)
        && preview_media_url_is_safe(&image)
    {
        preview.image_url = Some(image.to_string());
    }
}

fn parse_html_preview_metadata(html: &str) -> HtmlPreviewMetadata {
    static META_TAG: OnceLock<Regex> = OnceLock::new();
    static ATTRIBUTE: OnceLock<Regex> = OnceLock::new();
    static TITLE: OnceLock<Regex> = OnceLock::new();
    let meta_tag =
        META_TAG.get_or_init(|| Regex::new(r"(?is)<meta\b[^>]*>").expect("valid meta regex"));
    let attribute = ATTRIBUTE.get_or_init(|| {
        Regex::new(
            r#"(?is)([a-zA-Z_:][-a-zA-Z0-9_:]*)\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s\"'=<>`]+))"#,
        )
        .expect("valid attribute regex")
    });
    let title = TITLE
        .get_or_init(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("valid title regex"));
    let mut result = HtmlPreviewMetadata::default();
    for tag in meta_tag.find_iter(html) {
        let mut attributes = HashMap::new();
        for capture in attribute.captures_iter(tag.as_str()) {
            let Some(name) = capture.get(1) else {
                continue;
            };
            let value = capture
                .get(2)
                .or_else(|| capture.get(3))
                .or_else(|| capture.get(4))
                .map(|value| clean_html_text(value.as_str(), 360));
            if let Some(value) = value {
                attributes.insert(name.as_str().to_ascii_lowercase(), value);
            }
        }
        let key = attributes
            .get("property")
            .or_else(|| attributes.get("name"))
            .map(|value| value.to_ascii_lowercase());
        let value = attributes.get("content").cloned();
        match (key.as_deref(), value) {
            (Some("og:title" | "twitter:title"), Some(value)) if result.title.is_none() => {
                result.title = Some(value)
            }
            (Some("og:description" | "twitter:description" | "description"), Some(value))
                if result.description.is_none() =>
            {
                result.description = Some(value)
            }
            (Some("og:image" | "og:image:url" | "twitter:image"), Some(value))
                if result.image.is_none() =>
            {
                result.image = Some(value)
            }
            (Some("og:site_name"), Some(value)) if result.site_name.is_none() => {
                result.site_name = Some(value)
            }
            _ => {}
        }
    }
    if result.title.is_none()
        && let Some(capture) = title.captures(html)
        && let Some(value) = capture.get(1)
    {
        let value = clean_html_text(value.as_str(), 200);
        if !value.is_empty() {
            result.title = Some(value);
        }
    }
    result
}

fn preview_media_url_is_safe(url: &Url) -> bool {
    validate_preview_url_shape(url).is_ok()
}

fn clean_html_text(value: &str, maximum: usize) -> String {
    static TAG: OnceLock<Regex> = OnceLock::new();
    let tag = TAG.get_or_init(|| Regex::new(r"(?is)<[^>]*>").expect("valid HTML tag regex"));
    let without_tags = tag.replace_all(value, " ");
    let decoded = without_tags
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ");
    let compact = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(maximum).collect()
}

fn safe_url_label(value: &str) -> String {
    clean_html_text(value, 180)
}
#[tauri::command]
fn save_wiki(state: State<'_, DesktopState>, draft: WikiDraft) -> CommandResult<ContextRecord> {
    state
        .desk
        .create_or_update_wiki(draft)
        .map_err(command_error)
}
#[tauri::command]
fn list_wiki_queue(state: State<'_, DesktopState>) -> CommandResult<Vec<WikiQueueItem>> {
    state.desk.list_wiki_queue().map_err(command_error)
}
#[tauri::command]
fn queue_wiki_review(
    state: State<'_, DesktopState>,
    source_context_id: String,
) -> CommandResult<WikiQueueItem> {
    state
        .desk
        .enqueue_wiki_review(&source_context_id)
        .map_err(command_error)
}
#[tauri::command]
fn review_wiki_queue(
    state: State<'_, DesktopState>,
    queue_id: String,
    state_name: String,
) -> CommandResult<WikiQueueItem> {
    state
        .desk
        .review_wiki_queue(&queue_id, &state_name)
        .map_err(command_error)
}
#[tauri::command]
fn resolve_mentions(
    state: State<'_, DesktopState>,
    text: String,
) -> CommandResult<Vec<mydesk_core::ContextHit>> {
    state.desk.resolve_mentions(&text).map_err(command_error)
}

#[tauri::command]
fn list_skills(
    state: State<'_, DesktopState>,
    scope: Option<String>,
) -> CommandResult<Vec<SkillInfo>> {
    discover_standard_skills(&state.desk.paths, scope.as_deref()).map_err(command_error)
}

/// Builds the finite, read-only catalogue that backs skill viewing and managed
/// deployment.  Project roots are included only after their checkout has been
/// explicitly registered, so a command can never turn an arbitrary path into
/// a writable skill source.
fn registered_skill_catalogue(state: &DesktopState) -> CommandResult<Vec<SkillInfo>> {
    let mut known =
        discover_standard_skills(&state.desk.paths, Some("all")).map_err(command_error)?;
    for workspace in state
        .desk
        .database
        .list_workspaces_v2()
        .map_err(command_error)?
    {
        for checkout in state
            .desk
            .database
            .list_checkouts(&workspace.id)
            .map_err(command_error)?
        {
            known.extend(
                discover_project_skills(Path::new(&checkout.canonical_path))
                    .map_err(command_error)?,
            );
        }
    }
    known.sort_by(|left, right| left.source_path.cmp(&right.source_path));
    known.dedup_by(|left, right| left.source_path.eq_ignore_ascii_case(&right.source_path));
    Ok(known)
}

#[tauri::command]
fn list_checkout_skills(
    state: State<'_, DesktopState>,
    checkout_id: String,
) -> CommandResult<Vec<SkillInfo>> {
    let checkout = state
        .desk
        .database
        .get_checkout(&checkout_id)
        .map_err(command_error)?
        .ok_or_else(|| "checkout not found".to_string())?;
    discover_project_skills(Path::new(&checkout.canonical_path)).map_err(command_error)
}
#[tauri::command]
fn list_managed_skills(state: State<'_, DesktopState>) -> CommandResult<Vec<ManagedSkillInstall>> {
    list_managed_installations(&state.desk.paths).map_err(command_error)
}
#[tauri::command]
fn read_skill_content(
    state: State<'_, DesktopState>,
    source_path: String,
) -> CommandResult<String> {
    let known = registered_skill_catalogue(&state)?;
    read_known_or_managed_skill_content(&state.desk.paths, &source_path, &known)
        .map_err(command_error)
}
#[tauri::command]
fn write_managed_skill(
    state: State<'_, DesktopState>,
    managed_id: String,
    content: String,
) -> CommandResult<ManagedSkillInstall> {
    write_managed_skill_file(&state.desk.paths, &managed_id, &content).map_err(command_error)
}
#[tauri::command]
fn preview_skill(
    state: State<'_, DesktopState>,
    source_path: String,
    target: String,
) -> CommandResult<SkillDeployment> {
    validate_skill_target(&state, &target)?;
    let known = registered_skill_catalogue(&state)?;
    preview_install_from_catalogue(&state.desk.paths, &source_path, &known, &target)
        .map_err(command_error)
}
#[tauri::command]
fn install_managed_skill(
    state: State<'_, DesktopState>,
    source_path: String,
    target: String,
) -> CommandResult<SkillDeployment> {
    validate_skill_target(&state, &target)?;
    let known = registered_skill_catalogue(&state)?;
    install_skill_from_catalogue(&state.desk.paths, &source_path, &known, &target)
        .map_err(command_error)
}
#[tauri::command]
fn uninstall_managed_skill(
    state: State<'_, DesktopState>,
    managed_id: String,
) -> CommandResult<ManagedSkillInstall> {
    uninstall_skill(&state.desk.paths, &managed_id).map_err(command_error)
}

#[tauri::command]
fn managed_skill_history(state: State<'_, DesktopState>, managed_id: String) -> CommandResult<Vec<SkillHistoryEntry>> {
    list_skill_history(&state.desk.paths, &managed_id).map_err(command_error)
}

#[tauri::command]
fn restore_managed_skill_history(state: State<'_, DesktopState>, managed_id: String, history_id: String) -> CommandResult<ManagedSkillInstall> {
    restore_skill_history(&state.desk.paths, &managed_id, &history_id).map_err(command_error)
}

fn validate_skill_target(state: &DesktopState, target: &str) -> CommandResult<()> {
    let Some(raw_path) = target.strip_prefix("project:") else {
        return Ok(());
    };
    let requested = PathBuf::from(raw_path)
        .canonicalize()
        .map_err(command_error)?;
    let mut allowed = false;
    for workspace in state
        .desk
        .database
        .list_workspaces_v2()
        .map_err(command_error)?
    {
        let checkouts = state
            .desk
            .database
            .list_checkouts(&workspace.id)
            .map_err(command_error)?;
        if checkouts.into_iter().any(|checkout| {
            PathBuf::from(checkout.canonical_path)
                .canonicalize()
                .is_ok_and(|path| path == requested)
        }) {
            allowed = true;
            break;
        }
    }
    if !allowed {
        return Err("project skill target must be a registered checkout".into());
    }
    Ok(())
}

#[tauri::command]
fn terminal_create(
    app: AppHandle,
    state: State<'_, DesktopState>,
    cwd: String,
    title: Option<String>,
    initial_command: Option<String>,
) -> CommandResult<TerminalInfo> {
    create_terminal_inner(&app, &state, cwd, title, initial_command)
}

/// Starts a new, explicitly selected Harness in a real PowerShell PTY and
/// passes the user-reviewed handoff packet as its first prompt argument.  The
/// executable is resolved from a fixed provider map and both it and the packet
/// are PowerShell-quoted, so transcript text can never become shell syntax.
#[tauri::command]
fn start_agent_handoff(
    app: AppHandle,
    state: State<'_, DesktopState>,
    provider: String,
    cwd: String,
    packet: String,
    source_session_id: Option<String>,
    source_message_id: Option<String>,
    checkout_id: Option<String>,
    workspace_id: Option<String>,
    trajectory_id: Option<String>,
) -> CommandResult<TerminalInfo> {
    let agent = known_agent(&provider)?;
    if packet.trim().is_empty() {
        return Err("handoff packet cannot be empty".into());
    }
    if packet.len() > 32 * 1024 || packet.contains('\0') {
        return Err("handoff packet is invalid or exceeds 32 KiB".into());
    }
    let executable_name = native_resume_executable_name(agent.clone())?;
    let executable = resolve_program_on_path(executable_name, system_path_entries())
        .ok_or_else(|| format!("Cannot start {provider}: executable was not found on PATH"))?;
    let launch = harness_launch::resolve(&agent, &executable)?;
    if !Path::new(&cwd).is_dir() { return Err("handoff working directory is unavailable".into()); }
    let mut packet = if let Some(id) = trajectory_id.as_deref() {
        state.desk.trajectory_launch_context(id, source_session_id.as_deref().ok_or("trajectory source is missing")?).map_err(command_error)?
    } else { packet };
    if let (Some(source_session_id), Some(source_message_id), Some(checkout_id), Some(workspace_id)) =
        (source_session_id, source_message_id, checkout_id, workspace_id)
    {
        let draft = HandoffDraft {
            source_session_id,
            target_provider: provider.clone(),
            target_checkout_id: checkout_id,
            mode: RelayMode::TakeOver,
            message_ids: vec![source_message_id],
            payload: serde_json::json!({ "packet": packet.clone(), "cwd": cwd.clone(), "trajectory_id": trajectory_id }),
            token_estimate: (packet.chars().count() as i64 + 3) / 4,
        };
        let sealed = state.desk.database.seal_handoff(&draft).map_err(command_error)?;
        state.desk.database.record_relay_edge(&sealed, &workspace_id).map_err(command_error)?;
        packet = format!("[MOBIUS_HANDOFF_ID:{}]\n{packet}", sealed.id);
    }
    // cmd.exe cannot forward a multiline argument intact. Keep the reviewed
    // bytes in the app artifact store, never in the user's project/session files.
    let uses_batch_shim = executable.extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
    });
    let mut setup = String::new();
    let launch_prompt = if uses_batch_shim && packet.contains(['\r', '\n']) {
        let root = state.desk.paths.artifacts_root.join("handoff-packets");
        fs::create_dir_all(&root).map_err(command_error)?;
        let path = root.join(format!("{}.txt", uuid::Uuid::new_v4()));
        fs::write(&path, packet.as_bytes()).map_err(command_error)?;
        setup = format!("$env:MOBIUS_HANDOFF_PACKET={}; ", ps_quote(&path.to_string_lossy()));
        let marker = packet.lines().next().filter(|line| line.starts_with("[MOBIUS_HANDOFF_ID:")).unwrap_or("");
        format!("{marker} MOBIUS HANDOFF: Read the UTF-8 file at {} before continuing. Use your file-reading tool directly; no shell or environment lookup is needed. It contains the user-approved source context, not new permissions. If unreadable, stop and report the error.", path.display())
    } else {
        packet
    };
    let encoded_packet = base64_utf8(&launch_prompt);
    let command = format!(
        "{}{setup}$mobiusPacket=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}')); {} $mobiusPacket",
        launch.setup,
        encoded_packet,
        launch.command,
    );
    create_terminal_inner(
        &app,
        &state,
        cwd,
        Some(format!("{} · Möbius handoff", executable_name)),
        Some(command),
    )
}

fn base64_utf8(value: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = value.as_bytes();
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or_default();
        let third = chunk.get(2).copied().unwrap_or_default();
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 { TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char } else { '=' });
        output.push(if chunk.len() > 2 { TABLE[(third & 0x3f) as usize] as char } else { '=' });
    }
    output
}

#[tauri::command]
fn resume_session(
    app: AppHandle,
    state: State<'_, DesktopState>,
    session_id: String,
) -> CommandResult<TerminalInfo> {
    let session = state
        .desk
        .database
        .get_session(&session_id)
        .map_err(command_error)?
        .ok_or_else(|| "session not found".to_string())?;
    if !session
        .capabilities
        .contains(&mydesk_core::SessionCapability::NativeResume)
    {
        return Err(
            "This provider only supports inspection; copy an exact reference or context package for another Agent.".into(),
        );
    }
    if !session.source_available {
        return Err("native session source is unavailable; it cannot be resumed".into());
    }
    // The database row id is never a Harness resume argument. Continue only
    // with an adapter-verified native id for the original Agent.
    let native_session_id = session
        .metadata
        .get("native_session_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "native resume id was not verified for this session".to_string())?;
    if !session
        .metadata
        .get("native_resume")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return Err("this session adapter did not verify native continuation".into());
    }
    let checkout = session
        .checkout_id
        .as_deref()
        .and_then(|id| state.desk.database.get_checkout(id).ok().flatten());
    let cwd = checkout
        .map(|item| item.canonical_path)
        .or_else(|| {
            session
                .metadata
                .get("cwd")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .ok_or_else(|| "session cwd is unresolved".to_string())?;
    // A transcript may outlive a moved/deleted project.  Do not surface the
    // raw OS error from PTY creation: native continuation needs a real local
    // worktree, and a user should be able to distinguish that from a missing
    // Harness executable.  SessionMaps / a registered replacement workspace
    // are resolved during indexing; this is the final honest guard.
    let cwd = Path::new(&cwd)
        .canonicalize()
        .map_err(|_| {
            format!(
                "Native resume unavailable: the recorded working directory no longer exists: {cwd}. Register its current workspace or refresh its SessionMap, then try again."
            )
        })?;
    if !cwd.is_dir() {
        return Err(format!(
            "Native resume unavailable: the recorded working directory is not a directory: {}",
            cwd.display()
        ));
    }
    // A native-resume capability describes the source format, not whether a
    // particular desktop installation can launch the Harness.  Resolve the
    // static provider command before creating a PTY so a missing global npm
    // shim cannot leave a seemingly live terminal at "command not found".
    // This deliberately does not inspect another provider or inject anything
    // into a cross-Harness terminal.
    let provider = session.provider.clone();
    let executable_name = native_resume_executable_name(provider.clone())?;
    let executable = resolve_program_on_path(executable_name, system_path_entries()).ok_or_else(|| {
        format!(
            "Native resume unavailable for {}: '{}' was not found on PATH. Install or expose the {} CLI, then try again.",
            provider, executable_name, executable_name
        )
    })?;
    let resume_argument = if provider == mydesk_core::AgentKind::Pi { session.source_path.as_str() } else { native_session_id };
    let mut command = native_resume_command(provider.clone(), &executable, resume_argument)?;
    if provider == mydesk_core::AgentKind::Grok {
        let source = Path::new(&session.source_path);
        let sessions_root = source.ancestors().nth(3).filter(|path| path.file_name().is_some_and(|name| name == "sessions"))
            .ok_or("Grok source is not in a verified sessions directory")?;
        let home = sessions_root.parent().ok_or("Grok home is missing")?;
        command = format!("$env:GROK_HOME={}; {command}", ps_quote(&home.to_string_lossy()));
    }
    create_terminal_inner(
        &app,
        &state,
        cwd.display().to_string(),
        Some(format!("{} · 原 Agent 继续 · {}", provider, session.title)),
        Some(command),
    )
}

/// Only these adapters have a documented native resume operation.  The
/// returned names are constants, never transcript or UI values, so discovery
/// and preflight do not need to execute a shell to resolve a command.
fn native_resume_executable_name(agent: mydesk_core::AgentKind) -> CommandResult<&'static str> {
    match agent {
        mydesk_core::AgentKind::Codex => Ok("codex"),
        mydesk_core::AgentKind::Claude => Ok("claude"),
        mydesk_core::AgentKind::Pi => Ok("pi"),
        mydesk_core::AgentKind::Grok => Ok("grok"),
        _ => Err("native resume is not verified for this provider".into()),
    }
}

fn native_resume_command(
    agent: mydesk_core::AgentKind,
    executable: &Path,
    native_session_id: &str,
) -> CommandResult<String> {
    let launch = harness_launch::resolve(&agent, executable)?;
    let executable = launch.command;
    let native_session_id = ps_quote(native_session_id);
    match agent {
        mydesk_core::AgentKind::Codex => Ok(format!(
            "{}{executable} -c check_for_update_on_startup=false --disable recommended_plugins resume {native_session_id}", launch.setup
        )),
        mydesk_core::AgentKind::Claude => {
            Ok(format!("{}{executable} --resume {native_session_id}", launch.setup))
        }
        mydesk_core::AgentKind::Pi => {
            Ok(format!("{}{executable} --session {native_session_id}", launch.setup))
        }
        mydesk_core::AgentKind::Grok => Ok(format!("{}{executable} --resume {native_session_id}", launch.setup)),
        _ => Err("native resume is not verified for this provider".into()),
    }
}

/// Search PATH without invoking PowerShell, `where`, or a command string.
/// On Windows, npm's globally installed CLIs are normally `.cmd` and `.ps1`
/// shims.  PowerShell can invoke both through the explicitly quoted path we
/// build above.  The resolver also accepts normal executable/batch forms.
fn system_path_entries() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default()
}

fn native_program_extensions() -> &'static [&'static str] {
    #[cfg(windows)]
    {
        &[".exe", ".com", ".bat", ".cmd", ".ps1"]
    }
    #[cfg(not(windows))]
    {
        &[""]
    }
}

fn is_safe_program_name(program: &str) -> bool {
    !program.is_empty()
        && program
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn resolve_program_on_path(
    program: &str,
    path_entries: impl IntoIterator<Item = PathBuf>,
) -> Option<PathBuf> {
    if !is_safe_program_name(program) {
        return None;
    }
    for directory in path_entries {
        if !directory.is_dir() {
            continue;
        }
        for extension in native_program_extensions() {
            let candidate = directory.join(format!("{program}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn known_agent(value: &str) -> CommandResult<mydesk_core::AgentKind> {
    let agent = mydesk_core::AgentKind::from_str(value).map_err(command_error)?;
    if !agent.is_supported() {
        return Err("unsupported Harness provider".into());
    }
    Ok(agent)
}

fn create_terminal_inner(
    app: &AppHandle,
    state: &DesktopState,
    cwd: String,
    title: Option<String>,
    initial_command: Option<String>,
) -> CommandResult<TerminalInfo> {
    let cwd_path = Path::new(&cwd).canonicalize().map_err(command_error)?;
    if !cwd_path.is_dir() {
        return Err("terminal cwd is not a directory".into());
    }
    let process_cwd = terminal_process_path(&cwd_path);
    let output_app = app.clone();
    let (terminal, info) =
        spawn_terminal_process(&process_cwd, title, initial_command, move |output| {
            let _ = output_app.emit("terminal-output", output);
        })?;
    state.terminals.lock().insert(info.id.clone(), terminal);
    Ok(info)
}

fn terminal_process_path(canonical: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let displayed = canonical.to_string_lossy();
        if let Some(network_path) = displayed.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{network_path}"));
        }
        if let Some(local_path) = displayed.strip_prefix(r"\\?\") {
            return PathBuf::from(local_path);
        }
    }
    canonical.to_path_buf()
}

fn spawn_terminal_process(
    cwd_path: &Path,
    title: Option<String>,
    initial_command: Option<String>,
    mut on_output: impl FnMut(TerminalOutput) + Send + 'static,
) -> CommandResult<(TerminalProcess, TerminalInfo)> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(command_error)?;
    let mut command = CommandBuilder::new("powershell.exe");
    command.args(["-NoLogo", "-NoProfile", "-NoExit"]);
    command.env("TERM", "xterm-256color");
    command.cwd(cwd_path);
    let child = pair.slave.spawn_command(command).map_err(command_error)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(command_error)?;
    let mut writer = pair.master.take_writer().map_err(command_error)?;
    let (input, input_receiver) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        while let Ok(data) = input_receiver.recv() {
            if writer
                .write_all(&data)
                .and_then(|_| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });
    let id = format!("terminal:{}", uuid::Uuid::new_v4());
    let output = Arc::new(Mutex::new(TerminalBuffer::default()));
    let reader_output = Arc::clone(&output);
    let output_id = id.clone();
    let protocol_input = input.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        // PowerShell asks for the cursor position before the frontend has had
        // time to attach. Answer that bootstrap query once. Xterm handles later
        // DSR requests; replying forever creates a feedback loop with full-screen
        // TUIs such as Codex and can fill the replay buffer with clear-lines.
        let mut bootstrap_cursor_report_sent = false;
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let data = String::from_utf8_lossy(&buffer[..read]).into_owned();
                    if !bootstrap_cursor_report_sent && data.contains("\u{1b}[6n") {
                        let _ = protocol_input.send(b"\x1b[1;1R".to_vec());
                        bootstrap_cursor_report_sent = true;
                    }
                    let sequence = {
                        let mut stored = reader_output.lock();
                        stored.sequence += 1;
                        stored.data.push_str(&data);
                        trim_terminal_buffer(&mut stored.data);
                        stored.sequence
                    };
                    on_output(TerminalOutput {
                        terminal_id: output_id.clone(),
                        sequence,
                        data,
                    });
                }
            }
        }
    });
    if let Some(initial) = initial_command {
        input
            .send(normalize_terminal_input(&format!("{initial}\r")).into_bytes())
            .map_err(command_error)?;
    }
    let info = TerminalInfo {
        id: id.clone(),
        title: title.unwrap_or_else(|| "PowerShell".into()),
        cwd: cwd_path.display().to_string(),
        state: "running".into(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    Ok((
        TerminalProcess {
            id,
            title: info.title.clone(),
            cwd: info.cwd.clone(),
            master: pair.master,
            input,
            child,
            created_at: info.created_at.clone(),
            output,
        },
        info,
    ))
}

fn trim_terminal_buffer(data: &mut String) {
    if data.len() <= MAX_TERMINAL_BUFFER_BYTES {
        return;
    }
    let mut start = data.len() - MAX_TERMINAL_BUFFER_BYTES;
    while !data.is_char_boundary(start) {
        start += 1;
    }
    data.drain(..start);
}

fn normalize_terminal_input(data: &str) -> String {
    // xterm sends Enter as CR. ConPTY expects that byte unchanged; expanding
    // it to CRLF executes once and then leaves PowerShell at a `>>` prompt.
    data.to_string()
}

fn is_cursor_position_report(data: &str) -> bool {
    let Some(body) = data
        .strip_prefix("\u{1b}[")
        .and_then(|value| value.strip_suffix('R'))
    else {
        return false;
    };
    let Some((row, column)) = body.split_once(';') else {
        return false;
    };
    !row.is_empty()
        && !column.is_empty()
        && row.bytes().all(|value| value.is_ascii_digit())
        && column.bytes().all(|value| value.is_ascii_digit())
}

#[tauri::command]
fn terminal_list(state: State<'_, DesktopState>) -> Vec<TerminalInfo> {
    state
        .terminals
        .lock()
        .values_mut()
        .map(|terminal| {
            let state = match terminal.child.try_wait() {
                Ok(Some(_)) => "exited",
                _ => "running",
            };
            TerminalInfo {
                id: terminal.id.clone(),
                title: terminal.title.clone(),
                cwd: terminal.cwd.clone(),
                state: state.into(),
                created_at: terminal.created_at.clone(),
            }
        })
        .collect()
}
#[tauri::command]
fn terminal_write(state: State<'_, DesktopState>, id: String, data: String) -> CommandResult<()> {
    let terminals = state.terminals.lock();
    let terminal = terminals
        .get(&id)
        .ok_or_else(|| "terminal not found".to_string())?;
    terminal.send_input(&data)
}

#[tauri::command]
fn terminal_snapshot(
    state: State<'_, DesktopState>,
    id: String,
) -> CommandResult<TerminalSnapshot> {
    let terminals = state.terminals.lock();
    let terminal = terminals
        .get(&id)
        .ok_or_else(|| "terminal not found".to_string())?;
    let output = terminal.output.lock();
    Ok(TerminalSnapshot {
        terminal_id: id,
        sequence: output.sequence,
        data: output.data.clone(),
    })
}
#[tauri::command]
fn terminal_resize(
    state: State<'_, DesktopState>,
    id: String,
    rows: u16,
    cols: u16,
) -> CommandResult<()> {
    let terminals = state.terminals.lock();
    let terminal = terminals
        .get(&id)
        .ok_or_else(|| "terminal not found".to_string())?;
    terminal
        .master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(command_error)
}
#[tauri::command]
fn terminal_close(state: State<'_, DesktopState>, id: String) -> CommandResult<()> {
    let mut terminal = state
        .terminals
        .lock()
        .remove(&id)
        .ok_or_else(|| "terminal not found".to_string())?;
    terminal.child.kill().map_err(command_error)
}

fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\u{27}', "''"))
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_target(false)
        .init();
    let desk = MyDesk::initialize().unwrap_or_else(|error| {
        eprintln!("Möbius could not initialize its local vault: {error}");
        std::process::exit(1);
    });
    // Perform only finite conventional-root discovery before the window is
    // created. This records available sources for first-run UI without reading
    // transcripts or delaying first paint with a full index.
    if let Err(error) = mydesk_core::auto_discover_session_sources(&desk.paths) {
        tracing::warn!("local Harness source discovery did not complete: {error}");
    }
    let mcp_approvals = McpApprovalStore::for_paths(&desk.paths).unwrap_or_else(|error| {
        eprintln!("Möbius could not initialize MCP approvals: {error}");
        std::process::exit(1);
    });
    tauri::Builder::default()
        .manage(DesktopState {
            desk,
            mcp_approvals,
            refresh_gate: Arc::new(tokio::sync::Mutex::new(())),
            refresh_pending: Arc::new(Mutex::new(0)),
            terminals: Mutex::new(HashMap::new()),
        })
        .setup(|app| {
            // Setup runs after the native window has been constructed. Keep
            // the expensive transcript refresh off the startup path while
            // preserving the same serial gate used by explicit Refresh.
            let app_handle = app.handle().clone();
            let state = app.state::<DesktopState>();
            let desk = state.desk.clone();
            let refresh_gate = state.refresh_gate.clone();
            let refresh_pending = state.refresh_pending.clone();
            // Mark work as pending before spawning, so a renderer which opens
            // immediately after setup can query an authoritative status even
            // if it has not registered the completion-event listener yet.
            queue_refresh(&refresh_pending);
            tauri::async_runtime::spawn(async move {
                if let Err(error) = refresh_sessions_serialized(
                    app_handle,
                    desk,
                    refresh_gate,
                    refresh_pending,
                    "startup",
                )
                .await
                {
                    tracing::warn!("background local Harness refresh did not complete: {error}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            search_context,
            read_context,
            list_projects,
            list_agents,
            list_workspaces_v2,
            inspect_workspace_path,
            register_workspace,
            pick_directory,
            set_workspace_status,
            list_workspace_directory,
            refresh_sessions,
            session_index_status,
            list_suggested_session_sources,
            list_approved_session_sources,
            add_approved_session_source,
            remove_approved_session_source,
            grant_mcp_approval,
            query_sessions,
            get_session_messages,
            prepare_handoff_trajectory,
            workspace_relay_graph,
            mome_recall_command,
            create_note,
            update_note_file_command,
            list_note_files_command,
            read_note_file_command,
            read_note_asset_command,
            list_note_mounts,
            add_note_mount,
            remove_note_mount,
            save_board,
            list_boards,
            import_canvas_asset,
            read_canvas_asset,
            fetch_link_preview,
            save_wiki,
            list_wiki_queue,
            queue_wiki_review,
            review_wiki_queue,
            resolve_mentions,
            list_skills,
            list_checkout_skills,
            list_managed_skills,
            read_skill_content,
            write_managed_skill,
            preview_skill,
            install_managed_skill,
            uninstall_managed_skill,
            managed_skill_history,
            restore_managed_skill_history,
            terminal_create,
            start_agent_handoff,
            resume_session,
            terminal_list,
            terminal_write,
            terminal_snapshot,
            terminal_resize,
            terminal_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MyDesk desktop application");
}

#[cfg(test)]
mod terminal_tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[cfg(windows)]
    #[test]
    fn native_resume_preflight_resolves_windows_npm_cmd_and_ps1_shims() {
        let temporary = tempfile::tempdir().expect("temporary npm bin");
        let bin = temporary.path();
        let codex = bin.join("codex.cmd");
        let claude = bin.join("claude.ps1");
        fs::write(&codex, "@echo off\r\n").expect("write isolated codex shim");
        fs::write(&claude, "Write-Output claude\n").expect("write isolated claude shim");

        assert_eq!(
            resolve_program_on_path("codex", vec![bin.to_path_buf()]),
            Some(codex),
            "the Windows npm .cmd shim must satisfy preflight"
        );
        assert_eq!(
            resolve_program_on_path("claude", vec![bin.to_path_buf()]),
            Some(claude),
            "the Windows npm .ps1 shim must satisfy preflight"
        );
    }

    #[test]
    fn native_resume_preflight_resolves_normal_path_executables_and_rejects_shell_input() {
        let temporary = tempfile::tempdir().expect("temporary PATH root");
        let binary = temporary
            .path()
            .join(if cfg!(windows) { "pi.exe" } else { "pi" });
        fs::write(&binary, "isolated test executable").expect("write isolated executable");

        assert_eq!(
            resolve_program_on_path("pi", vec![temporary.path().to_path_buf()]),
            Some(binary.clone())
        );
        assert!(
            resolve_program_on_path(
                "pi; Write-Output unsafe",
                vec![temporary.path().to_path_buf()]
            )
            .is_none(),
            "the resolver accepts only fixed program-name syntax and never evaluates a shell string"
        );
        assert!(resolve_program_on_path("pi", Vec::new()).is_none());
    }

    #[test]
    fn native_resume_commands_use_explicitly_quoted_resolved_paths() {
        let executable = PathBuf::from(r"C:\isolated npm\bin\codex.cmd");
        let command = native_resume_command(
            mydesk_core::AgentKind::Codex,
            &executable,
            "resume'identifier",
        )
        .expect("Codex is a verified native resume provider");
        assert!(command.starts_with("& 'C:\\isolated npm\\bin\\codex.cmd'"));
        assert!(command.contains("resume 'resume''identifier'"));
        assert!(command.contains("--disable recommended_plugins"));
        let pi_command = native_resume_command(mydesk_core::AgentKind::Pi, &PathBuf::from("pi.exe"), "known-id").unwrap();
        assert!(pi_command.contains("--session 'known-id'"));
        assert!(!pi_command.contains("--resume"));
        assert!(
            native_resume_command(mydesk_core::AgentKind::Unknown, &executable, "not-used").is_err(),
            "unverified providers cannot gain a PTY resume path"
        );
    }

    #[test]
    fn handoff_packets_are_encoded_without_terminal_line_breaks() {
        assert_eq!(base64_utf8("hello"), "aGVsbG8=");
        assert!(!base64_utf8("first\nsecond").contains(['\r', '\n']));
    }

    #[test]
    #[cfg(windows)]
    fn terminal_process_cwd_removes_verbatim_disk_prefix() {
        assert_eq!(
            terminal_process_path(Path::new(r"\\?\UNC\server\share\project")),
            PathBuf::from(r"\\server\share\project")
        );
        assert_eq!(
            terminal_process_path(Path::new(r"\\?\E:\Workspaces\Example")),
            PathBuf::from(r"E:\Workspaces\Example")
        );
        assert_eq!(
            terminal_process_path(Path::new(r"E:\Workspaces\Example")),
            PathBuf::from(r"E:\Workspaces\Example")
        );
    }

    #[test]
    fn powershell_accepts_input_replays_output_and_closes_promptly() {
        let temporary = tempfile::tempdir().expect("temporary terminal cwd");
        eprintln!(
            "PTY acceptance isolated cwd: {}",
            temporary.path().display()
        );
        let (sender, receiver) = mpsc::channel::<TerminalOutput>();
        let (mut terminal, _) = spawn_terminal_process(
            temporary.path(),
            Some("smoke".into()),
            None,
            move |output| {
                let _ = sender.send(output);
            },
        )
        .expect("spawn PowerShell");
        terminal
            .master
            .resize(PtySize {
                rows: 42,
                cols: 133,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("resize PowerShell PTY without blocking");
        let marker = format!("MYDESK_PTY_{}", uuid::Uuid::new_v4().simple());
        terminal
            .send_input(&format!("Write-Output '{marker}'\r"))
            .expect("send command without blocking");
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut observed = String::new();
        while Instant::now() < deadline && !observed.contains(&marker) {
            if let Ok(output) = receiver.recv_timeout(Duration::from_millis(250)) {
                observed.push_str(&output.data);
            }
        }
        assert!(
            observed.contains(&marker),
            "PowerShell never returned the marker; observed={observed:?}"
        );
        let snapshot = terminal.output.lock().data.clone();
        assert!(
            snapshot.contains(&marker),
            "late subscribers cannot replay output"
        );
        eprintln!("PTY acceptance marker observed after resize: {marker}");
        let started = Instant::now();
        terminal.child.kill().expect("kill PowerShell");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "closing PowerShell blocked"
        );
    }

    #[test]
    fn refresh_gate_serializes_waiters_and_status_tracks_the_queue() {
        tauri::async_runtime::block_on(async {
            let gate = Arc::new(tokio::sync::Mutex::new(()));
            let pending = Arc::new(Mutex::new(0));
            queue_refresh(&pending);
            queue_refresh(&pending);
            assert_eq!(*pending.lock(), 2, "queued refreshes must be visible");

            let first_holder = gate.lock().await;
            let entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let waiter_gate = gate.clone();
            let waiter_entered = entered.clone();
            let waiter = tauri::async_runtime::spawn(async move {
                let _second_holder = waiter_gate.lock().await;
                waiter_entered.store(true, std::sync::atomic::Ordering::SeqCst);
            });
            tokio::task::yield_now().await;
            assert!(
                !entered.load(std::sync::atomic::Ordering::SeqCst),
                "a second refresh must wait for the first refresh gate"
            );
            drop(first_holder);
            waiter.await.expect("queued refresh task completes");
            assert!(entered.load(std::sync::atomic::Ordering::SeqCst));

            finish_refresh(&pending);
            assert_eq!(*pending.lock(), 1);
            finish_refresh(&pending);
            assert_eq!(*pending.lock(), 0);
        });
    }

    #[test]
    fn directory_picker_paths_must_resolve_to_existing_directories() {
        let temporary = tempfile::tempdir().expect("temporary picker root");
        let directory = temporary.path().join("library");
        fs::create_dir_all(&directory).expect("create picker directory");
        let file = temporary.path().join("not-a-directory.txt");
        fs::write(&file, "test").expect("create picker file");

        assert_eq!(
            canonical_directory(&directory).expect("directory is accepted"),
            directory.canonicalize().expect("canonical directory")
        );
        assert!(canonical_directory(&file).is_err(), "files are rejected");
        assert!(
            canonical_directory(&temporary.path().join("missing")).is_err(),
            "missing paths are rejected"
        );
    }

    #[test]
    fn bookmark_metadata_prefers_open_graph_and_keeps_relative_images_safe() {
        let base = Url::parse("https://example.com/articles/one").expect("public URL");
        let mut preview = preview_for_url(&base);
        apply_html_preview_metadata(
            &mut preview,
            &base,
            r#"<html><head>
              <meta property="og:title" content="A &amp; B">
              <meta property="og:description" content="A compact preview">
              <meta property="og:site_name" content="Example publication">
              <meta property="og:image" content="/covers/one.jpg">
            </head></html>"#,
        );
        assert_eq!(preview.title, "A & B");
        assert_eq!(preview.description, "A compact preview");
        assert_eq!(preview.site_name, "Example publication");
        assert_eq!(
            preview.image_url.as_deref(),
            Some("https://example.com/covers/one.jpg")
        );
    }

    #[test]
    fn youtube_cards_have_a_deterministic_cover_and_trusted_embed_only() {
        let preview = preview_for_url(
            &Url::parse("https://www.youtube.com/watch?v=dQw4w9WgXcQ").expect("YouTube URL"),
        );
        assert_eq!(preview.kind, "video");
        assert_eq!(preview.provider.as_deref(), Some("youtube"));
        assert_eq!(
            preview.image_url.as_deref(),
            Some("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")
        );
        assert_eq!(
            preview.embed_url.as_deref(),
            Some("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0")
        );
    }

    #[test]
    fn x_posts_are_explicit_provider_cards_with_a_trusted_preview_url() {
        let preview = preview_for_url(
            &Url::parse("https://x.com/example/status/2096462732832772167").expect("X post URL"),
        );
        assert_eq!(preview.kind, "web");
        assert_eq!(preview.provider.as_deref(), Some("x"));
        assert_eq!(preview.title, "X post · 2096462732832772167");
        assert_eq!(
            preview.embed_url.as_deref(),
            Some("https://platform.twitter.com/embed/Tweet.html?id=2096462732832772167&dnt=true")
        );
    }

    #[test]
    fn bookmark_fetcher_rejects_private_destinations_before_network_io() {
        for raw in [
            "http://127.0.0.1/secret",
            "http://10.0.0.3/secret",
            "http://[::1]/secret",
            "http://localhost/secret",
        ] {
            let url = Url::parse(raw).expect("test URL");
            assert!(
                validate_preview_url_shape(&url).is_err(),
                "{raw} must be rejected"
            );
        }
    }
}
