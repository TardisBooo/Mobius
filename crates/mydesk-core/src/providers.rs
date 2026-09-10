use crate::{
    AgentKind, Database, Message, MessageRole, Session, SessionCapability, SessionMapCatalog,
    SessionState, WorkspacePaths,
    sources::{SessionSourceRoot, load_approved_session_sources, source_fingerprint},
};
use anyhow::Result;
use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::OnceLock,
};
use walkdir::WalkDir;

const MAX_JSON_BYTES: u64 = 64 * 1024 * 1024;
const MAX_JSONL_FULL_BYTES: u64 = 16 * 1024 * 1024;
// First launch must catalogue every transcript file, including very large
// Codex JSONL files, without reading tens of gigabytes just to populate a
// session list. The head carries session metadata/CWD/first user title; the
// tail carries the most recent state. Anything outside this bounded sample is
// explicitly represented as partial coverage in session metadata.
const LARGE_HEAD_BYTES: u64 = 64 * 1024;
const LARGE_TAIL_BYTES: u64 = 64 * 1024;
// Catalogue storage is intentionally much smaller than a full transcript.
// The original source remains the authority; the catalogue discloses when it
// holds only a bounded sample rather than promising full-source retrieval.
const MAX_MESSAGE_CHARS: usize = 16 * 1024;
const MAX_TOOL_CHARS: usize = 4 * 1024;
const MAX_SESSION_CHARS: usize = 64 * 1024;
const FIRST_SESSION_CHARS: usize = 16 * 1024;
const MAX_SESSION_MESSAGES: usize = 24;
const FIRST_SESSION_MESSAGES: usize = 12;

