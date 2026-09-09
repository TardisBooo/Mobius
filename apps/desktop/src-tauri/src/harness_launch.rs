//! Read-only compatibility for installed OpenAgents launchers. Never execute or
//! rewrite the launcher to discover its configuration, and never print credentials.
use std::{fs, path::{Path, PathBuf}};
use mydesk_core::AgentKind;

pub struct LaunchPrefix { pub setup: String, pub command: String }

fn quoted_assignment(text: &str, prefix: &str, suffix: &str) -> Option<String> {
    text.lines().find_map(|line| line.trim().strip_prefix(prefix)?.strip_suffix(suffix).map(str::to_owned))
}

pub fn resolve(agent: &AgentKind, executable: &Path) -> Result<LaunchPrefix, String> {
    let direct = || LaunchPrefix { setup: String::new(), command: format!("& {}", super::ps_quote(&executable.to_string_lossy())) };
    if !matches!(agent, AgentKind::Pi | AgentKind::Grok)
        || !executable.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("cmd")) {
        return Ok(direct());
    }
    let shim = fs::read_to_string(executable).map_err(|error| error.to_string())?;
    let Some(launcher) = quoted_assignment(&shim, "set \"LAUNCHER=", "\"") else { return Ok(direct()); };
    let launcher = PathBuf::from(launcher);
    let script = fs::read_to_string(&launcher).map_err(|error| format!("Cannot read Harness launcher: {error}"))?;
    let root = launcher.parent().ok_or("Harness launcher has no directory")?;
    // Recognize this specific wrapper protocol, not arbitrary PowerShell source.
    if !script.contains("GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')") { return Ok(direct()); }
    let model = quoted_assignment(&script, "[string]$Model = '", "'")
        .filter(|value| value.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)))
        .ok_or("Unrecognized Harness model configuration; configure a native CLI on PATH")?;
    let setup = "if (-not $env:DEEPSEEK_API_KEY) { $env:DEEPSEEK_API_KEY=[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User') }; if (-not $env:DEEPSEEK_API_KEY) { throw 'DEEPSEEK_API_KEY is not configured' }; ".to_string();
    let command = match agent {
        AgentKind::Pi if script.contains("packages\\coding-agent\\dist\\bundle\\cli.js") => {
            let node_root = quoted_assignment(&script, "$nodeRoot = '", "'").ok_or("Unrecognized Pi Node location")?;
            let node = PathBuf::from(node_root).join("node.exe");
            let cli = root.join("packages/coding-agent/dist/bundle/cli.js");
            if !node.is_file() || !cli.is_file() { return Err("Pi native runtime or bundle is missing".into()); }
            format!("& {} {} --provider deepseek --model {}", super::ps_quote(&node.to_string_lossy()), super::ps_quote(&cli.to_string_lossy()), super::ps_quote(&model))
        }
        AgentKind::Grok if script.contains("target\\release\\xai-grok-pager.exe") => {
            let binary = root.join("target/release/xai-grok-pager.exe");
            if !binary.is_file() { return Err("Grok native runtime is missing".into()); }
            format!("& {} --model {}", super::ps_quote(&binary.to_string_lossy()), super::ps_quote(&model))
        }
        _ => return Ok(direct()),
    };
    Ok(LaunchPrefix { setup, command })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_native_launch_is_quoted_without_reading_scripts() {
        let prefix = resolve(&AgentKind::Pi, Path::new("C:/program's files/pi.exe")).unwrap();
        assert_eq!(prefix.command, "& 'C:/program''s files/pi.exe'");
        assert!(prefix.setup.is_empty());
    }
}
