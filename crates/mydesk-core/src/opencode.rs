//! Read-only OpenCode session adapter.
//!
//! OpenCode v1.2+ stores sessions in `opencode.db` (SQLite, WAL). Möbius never
//! writes that database. Each native session is catalogued with a locator
//! `{db_path}#opencode:{session_id}` so byte-range reads cannot leak other
//! sessions from the same file.

use crate::{MessageRole, sources::SourceFingerprint};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

pub const OPENCODE_DB_NAME: &str = "opencode.db";
const LOCATOR_MARK: &str = "#opencode:";

#[derive(Clone, Debug)]
pub struct OpenCodeSession {
    pub native_id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub parent_id: Option<String>,
    pub started_at: Option<String>,
    pub updated_at: Option<String>,
    pub db_path: PathBuf,
    pub locator: String,
    pub fingerprint: SourceFingerprint,
    pub messages: Vec<OpenCodeMessage>,
}

#[derive(Clone, Debug)]
pub struct OpenCodeMessage {
    pub role: MessageRole,
    pub kind: String,
    pub content: String,
    pub timestamp: Option<String>,
    pub event_id: Option<String>,
}

pub fn is_opencode_db_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(OPENCODE_DB_NAME))
}

pub fn parse_locator(value: &str) -> Option<(PathBuf, String)> {
    let (path, rest) = value.split_once(LOCATOR_MARK)?;
    if path.is_empty() || rest.is_empty() {
        return None;
    }
    Some((PathBuf::from(path), rest.to_string()))
}

pub fn locator(db_path: &Path, session_id: &str) -> String {
    format!("{}{LOCATOR_MARK}{session_id}", db_path.display())
}

pub fn db_file_in_root(root: &Path) -> Option<PathBuf> {
    if is_opencode_db_name(root) && root.is_file() {
        return Some(root.to_path_buf());
    }
    let candidate = root.join(OPENCODE_DB_NAME);
    candidate.is_file().then_some(candidate)
}

pub fn conventional_db_paths(user: &Path) -> Vec<PathBuf> {
    let mut paths = vec![
        user.join(".local/share/opencode").join(OPENCODE_DB_NAME),
        user.join(".opencode").join(OPENCODE_DB_NAME),
    ];
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        paths.insert(0, PathBuf::from(xdg).join("opencode").join(OPENCODE_DB_NAME));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        paths.push(PathBuf::from(local).join("opencode").join(OPENCODE_DB_NAME));
    }
    paths
}

fn open_readonly(path: &Path) -> Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("opening OpenCode database {} read-only", path.display()))?;
    connection.busy_timeout(Duration::from_millis(5_000))?;
    Ok(connection)
}

fn table_has_column(connection: &Connection, table: &str, column: &str) -> bool {
    connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .and_then(|mut statement| {
            let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
            for name in rows.flatten() {
                if name.eq_ignore_ascii_case(column) {
                    return Ok(true);
                }
            }
            Ok(false)
        })
        .unwrap_or(false)
}

fn iso_millis(ms: i64) -> Option<String> {
    (ms > 0)
        .then(|| chrono::DateTime::from_timestamp_millis(ms).map(|time| time.to_rfc3339()))
        .flatten()
}

fn fingerprint_for(db_path: &Path, locator: &str, time_updated: i64) -> Result<SourceFingerprint> {
    let metadata = fs::metadata(db_path)
        .with_context(|| format!("reading OpenCode database metadata {}", db_path.display()))?;
    let modified_unix_millis = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok());
    Ok(SourceFingerprint {
        id: format!("session:opencode:{}", crate::sources::stable_path_hash(locator)),
        source_path: locator.to_string(),
        raw_bytes: metadata.len(),
        modified_unix_millis: Some(modified_unix_millis.unwrap_or(0).saturating_add(time_updated.max(0) as u64)),
    })
}

fn json_text(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn part_text(part: &Value) -> Option<(MessageRole, String, String)> {
    let kind = part
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    match kind.as_str() {
        "text" => json_text(part, &["text", "content"]).map(|text| (MessageRole::Unknown, "text".into(), text)),
        "reasoning" | "thinking" => {
            json_text(part, &["text", "thinking"]).map(|text| (MessageRole::Assistant, "thinking".into(), text))
        }
        "tool" => {
            let tool = json_text(part, &["tool", "name"]).unwrap_or_else(|| "tool".into());
            let state = part.get("state").cloned().unwrap_or(Value::Null);
            let input = state.get("input").cloned().unwrap_or(Value::Null);
            let output = json_text(&state, &["output", "error"]).unwrap_or_default();
            Some((
                MessageRole::Tool,
                "tool".into(),
                format!("{tool} {input} {output}").trim().to_string(),
            ))
        }
        "patch" => part.get("files").map(|files| {
            (
                MessageRole::Assistant,
                "patch".into(),
                files.to_string(),
            )
        }),
        _ => json_text(part, &["text", "content"]).map(|text| (MessageRole::Unknown, kind, text)),
    }
}

fn role_from_message(data: &Value) -> MessageRole {
    match data
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "user" => MessageRole::User,
        "assistant" => MessageRole::Assistant,
        "system" => MessageRole::System,
        "tool" => MessageRole::Tool,
        _ => MessageRole::Unknown,
    }
}

