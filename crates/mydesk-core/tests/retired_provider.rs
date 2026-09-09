use mydesk_core::{AgentKind, MyDesk, SessionAdapterRegistry, WorkspacePaths};

#[test]
fn retired_provider_decodes_but_cannot_be_used() {
    let provider: AgentKind = serde_json::from_str("\"apodex\"").unwrap();
    assert!(!provider.is_supported());
    assert!(!AgentKind::ALL.contains(&provider));
    assert_eq!(serde_json::to_string(&provider).unwrap(), "\"apodex\"");
    assert!(!SessionAdapterRegistry::default_adapters().iter().any(|adapter| adapter.provider == provider));
    assert!(!SessionAdapterRegistry::is_candidate(&provider, std::path::Path::new("history.json")));
    assert_eq!(SessionAdapterRegistry::for_provider(&provider).coverage, "unsupported");
    let root = tempfile::tempdir().unwrap();
    let desk = MyDesk::open(WorkspacePaths {
        workspace_root: root.path().join("workspace"),
        data_root: root.path().join("vault"),
        artifacts_root: root.path().join("artifacts"),
        catalog_root: root.path().join("catalog"),
    }).unwrap();
    // Reject before attempting to open even a nonexistent source path.
    let error = desk.import_session_file(&root.path().join("missing.json"), provider, None).unwrap_err();
    assert!(error.to_string().contains("Unsupported session provider"));
}