fn session_map_revision(mappings: &SessionMapCatalog) -> String {
    let mut digest = Sha256::new();
    for mapping in mappings.entries() {
        digest.update(mapping.id.as_bytes());
        digest.update([0]);
        digest.update(mapping.old_path.as_bytes());
        digest.update([0]);
        digest.update(mapping.new_path.as_bytes());
        digest.update([0xff]);
    }
    format!("{:x}", digest.finalize())[..16].to_string()
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ProviderIndexReport {
    pub roots: usize,
    pub discovered: usize,
    pub indexed: usize,
    pub unchanged: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
    pub by_provider: Vec<ProviderIndexProviderReport>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ProviderIndexProviderReport {
    pub provider: AgentKind,
    pub roots: usize,
    pub discovered: usize,
    pub indexed: usize,
    pub unchanged: usize,
    pub skipped: usize,
    /// `full`, `partial`, `unavailable`, or `failed`; a root report is more
    /// honest than claiming every provider history was discovered.
    pub coverage: String,
    #[serde(default)]
    pub root_reports: Vec<ProviderIndexRootReport>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ProviderIndexRootReport {
    pub root: String,
    pub provider: AgentKind,
    pub coverage: String,
    pub discovered: usize,
    pub indexed: usize,
    pub unchanged: usize,
    pub skipped: usize,
    #[serde(default)]
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionAdapter {
    pub provider: AgentKind,
    pub version: &'static str,
    pub coverage: &'static str,
    pub native_resume: bool,
}

#[derive(Clone, Debug, Default)]
pub struct SessionAdapterRegistry;

impl SessionAdapterRegistry {
    pub fn default_adapters() -> Vec<SessionAdapter> {
        vec![
            SessionAdapter {
                provider: AgentKind::Codex,
                version: "codex-json-v3-verified-resume",
                coverage: "partial",
                native_resume: true,
            },
            SessionAdapter {
                provider: AgentKind::Claude,
                version: "claude-jsonl-v2",
                coverage: "partial",
                native_resume: true,
            },
            SessionAdapter {
                provider: AgentKind::Pi,
                version: "pi-json-v2",
                coverage: "partial",
                native_resume: true,
            },
            SessionAdapter {
                provider: AgentKind::Grok,
                version: "grok-history-v3",
                coverage: "partial",
                native_resume: true,
            },
        ]
    }

    pub fn for_provider(provider: &AgentKind) -> SessionAdapter {
        Self::default_adapters()
            .into_iter()
            .find(|adapter| &adapter.provider == provider)
            .unwrap_or(SessionAdapter {
                provider: provider.clone(),
                version: "unsupported-v1",
                coverage: "unsupported",
                native_resume: false,
            })
    }

    pub fn is_candidate(provider: &AgentKind, path: &Path) -> bool {
        if !session_extension(path) {
            return false;
        }
        match provider {
            AgentKind::Grok => path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("chat_history.jsonl")),
            AgentKind::Codex => path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl")),
            AgentKind::Claude | AgentKind::Pi => true,
            AgentKind::Apodex | AgentKind::Unknown => false,
        }
    }
}

pub struct ProviderIndexer<'a> {
    database: &'a Database,
    paths: &'a WorkspacePaths,
}

impl<'a> ProviderIndexer<'a> {
    pub fn new(database: &'a Database, paths: &'a WorkspacePaths) -> Self {
        Self { database, paths }
    }

    pub fn index_standard_roots(&self) -> Result<ProviderIndexReport> {
        // Backwards-compatible entry point.  "Standard" paths are no longer
        // permission to traverse USERPROFILE: refresh sees only the explicit
        // manifest created by the user.
        self.index_approved_roots()
    }

    pub fn index_approved_roots(&self) -> Result<ProviderIndexReport> {
        self.database.ensure_message_search_indexes()?;
        let mappings = SessionMapCatalog::load(&self.paths.session_maps_dir())
            .map(|report| SessionMapCatalog::from_entries(report.entries))
            .unwrap_or_default();
        let roots = load_approved_session_sources(self.paths)?.roots;
        // Repair only our catalogue, never historical transcripts. Keep row IDs
        // stable so notes, exact references and relay edges survive relocation.
        for mut session in self.database.sessions_for_source_audit()? {
            let original_path = session.source_path.clone();
            let original = Path::new(&original_path);
            let relocated = (!original.is_file())
                .then(|| mappings.resolve_forward(original)).flatten()
                .filter(|path| path.is_file());
            if let Some(path) = relocated {
                // Only follow explicit catalogue mappings and a matching native
                // identity. Legacy Codex rows may contain the parent's alias.
                if let Ok(parsed) = parse_session(&path, session.provider.clone()) {
                    let legacy_alias = session.provider == AgentKind::Codex
                        && codex_source_identity(&path).is_ok_and(|identity|
                            identity.legacy_session_id.as_deref() == Some(&session.provider_session_id));
                    if parsed.provider_session_id == session.provider_session_id || legacy_alias {
                        let target = path.canonicalize()?.display().to_string();
                        // Never merge two existing row identities: either may
                        // own relay edges. Retain the stale row for inspection.
                        if self.database.session_id_for_source(&target)?.is_none_or(|id| id == session.id) {
                            session.source_path = target;
                            session.metadata["source_version"] = Value::Null;
                        }
                    }
                }
            }
            let available = Path::new(&session.source_path).is_file();
            if available != session.source_available || session.source_path != original.to_string_lossy() {
                session.source_available = available;
                session.metadata["source_version"] = Value::Null;
                if !available {
                    session.capabilities.retain(|capability| *capability != SessionCapability::NativeResume);
                    session.metadata["native_resume"] = json!(false);
                }
                self.database.update_session_source(&session)?;
            }
        }
        let providers = [
            AgentKind::Codex,
            AgentKind::Claude,
            AgentKind::Pi,
            AgentKind::Grok,
        ];
        let mut reports = providers
            .iter()
            .cloned()
            .map(|provider| ProviderIndexProviderReport {
                roots: roots.iter().filter(|root| root.agent == provider).count(),
                provider,
                ..ProviderIndexProviderReport::default()
            })
            .collect::<Vec<_>>();

        // Keep the manifest's source order instead of exhausting every Codex
        // root before beginning Claude, Pi, or Grok. A large portable
        // Codex archive is often present beside small active roots; preserving
        // discovery order lets each configured Harness become visible during a
        // single refresh rather than making the smaller sources wait behind a
        // historic archive. Reports remain grouped by provider below.
        let mut report = ProviderIndexReport::default();
        for root in &roots {
            let Some(index) = providers
                .iter()
                .position(|provider| *provider == root.agent)
            else {
                continue;
            };
            self.index_root(root, &mappings, &mut reports[index], &mut report.errors)?;
        }

        for provider_report in reports {
            report.roots += provider_report.roots;
            report.discovered += provider_report.discovered;
            report.indexed += provider_report.indexed;
            report.unchanged += provider_report.unchanged;
            report.skipped += provider_report.skipped;
            report.by_provider.push(provider_report);
        }
        Ok(report)
    }

    fn index_root(
        &self,
        root: &SessionSourceRoot,
        mappings: &SessionMapCatalog,
        report: &mut ProviderIndexProviderReport,
        errors: &mut Vec<String>,
    ) -> Result<()> {
        let relocated_root = mappings.resolve_forward(Path::new(&root.path));
        let root_path = if Path::new(&root.path).is_dir() {
            Path::new(&root.path)
        } else {
            relocated_root.as_deref().unwrap_or(Path::new(&root.path))
        };
        let mut root_report = ProviderIndexRootReport {
            root: root.path.clone(),
            provider: root.agent.clone(),
            coverage: "unavailable".to_string(),
            ..ProviderIndexRootReport::default()
        };
        let canonical_root = match approved_canonical_root(root_path) {
            Ok(path) => path,
            Err(error) => {
                root_report.coverage = "failed".to_string();
                root_report.errors.push(error.to_string());
                report.skipped += 1;
                errors.push(format!("{}: {error}", root_path.display()));
                report.root_reports.push(root_report);
                report.coverage = aggregate_coverage(&report.root_reports);
                return Ok(());
            }
        };
        if !canonical_root.is_dir() {
            root_report.coverage = "unavailable".to_string();
            report.root_reports.push(root_report);
            report.coverage = aggregate_coverage(&report.root_reports);
            return Ok(());
        }
        for entry in WalkDir::new(&canonical_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| !excluded_source_path(entry.path()))
        {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    root_report.skipped += 1;
                    if root_report.errors.len() < 20 {
                        root_report.errors.push(error.to_string());
                    }
                    continue;
                }
            };
            if !entry.file_type().is_file()
                || entry.file_type().is_symlink()
                || !SessionAdapterRegistry::is_candidate(&root.agent, entry.path())
            {
                continue;
            }
            let canonical_file = match entry.path().canonicalize() {
                Ok(path) if path.starts_with(&canonical_root) => path,
                Ok(_) => {
                    root_report.skipped += 1;
                    root_report.errors.push(format!(
                        "rejected path outside approved root: {}",
                        entry.path().display()
                    ));
                    continue;
                }
                Err(error) => {
                    root_report.skipped += 1;
                    root_report.errors.push(format!(
                        "cannot canonicalize {}: {error}",
                        entry.path().display()
                    ));
                    continue;
                }
            };
            report.discovered += 1;
            root_report.discovered += 1;
            match self.index_file(&canonical_file, root.agent.clone(), mappings) {
                Ok(IndexOutcome::Indexed) => {
                    report.indexed += 1;
                    root_report.indexed += 1;
                }
                Ok(IndexOutcome::Unchanged) => {
                    report.unchanged += 1;
                    root_report.unchanged += 1;
                }
                Err(error) => {
                    root_report.skipped += 1;
                    if errors.len() < 100 {
                        errors.push(format!("{}: {error}", entry.path().display()));
                    }
                    if root_report.errors.len() < 20 {
                        root_report.errors.push(error.to_string());
                    }
                }
            }
        }
        root_report.coverage = if root_report.errors.is_empty() {
            "partial"
        } else {
            "partial"
        }
        .to_string();
        report.skipped += root_report.skipped;
        report.root_reports.push(root_report);
        report.coverage = aggregate_coverage(&report.root_reports);
        Ok(())
    }

    fn index_file(
        &self,
        path: &Path,
        provider: AgentKind,
        mappings: &SessionMapCatalog,
    ) -> Result<IndexOutcome> {
        let fingerprint = source_fingerprint(path, provider.clone())?;
        let fingerprint_suffix = format!(
            "{}:{}",
            fingerprint.raw_bytes,
            fingerprint.modified_unix_millis.unwrap_or_default()
        );
        let adapter = SessionAdapterRegistry::for_provider(&provider);
        let mapping_revision = session_map_revision(mappings);
        let source_version = if provider == AgentKind::Grok {
            format!(
                "{}:grok-cwd-v1:{fingerprint_suffix}:{}:maps-{mapping_revision}:relay-marker-v1",
                adapter.version,
                companion_source_fingerprint(path)
            )
        } else {
            format!("{}:{fingerprint_suffix}:maps-{mapping_revision}:relay-marker-v1", adapter.version)
        };
        let source_is_current = self
            .database
            .session_source_unchanged(&fingerprint.source_path, &source_version)?;
        if source_is_current {
            return Ok(IndexOutcome::Unchanged);
        }
        let mut parsed = parse_session(path, provider.clone())?;
        if parsed.messages.is_empty() {
            anyhow::bail!("no shareable messages found");
        }
        let source_message_count = parsed.messages.len();
        // A complete source file can still need a partial catalogue entry: each
        // individual payload and the retained message set have explicit caps.
        // Keep this separate from byte-level source sampling and publish their
        // combined result below so clients never mistake a small source for a
        // complete transcript merely because its file was read in full.
        let message_payload_truncated = parsed.messages.iter().any(|message| {
            let cap = if message.role == MessageRole::Tool {
                MAX_TOOL_CHARS
            } else {
                MAX_MESSAGE_CHARS
            };
            message.content.chars().count() > cap
        });
        parsed.messages = bounded_session_messages(parsed.messages);
        let catalogue_message_count = parsed.messages.len();
        let message_rows_omitted = catalogue_message_count < source_message_count;
        let message_catalogue_partial = message_rows_omitted || message_payload_truncated;
        let source_catalogue_partial = fingerprint.raw_bytes > MAX_JSONL_FULL_BYTES;
        let catalogue_coverage = if source_catalogue_partial || message_catalogue_partial {
            "partial"
        } else {
            "full"
        };
        let checkout_id = parsed.cwd.as_deref().and_then(|cwd| {
            resolve_checkout(self.database, mappings, Path::new(cwd))
                .ok()
                .flatten()
        });
        let title = parsed
            .messages
            .iter()
            .find(|message| message.role == MessageRole::User)
            .map(|message| compact_title(&message.content))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| format!("{} · {}", provider, parsed.provider_session_id));
        // A native id is intentionally not sufficient for internal identity:
        // multiple source folders can legitimately contain the same session.
        let session_id = self.database.session_id_for_source(&fingerprint.source_path)?.unwrap_or_else(|| format!(
            "session:{}:{}:{}",
            provider,
            stable_fragment(&fingerprint.source_path),
            parsed.provider_session_id
        ));
        let mut capabilities = vec![SessionCapability::Inspect];
        if adapter.native_resume && parsed.native_session_id.is_some() && !parsed.is_subagent {
            capabilities.push(SessionCapability::NativeResume);
        }
        let native_resume = capabilities.contains(&SessionCapability::NativeResume);
        let handoff_marker = Regex::new(r"\[MOBIUS_HANDOFF_ID:([^\]\r\n]+)\]")?;
        let mobius_handoff_id = parsed.messages.iter()
            .filter(|message| message.role == MessageRole::User)
            .find_map(|message| handoff_marker.captures(&message.content).map(|capture| capture[1].to_string()));
        let session = Session {
            id: session_id.clone(),
            provider: provider.clone(),
            provider_session_id: parsed.provider_session_id.clone(),
            checkout_id,
            title,
            state: SessionState::Indexed,
            capabilities,
            source_path: fingerprint.source_path.clone(),
            source_available: true,
            started_at: parsed.started_at,
            updated_at: parsed.updated_at.unwrap_or_else(|| Utc::now().to_rfc3339()),
            metadata: json!({
                "cwd": parsed.cwd,
                "mobius_handoff_id": mobius_handoff_id,
                "source_version": source_version,
                "source_bytes": fingerprint.raw_bytes,
                "sampled_large_source": source_catalogue_partial,
                "catalogue_coverage": catalogue_coverage,
                "catalogue_coverage_reason": {
                    "source_bytes_sampled": source_catalogue_partial,
                    "message_rows_omitted": message_rows_omitted,
                    "message_payload_truncated": message_payload_truncated,
                },
                "source_sampling": if source_catalogue_partial {
                    json!({
                        "mode": "bounded_head_tail",
                        "coverage": "partial",
                        "head_bytes": LARGE_HEAD_BYTES,
                        "tail_bytes": LARGE_TAIL_BYTES,
                        "reason": "catalogue first; open the original source for full transcript",
                    })
                } else {
                    json!({ "mode": "full", "coverage": "full" })
                },
                "catalogue_message_budget_chars": MAX_SESSION_CHARS,
                "catalogue_message_cap_chars": MAX_MESSAGE_CHARS,
                "message_sampling": {
                    "mode": if message_catalogue_partial { "bounded_head_tail" } else { "full" },
                    "coverage": if message_catalogue_partial { "partial" } else { "full" },
                    "source_message_count": source_message_count,
                    "catalogue_message_count": catalogue_message_count,
                    "max_catalogue_messages": MAX_SESSION_MESSAGES,
                    "payloads_truncated": message_payload_truncated,
                },
                "adapter": adapter.version,
                "adapter_coverage": adapter.coverage,
                "native_session_id": parsed.native_session_id,
                "native_resume": native_resume,
                "parent_session_id": parsed.parent_session_id,
                "native_resume_reason": if parsed.is_subagent {
                    Some("Codex child agent: inspect this history; resume the parent explicitly in Codex to continue the agent tree.")
                } else { None },
            }),
        };
        let messages = parsed
            .messages
            .into_iter()
            .enumerate()
            .map(|(ordinal, parsed)| {
                let limit = if parsed.role == MessageRole::Tool {
                    MAX_TOOL_CHARS
                } else {
                    MAX_MESSAGE_CHARS
                };
                Message {
                    id: format!("message:{}:{}", stable_fragment(&session_id), ordinal),
                    session_id: session_id.clone(),
                    ordinal: ordinal as i64,
                    role: parsed.role,
                    kind: parsed.kind,
                    content: truncate_shareable(&redact(&parsed.content), limit),
                    timestamp: parsed.timestamp,
                    source_locator: json!({
                        "path": fingerprint.source_path,
                        "line": parsed.line,
                        "event_id": parsed.event_id
                    }),
                    redacted: false,
                }
            })
            .collect::<Vec<_>>();
        self.database.upsert_session(&session)?;
        self.database
            .replace_session_messages_without_search(&session.id, &messages)?;
        Ok(IndexOutcome::Indexed)
    }
}

