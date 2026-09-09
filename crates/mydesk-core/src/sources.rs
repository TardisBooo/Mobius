use crate::{AgentKind, ContextKind, ContextRecord, WorkspacePaths};
use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

const FULL_READ_BYTES: u64 = 4 * 1024 * 1024;
const LARGE_SOURCE_SAMPLE_BYTES: usize = 512 * 1024;
const MAX_INDEXED_CHARS: usize = 900_000;
const DEFAULT_SCAN_LIMIT: usize = 100;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionSourceRoot {
    pub agent: AgentKind,
    pub path: String,
    pub exists: bool,
    pub mode: String,
    /// Why this narrow root was approved. Never contains transcript content.
    #[serde(default)]
    pub provenance: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct AutoSourceSuppression {
    pub agent: AgentKind,
    pub path: String,
}

/// The only roots a refresh is allowed to read.  Saving this manifest is an
/// explicit user action (for example, after choosing a folder in the desktop
/// app); convention paths are suggestions only and are never persisted here.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ApprovedSessionSources {
    #[serde(default = "approved_source_manifest_version")]
    pub version: u32,
    #[serde(default)]
    pub roots: Vec<SessionSourceRoot>,
    /// An explicit removal is durable: auto discovery must not silently add
    /// that same root back on a future launch.
    #[serde(default)]
    pub suppressed_auto_roots: Vec<AutoSourceSuppression>,
}

fn approved_source_manifest_version() -> u32 {
    2
}

pub fn load_approved_session_sources(paths: &WorkspacePaths) -> Result<ApprovedSessionSources> {
    let path = paths.approved_session_sources_path();
    if !path.exists() {
        return Ok(ApprovedSessionSources {
            version: approved_source_manifest_version(),
            roots: Vec::new(),
            suppressed_auto_roots: Vec::new(),
        });
    }
    let bytes = fs::read(&path)
        .with_context(|| format!("reading approved source manifest {}", path.display()))?;
    let mut manifest: ApprovedSessionSources = serde_json::from_slice(&bytes)
        .with_context(|| format!("parsing approved source manifest {}", path.display()))?;
    manifest.version = approved_source_manifest_version();
    manifest.roots = normalize_approved_roots(manifest.roots)?;
    Ok(manifest)
}

/// Persist a normalized copy.  Provider histories remain read-only; only
/// Möbius' own manifest is written.
pub fn save_approved_session_sources(
    paths: &WorkspacePaths,
    roots: Vec<SessionSourceRoot>,
) -> Result<ApprovedSessionSources> {
    let previous = read_manifest(paths)?;
    let manifest = ApprovedSessionSources {
        version: approved_source_manifest_version(),
        roots: normalize_approved_roots(roots)?,
        suppressed_auto_roots: previous.suppressed_auto_roots,
    };
    let path = paths.approved_session_sources_path();
    let parent = path
        .parent()
        .context("approved source manifest has no parent")?;
    fs::create_dir_all(parent)?;
    let bytes = serde_json::to_vec_pretty(&manifest)?;
    fs::write(&path, bytes)
        .with_context(|| format!("writing approved source manifest {}", path.display()))?;
    Ok(manifest)
}

/// Remove a manifest entry without probing other approved directories. This is
/// deliberately tolerant of a directory that disappeared after approval, so a
/// user can always revoke it without Möbius touching unrelated sources.
pub fn remove_approved_session_source(
    paths: &WorkspacePaths,
    agent: AgentKind,
    path: &Path,
) -> Result<ApprovedSessionSources> {
    let manifest_path = paths.approved_session_sources_path();
    let mut manifest = read_manifest(paths)?;
    manifest.version = approved_source_manifest_version();
    let requested = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string();
    manifest
        .roots
        .retain(|root| !(root.agent == agent && root.path.eq_ignore_ascii_case(&requested)));
    if !manifest
        .suppressed_auto_roots
        .iter()
        .any(|root| root.agent == agent && root.path.eq_ignore_ascii_case(&requested))
    {
        manifest.suppressed_auto_roots.push(AutoSourceSuppression {
            agent,
            path: requested,
        });
    }
    let parent = manifest_path
        .parent()
        .context("approved source manifest has no parent")?;
    fs::create_dir_all(parent)?;
    fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).with_context(|| {
        format!(
            "writing approved source manifest {}",
            manifest_path.display()
        )
    })?;
    Ok(manifest)
}

