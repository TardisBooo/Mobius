use mydesk_core::{
    AgentKind, ContextKind, ContextRecord, MyDesk, NoteDraft, SearchRequest, WorkspacePaths,
};
use std::{fs, path::Path};

fn test_paths(root: &Path) -> WorkspacePaths {
    WorkspacePaths {
        workspace_root: root.join("workspace"),
        data_root: root.join("data-vault"),
        artifacts_root: root.join("accepted-artifacts"),
        catalog_root: root.join("catalog"),
    }
}

#[test]
fn imported_source_is_untouched_and_searchable() {
    let temporary = tempfile::tempdir().expect("temporary test root");
    let paths = test_paths(temporary.path());
    fs::create_dir_all(&paths.workspace_root).expect("workspace");
    let source = paths.workspace_root.join("input/claude-session.json");
    fs::create_dir_all(source.parent().expect("source parent")).expect("source directory");
    let original = r#"{"messages":[{"role":"user","content":"keep this raw source unchanged"}]}"#;
    fs::write(&source, original).expect("source session");

    let desk = MyDesk::open(paths).expect("open desk");
    desk.import_session_file(&source, AgentKind::Claude, Some("demo".to_string()))
        .expect("import source");

    assert_eq!(fs::read_to_string(&source).expect("read source"), original);
    let hits = desk
        .search(&SearchRequest {
            query: "unchanged".to_string(),
            limit: 8,
            ..SearchRequest::default()
        })
        .expect("search context");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].agent, Some(AgentKind::Claude));
    assert_eq!(hits[0].project_slug.as_deref(), Some("demo"));
}

#[test]
fn note_update_creates_a_snapshot_before_replacing_current_markdown() {
    let temporary = tempfile::tempdir().expect("temporary test root");
    let paths = test_paths(temporary.path());
    let desk = MyDesk::open(paths.clone()).expect("open desk");

    let first = NoteDraft {
        title: "Architecture decision".to_string(),
        body: "First conclusion".to_string(),
        project_slug: Some("mydesk".to_string()),
        tags: vec!["decision".to_string()],
        source_ids: Vec::new(),
    };
    desk.create_or_update_note(first.clone())
        .expect("save first note");
    desk.create_or_update_note(NoteDraft {
        body: "Second conclusion".to_string(),
        ..first
    })
    .expect("save revised note");

    let current = fs::read_to_string(paths.notes_dir().join("architecture-decision.md"))
        .expect("current note");
    assert!(current.contains("Second conclusion"));
    let snapshots = fs::read_dir(paths.history_dir().join("notes/architecture-decision"))
        .expect("snapshot directory")
        .count();
    assert_eq!(snapshots, 1);
}

#[test]
fn project_summary_groups_normalized_context() {
    let temporary = tempfile::tempdir().expect("temporary test root");
    let desk = MyDesk::open(test_paths(temporary.path())).expect("open desk");
    let mut first = ContextRecord::new("session:test:one", ContextKind::Session, "One");
    first.project_slug = Some("mydesk".to_string());
    first.body = "SQLite search test".to_string();
    let mut second = ContextRecord::new("note:test:two", ContextKind::Note, "Two");
    second.project_slug = Some("mydesk".to_string());
    second.body = "Snapshot test".to_string();
    desk.import_session(first).expect("index session");
    desk.database.upsert_context(&second).expect("index note");

    let projects = desk
        .database
        .list_project_summaries()
        .expect("project summaries");
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].slug, "mydesk");
    assert_eq!(projects[0].count, 2);
}

#[test]
fn repeated_source_index_skips_unchanged_files() {
    let temporary = tempfile::tempdir().expect("temporary test root");
    let paths = test_paths(temporary.path());
    let source_root = paths.workspace_root.join("sessions");
    fs::create_dir_all(&source_root).expect("source root");
    fs::write(
        source_root.join("one.jsonl"),
        "{\"cwd\":\"E:\\\\Workspaces\\\\MyDesk\",\"message\":{\"content\":\"Incremental index\"}}\n",
    )
    .expect("source session");

    let desk = MyDesk::open(paths).expect("open desk");
    let first = desk
        .index_session_root(&source_root, AgentKind::Codex, None, Some(10), Some(0))
        .expect("first scan");
    let second = desk
        .index_session_root(&source_root, AgentKind::Codex, None, Some(10), Some(0))
        .expect("second scan");

    assert_eq!(first.available, 1);
    assert_eq!(first.indexed, 1);
    assert_eq!(second.indexed, 0);
    assert_eq!(second.unchanged, 1);
}