enum IndexOutcome {
    Indexed,
    Unchanged,
}

#[derive(Debug)]
pub struct CodexSourceIdentity {
    pub id: String,
    pub cwd: Option<String>,
    pub legacy_session_id: Option<String>,
    pub model_provider: Option<String>,
    pub is_subagent: bool,
    pub parent_session_id: Option<String>,
}

/// Read the authoritative header, never a filename guess or an inherited
/// event ID. Bounded and read-only; suitable for every native launch preflight.
pub fn codex_source_identity(path: &Path) -> Result<CodexSourceIdentity> {
    let reader = BufReader::new(fs::File::open(path)?.take(LARGE_HEAD_BYTES));
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&line)
            .map_err(|_| anyhow::anyhow!("Codex first source record is malformed; refusing inherited-header fallback"))?;
        anyhow::ensure!(value.get("type").and_then(Value::as_str) == Some("session_meta"),
            "Codex first source record is not an authoritative session header");
        let payload = value.get("payload").unwrap_or(&value);
        let id = first_string(payload, &["id", "session_id", "sessionId"])
            .filter(|id| looks_like_native_session_id(id))
            .ok_or_else(|| anyhow::anyhow!("Codex source header has no valid native identity"))?;
        return Ok(CodexSourceIdentity {
            id: id.to_owned(),
            cwd: first_string(payload, &["cwd"]).map(str::to_owned),
            legacy_session_id: first_string(payload, &["session_id", "sessionId"]).map(str::to_owned),
            model_provider: first_string(payload, &["model_provider"]).map(str::to_owned),
            is_subagent: payload.pointer("/source/subagent").is_some()
                || payload.get("source").and_then(Value::as_str).is_some_and(|source| source.starts_with("subagent")),
            parent_session_id: payload.pointer("/source/subagent/thread_spawn/parent_thread_id")
                .and_then(Value::as_str).map(str::to_owned),
        });
    }
    anyhow::bail!("Codex source has no authoritative session header; refresh or inspect its source")
}

