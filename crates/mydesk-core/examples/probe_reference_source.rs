//! Read-only reference preparation probe for an explicitly supplied source.
//! Uses a disposable independent catalogue; never opens the production database.
use anyhow::{Result, ensure};
use mydesk_core::*;
use std::{fs, path::PathBuf, time::Instant};

fn main() -> Result<()> {
    let source = PathBuf::from(std::env::args().nth(1).expect("explicit Codex source required"));
    ensure!(source.is_absolute() && source.is_file(), "source must be an existing absolute file");
    let identity = providers::codex_source_identity(&source)?;
    let root = tempfile::tempdir()?;
    let desk = MyDesk::open(WorkspacePaths {
        workspace_root: root.path().join("workspace"), data_root: root.path().join("vault"),
        artifacts_root: root.path().join("artifacts"), catalog_root: root.path().join("catalog"),
    })?;
    save_approved_session_sources(&desk.paths, vec![SessionSourceRoot {
        agent: AgentKind::Codex, path: source.parent().unwrap().display().to_string(), exists: true,
        mode: "manual_read_only".into(), provenance: "explicit source verification".into(),
    }])?;
    let session = Session { id: "probe-source".into(), provider: AgentKind::Codex,
        provider_session_id: identity.id, checkout_id: None,
        title: "Explicit source verification".into(), state: SessionState::Indexed, capabilities: vec![],
        source_path: source.display().to_string(), source_available: true, started_at: None,
        updated_at: String::new(), metadata: serde_json::json!({}),
    };
    desk.database.upsert_session(&session)?;
    let before = fs::metadata(&source)?;
    let started = Instant::now();
    let review = desk.prepare_trajectory(&session.id)?;
    let prompt = desk.trajectory_launch_context(&review.id, &session.id)?;
    let elapsed_ms = started.elapsed().as_millis();
    let after = fs::metadata(&source)?;
    println!("{}", serde_json::json!({
        "source_bytes":before.len(),"graph_bytes":review.bytes,"preparation_and_validation_ms":elapsed_ms,
        "mode":"references_only","source_count":review.source_count,
        "source_metadata_unchanged_during_probe":before.len()==after.len() && before.modified()?==after.modified()?,
        "full_source_copy_created":desk.paths.data_root.join("handoff-trajectories").exists(),
        "prompt_forces_full_read":prompt.contains("to EOF"),
    }));
    Ok(())
}
