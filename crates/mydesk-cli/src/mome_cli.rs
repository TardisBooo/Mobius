//! CLI-only adapter for explicit Mome recall.
//!
//! This module deliberately has no terminal/PTY code. A Harness hook may read
//! its JSON response and decide what its *official* extension API supports,
//! but Möbius never types or pastes data into a terminal.

use anyhow::{Context, Result, bail};
use mydesk_core::{AgentKind, MomeRecallResponse};
use serde::Serialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

const PACKET_KIND: &str = "mobius_mome_context_packet";
pub(crate) const DEFAULT_OLLAMA_EMBEDDING_MODEL: &str = "nomic-embed-text";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MomeContextPacket {
    pub kind: &'static str,
    pub version: u8,
    pub additional_context: String,
    pub citations: Vec<PacketCitation>,
    pub retrieval: MomeRecallResponse,
    pub safety: PacketSafety,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PacketCitation {
    pub provider: AgentKind,
    pub session_id: String,
    pub session_record_id: String,
    pub message_range: String,
    pub citation: String,
    pub content_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PacketSafety {
    pub explicit_recall_only: bool,
    pub pty_injection: bool,
    pub raw_sessions_modified: bool,
}

/// A deterministic packet can be copied into any provider, independently of
/// whether that provider has an official hook integration.
pub(crate) fn packet_from_recall(response: &MomeRecallResponse) -> MomeContextPacket {
    let citations = response
        .sources
        .iter()
        .map(|source| PacketCitation {
            provider: source.provider.clone(),
            session_id: source.session_id.clone(),
            session_record_id: source.session_record_id.clone(),
            message_range: format!("m{}-m{}", source.start_ordinal, source.end_ordinal),
            citation: source.citation.clone(),
            content_hash: source.content_hash.clone(),
        })
        .collect();

    MomeContextPacket {
        kind: PACKET_KIND,
        version: 1,
        additional_context: render_additional_context(response),
        citations,
        retrieval: response.clone(),
        safety: PacketSafety {
            explicit_recall_only: true,
            pty_injection: false,
            raw_sessions_modified: false,
        },
    }
}

fn render_additional_context(response: &MomeRecallResponse) -> String {
    if response.sources.is_empty() {
        return String::new();
    }

    response
        .sources
        .iter()
        .map(|source| format!("[{}]\n{}", source.citation, source.text.trim()))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Return a query only when the entire prompt follows the opt-in spelling.
/// In particular, ordinary `@` mentions and a bare `@mome` are never recall
/// requests. This is intentionally case-sensitive so a provider cannot make
/// ambient context collection look like an explicit user action.
pub(crate) fn explicit_mome_query(prompt: &str) -> Option<String> {
    let query = prompt.strip_prefix("@mome ")?.trim();
    (!query.is_empty()).then(|| query.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HookResponse {
    pub kind: &'static str,
    pub version: u8,
    pub provider: AgentKind,
    pub matched_explicit_mome: bool,
    pub additional_context: String,
    pub packet: Option<MomeContextPacket>,
    pub delivery: &'static str,
    pub pty_injection: bool,
    pub cwd: Option<String>,
}

pub(crate) fn hook_response(
    provider: AgentKind,
    prompt: &str,
    cwd: Option<&Path>,
    recall: Option<&MomeRecallResponse>,
) -> HookResponse {
    // `recall` is accepted only when the same literal opt-in condition holds;
    // callers cannot accidentally turn a generic hook invocation into recall.
    let matched = explicit_mome_query(prompt).is_some() && recall.is_some();
    let packet = matched.then(|| packet_from_recall(recall.expect("matched recall")));
    let additional_context = packet
        .as_ref()
        .map(|value| value.additional_context.clone())
        .unwrap_or_default();
    HookResponse {
        kind: "mobius_mome_hook_response",
        version: 1,
        provider,
        matched_explicit_mome: matched,
        additional_context,
        packet,
        delivery: "hook_response_only",
        pty_injection: false,
        cwd: cwd.map(|path| path.display().to_string()),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DoctorReport {
    pub kind: &'static str,
    pub version: u8,
    pub read_only: bool,
    pub writes_harness_configuration: bool,
    /// Mome recall remains lexical until a vector backend is implemented. This
    /// makes an installed external model visible without claiming it is used.
    pub semantic_retrieval_enabled: bool,
    pub local_model_runtime: LocalModelStatus,
    pub capabilities: Vec<ProviderCapability>,
}

/// Read-only observation of the conventional Ollama local model runtime.
/// The command is never run by Mome recall and this report never downloads.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalModelStatus {
    pub runtime: &'static str,
    pub model: String,
    pub executable_found: bool,
    pub executable_path: Option<String>,
    pub model_installed: bool,
    pub installed_models: Vec<String>,
    pub inspection_error: Option<String>,
    pub semantic_retrieval_enabled: bool,
    pub install_requires_explicit_download_acceptance: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCapability {
    pub provider: AgentKind,
    pub executable: String,
    pub executable_found: bool,
    pub executable_path: Option<String>,
    pub existing_configuration_found: bool,
    pub existing_configuration_paths: Vec<String>,
    pub mome_delivery: &'static str,
    pub automatic_injection: bool,
    pub note: &'static str,
}

/// Doctor only observes PATH and conventional config paths. It neither parses
/// configuration contents nor creates missing configuration files.
pub(crate) fn doctor_report() -> DoctorReport {
    let capabilities = [
        provider_capability(
            AgentKind::Codex,
            "codex",
            "official_hook_after_doctor",
            true,
            "Official Hook/Extension integration may be enabled only by an explicit installer target.",
        ),
        provider_capability(
            AgentKind::Claude,
            "claude",
            "official_hook_after_doctor",
            true,
            "Official Hook/Extension integration may be enabled only by an explicit installer target.",
        ),
        provider_capability(
            AgentKind::Pi,
            "pi",
            "official_hook_after_doctor",
            true,
            "Official Hook/Extension integration may be enabled only by an explicit installer target.",
        ),
        provider_capability(
            AgentKind::Grok,
            "grok",
            "mcp_or_copy_packet",
            false,
            "Use explicit MCP recall or copy the packet; no prompt hook is installed.",
        ),
    ];
    DoctorReport {
        kind: "mobius_mome_doctor_report",
        version: 1,
        read_only: true,
        writes_harness_configuration: false,
        semantic_retrieval_enabled: false,
        local_model_runtime: local_model_status(DEFAULT_OLLAMA_EMBEDDING_MODEL),
        capabilities: capabilities.into(),
    }
}

/// Inspect the local Ollama CLI only. `ollama ls` reads its local registry;
/// it is intentionally not a pull, and the result is advisory rather than a
/// claim that Mome semantic retrieval is enabled.
pub(crate) fn local_model_status(model: &str) -> LocalModelStatus {
    let executable = find_executable("ollama");
    let executable_path = executable.as_ref().map(|path| path.display().to_string());
    let mut installed_models = Vec::new();
    let mut inspection_error = None;
    if let Some(path) = executable {
        match Command::new(&path).arg("ls").output() {
            Ok(output) if output.status.success() => {
                installed_models = parse_ollama_list(&String::from_utf8_lossy(&output.stdout));
            }
            Ok(output) => {
                inspection_error = Some(format!(
                    "ollama ls exited with {}; {}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            Err(error) => inspection_error = Some(format!("could not run ollama ls: {error}")),
        }
    }
    let model_installed = installed_models
        .iter()
        .any(|installed| same_ollama_model(installed, model));
    LocalModelStatus {
        runtime: "ollama",
        model: model.to_string(),
        executable_found: executable_path.is_some(),
        executable_path,
        model_installed,
        installed_models,
        inspection_error,
        semantic_retrieval_enabled: false,
        install_requires_explicit_download_acceptance: true,
    }
}

/// Download exactly the named model only after the caller has made the
/// network-affecting choice explicit. It is never called by recall or doctor.
pub(crate) fn install_local_model(model: &str, accept_download: bool) -> Result<LocalModelStatus> {
    validate_ollama_model(model)?;
    if !accept_download {
        bail!(
            "Refusing to download a model without --accept-download. Inspect first with `mobius mome model status --model {model}`."
        );
    }
    let executable = find_executable("ollama").context(
        "Ollama was not found on PATH. Install and start Ollama yourself, then rerun this explicit command.",
    )?;
    let status = Command::new(&executable)
        .arg("pull")
        .arg(model)
        .status()
        .context("starting explicit `ollama pull`")?;
    if !status.success() {
        bail!("ollama pull {model} exited with {status}");
    }
    Ok(local_model_status(model))
}

fn validate_ollama_model(model: &str) -> Result<()> {
    if model.is_empty()
        || model.len() > 128
        || !model.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, ':' | '/' | '_' | '-' | '.')
        })
    {
        bail!("Invalid Ollama model name. Use a registry-style name such as nomic-embed-text.");
    }
    Ok(())
}

fn parse_ollama_list(output: &str) -> Vec<String> {
    output
        .lines()
        .skip(1) // NAME ID SIZE MODIFIED
        .filter_map(|line| line.split_whitespace().next())
        .map(str::to_string)
        .collect()
}

fn same_ollama_model(installed: &str, requested: &str) -> bool {
    installed == requested
        || installed.strip_suffix(":latest") == Some(requested)
        || requested.strip_suffix(":latest") == Some(installed)
}

fn provider_capability(
    provider: AgentKind,
    executable: &str,
    mome_delivery: &'static str,
    automatic_injection: bool,
    note: &'static str,
) -> ProviderCapability {
    let configuration_paths = known_configuration_paths(&provider);
    let present_configs = configuration_paths
        .iter()
        .filter(|path| path.exists())
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>();
    let executable_path = find_executable(executable).map(|path| path.display().to_string());
    ProviderCapability {
        provider,
        executable: executable.to_string(),
        executable_found: executable_path.is_some(),
        executable_path,
        existing_configuration_found: !present_configs.is_empty(),
        existing_configuration_paths: present_configs,
        mome_delivery,
        automatic_injection,
        note,
    }
}

fn known_configuration_paths(provider: &AgentKind) -> Vec<PathBuf> {
    let Some(home) = user_home_dir() else {
        return Vec::new();
    };
    let names: &[&str] = match provider {
        AgentKind::Codex => &[".codex/config.toml", ".codex/config.json"],
        AgentKind::Claude => &[".claude.json", ".claude/settings.json"],
        AgentKind::Pi => &[".pi/config.json", ".pi/settings.json"],
        AgentKind::Grok => &[".grok/config.json", ".config/grok/config.json"],
        AgentKind::Apodex | AgentKind::Unknown => &[],
    };
    names.iter().map(|name| home.join(name)).collect()
}

fn user_home_dir() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let direct_names = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
        ]
    } else {
        vec![name.to_string()]
    };
    let paths = env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    for directory in paths {
        for candidate in &direct_names {
            let path = directory.join(candidate);
            if fs::metadata(&path)
                .map(|metadata| metadata.is_file())
                .unwrap_or(false)
            {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use mydesk_core::{MomeRecallResponse, MomeSemanticStatus, MomeSource};

    fn recall() -> MomeRecallResponse {
        MomeRecallResponse {
            query: "remember the migration".into(),
            retrieval_mode: "lexical_bm25".into(),
            semantic_status: MomeSemanticStatus::LexicalOnlyNoSemanticBackendConfigured,
            max_tokens: 1200,
            estimated_tokens: 4,
            sources: vec![MomeSource {
                provider: AgentKind::Codex,
                session_id: "native-session".into(),
                session_record_id: "record-1".into(),
                start_ordinal: 2,
                end_ordinal: 4,
                citation: "@session:codex/native-session#m2-m4".into(),
                content_hash: "abc123".into(),
                text: "Keep source JSONL read-only.".into(),
                estimated_tokens: 4,
            }],
        }
    }

    #[test]
    fn prompt_must_use_exact_explicit_mome_prefix() {
        assert_eq!(
            explicit_mome_query("@mome find migrations"),
            Some("find migrations".into())
        );
        assert_eq!(explicit_mome_query(" @mome find migrations"), None);
        assert_eq!(explicit_mome_query("@Mome find migrations"), None);
        assert_eq!(explicit_mome_query("@mome"), None);
    }

    #[test]
    fn packet_keeps_precise_citation_and_no_injection() {
        let packet = packet_from_recall(&recall());
        assert_eq!(packet.kind, PACKET_KIND);
        assert!(
            packet
                .additional_context
                .contains("@session:codex/native-session#m2-m4")
        );
        assert_eq!(packet.citations[0].message_range, "m2-m4");
        assert!(!packet.safety.pty_injection);
        let json = serde_json::to_value(&packet).expect("packet JSON");
        assert!(json.get("additionalContext").is_some());
        assert!(json["citations"][0].get("messageRange").is_some());
    }

    #[test]
    fn hook_returns_empty_context_for_ordinary_prompt() {
        let hook = hook_response(
            AgentKind::Codex,
            "please recall migration",
            None,
            Some(&recall()),
        );
        assert!(!hook.matched_explicit_mome);
        assert!(hook.additional_context.is_empty());
        assert!(hook.packet.is_none());
        assert!(!hook.pty_injection);
    }

    #[test]
    fn doctor_is_always_declared_read_only() {
        let report = doctor_report();
        assert!(report.read_only);
        assert!(!report.writes_harness_configuration);
        assert_eq!(report.capabilities.len(), 4);
        assert!(!report.semantic_retrieval_enabled);
        assert!(!report.local_model_runtime.semantic_retrieval_enabled);
    }

    #[test]
    fn ollama_model_names_are_checked_without_shelling_out() {
        assert!(validate_ollama_model("nomic-embed-text").is_ok());
        assert!(validate_ollama_model("org/model:latest").is_ok());
        assert!(validate_ollama_model("model;curl").is_err());
        assert!(same_ollama_model(
            "nomic-embed-text:latest",
            "nomic-embed-text"
        ));
        assert_eq!(
            parse_ollama_list("NAME ID SIZE MODIFIED\nnomic-embed-text:latest abc 1GB now\n"),
            vec!["nomic-embed-text:latest"]
        );
    }
}