/// Resolve the Codex home from a canonical source tree, not the launching
/// shell's inherited environment. Archives outside a native tree fail closed.
pub fn codex_home_for_source(path: &Path) -> Result<PathBuf> {
    let canonical = path.canonicalize()?;
    for ancestor in canonical.ancestors().skip(1) {
        if ancestor.file_name().is_some_and(|name| name == "sessions" || name == "archived_sessions") {
            return ancestor.parent().map(Path::to_path_buf)
                .ok_or_else(|| anyhow::anyhow!("Codex source home is missing"));
        }
    }
    anyhow::bail!("Codex source is outside a native sessions directory; inspect only")
}

pub fn verified_codex_resume_home(path: &Path, expected_id: &str) -> Result<PathBuf> {
    let identity = codex_source_identity(path)?;
    anyhow::ensure!(identity.id == expected_id,
        "Codex source identity differs from the cached index. Refresh sessions; refusing to open a different thread.");
    anyhow::ensure!(!identity.is_subagent,
        "This is a Codex child-agent history, not an independently resumable CLI conversation. Resume its parent explicitly in Codex; this source remains inspectable.");
    codex_home_for_source(path)
}

fn approved_canonical_root(root: &Path) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(root)?;
    if metadata.file_type().is_symlink() {
        anyhow::bail!("approved source root cannot be a symlink");
    }
    if !metadata.is_dir() {
        anyhow::bail!("approved source root is not a directory");
    }
    Ok(root.canonicalize()?)
}

fn aggregate_coverage(roots: &[ProviderIndexRootReport]) -> String {
    if roots.is_empty() {
        "none".to_string()
    } else if roots.iter().all(|root| root.coverage == "failed") {
        "failed".to_string()
    } else if roots.iter().all(|root| root.coverage == "full") {
        "full".to_string()
    } else {
        // Session layouts differ by harness/version and a finite source root
        // never proves it contains all historical data.
        "partial".to_string()
    }
}

#[derive(Default)]
struct ParsedSession {
    provider_session_id: String,
    native_session_id: Option<String>,
    is_subagent: bool,
    parent_session_id: Option<String>,
    cwd: Option<String>,
    started_at: Option<String>,
    updated_at: Option<String>,
    messages: Vec<ParsedMessage>,
}

struct ParsedMessage {
    role: MessageRole,
    kind: String,
    content: String,
    timestamp: Option<String>,
    line: usize,
    event_id: Option<String>,
}

fn parse_session(path: &Path, provider: AgentKind) -> Result<ParsedSession> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut parsed = ParsedSession {
        provider_session_id: stable_provider_session_id(path, &provider),
        ..ParsedSession::default()
    };
    // Forked Codex files can contain both their own header and inherited
    // parent headers. The first header's `id` is authoritative, not session_id.
    let codex_identity = (provider == AgentKind::Codex)
        .then(|| codex_source_identity(path).ok()).flatten();
    if let Some(identity) = &codex_identity {
        parsed.native_session_id = Some(identity.id.clone());
        parsed.cwd = identity.cwd.clone();
        parsed.is_subagent = identity.is_subagent;
        parsed.parent_session_id = identity.parent_session_id.clone();
    }
    if extension == "jsonl" {
        parse_jsonl(path, &provider, &mut parsed)?;
    } else {
        let metadata = fs::metadata(path)?;
        if metadata.len() > MAX_JSON_BYTES {
            anyhow::bail!("JSON session exceeds {} MiB", MAX_JSON_BYTES / 1024 / 1024);
        }
        let value: Value = serde_json::from_reader(BufReader::new(fs::File::open(path)?))?;
        absorb_metadata(&value, &mut parsed);
        collect_messages(&value, 1, &provider, &mut parsed.messages);
    }
    if provider == AgentKind::Codex {
        // Headerless legacy content remains inspectable, never resumable.
        parsed.native_session_id = codex_identity.map(|identity| identity.id);
    }
    if provider == AgentKind::Grok && (parsed.cwd.is_none() || parsed.native_session_id.is_none()) {
        absorb_grok_companion_metadata(path, &mut parsed);
    }
    if parsed.provider_session_id == "unknown" {
        parsed.provider_session_id = stable_fragment(&path.display().to_string());
    }
    // Keep the provider-visible identifier separately.  Older source shapes
    // may have only a filename-derived id; that is inspectable but never gets
    // a resume capability.
    if let Some(native) = parsed.native_session_id.as_ref() {
        parsed.provider_session_id = native.clone();
    } else {
        parsed.provider_session_id = stable_provider_session_id(path, &provider);
    }
    Ok(parsed)
}

fn parse_jsonl(path: &Path, provider: &AgentKind, parsed: &mut ParsedSession) -> Result<()> {
    let length = fs::metadata(path)?.len();
    let mut file = fs::File::open(path)?;
    if length > MAX_JSONL_FULL_BYTES {
        {
            let limited = Read::take(&mut file, LARGE_HEAD_BYTES);
            let reader = BufReader::new(limited);
            for (line_index, line) in reader.lines().enumerate() {
                if let Ok(line) = line {
                    absorb_jsonl_line(&line, line_index + 1, provider, parsed);
                }
            }
        }
        file.seek(SeekFrom::Start(length.saturating_sub(LARGE_TAIL_BYTES)))?;
        let mut reader = BufReader::new(&mut file);
        let mut partial = Vec::new();
        reader.read_until(b'\n', &mut partial)?;
        let mut tail_line = 1_000_000_000usize;
        loop {
            let mut line = Vec::new();
            if reader.read_until(b'\n', &mut line)? == 0 {
                break;
            }
            absorb_jsonl_line(&String::from_utf8_lossy(&line), tail_line, provider, parsed);
            tail_line += 1;
        }
    } else {
        let reader = BufReader::new(&mut file);
        for (line_index, line) in reader.lines().enumerate() {
            if let Ok(line) = line {
                absorb_jsonl_line(&line, line_index + 1, provider, parsed);
            }
        }
    }
    Ok(())
}

fn absorb_jsonl_line(
    line: &str,
    line_number: usize,
    provider: &AgentKind,
    parsed: &mut ParsedSession,
) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    absorb_metadata(&value, parsed);
    if let Some(message) = extract_message(&value, line_number, provider) {
        parsed.messages.push(message);
    }
}

fn absorb_metadata(value: &Value, parsed: &mut ParsedSession) {
    let payload = value.get("payload").unwrap_or(value);
    if parsed.cwd.is_none() {
        parsed.cwd = first_string(payload, &["cwd", "working_directory", "project_path"])
            .or_else(|| value.pointer("/info/cwd").and_then(Value::as_str))
            .or_else(|| value.get("git_root_dir").and_then(Value::as_str))
            .map(str::to_string);
    }
    if parsed.native_session_id.is_none() {
        let is_session_metadata = matches!(
            first_string(value, &["type"]),
            Some("session_meta") | Some("session_metadata") | Some("session")
        );
        parsed.native_session_id = first_string(payload, &["session_id", "sessionId"])
            .or_else(|| first_string(value, &["session_id", "sessionId"]))
            .or_else(|| {
                is_session_metadata
                    .then(|| first_string(payload, &["id"]))
                    .flatten()
            })
            .filter(|value| looks_like_native_session_id(value))
            .map(str::to_string);
    }
    let timestamp = first_string(value, &["timestamp", "created_at", "updated_at"])
        .or_else(|| first_string(payload, &["timestamp", "created_at", "updated_at"]));
    if parsed.started_at.is_none() {
        parsed.started_at = timestamp.map(str::to_string);
    }
    if timestamp.is_some() {
        parsed.updated_at = timestamp.map(str::to_string);
    }
}

