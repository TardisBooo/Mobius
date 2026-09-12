//! Regenerable, fictional desktop fixtures. Never points at a user's vault.
use anyhow::{Result, ensure};
use mydesk_core::*;
use std::{fs, path::PathBuf};

fn main() -> Result<()> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .expect("isolated verification directory required"),
    );
    ensure!(
        root.is_absolute() && root.starts_with(r"E:\Workspaces\_verification") && !root.exists(),
        "use a fresh directory below E:\\Workspaces\\_verification"
    );
    let paths = WorkspacePaths {
        workspace_root: root.join("workspace"),
        data_root: root.join("vault"),
        artifacts_root: root.join("artifacts"),
        catalog_root: root.join("catalog"),
    };
    fs::create_dir_all(&paths.workspace_root)?;
    let sources = root.join("harness/sessions");
    fs::create_dir_all(&sources)?;
    let desk = MyDesk::open(paths)?;
    let workspace = desk.register_workspace(
        &desk.paths.workspace_root,
        Some("Lineage acceptance fixture".into()),
    )?;
    save_approved_session_sources(
        &desk.paths,
        vec![SessionSourceRoot {
            agent: AgentKind::Codex,
            path: sources.display().to_string(),
            exists: true,
            mode: "manual_read_only".into(),
            provenance: "fictional acceptance fixture".into(),
        }],
    )?;
    for (id, title) in [
        ("a", "Define the retry contract"),
        ("b", "Implement bounded retries"),
        ("c", "Verify failure recovery"),
        ("d", "Merge implementation and verification"),
    ] {
        let path = sources.join(format!("{id}.jsonl"));
        fs::write(
            &path,
            format!(
                "{{\"role\":\"user\",\"content\":\"Fictional acceptance fixture: {title}\"}}\n"
            ),
        )?;
        desk.database.upsert_session(&Session {
            id: format!("fixture-{id}"),
            provider: AgentKind::Codex,
            provider_session_id: format!("native-{id}"),
            checkout_id: Some(workspace.checkouts[0].id.clone()),
            title: title.into(),
            state: SessionState::Indexed,
            capabilities: vec![SessionCapability::Inspect],
            source_path: path.display().to_string(),
            source_available: true,
            started_at: Some("2026-09-11T10:00:00Z".into()),
            updated_at: "2026-09-12T02:00:00Z".into(),
            metadata: serde_json::json!({"fixture":true,"catalogue_coverage":"partial"}),
        })?;
    }
    for (parents, target) in [(vec!["a"], "b"), (vec!["a"], "c"), (vec!["b", "c"], "d")] {
        let entries: Vec<_> = parents.iter().map(|p| format!("fixture-{p}")).collect();
        let graph = desk.prepare_lineage_review(&entries)?;
        let handoff = desk.database.seal_handoff(&HandoffDraft {
            source_session_id: entries[0].clone(),
            target_provider: "codex".into(),
            target_checkout_id: workspace.checkouts[0].id.clone(),
            mode: RelayMode::TakeOver,
            message_ids: vec![],
            payload: serde_json::json!({"entry_session_ids":entries,"trajectory_id":graph.id}),
            token_estimate: 0,
        })?;
        desk.database
            .record_relay_edge(&handoff, &workspace.workspace.id)?;
        let mut session = desk
            .database
            .get_session(&format!("fixture-{target}"))?
            .unwrap();
        session.metadata["mobius_handoff_id"] = serde_json::json!(handoff.id);
        session.started_at = Some(chrono::Utc::now().to_rfc3339());
        desk.database.upsert_session(&session)?;
    }
    println!(
        "{}",
        serde_json::json!({"fixture_root":root,"workspace_id":workspace.workspace.id,"graph":desk.session_lineage(&["fixture-d".into()])?})
    );
    Ok(())
}
