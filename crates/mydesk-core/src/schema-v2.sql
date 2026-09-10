CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    canonical_path TEXT NOT NULL UNIQUE,
    git_identity TEXT,
    user_status TEXT NOT NULL CHECK(user_status IN ('working', 'paused')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workspaces_status_idx ON workspaces(user_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS checkouts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('main', 'worktree', 'directory')),
    canonical_path TEXT NOT NULL UNIQUE,
    branch TEXT,
    head TEXT,
    git_common_dir TEXT,
    dirty INTEGER NOT NULL DEFAULT 0,
    ahead INTEGER NOT NULL DEFAULT 0,
    behind INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS checkouts_workspace_idx ON checkouts(workspace_id, kind, canonical_path);

CREATE TABLE IF NOT EXISTS path_mappings (
    id TEXT PRIMARY KEY,
    old_path TEXT NOT NULL,
    new_path TEXT NOT NULL,
    source_path TEXT NOT NULL,
    status TEXT,
    discovered_at TEXT NOT NULL,
    UNIQUE(old_path, new_path, source_path)
);
CREATE INDEX IF NOT EXISTS path_mappings_old_idx ON path_mappings(old_path);

CREATE TABLE IF NOT EXISTS provider_sources (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    root_path TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'read_only',
    cursor_json TEXT NOT NULL DEFAULT '{}',
    health TEXT NOT NULL DEFAULT 'unknown',
    last_error TEXT,
    last_scanned_at TEXT,
    UNIQUE(provider, root_path)
);

CREATE TABLE IF NOT EXISTS source_files (
    id TEXT PRIMARY KEY,
    provider_source_id TEXT NOT NULL REFERENCES provider_sources(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    modified_millis INTEGER,
    fingerprint TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    UNIQUE(provider_source_id, path)
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_session_id TEXT NOT NULL,
    checkout_id TEXT REFERENCES checkouts(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'unknown',
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    source_path TEXT NOT NULL,
    source_available INTEGER NOT NULL DEFAULT 1,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS sessions_checkout_idx ON sessions(checkout_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS sessions_provider_idx ON sessions(provider, updated_at DESC);
CREATE INDEX IF NOT EXISTS sessions_source_path_idx ON sessions(source_path);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    timestamp TEXT,
    source_locator_json TEXT NOT NULL DEFAULT '{}',
    redacted INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_id, ordinal)
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id, ordinal);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts_word USING fts5(
    message_id UNINDEXED,
    session_id UNINDEXED,
    content,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts_trigram USING fts5(
    message_id UNINDEXED,
    session_id UNINDEXED,
    content,
    tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    path TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS artifacts_session_idx ON artifacts(session_id, message_id);

CREATE TABLE IF NOT EXISTS relay_chains (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    checkout_id TEXT REFERENCES checkouts(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handoff_packages (
    id TEXT PRIMARY KEY,
    source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    target_provider TEXT NOT NULL,
    target_checkout_id TEXT NOT NULL REFERENCES checkouts(id) ON DELETE RESTRICT,
    mode TEXT NOT NULL CHECK(mode IN ('take_over', 'parallel')),
    payload_json TEXT NOT NULL,
    token_estimate INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS handoff_packages_immutable
BEFORE UPDATE ON handoff_packages
BEGIN
    SELECT RAISE(ABORT, 'handoff packages are immutable');
END;

CREATE TABLE IF NOT EXISTS handoff_sources (
    handoff_id TEXT NOT NULL REFERENCES handoff_packages(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT,
    artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL,
    PRIMARY KEY(handoff_id, position),
    CHECK(message_id IS NOT NULL OR artifact_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS relay_edges (
    id TEXT PRIMARY KEY,
    chain_id TEXT NOT NULL REFERENCES relay_chains(id) ON DELETE CASCADE,
    source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    target_session_id TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
    handoff_id TEXT NOT NULL UNIQUE REFERENCES handoff_packages(id) ON DELETE RESTRICT,
    relation TEXT NOT NULL CHECK(relation IN ('take_over', 'parallel')),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_edges_chain_idx ON relay_edges(chain_id, created_at);

CREATE TABLE IF NOT EXISTS terminals (
    id TEXT PRIMARY KEY,
    checkout_id TEXT NOT NULL REFERENCES checkouts(id) ON DELETE RESTRICT,
    shell TEXT NOT NULL,
    state TEXT NOT NULL,
    daemon_pid INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terminal_bindings (
    terminal_id TEXT PRIMARY KEY REFERENCES terminals(id) ON DELETE CASCADE,
    provider TEXT,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    task_id TEXT,
    bound_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terminal_snapshots (
    id TEXT PRIMARY KEY,
    terminal_id TEXT NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    byte_count INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    checkout_id TEXT REFERENCES checkouts(id) ON DELETE SET NULL,
    state TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_sessions (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    PRIMARY KEY(task_id, session_id)
);

CREATE TABLE IF NOT EXISTS note_libraries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mounts (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES note_libraries(id) ON DELETE CASCADE,
    virtual_path TEXT NOT NULL,
    real_path TEXT NOT NULL,
    access TEXT NOT NULL CHECK(access IN ('read_only', 'read_write')),
    watcher_mode TEXT NOT NULL CHECK(watcher_mode IN ('auto', 'native', 'poll')),
    include_json TEXT NOT NULL DEFAULT '[]',
    ignore_json TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'connected',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(library_id, virtual_path)
);

CREATE TABLE IF NOT EXISTS mounted_files (
    mount_id TEXT NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
    virtual_path TEXT NOT NULL,
    real_path TEXT NOT NULL,
    fingerprint TEXT,
    indexed_at TEXT,
    PRIMARY KEY(mount_id, virtual_path)
);

CREATE TABLE IF NOT EXISTS skill_sources (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    root_path TEXT NOT NULL,
    name TEXT NOT NULL,
    source_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    discovered_at TEXT NOT NULL,
    UNIQUE(scope, source_path)
);

CREATE TABLE IF NOT EXISTS skill_effective_state (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    checkout_id TEXT REFERENCES checkouts(id) ON DELETE CASCADE,
    skill_name TEXT NOT NULL,
    source_id TEXT REFERENCES skill_sources(id) ON DELETE SET NULL,
    state TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    computed_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, checkout_id, skill_name)
);

CREATE TABLE IF NOT EXISTS index_jobs (
    id TEXT PRIMARY KEY,
    provider_source_id TEXT REFERENCES provider_sources(id) ON DELETE SET NULL,
    state TEXT NOT NULL,
    discovered INTEGER NOT NULL DEFAULT 0,
    indexed INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