fn looks_like_native_session_id(value: &str) -> bool {
    let value = value.trim();
    value.len() >= 6
        && value.len() <= 256
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn absorb_grok_companion_metadata(path: &Path, parsed: &mut ParsedSession) {
    let Some(directory) = path.parent() else {
        return;
    };
    for name in ["summary.json", "metadata.json"] {
        let companion = directory.join(name);
        let Ok(metadata) = fs::metadata(&companion) else {
            continue;
        };
        if metadata.len() > MAX_JSON_BYTES {
            continue;
        }
        let Ok(file) = fs::File::open(companion) else {
            continue;
        };
        let Ok(value) = serde_json::from_reader::<_, Value>(BufReader::new(file)) else {
            continue;
        };
        absorb_metadata(&value, parsed);
        if let Some(id) = value.pointer("/info/id").and_then(Value::as_str)
            .filter(|id| uuid::Uuid::parse_str(id).is_ok()) {
            if directory.file_name().is_some_and(|name| name.to_string_lossy() == id) {
                parsed.native_session_id = Some(id.to_string());
            }
        }
        if parsed.cwd.is_some() {
            break;
        }
    }
}

fn companion_source_fingerprint(path: &Path) -> String {
    let Some(directory) = path.parent() else {
        return "none".to_string();
    };
    for name in ["summary.json", "metadata.json"] {
        let companion = directory.join(name);
        let Ok(metadata) = fs::metadata(companion) else {
            continue;
        };
        let modified = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_millis())
            .unwrap_or_default();
        return format!("{}:{modified}", metadata.len());
    }
    "none".to_string()
}

fn stable_provider_session_id(path: &Path, provider: &AgentKind) -> String {
    if *provider == AgentKind::Grok {
        return path
            .parent()
            .and_then(Path::file_name)
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| stable_fragment(&path.display().to_string()));
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown");
    if let Some(found) = uuid_fragment(stem) {
        return found.to_string();
    }
    stem.to_string()
}

fn uuid_fragment(value: &str) -> Option<&str> {
    value
        .as_bytes()
        .windows(36)
        .position(|window| {
            window.iter().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    *byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
        })
        .map(|start| &value[start..start + 36])
}

fn extract_message(value: &Value, line: usize, _provider: &AgentKind) -> Option<ParsedMessage> {
    let payload = value.get("payload").unwrap_or(value);
    let message = if payload.get("type").and_then(Value::as_str) == Some("message") {
        // Pi writes an envelope `{ type: "message", message: { role,
        // content } }`, whereas Codex writes the role/content directly in its
        // `payload`. Prefer the child message when one is present, while
        // retaining the direct-payload form used by the other adapters.
        payload.get("message").unwrap_or(payload)
    } else {
        value.get("message").unwrap_or(payload)
    };
    let role_text =
        first_string(message, &["role"]).or_else(|| first_string(value, &["type", "role"]))?;
    let role = match role_text.to_ascii_lowercase().as_str() {
        "user" | "human" => MessageRole::User,
        "assistant" => MessageRole::Assistant,
        "tool" | "tool_result" | "tool_use" => MessageRole::Tool,
        _ => return None,
    };
    let content_value = message.get("content").or_else(|| message.get("text"))?;
    let content = extract_content(content_value);
    if content.trim().is_empty() {
        return None;
    }
    Some(ParsedMessage {
        role,
        kind: first_string(message, &["type"])
            .unwrap_or("text")
            .to_string(),
        content,
        timestamp: first_string(value, &["timestamp", "created_at"])
            .or_else(|| first_string(message, &["timestamp", "created_at"]))
            .map(str::to_string),
        line,
        event_id: first_string(value, &["id", "uuid"]).map(str::to_string),
    })
}

fn collect_messages(
    value: &Value,
    line: usize,
    provider: &AgentKind,
    output: &mut Vec<ParsedMessage>,
) {
    if let Some(message) = extract_message(value, line, provider) {
        output.push(message);
        return;
    }
    match value {
        Value::Array(values) => {
            for value in values {
                collect_messages(value, line, provider, output);
            }
        }
        Value::Object(object) => {
            for (key, value) in object {
                if matches!(
                    key.as_str(),
                    "messages" | "history" | "conversation" | "items"
                ) {
                    collect_messages(value, line, provider, output);
                }
            }
        }
        _ => {}
    }
}

fn extract_content(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .filter_map(|item| {
                if let Some(text) = item.as_str() {
                    Some(text.to_string())
                } else if let Some(object) = item.as_object() {
                    object
                        .get("text")
                        .or_else(|| object.get("content"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(object) => object
            .get("text")
            .or_else(|| object.get("content"))
            .map(extract_content)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn first_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    let object = value.as_object()?;
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
}

fn resolve_checkout(
    database: &Database,
    mappings: &SessionMapCatalog,
    cwd: &Path,
) -> Result<Option<String>> {
    // A transcript's cwd is untrusted metadata.  It may be linked only to an
    // already registered checkout or an explicit historical path-map; it may
    // never cause Möbius to discover/register a new workspace during indexing.
    let candidate = mappings
        .resolve_forward(cwd)
        .unwrap_or_else(|| cwd.to_path_buf());
    if let Some(id) = database.find_checkout_by_path(&candidate)? {
        return Ok(Some(id));
    }
    Ok(None)
}

fn session_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("jsonl" | "json")
    )
}

fn excluded_source_path(path: &Path) -> bool {
    path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        value.contains("cwd-remap-rollbacks")
            || value.contains("pre-remap")
            || value == "backup"
            || value == "backups"
    })
}

fn truncate_shareable(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    const OMITTED: &str = "\n\n[MyDesk omitted oversized message payload]\n\n";
    let marker = OMITTED.chars().count();
    if limit <= marker {
        return value.chars().take(limit).collect();
    }
    let visible = limit - marker;
    let head = value.chars().take(visible * 3 / 4).collect::<String>();
    let tail = value
        .chars()
        .rev()
        .take(visible - visible * 3 / 4)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{head}{OMITTED}{tail}")
}

fn bounded_session_messages(mut messages: Vec<ParsedMessage>) -> Vec<ParsedMessage> {
    // Cap before selecting head/tail so the retained collection itself—not
    // merely the later database projection—obeys the catalogue budget.
    for message in &mut messages {
        let cap = if message.role == MessageRole::Tool {
            MAX_TOOL_CHARS
        } else {
            MAX_MESSAGE_CHARS
        };
        message.content = truncate_shareable(&message.content, cap);
    }
    if messages.len() <= MAX_SESSION_MESSAGES
        && messages
            .iter()
            .map(|message| message.content.chars().count())
            .sum::<usize>()
            <= MAX_SESSION_CHARS
    {
        return messages;
    }
    let mut head = Vec::new();
    let mut remainder = Vec::new();
    let mut used = 0usize;
    for message in messages {
        let length = message.content.chars().count().min(MAX_MESSAGE_CHARS);
        if used < FIRST_SESSION_CHARS && head.len() < FIRST_SESSION_MESSAGES {
            used += length;
            head.push(message);
        } else {
            remainder.push(message);
        }
    }
    let mut tail = Vec::new();
    for message in remainder.into_iter().rev() {
        if tail.len() >= MAX_SESSION_MESSAGES.saturating_sub(head.len()) {
            break;
        }
        let length = message.content.chars().count().min(MAX_MESSAGE_CHARS);
        if used + length > MAX_SESSION_CHARS {
            continue;
        }
        used += length;
        tail.push(message);
    }
    tail.reverse();
    head.extend(tail);
    head
}

fn compact_title(value: &str) -> String {
    let title = value
        .split_whitespace()
        .take(14)
        .collect::<Vec<_>>()
        .join(" ");
    title.chars().take(100).collect()
}

fn stable_fragment(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())[..24].to_string()
}

