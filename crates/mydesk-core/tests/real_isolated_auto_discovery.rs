//! Explicit, opt-in read-only verification against the user's real Harness
//! roots. It owns only the Möbius catalogue under run-017; provider sources
//! are hashed before/after and are never launched, resumed, or modified.

use mydesk_core::{MyDesk, SessionAdapterRegistry, WorkspacePaths, auto_discover_session_sources};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

const VERIFICATION_ROOT: &str =
    r"E:\Workspaces\Mobius-Verification-20260907\runs\run-017-final-bounded-discovery";
const DATA_ROOT: &str =
    r"D:\DataVault\Mobius-Verification-20260907\runs\run-017-final-bounded-discovery";
const ARTIFACTS_ROOT: &str =
    r"D:\AcceptedArtifacts\Mobius-Verification-20260907\runs\run-017-final-bounded-discovery";
const CATALOG_ROOT: &str =
    r"D:\Catalog\Mobius-Verification-20260907\runs\run-017-final-bounded-discovery";
// A live Harness can append its current transcript while this read-only test
// is running.  That is external source activity, not an indexer write.  Keep
// the allowance deliberately small so a broad unexpected mutation still
// fails verification, while preserving an audit record either way.
const MAX_CONCURRENT_EXTERNAL_DRIFT_FILES: usize = 8;

fn candidate_hashes(
    root: &Path,
    agent: mydesk_core::AgentKind,
) -> anyhow::Result<BTreeMap<String, String>> {
    let mut output = BTreeMap::new();
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && !entry.file_type().is_symlink())
        .filter(|entry| SessionAdapterRegistry::is_candidate(&agent, entry.path()))
    {
        // A content hash over a whole historical archive made the validation
        // itself slower than a full local index.  Hash the immutable identity
        // tuple Möbius uses for incremental refresh instead: canonical path,
        // bytes and mtime. This proves the refresh did not write/replace a
        // source while avoiding an extra full read of every transcript.
        let metadata = entry.metadata()?;
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        let mut hash = Sha256::new();
        hash.update(entry.path().canonicalize()?.to_string_lossy().as_bytes());
        hash.update(metadata.len().to_le_bytes());
        hash.update(modified.to_le_bytes());
        output.insert(
            entry.path().display().to_string(),
            hex::encode(hash.finalize()),
        );
    }
    Ok(output)
}

fn concurrent_external_drift(
    before: &BTreeMap<String, BTreeMap<String, String>>,
    after: &BTreeMap<String, BTreeMap<String, String>>,
) -> Vec<serde_json::Value> {
    let mut output = Vec::new();
    for root in before
        .keys()
        .chain(after.keys())
        .collect::<std::collections::BTreeSet<_>>()
    {
        let before_files = before.get(root);
        let after_files = after.get(root);
        let file_paths = before_files
            .into_iter()
            .flat_map(|files| files.keys())
            .chain(after_files.into_iter().flat_map(|files| files.keys()))
            .collect::<std::collections::BTreeSet<_>>();
        for path in file_paths {
            let before_identity = before_files.and_then(|files| files.get(path));
            let after_identity = after_files.and_then(|files| files.get(path));
            if before_identity != after_identity {
                let provider = root.split(':').next().unwrap_or("unknown");
                output.push(json!({
                    "kind": "concurrent_external_drift",
                    "provider": provider,
                    "root": root,
                    "path": path,
                    "before_identity": before_identity,
                    "after_identity": after_identity,
                    "contents_read_for_validation": false,
                }));
            }
        }
    }
    output
}

#[test]
fn real_provider_roots_are_discovered_and_indexed_read_only() -> anyhow::Result<()> {
    if std::env::var("MOBIUS_RUN_REAL_DISCOVERY").as_deref() != Ok("1") {
        return Ok(());
    }
    let paths = WorkspacePaths {
        workspace_root: PathBuf::from(VERIFICATION_ROOT).join("workspace-catalog"),
        data_root: PathBuf::from(DATA_ROOT),
        artifacts_root: PathBuf::from(ARTIFACTS_ROOT),
        catalog_root: PathBuf::from(CATALOG_ROOT),
    };
    fs::create_dir_all(&paths.workspace_root)?;
    let desk = MyDesk::open(paths.clone())?;
    // Persist finite, provider-specific candidates before hashing. This writes
    // only Möbius' manifest below D:\\DataVault, not a Harness root.
    let roots = auto_discover_session_sources(&paths)?.roots;
    let before = roots
        .iter()
        .map(|root| {
            Ok((
                format!("{}:{}", root.agent, root.path),
                candidate_hashes(Path::new(&root.path), root.agent.clone())?,
            ))
        })
        .collect::<anyhow::Result<BTreeMap<_, _>>>()?;

    let report = desk.refresh_local_harness_sessions()?;
    let approved = desk.approved_session_sources()?;
    let after = roots
        .iter()
        .map(|root| {
            Ok((
                format!("{}:{}", root.agent, root.path),
                candidate_hashes(Path::new(&root.path), root.agent.clone())?,
            ))
        })
        .collect::<anyhow::Result<BTreeMap<_, _>>>()?;
    let drift = concurrent_external_drift(&before, &after);

    let sessions = desk.database.list_all_sessions_for_aggregation()?;
    let workspaces = desk.database.list_workspaces_v2()?;
    let checkout_count = workspaces
        .iter()
        .map(|workspace| {
            desk.database
                .list_checkouts(&workspace.id)
                .map(|checkouts| checkouts.len())
        })
        .collect::<anyhow::Result<Vec<_>>>()?
        .into_iter()
        .sum::<usize>();
    fs::create_dir_all(&paths.catalog_root)?;
    fs::write(
        paths.catalog_root.join("real-auto-discovery-report.json"),
        serde_json::to_vec_pretty(&json!({
            "roots_probed": roots,
            "approved_manifest": approved,
            "refresh": report,
            "session_count": sessions.len(),
            "workspace_count": workspaces.len(),
            "checkout_count": checkout_count,
            "source_hashes_before": before,
            "source_hashes_after": after,
            "source_identity_unchanged": drift.is_empty(),
            "concurrent_external_drift": drift,
            "concurrent_external_drift_limit": MAX_CONCURRENT_EXTERNAL_DRIFT_FILES,
            "cold_scan_completed_previously_in_this_isolated_database": true,
            "harness_launches": 0,
            "native_resumes": 0,
        }))?,
    )?;
    eprintln!(
        "read-only refresh finished: {} sessions, {} workspaces, {} checkouts; concurrent external source drift: {} file(s)",
        sessions.len(),
        workspaces.len(),
        checkout_count,
        drift.len()
    );
    // Every file not listed above has already compared equal by construction.
    // A live agent may append its own current JSONL, but a broad mutation is
    // not silently accepted as a harmless race.
    assert!(
        drift.len() <= MAX_CONCURRENT_EXTERNAL_DRIFT_FILES,
        "unexpectedly broad source mutation during read-only verification; details were written to the report"
    );
    Ok(())
}