/// Add an explicitly selected source.  This is distinct from auto discovery:
/// the user's choice removes an earlier suppression for the exact root.
pub fn add_manual_session_source(
    paths: &WorkspacePaths,
    agent: AgentKind,
    path: &Path,
) -> Result<ApprovedSessionSources> {
    anyhow::ensure!(agent.is_supported(), "Unsupported session provider: {agent}");
    let mut manifest = read_manifest(paths)?;
    let normalized = normalize_approved_roots(vec![SessionSourceRoot {
        agent: agent.clone(),
        path: path.display().to_string(),
        exists: true,
        mode: "manual_read_only".to_string(),
        provenance: "user-selected directory".to_string(),
    }])?;
    let root = normalized
        .into_iter()
        .next()
        .context("missing normalized source root")?;
    manifest
        .roots
        .retain(|known| !(known.agent == agent && known.path.eq_ignore_ascii_case(&root.path)));
    manifest
        .suppressed_auto_roots
        .retain(|known| !(known.agent == agent && known.path.eq_ignore_ascii_case(&root.path)));
    manifest.roots.push(root);
    manifest.version = approved_source_manifest_version();
    write_manifest(paths, &manifest)?;
    Ok(manifest)
}

/// Find only narrowly documented/provider-specific source roots.  This never
/// walks a home directory or invokes a Harness; it performs `is_dir` checks on
/// a finite list of roots and only returns existing, non-link directories.
pub fn auto_discover_session_sources(paths: &WorkspacePaths) -> Result<ApprovedSessionSources> {
    let candidates = conventional_session_roots(paths, true);
    auto_discover_session_sources_from_candidates(paths, candidates)
}

fn auto_discover_session_sources_from_candidates(
    paths: &WorkspacePaths,
    candidates: Vec<SessionSourceRoot>,
) -> Result<ApprovedSessionSources> {
    let mut manifest = read_manifest(paths)?;
    manifest.version = approved_source_manifest_version();
    let mut changed = false;
    for candidate in candidates {
        if !candidate.exists {
            continue;
        }
        let normalized = match normalize_approved_roots(vec![candidate]) {
            Ok(mut roots) => roots.pop(),
            // A root disappearing while the application starts is benign.
            Err(_) => None,
        };
        let Some(mut root) = normalized else { continue };
        root.mode = "auto_discovered_read_only".to_string();
        if root.provenance.is_empty() {
            root.provenance = "provider convention".to_string();
        }
        if manifest.suppressed_auto_roots.iter().any(|suppressed| {
            suppressed.agent == root.agent && suppressed.path.eq_ignore_ascii_case(&root.path)
        }) || manifest
            .roots
            .iter()
            .any(|known| known.agent == root.agent && known.path.eq_ignore_ascii_case(&root.path))
        {
            continue;
        }
        manifest.roots.push(root);
        changed = true;
    }
    if changed || !paths.approved_session_sources_path().exists() {
        write_manifest(paths, &manifest)?;
    }
    Ok(manifest)
}

fn read_manifest(paths: &WorkspacePaths) -> Result<ApprovedSessionSources> {
    let path = paths.approved_session_sources_path();
    if !path.exists() {
        return Ok(ApprovedSessionSources {
            version: approved_source_manifest_version(),
            roots: Vec::new(),
            suppressed_auto_roots: Vec::new(),
        });
    }
    let bytes = fs::read(&path)
        .with_context(|| format!("reading approved source manifest {}", path.display()))?;
    let mut manifest: ApprovedSessionSources = serde_json::from_slice(&bytes)
        .with_context(|| format!("parsing approved source manifest {}", path.display()))?;
    manifest.version = approved_source_manifest_version();
    Ok(manifest)
}

fn write_manifest(paths: &WorkspacePaths, manifest: &ApprovedSessionSources) -> Result<()> {
    let path = paths.approved_session_sources_path();
    let parent = path
        .parent()
        .context("approved source manifest has no parent")?;
    fs::create_dir_all(parent)?;
    fs::write(&path, serde_json::to_vec_pretty(manifest)?)
        .with_context(|| format!("writing approved source manifest {}", path.display()))
}