fn redact(value: &str) -> String {
    static SECRET: OnceLock<Regex> = OnceLock::new();
    SECRET.get_or_init(|| Regex::new(r#"(?i)(sk-[a-z0-9_-]{20,}|(?:api[_-]?key|token|secret)\s*[:=]\s*['"]?[a-z0-9_./+-]{16,})"#).expect("secret regex"))
        .replace_all(value, "[REDACTED]").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SessionQuery, WorkspacePaths, save_approved_session_sources};
    use std::{
        io::{Seek, SeekFrom, Write},
        path::Path,
    };

    fn test_paths(root: &Path) -> WorkspacePaths {
        WorkspacePaths {
            workspace_root: root.join("workspace"),
            data_root: root.join("data"),
            artifacts_root: root.join("artifacts"),
            catalog_root: root.join("catalog"),
        }
    }

    #[test]
    fn codex_fork_uses_first_own_id_not_parent_alias_or_inherited_header() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("sessions/2026/09/11/child.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let raw = format!("{}\n{}\n{}\n",
            json!({"type":"session_meta","payload":{"id":"child-id","session_id":"parent-id","forked_from_id":"parent-id","cwd":temp.path()}}),
            json!({"type":"session_meta","payload":{"id":"parent-id","cwd":"other-directory"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":"keep the exact trajectory"}}));
        fs::write(&path, &raw).unwrap();
        let parsed = parse_session(&path, AgentKind::Codex).unwrap();
        assert_eq!(parsed.native_session_id.as_deref(), Some("child-id"));
        assert_eq!(parsed.cwd.as_deref(), temp.path().to_str());
        assert_eq!(codex_home_for_source(&path).unwrap(), temp.path().canonicalize().unwrap());
        assert!(verified_codex_resume_home(&path, "child-id").is_ok());
        assert!(verified_codex_resume_home(&path, "parent-id").is_err());
        assert!(verified_codex_resume_home(&temp.path().join("missing.jsonl"), "child-id").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
        let outside = temp.path().join("archive.jsonl");
        fs::write(&outside, raw).unwrap();
        assert!(codex_home_for_source(&outside).is_err());
    }

    #[test]
    fn codex_corrupt_first_header_cannot_resume_an_inherited_parent() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("sessions/corrupt.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("{{broken\n{}\n",
            json!({"type":"session_meta","payload":{"id":"parent-id"}}))).unwrap();
        assert!(codex_source_identity(&path).is_err());
        assert!(verified_codex_resume_home(&path, "parent-id").is_err());
    }

    #[test]
    fn codex_child_agent_is_inspectable_but_not_independently_resumable() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        let database = Database::open(&paths).unwrap();
        let path = temp.path().join("sessions/child.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("{}\n{}\n",
            json!({"type":"session_meta","payload":{"id":"child-id","session_id":"parent-id",
                "source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent-id"}}}}}),
            json!({"role":"user","content":"child history"}))).unwrap();
        ProviderIndexer::new(&database, &paths).index_file(&path.canonicalize().unwrap(),
            AgentKind::Codex, &SessionMapCatalog::default()).unwrap();
        let session = database.sessions_for_source_audit().unwrap().remove(0);
        assert_eq!(session.provider_session_id, "child-id");
        assert!(session.capabilities.contains(&SessionCapability::Inspect));
        assert!(!session.capabilities.contains(&SessionCapability::NativeResume));
        assert_eq!(session.metadata["parent_session_id"], "parent-id");
        assert!(verified_codex_resume_home(&path, "child-id").is_err());
    }

    #[test]
    fn codex_reindex_corrects_identity_preserves_row_and_marks_missing_source() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        let database = Database::open(&paths).unwrap();
        let source = temp.path().join("source.jsonl");
        fs::write(&source, format!("{}\n{}\n",
            json!({"type":"session_meta","payload":{"id":"child-id","session_id":"parent-id"}}),
            json!({"role":"user","content":"test message"}))).unwrap();
        let mut legacy = Session {
            id: "stable-row-id".into(), provider: AgentKind::Codex,
            provider_session_id: "parent-id".into(), checkout_id: None,
            title: "legacy".into(), state: SessionState::Indexed,
            capabilities: vec![SessionCapability::NativeResume],
            source_path: source.canonicalize().unwrap().display().to_string(),
            source_available: true, started_at: None, updated_at: Utc::now().to_rfc3339(),
            metadata: json!({"adapter":"codex-json-v2"}),
        };
        database.upsert_session(&legacy).unwrap();
        let indexer = ProviderIndexer::new(&database, &paths);
        indexer.index_file(&source.canonicalize().unwrap(), AgentKind::Codex, &SessionMapCatalog::default()).unwrap();
        let corrected = database.get_session("stable-row-id").unwrap().unwrap();
        assert_eq!(corrected.provider_session_id, "child-id");
        assert_eq!(corrected.metadata["native_session_id"], "child-id");
        assert_eq!(database.sessions_for_source_audit().unwrap().len(), 1);
        legacy = corrected;
        legacy.source_path = temp.path().join("missing.jsonl").display().to_string();
        database.update_session_source(&legacy).unwrap();
        indexer.index_approved_roots().unwrap();
        assert!(!database.get_session("stable-row-id").unwrap().unwrap().source_available);
    }

    #[test]
    fn mapped_source_and_approved_root_relocate_without_changing_history_or_row_id() {
        let temp = tempfile::tempdir().unwrap();
        let paths = test_paths(temp.path());
        let database = Database::open(&paths).unwrap();
        let old = temp.path().join("old/sessions");
        let new = temp.path().join("new/sessions");
        fs::create_dir_all(&old).unwrap();
        let source = old.join("fork.jsonl");
        let raw = format!("{}\n{}\n",
            json!({"type":"session_meta","payload":{"id":"fork-id","session_id":"parent-id"}}),
            json!({"role":"user","content":"migration test"}));
        fs::write(&source, &raw).unwrap();
        save_approved_session_sources(&paths, vec![SessionSourceRoot {
            agent: AgentKind::Codex, path: old.display().to_string(), exists: true,
            mode: "read-only".into(), provenance: "test".into(),
        }]).unwrap();
        let indexer = ProviderIndexer::new(&database, &paths);
        indexer.index_approved_roots().unwrap();
        let before = database.sessions_for_source_audit().unwrap().remove(0);
        fs::create_dir_all(new.parent().unwrap()).unwrap();
        fs::rename(&old, &new).unwrap();
        fs::create_dir_all(paths.session_maps_dir()).unwrap();
        fs::write(paths.session_maps_dir().join("move.csv"),
            format!("old_path,new_path\n{},{}\n", old.display(), new.display())).unwrap();
        let report = indexer.index_approved_roots().unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.indexed, 1);
        let after = database.get_session(&before.id).unwrap().unwrap();
        assert!(after.source_available);
        assert_eq!(Path::new(&after.source_path), new.join("fork.jsonl").canonicalize().unwrap());
        assert_eq!(after.provider_session_id, "fork-id");
        assert_eq!(fs::read_to_string(new.join("fork.jsonl")).unwrap(), raw);
        assert_eq!(indexer.index_approved_roots().unwrap().unchanged, 1);
    }

    #[test]
    fn parses_codex_messages_without_system_prompt() {
        let temporary = tempfile::tempdir().expect("temp");
        let path = temporary.path().join("session.jsonl");
        let mut file = fs::File::create(&path).expect("create");
        writeln!(
            file,
            "{}",
            json!({"type":"session_meta","payload":{"id":"abc-session","cwd":temporary.path()}})
        )
        .expect("meta");
        writeln!(file, "{}", json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Build the corridor"}]}})).expect("user");
        writeln!(file, "{}", json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}})).expect("assistant");
        writeln!(file, "{}", json!({"role":"system","content":"private"})).expect("system");
        let parsed = parse_session(&path, AgentKind::Codex).expect("parse");
        assert_eq!(parsed.provider_session_id, "abc-session");
        assert_eq!(parsed.native_session_id.as_deref(), Some("abc-session"));
        assert_eq!(parsed.messages.len(), 2);
        assert!(
            !parsed
                .messages
                .iter()
                .any(|message| message.content.contains("private"))
        );
    }

    #[test]
    fn large_jsonl_catalogue_sample_keeps_head_and_tail_metadata_with_fixed_io_budget() {
        let temporary = tempfile::tempdir().expect("temp");
        let path = temporary.path().join("large-session.jsonl");
        let mut file = fs::File::create(&path).expect("create");
        writeln!(
            file,
            "{}",
            json!({
                "type": "session",
                "id": "11111111-1111-4111-8111-111111111111",
                "cwd": temporary.path(),
            })
        )
        .expect("header");
        writeln!(
            file,
            "{}",
            json!({
                "type": "message",
                "message": {"role": "user", "content": {"type": "text", "text": "catalogue title"}},
            })
        )
        .expect("head message");
        // Sparse expansion makes the file cross the large-source threshold
        // without making the test itself perform a large write.
        file.set_len(MAX_JSONL_FULL_BYTES + 4096)
            .expect("sparse expand");
        file.seek(SeekFrom::End(-2048)).expect("seek tail");
        writeln!(file).expect("tail separator");
        writeln!(file, "{}", json!({
            "type": "message",
            "message": {"role": "assistant", "content": {"type": "text", "text": "latest tail state"}},
        })).expect("tail message");
        drop(file);

        let parsed = parse_session(&path, AgentKind::Pi).expect("bounded parse");
        assert_eq!(
            parsed.native_session_id.as_deref(),
            Some("11111111-1111-4111-8111-111111111111")
        );
        assert_eq!(parsed.cwd.as_deref(), temporary.path().to_str());
        assert!(
            parsed
                .messages
                .iter()
                .any(|message| message.content == "catalogue title")
        );
        assert!(
            parsed
                .messages
                .iter()
                .any(|message| message.content == "latest tail state")
        );
        assert!(LARGE_HEAD_BYTES + LARGE_TAIL_BYTES <= 128 * 1024);
    }

    #[test]
    fn catalogue_message_budget_keeps_head_tail_semantics_under_64k() {
        let messages = (0..12)
            .map(|index| ParsedMessage {
                role: MessageRole::Assistant,
                kind: "text".to_string(),
                content: format!("message-{index}-{}", "x".repeat(24 * 1024)),
                timestamp: None,
                line: index + 1,
                event_id: None,
            })
            .collect();
        let bounded = bounded_session_messages(messages);
        let persisted_chars = bounded
            .iter()
            .map(|message| message.content.chars().count())
            .sum::<usize>();
        assert!(persisted_chars <= MAX_SESSION_CHARS);
        assert!(
            bounded
                .first()
                .is_some_and(|message| message.content.starts_with("message-0-"))
        );
        assert!(
            bounded
                .last()
                .is_some_and(|message| message.content.starts_with("message-11-"))
        );
        assert!(
            bounded
                .iter()
                .all(|message| message.content.chars().count() <= MAX_MESSAGE_CHARS)
        );
    }

    #[test]
    fn catalogue_caps_many_short_messages_without_dropping_session_identity() {
        let messages = (0..80)
            .map(|index| ParsedMessage {
                role: MessageRole::User,
                kind: "text".to_string(),
                content: format!("message-{index}"),
                timestamp: None,
                line: index + 1,
                event_id: None,
            })
            .collect();
        let bounded = bounded_session_messages(messages);
        assert_eq!(bounded.len(), MAX_SESSION_MESSAGES);
        assert!(bounded.iter().any(|message| message.content == "message-0"));
        assert!(
            bounded
                .iter()
                .any(|message| message.content == "message-11")
        );
        assert!(
            bounded
                .iter()
                .any(|message| message.content == "message-79")
        );
    }

    #[test]
    fn ignores_generic_event_ids_for_session_identity() {
        let temporary = tempfile::tempdir().expect("temp");
        let path = temporary
            .path()
            .join("rollout-2026-09-04T00-00-00-12345678-1234-1234-1234-123456789abc.jsonl");
        let mut file = fs::File::create(&path).expect("create");
        writeln!(
            file,
            "{}",
            json!({"type":"event","payload":{"id":"event-that-must-not-win"}})
        )
        .expect("event");
        writeln!(file, "{}", json!({"type":"response_item","payload":{"type":"message","role":"user","content":"hello"}})).expect("message");
        let parsed = parse_session(&path, AgentKind::Codex).expect("parse");
        assert_eq!(
            parsed.provider_session_id,
            "12345678-1234-1234-1234-123456789abc"
        );
    }

    #[test]
    fn grok_session_identity_uses_its_session_directory() {
        let path = Path::new("C:/Users/test/.grok/sessions/grok-session-42/chat_history.jsonl");
        assert_eq!(
            stable_provider_session_id(path, &AgentKind::Grok),
            "grok-session-42"
        );
    }

    #[test]
    fn grok_session_reads_checkout_from_summary_companion() {
        let temporary = tempfile::tempdir().expect("temp");
        let session_directory = temporary.path().join("grok-session-42");
        fs::create_dir_all(&session_directory).expect("session directory");
        let history = session_directory.join("chat_history.jsonl");
        fs::write(
            &history,
            format!(
                "{}\n",
                json!({"type":"message","role":"user","content":"session smoke"})
            ),
        )
        .expect("history");
        fs::write(
            session_directory.join("summary.json"),
            serde_json::to_vec(&json!({
                "info": {"id": "grok-session-42", "cwd": "E:\\Workspaces\\MyDesk-AgentSession-SmokeTest"},
                "git_root_dir": "E:/Workspaces/MyDesk-AgentSession-SmokeTest/"
            }))
            .expect("summary json"),
        )
        .expect("summary");

        let parsed = parse_session(&history, AgentKind::Grok).expect("parse");
        assert_eq!(
            parsed.cwd.as_deref(),
            Some("E:\\Workspaces\\MyDesk-AgentSession-SmokeTest")
        );
    }

    #[test]
    fn refresh_requires_explicit_roots_and_keeps_each_source_distinct() {
        let temporary = tempfile::tempdir().expect("temp");
        let paths = test_paths(temporary.path());
        let database = Database::open(&paths).expect("database");

        // With no manifest, refresh does not derive or scan USERPROFILE.
        let empty = ProviderIndexer::new(&database, &paths)
            .index_standard_roots()
            .expect("empty refresh");
        assert_eq!(empty.roots, 0);
        assert!(empty.by_provider.iter().all(|provider| provider.roots == 0));

        let roots_dir = temporary.path().join("approved");
        let codex_one = roots_dir.join("codex-one");
        let codex_two = roots_dir.join("codex-two");
        let claude = roots_dir.join("claude");
        let pi = roots_dir.join("pi");
        let grok = roots_dir.join("grok/session-a");
        let apodex = roots_dir.join("apodex");
        for directory in [&codex_one, &codex_two, &claude, &pi, &grok, &apodex] {
            fs::create_dir_all(directory).expect("source directory");
        }
        let codex_source = codex_one.join("same.jsonl");
        let codex_one_content = format!("codex one {}", "x".repeat(MAX_MESSAGE_CHARS));
        let codex_raw = format!(
            "{}\n{}\n",
            json!({"type":"session_meta","payload":{"session_id":"same-native-id","cwd":"Z:/unregistered"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":codex_one_content}}),
        );
        fs::write(&codex_source, &codex_raw).expect("codex source");
        fs::write(
            codex_two.join("same.jsonl"),
            format!("{}\n{}\n", json!({"type":"session_meta","payload":{"session_id":"same-native-id"}}), json!({"type":"response_item","payload":{"type":"message","role":"user","content":"codex two"}})),
        ).expect("second codex source");
        fs::write(
            claude.join("claude.jsonl"),
            format!(
                "{}\n{}\n",
                json!({"type":"session_meta","payload":{"session_id":"claude-native"}}),
                json!({"role":"user","content":"claude message"})
            ),
        )
        .expect("claude source");
        fs::write(
            pi.join("pi.json"),
            serde_json::to_vec(&json!({"session_id":"pi-native", "messages":[{"role":"user","content":"pi message"}]})).expect("pi json"),
        ).expect("pi source");
        fs::write(
            grok.join("chat_history.jsonl"),
            format!(
                "{}\n",
                json!({"session_id":"grok-native", "role":"user","content":"grok message"})
            ),
        )
        .expect("grok source");
        fs::write(
            apodex.join("apodex.json"),
            serde_json::to_vec(&json!({"session_id":"apodex-native", "messages":[{"role":"user","content":"apodex message"}]})).expect("apodex json"),
        ).expect("apodex source");

        save_approved_session_sources(
            &paths,
            vec![
                SessionSourceRoot {
                    agent: AgentKind::Codex,
                    path: codex_one.display().to_string(),
                    exists: false,
                    mode: "ignored".into(),
                    provenance: "test fixture".into(),
                },
                SessionSourceRoot {
                    agent: AgentKind::Codex,
                    path: codex_two.display().to_string(),
                    exists: false,
                    mode: "ignored".into(),
                    provenance: "test fixture".into(),
                },
                SessionSourceRoot {
                    agent: AgentKind::Claude,
                    path: claude.display().to_string(),
                    exists: false,
                    mode: "ignored".into(),
                    provenance: "test fixture".into(),
                },
                SessionSourceRoot {
                    agent: AgentKind::Pi,
                    path: pi.display().to_string(),
                    exists: false,
                    mode: "ignored".into(),
                    provenance: "test fixture".into(),
                },
                SessionSourceRoot {
                    agent: AgentKind::Grok,
                    path: grok.parent().expect("grok root").display().to_string(),
                    exists: false,
                    mode: "ignored".into(),
                    provenance: "test fixture".into(),
                },
                SessionSourceRoot {
                    agent: AgentKind::Apodex,
                    path: apodex.display().to_string(),
                    exists: false,
                    mode: "ignored".into(),
                    provenance: "test fixture".into(),
                },
            ],
        )
        .expect("save approval");

        let report = ProviderIndexer::new(&database, &paths)
            .index_approved_roots()
            .expect("approved refresh");
        assert_eq!(report.roots, 5);
        assert_eq!(report.indexed, 5, "{report:#?}");
        assert!(
            report
                .by_provider
                .iter()
                .all(|provider| provider.coverage == "partial")
        );
        assert_eq!(
            fs::read_to_string(&codex_source).expect("source unchanged"),
            codex_raw
        );

        let sessions = database
            .query_sessions(&SessionQuery {
                limit: 20,
                ..SessionQuery::default()
            })
            .expect("sessions");
        assert_eq!(sessions.len(), 5);
        let same_native = sessions
            .iter()
            .filter(|hit| hit.session.provider_session_id == "same-native-id")
            .collect::<Vec<_>>();
        assert_eq!(same_native.len(), 2);
        assert_ne!(same_native[0].session.id, same_native[1].session.id);
        assert!(
            same_native
                .iter()
                .all(|hit| hit.session.checkout_id.is_none())
        );
        assert!(same_native.iter().all(|hit| {
            hit.session
                .capabilities
                .contains(&SessionCapability::NativeResume)
        }));
        let sampled_message_session = same_native
            .iter()
            .find(|hit| hit.session.title.starts_with("codex one"))
            .expect("long payload session");
        assert_eq!(
            sampled_message_session.session.metadata["source_sampling"]["coverage"],
            "full"
        );
        assert_eq!(
            sampled_message_session.session.metadata["message_sampling"]["coverage"],
            "partial"
        );
        assert_eq!(
            sampled_message_session.session.metadata["catalogue_coverage"],
            "partial"
        );
        let grok = sessions
            .iter()
            .find(|hit| hit.session.provider == AgentKind::Grok)
            .expect("grok session");
        assert!(
            grok
                .session
                .capabilities
                .contains(&SessionCapability::NativeResume)
        );
    }
}
