use mydesk_core::note_mounts::list_note_files;
use mydesk_core::{
    AgentKind, BoardDocument, MyDesk, NoteDraft, SessionCapability, SessionQuery,
    SessionSourceRoot, WorkspacePaths, save_approved_session_sources,
    skills::discover_standard_skills,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

const VERIFICATION_ROOT: &str = r"E:\Workspaces\Mobius-Verification-20260907";
const DATA_ROOT: &str = r"D:\DataVault\Mobius-Verification-20260907\runs\run-001";
const ARTIFACTS_ROOT: &str = r"D:\AcceptedArtifacts\Mobius-Verification-20260907\runs\run-001";
const CATALOG_ROOT: &str = r"D:\Catalog\Mobius-Verification-20260907\runs\run-001";

fn verification_root() -> PathBuf {
    std::env::var_os("MOBIUS_VERIFICATION_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(VERIFICATION_ROOT))
}

fn acceptance_id() -> String {
    let prefix = std::env::var("MOBIUS_ACCEPTANCE_ID").unwrap_or_else(|_| "attempt".into());
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let value = format!("{prefix}-p{}-{nonce}", std::process::id());
    assert!(
        !value.is_empty()
            && value
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-'),
        "MOBIUS_ACCEPTANCE_ID must be a simple new directory name"
    );
    value
}

fn paths(root: &Path, acceptance_id: &str) -> WorkspacePaths {
    WorkspacePaths {
        // This is a read-only project/skill fixture, not application state.
        // All mutable M枚bius state below receives an execution-unique root.
        workspace_root: root.join("workspaces/relay-demo"),
        data_root: PathBuf::from(DATA_ROOT)
            .join("isolated-acceptance")
            .join(acceptance_id),
        artifacts_root: PathBuf::from(ARTIFACTS_ROOT)
            .join("isolated-acceptance")
            .join(acceptance_id),
        catalog_root: PathBuf::from(CATALOG_ROOT)
            .join("isolated-acceptance")
            .join(acceptance_id),
    }
}

fn source_hashes(roots: &[PathBuf]) -> BTreeMap<String, String> {
    let mut hashes = BTreeMap::new();
    for root in roots {
        let entries = walkdir::WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file() && !entry.file_type().is_symlink());
        for entry in entries {
            let bytes = fs::read(entry.path()).expect("read isolated source fixture");
            let mut hash = Sha256::new();
            hash.update(&bytes);
            hashes.insert(
                entry.path().display().to_string(),
                hex::encode(hash.finalize()),
            );
        }
    }
    hashes
}

#[test]
#[ignore = "Requires a separately provisioned Windows verification fixture; set MOBIUS_VERIFICATION_ROOT and run with --ignored"]
fn isolated_provider_and_vault_acceptance() -> anyhow::Result<()> {
    let root = verification_root();
    let run = root.join("runs/run-001");
    assert!(run.is_dir(), "isolated verification run is missing");
    let workspace = root.join("workspaces/relay-demo");
    let feature_workspace = root.join("workspaces/relay-demo-feature");
    let unapproved_cwd = run.join("fixtures/unapproved/no-auto-register");
    let acceptance_id = acceptance_id();

    // This process sees only the version-controlled fixture profile.  These
    // are process-local environment variables (not a user configuration
    // write), required by the global-skill fixture; session roots are still
    // explicitly approved below and remain read-only.
    unsafe {
        std::env::set_var("USERPROFILE", root.join("agent-homes"));
        std::env::set_var("CODEX_HOME", root.join("agent-homes/codex"));
    }

    let paths = paths(&root, &acceptance_id);
    let desk = MyDesk::open(paths.clone())?;
    let inspection = desk.register_workspace(&workspace, Some("relay-demo"))?;
    assert!(
        inspection.checkouts.len() >= 2,
        "the only approved Git worktree pair must be visible"
    );

    let source_roots = vec![
        (AgentKind::Codex, root.join("agent-homes/codex/sessions")),
        (AgentKind::Claude, root.join("agent-homes/.claude/projects")),
        (AgentKind::Pi, root.join("agent-homes/.pi/agent/sessions")),
        (AgentKind::Grok, root.join("agent-homes/.grok/sessions")),
        (AgentKind::Apodex, root.join("agent-homes/.apodex/sessions")),
    ];
    let source_paths = source_roots
        .iter()
        .map(|(_, path)| path.clone())
        .collect::<Vec<_>>();
    let before = source_hashes(&source_paths);
    save_approved_session_sources(
        &paths,
        source_roots
            .iter()
            .map(|(agent, path)| SessionSourceRoot {
                agent: agent.clone(),
                path: path.display().to_string(),
                exists: true,
                mode: "fixture-approved".to_string(),
                provenance: "isolated fixture".to_string(),
            })
            .collect(),
    )?;

    let report = desk.index_all_provider_sessions()?;
    assert_eq!(report.roots, 4, "retired providers must not be scanned");
    assert_eq!(report.indexed, 5, "all supported provider fixtures index once");
    assert!(
        report.skipped >= 1,
        "the malformed fixture must be reported"
    );
    assert_eq!(report.by_provider.len(), 4);
    assert!(
        report
            .by_provider
            .iter()
            .all(|provider| provider.coverage == "partial")
    );
    let second_report = desk.index_all_provider_sessions()?;
    assert_eq!(second_report.indexed, 0, "second index is incremental");
    assert_eq!(
        second_report.unchanged, 5,
        "five supported fixture sources are unchanged"
    );

    let all_sessions = desk.database.query_sessions(&SessionQuery {
        limit: 20,
        ..SessionQuery::default()
    })?;
    assert_eq!(all_sessions.len(), 5);
    assert!(all_sessions.iter().all(|hit| hit.session.provider.is_supported()));
    assert!(all_sessions.iter().all(|hit| {
        !Path::new(&hit.session.source_path)
            .starts_with(root.join("runs/run-001/fixtures/unapproved"))
    }));
    assert!(
        desk.database
            .list_workspaces_v2()?
            .iter()
            .all(|item| Path::new(&item.canonical_path) != unapproved_cwd)
    );

    let shared_native_id = "11111111-1111-4111-8111-111111111111";
    let collision_sessions = all_sessions
        .iter()
        .filter(|hit| hit.session.provider_session_id == shared_native_id)
        .collect::<Vec<_>>();
    assert_eq!(
        collision_sessions.len(),
        3,
        "fixture keeps native-id collisions"
    );
    assert_eq!(
        collision_sessions
            .iter()
            .map(|hit| hit.session.id.as_str())
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        3,
        "internal session identities must remain collision-safe"
    );
    for hit in collision_sessions {
        assert!(matches!(
            hit.session.provider,
            AgentKind::Codex | AgentKind::Claude | AgentKind::Pi
        ));
        assert!(
            hit.session
                .capabilities
                .contains(&SessionCapability::NativeResume)
        );
    }
    for hit in all_sessions
        .iter()
        .filter(|hit| matches!(hit.session.provider, AgentKind::Grok | AgentKind::Apodex))
    {
        assert!(
            !hit.session
                .capabilities
                .contains(&SessionCapability::NativeResume)
        );
    }

    let pi = all_sessions
        .iter()
        .find(|hit| hit.session.provider == AgentKind::Pi)
        .expect("Pi fixture is indexed");
    assert_eq!(
        pi.session.checkout_id, None,
        "unregistered cwd stays unassigned"
    );

    let matches = desk.database.query_sessions(&SessionQuery {
        query: "MOBIUS_FIXTURE_CLAUDE_SHARED_ID".to_string(),
        limit: 5,
        ..SessionQuery::default()
    })?;
    assert_eq!(matches.len(), 1);
    assert!(
        !matches[0].ranges.is_empty(),
        "search response includes highlight ranges"
    );
    let redacted = desk.database.query_sessions(&SessionQuery {
        query: "MOBIUS_FIXTURE_REDACTION".to_string(),
        limit: 5,
        ..SessionQuery::default()
    })?;
    let redacted_message = redacted
        .iter()
        .filter_map(|hit| hit.message.as_ref())
        .find(|message| {
            message.content.contains("[REDACTED]") || message.content.contains("api_key")
        })
        .expect("redacted credential-bearing message");
    assert!(redacted_message.content.contains("[REDACTED]"));
    assert!(!redacted_message.content.contains("fixture_sensitive_token"));

    let note = desk.create_or_update_note(NoteDraft {
        title: "Isolated acceptance note".to_string(),
        body: "MOBIUS_FIXTURE_NOTE body".to_string(),
        project_slug: Some("relay-demo".to_string()),
        tags: vec!["fixture".to_string()],
        source_ids: Vec::new(),
    })?;
    assert!(
        note.source_path
            .as_ref()
            .is_some_and(|path| Path::new(path).exists())
    );

    let mounted_library = root.join("mounted-library");
    let mounted_before = source_hashes(&[mounted_library.clone()]);
    let mount = desk
        .database
        .add_note_mount(&mounted_library, "mounted-fixture", "read_only")?;
    let mounted_files = list_note_files(&paths, &[mount]);
    assert!(
        mounted_files?
            .iter()
            .any(|file| file.title == "isolated-mounted-note")
    );
    assert_eq!(mounted_before, source_hashes(&[mounted_library]));

    let board = BoardDocument {
        id: "fixture-board-20260907".to_string(),
        title: "Isolated media board".to_string(),
        project_slug: Some("relay-demo".to_string()),
        data: json!({
            "nodes": [{
                "kind": "media",
                "file_name": "fixture-media.txt",
                "fixture_path": run.join("fixtures/media/fixture-media.txt").display().to_string()
            }]
        }),
        updated_at: "2026-09-07T10:00:00Z".to_string(),
    };
    desk.save_board(board.clone())?;
    let board_files = fs::read_dir(paths.boards_dir())?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".board.json"))
        .collect::<Vec<_>>();
    assert_eq!(
        board_files.len(),
        1,
        "board save/list fixture has one board"
    );
    let persisted: BoardDocument = serde_json::from_slice(&fs::read(board_files[0].path())?)?;
    assert_eq!(persisted.id, board.id);
    assert_eq!(persisted.data["nodes"][0]["kind"], "media");

    let skills = discover_standard_skills(&paths, Some("all"))?;
    assert!(
        skills
            .iter()
            .any(|skill| skill.name == "fixture-global" && skill.scope == "global")
    );
    assert!(
        skills
            .iter()
            .any(|skill| skill.name == "fixture-project" && skill.scope == "project")
    );

    let after = source_hashes(&source_paths);
    assert_eq!(before, after, "indexing must never write source histories");

    fs::create_dir_all(&paths.catalog_root)?;
    let output = json!({
        "suite": "isolated_provider_and_vault_acceptance",
        "verification_root": root,
        "approved_session_roots": source_paths,
        "registered_workspace": inspection.workspace,
        "registered_checkouts": inspection.checkouts,
        "provider_report": report,
        "second_provider_report": second_report,
        "sessions": all_sessions,
        "search": { "query": "MOBIUS_FIXTURE_CLAUDE_SHARED_ID", "matches": matches },
        "source_hashes_before": before,
        "source_hashes_after": after,
        "assertions": {
            "unknown_cwd_not_registered": true,
            "native_resume_only_verified_adapters": true,
            "source_files_unchanged": true,
            "logical_mount_unchanged": true,
            "board_media_reference_persisted": true,
            "global_and_project_skills_discovered": true
        }
    });
    fs::write(
        paths.catalog_root.join("isolated-core-acceptance.json"),
        serde_json::to_vec_pretty(&output)?,
    )?;
    assert!(feature_workspace.exists());
    Ok(())
}