/// Canonicalization protects containment checks against `..` and symlink
/// escapes. A selected root must already exist and must itself not be a link.
pub fn normalize_approved_roots(roots: Vec<SessionSourceRoot>) -> Result<Vec<SessionSourceRoot>> {
    let mut normalized = Vec::new();
    for root in roots {
        let requested = PathBuf::from(&root.path);
        let metadata = fs::symlink_metadata(&requested)
            .with_context(|| format!("reading approved root {}", requested.display()))?;
        if metadata.file_type().is_symlink() {
            bail!(
                "approved source root may not be a symlink: {}",
                requested.display()
            );
        }
        if !metadata.is_dir() {
            bail!(
                "approved source root is not a directory: {}",
                requested.display()
            );
        }
        let canonical = requested
            .canonicalize()
            .with_context(|| format!("canonicalizing approved root {}", requested.display()))?;
        if normalized.iter().any(|known: &SessionSourceRoot| {
            known.agent == root.agent
                && known
                    .path
                    .eq_ignore_ascii_case(&canonical.display().to_string())
        }) {
            continue;
        }
        normalized.push(SessionSourceRoot {
            agent: root.agent,
            path: canonical.display().to_string(),
            exists: true,
            mode: if root.mode.is_empty() {
                "manual_read_only".to_string()
            } else {
                root.mode
            },
            provenance: root.provenance,
        });
    }
    Ok(normalized)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionIndexReport {
    pub source_root: String,
    pub agent: AgentKind,
    pub available: usize,
    pub offset: usize,
    pub discovered: usize,
    pub indexed: usize,
    pub unchanged: usize,
    pub skipped: usize,
    pub records: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct SourceFingerprint {
    pub id: String,
    pub source_path: String,
    pub raw_bytes: u64,
    pub modified_unix_millis: Option<u64>,
}

pub fn standard_session_roots(paths: &WorkspacePaths) -> Vec<SessionSourceRoot> {
    conventional_session_roots(paths, true)
}

fn conventional_session_roots(paths: &WorkspacePaths, probe: bool) -> Vec<SessionSourceRoot> {
    // A portable Harness home is useful for an external drive, a test profile,
    // or a second identity. It has the same read-only discovery semantics as
    // USERPROFILE, but prevents a deliberately isolated Möbius instance from
    // ever probing the interactive account's agent folders.
    let user = env::var_os("MOBIUS_HARNESS_HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.workspace_root.clone());
    let explicit_codex_home =
        env::var_os("MOBIUS_CODEX_HOME").or_else(|| env::var_os("CODEX_HOME"));
    let codex_home = explicit_codex_home
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(|| user.join(".codex"));
    let mut definitions = vec![
        (
            AgentKind::Codex,
            codex_home.join("sessions"),
            "Codex: CODEX_HOME/conventional sessions",
        ),
        (
            AgentKind::Codex,
            codex_home.join("archived_sessions"),
            "Codex: CODEX_HOME/conventional archive",
        ),
        (
            AgentKind::Claude,
            user.join(".claude/projects"),
            "Claude Code: conventional projects root",
        ),
        (
            AgentKind::Pi,
            user.join(".pi/agent/sessions"),
            "Pi: conventional agent sessions",
        ),
        (
            AgentKind::Pi,
            user.join(".pi/sessions"),
            "Pi: legacy conventional sessions",
        ),
        (
            AgentKind::Grok,
            user.join(".grok/sessions"),
            "Grok: conventional sessions",
        ),
    ];
    // An explicit CODEX_HOME is a deliberate boundary (and is how isolated
    // test profiles avoid reading a workstation's unrelated archive). When
    // absent, include the documented portable installation as one exact root;
    // it is never a broad E:\\Codex traversal.
    if explicit_codex_home.is_none() {
        definitions.push((
            AgentKind::Codex,
            PathBuf::from(r"E:\Codex\Home\sessions"),
            "Codex: installed portable home",
        ));
    }
    if let Some(path) = env::var_os("PI_CODING_AGENT_DIR") {
        definitions.push((
            AgentKind::Pi,
            PathBuf::from(path).join("sessions"),
            "Pi: PI_CODING_AGENT_DIR",
        ));
    }
    if let Some(path) = env::var_os("GROK_HOME") {
        definitions.push((
            AgentKind::Grok,
            PathBuf::from(path).join("sessions"),
            "Grok: GROK_HOME",
        ));
    }
    definitions
        .into_iter()
        .map(|(agent, path, provenance)| SessionSourceRoot {
            agent,
            exists: probe && safe_existing_directory(&path),
            path: path.display().to_string(),
            mode: if probe {
                "auto_discovered_read_only".to_string()
            } else {
                "suggested_unprobed".to_string()
            },
            provenance: provenance.to_string(),
        })
        .collect()
}

fn safe_existing_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

/// Conventional locations rendered in the desktop source picker. Unlike
/// `standard_session_roots`, this intentionally performs no filesystem probe:
/// displaying a suggestion must not inspect a real Harness home.
pub fn suggested_session_roots(paths: &WorkspacePaths) -> Vec<SessionSourceRoot> {
    conventional_session_roots(paths, false)
}

pub fn list_session_files(
    root: &Path,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<(Vec<PathBuf>, usize)> {
    if !root.is_dir() {
        bail!("Session source root is not a directory: {}", root.display());
    }
    let maximum = limit.unwrap_or(DEFAULT_SCAN_LIMIT).clamp(1, 10_000);
    let mut files = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry?;
        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            continue;
        }
        if is_session_extension(entry.path()) && !looks_sensitive(entry.path()) {
            files.push(entry.into_path());
        }
    }
    files.sort_by(|left, right| {
        let left_modified = fs::metadata(left).and_then(|item| item.modified()).ok();
        let right_modified = fs::metadata(right).and_then(|item| item.modified()).ok();
        right_modified
            .cmp(&left_modified)
            .then_with(|| left.cmp(right))
    });
    let available = files.len();
    let offset = offset.unwrap_or_default().min(available);
    let end = offset.saturating_add(maximum).min(available);
    let selected = files.drain(offset..end).collect();
    Ok((selected, available))
}

pub fn record_from_file(
    path: &Path,
    agent: AgentKind,
    project_slug: Option<String>,
) -> Result<ContextRecord> {
    if looks_sensitive(path) {
        bail!("Refusing to index a likely secret file: {}", path.display());
    }
    if !is_session_extension(path) {
        bail!(
            "Unsupported session source extension for {}. Use jsonl, json, md, or txt.",
            path.display()
        );
    }

    let fingerprint = source_fingerprint(path, agent.clone())?;
    let (raw, sampled) = read_source_text(path, fingerprint.raw_bytes)?;
    let (mut body, redacted_secrets) = normalized_text(path, &raw);
    if sampled {
        body = format!(
            "[Large source excerpt. Open the original source path for the full transcript.]\n\n{body}"
        );
    }
    let resolved_project = project_slug.or_else(|| derive_project_slug(path, &raw));
    let title = path
        .file_stem()
        .and_then(|item| item.to_str())
        .filter(|item| !item.is_empty())
        .map(|item| format!("{agent} · {item}"))
        .unwrap_or_else(|| format!("{agent} session source"));

    let mut record = ContextRecord::new(fingerprint.id, ContextKind::Session, title);
    record.agent = Some(agent.clone());
    record.project_slug = resolved_project.clone();
    record.body = body;
    record.summary = summarize(&record.body);
    record.source_path = Some(fingerprint.source_path);
    record.metadata = json!({
        "adapter": format!("{agent}-read-only-v1"),
        "raw_bytes": fingerprint.raw_bytes,
        "indexed_chars": record.body.chars().count(),
        "modified_unix_millis": fingerprint.modified_unix_millis,
        "derived_project_slug": resolved_project,
        "redacted_secrets": redacted_secrets,
        "sampled": sampled,
    });
    Ok(record)
}

fn read_source_text(path: &Path, bytes: u64) -> Result<(String, bool)> {
    if bytes <= FULL_READ_BYTES {
        return Ok((
            fs::read_to_string(path)
                .with_context(|| format!("reading source {}", path.display()))?,
            false,
        ));
    }

    let mut file =
        fs::File::open(path).with_context(|| format!("opening large source {}", path.display()))?;
    let mut head = vec![0_u8; LARGE_SOURCE_SAMPLE_BYTES.min(bytes as usize)];
    file.read_exact(&mut head)
        .with_context(|| format!("reading head of large source {}", path.display()))?;
    let tail_offset = bytes.saturating_sub(LARGE_SOURCE_SAMPLE_BYTES as u64);
    file.seek(SeekFrom::Start(tail_offset))
        .with_context(|| format!("seeking large source {}", path.display()))?;
    let mut tail = Vec::with_capacity(LARGE_SOURCE_SAMPLE_BYTES);
    file.read_to_end(&mut tail)
        .with_context(|| format!("reading tail of large source {}", path.display()))?;
    let mut text = String::from_utf8_lossy(&head).into_owned();
    if tail_offset > head.len() as u64 {
        text.push_str("\n\n[... large source middle omitted ...]\n\n");
    }
    text.push_str(&String::from_utf8_lossy(&tail));
    Ok((text, true))
}

pub fn source_fingerprint(path: &Path, agent: AgentKind) -> Result<SourceFingerprint> {
    let metadata =
        fs::metadata(path).with_context(|| format!("reading metadata for {}", path.display()))?;
    let source_path = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string();
    let modified_unix_millis = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok());
    Ok(SourceFingerprint {
        id: format!("session:{agent}:{}", stable_path_hash(&source_path)),
        source_path,
        raw_bytes: metadata.len(),
        modified_unix_millis,
    })
}

fn normalized_text(path: &Path, raw: &str) -> (String, bool) {
    let extension = path
        .extension()
        .and_then(|item| item.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let candidate = match extension.as_str() {
        "jsonl" => raw
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .flat_map(|value| strings_in_json(&value))
            .collect::<Vec<_>>()
            .join("\n"),
        "json" => serde_json::from_str::<Value>(raw)
            .map(|value| strings_in_json(&value).join("\n"))
            .unwrap_or_else(|_| raw.to_string()),
        _ => raw.to_string(),
    };
    let redacted = redact_sensitive_text(&candidate);
    let normalized = redacted.0.trim();
    if normalized.is_empty() {
        return (
            "Source contained no indexable text.".to_string(),
            redacted.1,
        );
    }
    (
        normalized.chars().take(MAX_INDEXED_CHARS).collect(),
        redacted.1,
    )
}

fn redact_sensitive_text(input: &str) -> (String, bool) {
    let patterns = [
        r"(?i)\bsk-[A-Za-z0-9_-]{16,}",
        r"(?i)\b(?:ghp|github_pat|xox[baprs])-[A-Za-z0-9_-]{16,}",
        r"(?i)(authorization\s*:\s*bearer\s+)[A-Za-z0-9._-]+",
        r#"(?i)(api[_-]?key\s*[:=]\s*["']?)[^"'\s,}]+"#,
        r#"(?i)(["']?(?:api[_-]?key|token|secret)["']?\s*:\s*["'])[^"]+"#,
    ];
    let mut output = input.to_string();
    let mut redacted = false;
    for pattern in patterns {
        let expression = Regex::new(pattern).expect("redaction expression is valid");
        if expression.is_match(&output) {
            redacted = true;
            output = expression
                .replace_all(&output, |captures: &regex::Captures<'_>| {
                    captures
                        .get(1)
                        .map(|prefix| format!("{}[REDACTED]", prefix.as_str()))
                        .unwrap_or_else(|| "[REDACTED]".to_string())
                })
                .into_owned();
        }
    }
    (output, redacted)
}

fn derive_project_slug(path: &Path, raw: &str) -> Option<String> {
    let extension = path
        .extension()
        .and_then(|item| item.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let values = match extension.as_str() {
        "jsonl" => raw
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect::<Vec<_>>(),
        "json" => serde_json::from_str::<Value>(raw)
            .ok()
            .into_iter()
            .collect(),
        _ => Vec::new(),
    };
    values
        .iter()
        .find_map(find_project_path)
        .and_then(|value| project_slug_from_path(&value))
}

fn find_project_path(value: &Value) -> Option<String> {
    match value {
        Value::Object(values) => {
            for (key, value) in values {
                if matches!(
                    key.as_str(),
                    "cwd" | "project" | "project_path" | "workspace" | "repo_root"
                ) && let Some(value) = value.as_str()
                {
                    return Some(value.to_string());
                }
                if let Some(found) = find_project_path(value) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(values) => values.iter().find_map(find_project_path),
        _ => None,
    }
}

fn project_slug_from_path(value: &str) -> Option<String> {
    let normalized_path = value.trim_end_matches(['/', '\\']).replace('\\', "/");
    let final_component = normalized_path.rsplit('/').next().unwrap_or_default();
    let mut slug = final_component
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    slug = slug.trim_matches('-').to_string();
    (slug.chars().count() >= 2).then_some(slug)
}

fn strings_in_json(value: &Value) -> Vec<String> {
    let mut strings = Vec::new();
    collect_strings(value, &mut strings);
    strings
}

fn collect_strings(value: &Value, strings: &mut Vec<String>) {
    match value {
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.len() > 1 && !looks_like_identifier(trimmed) {
                strings.push(trimmed.to_string());
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_strings(value, strings);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                collect_strings(value, strings);
            }
        }
        _ => {}
    }
}

fn looks_like_identifier(value: &str) -> bool {
    value.len() > 80
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn is_session_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("jsonl" | "json" | "md" | "txt")
    )
}

fn looks_sensitive(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    name == ".env"
        || name.starts_with(".env.")
        || name.contains("secret")
        || name.contains("credential")
        || name.contains("apikey")
        || name.contains("api-key")
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name == "key.txt"
}

fn stable_path_hash(path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    let hash = hex::encode(hasher.finalize());
    hash[..24].to_string()
}

fn summarize(body: &str) -> String {
    let normalized = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut summary = normalized.chars().take(360).collect::<String>();
    if normalized.chars().count() > summary.chars().count() {
        summary.push('…');
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::{
        SessionSourceRoot, add_manual_session_source,
        auto_discover_session_sources_from_candidates, record_from_file,
        remove_approved_session_source,
    };
    use crate::{AgentKind, WorkspacePaths};
    use std::fs;

    #[test]
    fn indexes_jsonl_without_changing_source() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let source = temporary.path().join("session.jsonl");
        let raw = "{\"cwd\":\"E:\\\\Workspaces\\\\MyDesk\",\"message\":{\"content\":\"Useful discussion sk-abcdefghijklmnopqrstuvwxyz123456\"}}\n";
        fs::write(&source, raw).expect("write source");

        let record = record_from_file(&source, AgentKind::Codex, None).expect("record");
        assert!(record.body.contains("Useful discussion"));
        assert!(!record.body.contains("sk-abcdefghijklmnopqrstuvwxyz123456"));
        assert!(record.body.contains("[REDACTED]"));
        assert_eq!(record.project_slug.as_deref(), Some("mydesk"));
        assert_eq!(fs::read_to_string(source).expect("read source"), raw);
    }

    #[test]
    fn auto_discovery_is_finite_persisted_and_respects_user_removal() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let source = temporary.path().join("known-pi-sessions");
        fs::create_dir_all(&source).expect("known source directory");
        let paths = WorkspacePaths {
            workspace_root: temporary.path().join("workspace"),
            data_root: temporary.path().join("data"),
            artifacts_root: temporary.path().join("artifacts"),
            catalog_root: temporary.path().join("catalog"),
        };
        let candidate = || SessionSourceRoot {
            agent: AgentKind::Pi,
            path: source.display().to_string(),
            exists: true,
            mode: "suggested_unprobed".to_string(),
            provenance: "test: known Pi root".to_string(),
        };
        let first = auto_discover_session_sources_from_candidates(&paths, vec![candidate()])
            .expect("auto discovery");
        assert_eq!(first.roots.len(), 1);
        assert_eq!(first.roots[0].mode, "auto_discovered_read_only");
        assert_eq!(first.roots[0].provenance, "test: known Pi root");
        assert!(paths.approved_session_sources_path().exists());

        let removed = remove_approved_session_source(&paths, AgentKind::Pi, &source)
            .expect("remove auto source");
        assert!(removed.roots.is_empty());
        assert_eq!(removed.suppressed_auto_roots.len(), 1);
        let rediscovered = auto_discover_session_sources_from_candidates(&paths, vec![candidate()])
            .expect("auto discovery after removal");
        assert!(
            rediscovered.roots.is_empty(),
            "explicit removal must persist"
        );

        let manual =
            add_manual_session_source(&paths, AgentKind::Pi, &source).expect("re-add manually");
        assert_eq!(manual.roots.len(), 1);
        assert_eq!(manual.roots[0].mode, "manual_read_only");
        assert!(manual.suppressed_auto_roots.is_empty());
    }
}