fn load_parts(connection: &Connection, session_id: &str) -> Result<HashMap<String, Vec<Value>>> {
    let mut statement = connection.prepare(
        "SELECT message_id, data FROM part WHERE session_id = ?1 ORDER BY time_created ASC, id ASC",
    )?;
    let mut grouped: HashMap<String, Vec<Value>> = HashMap::new();
    let rows = statement.query_map([session_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (message_id, data) = row?;
        if let Ok(value) = serde_json::from_str::<Value>(&data) {
            grouped.entry(message_id).or_default().push(value);
        }
    }
    Ok(grouped)
}

fn load_messages(connection: &Connection, session_id: &str) -> Result<Vec<OpenCodeMessage>> {
    let parts = load_parts(connection, session_id).unwrap_or_default();
    let mut statement = connection.prepare(
        "SELECT id, time_created, data FROM message WHERE session_id = ?1 ORDER BY time_created ASC, id ASC",
    )?;
    let rows = statement.query_map([session_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut messages = Vec::new();
    for row in rows {
        let (id, time_created, data) = row?;
        let payload: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        let role = role_from_message(&payload);
        let timestamp = iso_millis(time_created);
        let part_list = parts.get(&id).cloned().unwrap_or_default();
        let mut emitted = false;
        for part in part_list {
            let Some((part_role, kind, content)) = part_text(&part) else {
                continue;
            };
            if content.trim().is_empty() {
                continue;
            }
            let resolved_role = if part_role == MessageRole::Unknown {
                role.clone()
            } else {
                part_role
            };
            messages.push(OpenCodeMessage {
                role: resolved_role,
                kind,
                content,
                timestamp: timestamp.clone(),
                event_id: Some(id.clone()),
            });
            emitted = true;
        }
        if !emitted {
            let fallback = json_text(&payload, &["content", "text"])
                .or_else(|| {
                    payload
                        .get("summary")
                        .and_then(|summary| json_text(summary, &["title", "body"]))
                })
                .unwrap_or_default();
            if !fallback.trim().is_empty() {
                messages.push(OpenCodeMessage {
                    role,
                    kind: "text".into(),
                    content: fallback,
                    timestamp,
                    event_id: Some(id),
                });
            }
        }
    }
    Ok(messages)
}

fn list_session_rows(connection: &Connection) -> Result<Vec<(String, String, String, i64, i64, Option<String>)>> {
    let has_parent = table_has_column(connection, "session", "parent_id");
    let has_archived = table_has_column(connection, "session", "time_archived");
    let sql = match (has_parent, has_archived) {
        (true, true) => {
            "SELECT id, COALESCE(title,''), COALESCE(directory,''), COALESCE(time_created,0), COALESCE(time_updated,0), parent_id FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC"
        }
        (true, false) => {
            "SELECT id, COALESCE(title,''), COALESCE(directory,''), COALESCE(time_created,0), COALESCE(time_updated,0), parent_id FROM session ORDER BY time_updated DESC"
        }
        (false, true) => {
            "SELECT id, COALESCE(title,''), COALESCE(directory,''), COALESCE(time_created,0), COALESCE(time_updated,0), NULL FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC"
        }
        (false, false) => {
            "SELECT id, COALESCE(title,''), COALESCE(directory,''), COALESCE(time_created,0), COALESCE(time_updated,0), NULL FROM session ORDER BY time_updated DESC"
        }
    };
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn list_sessions(db_path: &Path) -> Result<Vec<OpenCodeSession>> {
    let connection = open_readonly(db_path)?;
    let canonical = db_path
        .canonicalize()
        .unwrap_or_else(|_| db_path.to_path_buf());
    let mut sessions = Vec::new();
    for (id, title, directory, created, updated, parent) in list_session_rows(&connection)? {
        if id.trim().is_empty() {
            continue;
        }
        let locator = locator(&canonical, &id);
        let messages = load_messages(&connection, &id)?;
        if messages.is_empty() {
            continue;
        }
        let title = title
            .trim()
            .to_string()
            .strip_prefix("New session")
            .map(|_| None)
            .unwrap_or_else(|| (!title.trim().is_empty()).then(|| title.trim().to_string()));
        sessions.push(OpenCodeSession {
            native_id: id,
            title,
            cwd: (!directory.trim().is_empty()).then(|| directory),
            parent_id: parent.filter(|value| !value.trim().is_empty()),
            started_at: iso_millis(created),
            updated_at: iso_millis(updated),
            fingerprint: fingerprint_for(&canonical, &locator, updated)?,
            db_path: canonical.clone(),
            locator,
            messages,
        });
    }
    Ok(sessions)
}

pub fn load_session(db_path: &Path, session_id: &str) -> Result<OpenCodeSession> {
    list_sessions(db_path)?
        .into_iter()
        .find(|session| session.native_id == session_id)
        .with_context(|| format!("OpenCode session {session_id} was not found"))
}

pub fn serialize_session_jsonl(session: &OpenCodeSession) -> String {
    let mut lines = vec![json!({
        "type": "session",
        "id": session.native_id,
        "cwd": session.cwd,
        "title": session.title,
        "parent_id": session.parent_id,
        "timestamp": session.started_at,
    })
    .to_string()];
    for message in &session.messages {
        lines.push(
            json!({
                "type": "message",
                "timestamp": message.timestamp,
                "event_id": message.event_id,
                "message": {
                    "role": message.role.as_str(),
                    "kind": message.kind,
                    "content": message.content,
                }
            })
            .to_string(),
        );
    }
    lines.join("\n")
}

pub fn read_locator_range(locator_value: &str, offset: u64, length: usize) -> Result<(Vec<u8>, u64)> {
    let Some((db_path, session_id)) = parse_locator(locator_value) else {
        bail!("not an OpenCode session locator");
    };
    let session = load_session(&db_path, &session_id)?;
    let bytes = serialize_session_jsonl(&session).into_bytes();
    let size = bytes.len() as u64;
    if offset > size {
        bail!("offset exceeds source length");
    }
    let start = offset as usize;
    let end = (start + length).min(bytes.len());
    Ok((bytes[start..end].to_vec(), size))
}

pub fn source_is_available(locator_value: &str) -> bool {
    parse_locator(locator_value)
        .map(|(path, _)| path.is_file())
        .unwrap_or(false)
}

pub fn write_fixture_db(path: &Path) -> Result<PathBuf> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let connection = Connection::open(path)?;
    connection.execute_batch(
        r#"
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            parent_id TEXT,
            directory TEXT,
            title TEXT,
            time_created INTEGER,
            time_updated INTEGER,
            time_archived INTEGER
        );
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT,
            time_created INTEGER,
            data TEXT
        );
        CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT,
            session_id TEXT,
            time_created INTEGER,
            data TEXT
        );
        "#,
    )?;
    connection.execute(
        "INSERT INTO session(id, project_id, parent_id, directory, title, time_created, time_updated, time_archived)
         VALUES ('ses_parent', 'p1', NULL, 'E:/repo/app', 'Refactor the router', 1000, 2000, NULL)",
        [],
    )?;
    connection.execute(
        "INSERT INTO session(id, project_id, parent_id, directory, title, time_created, time_updated, time_archived)
         VALUES ('ses_child', 'p1', 'ses_parent', 'E:/repo/app', 'subagent', 1500, 1800, NULL)",
        [],
    )?;
    connection.execute(
        "INSERT INTO message(id, session_id, time_created, data) VALUES ('msg_c1', 'ses_child', 1600, ?1)",
        params![json!({"role":"user","time":{"created":1600}}).to_string()],
    )?;
    connection.execute(
        "INSERT INTO part(id, message_id, session_id, time_created, data) VALUES ('prt_c1', 'msg_c1', 'ses_child', 1600, ?1)",
        params![json!({"type":"text","text":"child agent investigating the fixture"}).to_string()],
    )?;
    connection.execute(
        "INSERT INTO message(id, session_id, time_created, data) VALUES ('msg_u1', 'ses_parent', 1100, ?1)",
        params![json!({"role":"user","time":{"created":1100}}).to_string()],
    )?;
    connection.execute(
        "INSERT INTO part(id, message_id, session_id, time_created, data) VALUES ('prt_u1', 'msg_u1', 'ses_parent', 1100, ?1)",
        params![json!({"type":"text","text":"please refactor the flaky router tests"}).to_string()],
    )?;
    connection.execute(
        "INSERT INTO message(id, session_id, time_created, data) VALUES ('msg_a1', 'ses_parent', 1500, ?1)",
        params![json!({"role":"assistant","time":{"created":1500}}).to_string()],
    )?;
    connection.execute(
        "INSERT INTO part(id, message_id, session_id, time_created, data) VALUES ('prt_a1', 'msg_a1', 'ses_parent', 1500, ?1)",
        params![json!({"type":"text","text":"Done. Intermittent CI failures came from a shared fixture."}).to_string()],
    )?;
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_parent_session_from_sqlite_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join(OPENCODE_DB_NAME);
        write_fixture_db(&db).unwrap();
        let before = fs::metadata(&db).unwrap().len();
        let sessions = list_sessions(&db).unwrap();
        assert_eq!(sessions.len(), 2);
        let child = sessions
            .iter()
            .find(|session| session.native_id == "ses_child")
            .unwrap();
        assert_eq!(child.parent_id.as_deref(), Some("ses_parent"));
        let parent = sessions
            .iter()
            .find(|session| session.native_id == "ses_parent")
            .unwrap();
        assert_eq!(parent.cwd.as_deref(), Some("E:/repo/app"));
        assert!(parent.messages.iter().any(|message| {
            message.role == MessageRole::User && message.content.contains("flaky router")
        }));
        assert!(parse_locator(&parent.locator).is_some());
        assert_eq!(fs::metadata(&db).unwrap().len(), before);
    }
}
