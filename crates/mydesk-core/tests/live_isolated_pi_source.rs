//! Opt-in verification for a Pi session created inside the Möbius test root.
//!
//! This deliberately has no default fixture path and never changes HOME,
//! USERPROFILE, CODEX_HOME, or a provider configuration directory.  It runs
//! only when the caller supplies an already-created session directory beneath
//! `E:\Workspaces\Mobius-Verification-20260907`.

use mydesk_core::{AgentKind, MyDesk, SessionQuery, SessionSourceRoot, WorkspacePaths};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

const VERIFICATION_ROOT: &str = r"E:\Workspaces\Mobius-Verification-20260907";
const DATA_ROOT: &str = r"D:\DataVault\Mobius-Verification-20260907\runs\run-010-harness";
const ARTIFACTS_ROOT: &str =
    r"D:\AcceptedArtifacts\Mobius-Verification-20260907\runs\run-010-harness";
const CATALOG_ROOT: &str = r"D:\Catalog\Mobius-Verification-20260907\runs\run-010-harness";
const MARKER: &str = "MOBIUS_PI_ISOLATED_OK_20260907";

fn file_hashes(root: &Path) -> anyhow::Result<BTreeMap<String, String>> {
    let mut output = BTreeMap::new();
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && !entry.file_type().is_symlink())
    {
        let mut hash = Sha256::new();
        hash.update(fs::read(entry.path())?);
        output.insert(
            entry.path().display().to_string(),
            hex::encode(hash.finalize()),
        );
    }
    Ok(output)
}

#[test]
fn indexes_only_an_explicit_live_pi_test_source_without_resuming() -> anyhow::Result<()> {
    let Some(source_root) = std::env::var_os("MOBIUS_LIVE_PI_SESSION_ROOT").map(PathBuf::from)
    else {
        // Normal test runs intentionally have no live-Harness dependency.
        return Ok(());
    };
    let verification_root = PathBuf::from(VERIFICATION_ROOT).canonicalize()?;
    let source_root = source_root.canonicalize()?;
    assert!(source_root.starts_with(&verification_root));
    assert!(source_root.is_dir());

    let before = file_hashes(&source_root)?;
    assert!(
        !before.is_empty(),
        "the isolated Pi source must contain a session"
    );
    let paths = WorkspacePaths {
        workspace_root: verification_root.join("runs/run-010-harness"),
        data_root: PathBuf::from(DATA_ROOT).join("mobius-live-pi-index-attempt-005"),
        artifacts_root: PathBuf::from(ARTIFACTS_ROOT).join("mobius-live-pi-index-attempt-005"),
        catalog_root: PathBuf::from(CATALOG_ROOT).join("mobius-live-pi-index-attempt-005"),
    };
    let desk = MyDesk::open(paths.clone())?;
    let manifest = desk.set_approved_session_sources(vec![SessionSourceRoot {
        agent: AgentKind::Pi,
        path: source_root.display().to_string(),
        exists: true,
        mode: "user-approved-live-isolation".to_string(),
        provenance: "run-010 controlled test".to_string(),
    }])?;
    assert_eq!(manifest.roots.len(), 1);
    assert_eq!(manifest.roots[0].agent, AgentKind::Pi);
    assert_eq!(Path::new(&manifest.roots[0].path), source_root);

    let first = desk.index_all_provider_sessions()?;
    assert_eq!(
        first.roots, 1,
        "refresh must traverse exactly the approved root"
    );
    assert_eq!(
        first.indexed, 1,
        "one actual Pi session should be indexed: {first:#?}"
    );
    assert_eq!(first.errors.len(), 0);
    let pi_report = first
        .by_provider
        .iter()
        .find(|report| report.provider == AgentKind::Pi)
        .expect("Pi must have a provider report");
    assert_eq!(pi_report.roots, 1);
    assert_eq!(pi_report.coverage, "partial");

    let sessions = desk.database.query_sessions(&SessionQuery {
        limit: 10,
        ..SessionQuery::default()
    })?;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session.provider, AgentKind::Pi);
    let marker_hits = desk.database.query_sessions(&SessionQuery {
        query: MARKER.to_string(),
        limit: 10,
        ..SessionQuery::default()
    })?;
    assert!(marker_hits.iter().any(|hit| {
        hit.message
            .as_ref()
            .is_some_and(|message| message.content.contains(MARKER))
    }));

    // This test never calls a resume command.  The second refresh validates
    // incremental, read-only source indexing instead.
    let second = desk.index_all_provider_sessions()?;
    assert_eq!(second.indexed, 0);
    assert_eq!(second.unchanged, 1);
    let after = file_hashes(&source_root)?;
    assert_eq!(before, after, "Möbius must not alter the provider history");

    fs::create_dir_all(&paths.catalog_root)?;
    fs::write(
        paths.catalog_root.join("mobius-live-pi-index.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "source_root": source_root,
            "manifest": manifest,
            "first_refresh": first,
            "second_refresh": second,
            "source_hashes_before": before,
            "source_hashes_after": after,
            "native_resume_invoked": false,
        }))?,
    )?;
    Ok(())
}
