use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use mydesk_core::{
    AgentKind, ContextKind, Database, MomeRecallRequest, MyDesk, NoteDraft, SearchFilter,
    SearchRequest, SessionMapCatalog, WikiDraft, WorkspacePaths, WorkspaceStatus,
    inspect_workspace,
    skills::{
        discover_standard_skills, install_skill, list_managed_installations, preview_install,
        uninstall_skill,
    },
    sources::standard_session_roots,
};
mod mome_cli;
use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, Paragraph, Wrap},
};
use std::{
    io::{self, Stdout},
    path::PathBuf,
    time::Duration,
};

#[derive(Debug, Parser)]
#[command(name = "mydesk", version, about = "Local-first multi-agent workbench")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Inspect database migration requirements without changing local state.
    Migration {
        #[command(subcommand)]
        command: MigrationCommand,
    },
    /// Inspect and maintain the user-owned workspace corridor catalog.
    Workspaces {
        #[command(subcommand)]
        command: WorkspacesCommand,
    },
    /// Create the D: vault layout and SQLite index.
    Init,
    /// Report local index and vault health.
    Status,
    /// Start the PowerShell-first terminal UI.
    Tui,
    /// Search or import source sessions.
    Sessions {
        #[command(subcommand)]
        command: SessionsCommand,
    },
    /// Search context from sessions, notes, boards, and wiki entries.
    Recall(SearchArgs),
    /// Explicit, local Mome context recall and read-only Harness diagnostics.
    Mome {
        #[command(subcommand)]
        command: MomeCommand,
    },
    /// Create Markdown notes in the managed vault.
    Notes {
        #[command(subcommand)]
        command: NotesCommand,
    },
    /// Curate reviewable wiki entries from indexed context.
    Wiki {
        #[command(subcommand)]
        command: WikiCommand,
    },
    /// Discover standard SKILL.md packages in explicit local roots.
    Skills {
        #[command(subcommand)]
        command: SkillsCommand,
    },
    /// Print connection guidance for an installed agent.
    Agent {
        #[command(subcommand)]
        command: AgentCommand,
    },
    /// Describe how to run the writer daemon.
    Daemon {
        #[command(subcommand)]
        command: DaemonCommand,
    },
    /// Show the stdio MCP binary command.
    Mcp,
}

#[derive(Debug, Subcommand)]
enum MigrationCommand {
    /// Print the current/target schema and backup requirement; performs no writes.
    Plan,
    /// Inspect structured old-to-new session path maps without changing them.
    SessionMaps {
        #[arg(long, default_value = r"D:\Catalog\SessionMaps")]
        root: PathBuf,
        /// Include every parsed mapping instead of a small sample.
        #[arg(long)]
        details: bool,
    },
}

#[derive(Debug, Subcommand)]
enum WorkspacesCommand {
    /// Inspect a directory and its Git worktrees without writing to the catalog.
    Inspect {
        path: PathBuf,
        #[arg(long)]
        name: Option<String>,
    },
    /// Explicitly add or refresh a workspace and its checkouts.
    Add {
        path: PathBuf,
        #[arg(long)]
        name: Option<String>,
    },
    /// List cataloged workspaces in corridor order.
    List,
    /// Change the user-maintained working/paused state.
    Status { id: String, status: String },
}

#[derive(Debug, Args)]
struct SearchArgs {
    query: String,
    #[arg(long)]
    project: Option<String>,
    #[arg(long)]
    agent: Option<AgentKind>,
    #[arg(long)]
    kind: Option<ContextKind>,
    #[arg(long, default_value_t = 8)]
    limit: usize,
}

#[derive(Debug, Subcommand)]
enum SessionsCommand {
    Search(SearchArgs),
    /// Show only the conventional local roots that can be explicitly indexed.
    Sources,
    /// Discover and incrementally index every configured provider root.
    RefreshAll,
    /// Import one JSONL, JSON, Markdown, or text source as a read-only session.
    Import {
        path: PathBuf,
        #[arg(long)]
        agent: AgentKind,
        #[arg(long)]
        project: Option<String>,
    },
    /// Read a selected source root without altering any source session files.
    Index {
        #[arg(long)]
        root: PathBuf,
        #[arg(long)]
        agent: AgentKind,
        #[arg(long)]
        project: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: usize,
        /// Skip this many newest source files to continue a historical batch.
        #[arg(long, default_value_t = 0)]
        offset: usize,
    },
}

#[derive(Debug, Subcommand)]
enum NotesCommand {
    New {
        #[arg(long)]
        title: String,
        #[arg(long)]
        body: String,
        #[arg(long)]
        project: Option<String>,
        #[arg(long = "tag")]
        tags: Vec<String>,
    },
    Read {
        slug: String,
    },
}

#[derive(Debug, Subcommand)]
enum WikiCommand {
    /// List queued, accepted, and dismissed review items.
    List,
    /// Queue a source context for human review before it becomes knowledge.
    Queue { source_context_id: String },
    /// Mark a queued proposal as accepted or dismissed; this never edits its source.
    Review {
        queue_id: String,
        #[arg(long, conflicts_with = "dismiss")]
        accept: bool,
        #[arg(long, conflicts_with = "accept")]
        dismiss: bool,
    },
    /// Write a reviewed knowledge page into the durable wiki vault.
    New {
        #[arg(long)]
        title: String,
        #[arg(long)]
        body: String,
        #[arg(long)]
        project: Option<String>,
        #[arg(long = "tag")]
        tags: Vec<String>,
        #[arg(long = "source")]
        source_ids: Vec<String>,
    },
}

#[derive(Debug, Subcommand)]
enum SkillsCommand {
    /// List every explicit global/project skill root, or one scope.
    List {
        #[arg(long, default_value = "all")]
        scope: String,
    },
    /// List copies owned by the MyDesk managed-skill manifest.
    Managed,
    /// Check the exact source and destination without changing either directory.
    Preview {
        source: PathBuf,
        #[arg(long, default_value = "project")]
        target: String,
    },
    /// Copy a discovered skill into a managed target after safety checks.
    Install {
        source: PathBuf,
        #[arg(long, default_value = "project")]
        target: String,
    },
    /// Remove an unchanged copy listed by skills managed.
    Uninstall { managed_id: String },
}

#[derive(Debug, Subcommand)]
enum AgentCommand {
    Connect { agent: AgentKind },
}

#[derive(Debug, Subcommand)]
enum DaemonCommand {
    Start,
    Status,
}

#[derive(Debug, Subcommand)]
enum MomeCommand {
    /// Recall a small, citable context packet from already-indexed sessions.
    Recall(MomeRecallArgs),
    /// Return hook-safe additional context only for a prompt beginning with `@mome `.
    Hook(MomeHookArgs),
    /// Read-only report of installed Harness executables and configuration presence.
    Doctor,
    /// Inspect or explicitly install an optional local embedding model. Mome
    /// recall itself remains local BM25 until a semantic backend is available.
    Model {
        #[command(subcommand)]
        command: MomeModelCommand,
    },
}

#[derive(Debug, Subcommand)]
enum MomeModelCommand {
    /// Read-only local Ollama runtime/model inspection; never downloads.
    Status {
        #[arg(long, default_value = mome_cli::DEFAULT_OLLAMA_EMBEDDING_MODEL)]
        model: String,
    },
    /// Download a model only after supplying --accept-download explicitly.
    Install {
        #[arg(long, default_value = mome_cli::DEFAULT_OLLAMA_EMBEDDING_MODEL)]
        model: String,
        /// Acknowledge that this command runs `ollama pull` and may access the network.
        #[arg(long)]
        accept_download: bool,
    },
}

#[derive(Debug, Args)]
struct MomeRecallArgs {
    /// Explicit recall query. Mome never recalls for an ordinary prompt.
    query: String,
    #[arg(long)]
    workspace_id: Option<String>,
    #[arg(long)]
    checkout_id: Option<String>,
    /// Restrict the local search to one or more Harness providers.
    #[arg(long = "provider")]
    providers: Vec<String>,
    #[arg(long)]
    max_tokens: Option<usize>,
}

#[derive(Debug, Args)]
struct MomeHookArgs {
    /// Harness invoking the hook: codex, claude, pi, or grok.
    #[arg(long)]
    provider: String,
    /// Complete user prompt as received by the Harness hook.
    #[arg(long)]
    prompt: String,
    /// Informational working directory supplied by a Harness. It is never executed or injected.
    #[arg(long)]
    cwd: Option<PathBuf>,
    #[arg(long)]
    workspace_id: Option<String>,
    #[arg(long)]
    checkout_id: Option<String>,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_target(false)
        .init();

    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Status) {
        Command::Migration { command } => match command {
            MigrationCommand::Plan => {
                print_json(&Database::inspect_migration(&WorkspacePaths::default())?)
            }
            MigrationCommand::SessionMaps { root, details } => {
                let report = SessionMapCatalog::load(&root)?;
                if details {
                    print_json(&report)
                } else {
                    print_json(&serde_json::json!({
                        "root": report.root,
                        "files_scanned": report.files_scanned,
                        "files_skipped": report.files_skipped,
                        "invalid_rows": report.invalid_rows,
                        "mapping_count": report.entries.len(),
                        "sample": report.entries.into_iter().take(10).collect::<Vec<_>>(),
                        "source_files_were_modified": false
                    }))
                }
            }
        },
        Command::Workspaces { command } => match command {
            WorkspacesCommand::Inspect { path, name } => {
                print_json(&inspect_workspace(&path, name.as_deref())?)
            }
            WorkspacesCommand::Add { path, name } => {
                let desk = MyDesk::initialize()?;
                print_json(&desk.register_workspace(&path, name.as_deref())?)
            }
            WorkspacesCommand::List => {
                let desk = MyDesk::initialize()?;
                print_json(&desk.database.list_workspaces_v2()?)
            }
            WorkspacesCommand::Status { id, status } => {
                let desk = MyDesk::initialize()?;
                let status = match status.as_str() {
                    "working" => WorkspaceStatus::Working,
                    "paused" => WorkspaceStatus::Paused,
                    _ => anyhow::bail!("Unknown status {status}. Use working or paused."),
                };
                if !desk.set_workspace_status(&id, status)? {
                    anyhow::bail!("Unknown workspace id: {id}");
                }
                print_json(&desk.database.list_workspaces_v2()?)
            }
        },
        Command::Init => {
            let desk = MyDesk::initialize()?;
            print_json(&desk.health()?)
        }
        Command::Status => {
            let desk = MyDesk::initialize()?;
            print_json(&desk.health()?)
        }
        Command::Tui => run_tui(MyDesk::initialize()?),
        Command::Sessions { command } => {
            let desk = MyDesk::initialize()?;
            match command {
                SessionsCommand::Search(arguments) => search_and_print(&desk, arguments),
                SessionsCommand::Sources => print_json(&standard_session_roots(&desk.paths)),
                SessionsCommand::RefreshAll => print_json(&desk.index_all_provider_sessions()?),
                SessionsCommand::Import {
                    path,
                    agent,
                    project,
                } => {
                    require_supported_agent(&agent)?;
                    let record = desk.import_session_file(&path, agent, project)?;
                    print_json(&record)
                }
                SessionsCommand::Index {
                    root,
                    agent,
                    project,
                    limit,
                    offset,
                } => {
                    require_supported_agent(&agent)?;
                    let report =
                        desk.index_session_root(&root, agent, project, Some(limit), Some(offset))?;
                    print_json(&report)
                }
            }
        }
        Command::Recall(arguments) => {
            let desk = MyDesk::initialize()?;
            search_and_print(&desk, arguments)
        }
        Command::Mome { command } => match command {
            MomeCommand::Recall(arguments) => {
                let desk = MyDesk::initialize()?;
                let request = mome_request_from_args(arguments)?;
                print_json(&mome_cli::packet_from_recall(&desk.mome_recall(&request)?))
            }
            MomeCommand::Hook(arguments) => {
                let provider = parse_mome_provider(&arguments.provider)?;
                if let Some(query) = mome_cli::explicit_mome_query(&arguments.prompt) {
                    let desk = MyDesk::initialize()?;
                    let response = desk.mome_recall(&MomeRecallRequest {
                        query,
                        workspace_id: arguments.workspace_id,
                        checkout_id: arguments.checkout_id,
                        providers: vec![provider.clone()],
                        max_tokens: None,
                    })?;
                    print_json(&mome_cli::hook_response(
                        provider,
                        &arguments.prompt,
                        arguments.cwd.as_deref(),
                        Some(&response),
                    ))
                } else {
                    print_json(&mome_cli::hook_response(
                        provider,
                        &arguments.prompt,
                        arguments.cwd.as_deref(),
                        None,
                    ))
                }
            }
            MomeCommand::Doctor => print_json(&mome_cli::doctor_report()),
            MomeCommand::Model { command } => match command {
                MomeModelCommand::Status { model } => {
                    print_json(&mome_cli::local_model_status(&model))
                }
                MomeModelCommand::Install {
                    model,
                    accept_download,
                } => print_json(&mome_cli::install_local_model(&model, accept_download)?),
            },
        },
        Command::Notes { command } => {
            let desk = MyDesk::initialize()?;
            match command {
                NotesCommand::New {
                    title,
                    body,
                    project,
                    tags,
                } => {
                    let record = desk.create_or_update_note(NoteDraft {
                        title,
                        body,
                        project_slug: project,
                        tags,
                        source_ids: Vec::new(),
                    })?;
                    print_json(&record)
                }
                NotesCommand::Read { slug } => {
                    let path = desk.paths.notes_dir().join(format!("{slug}.md"));
                    let contents = std::fs::read_to_string(&path)
                        .with_context(|| format!("reading {}", path.display()))?;
                    print!("{contents}");
                    Ok(())
                }
            }
        }
        Command::Wiki { command } => {
            let desk = MyDesk::initialize()?;
            match command {
                WikiCommand::List => print_json(&desk.list_wiki_queue()?),
                WikiCommand::Queue { source_context_id } => {
                    print_json(&desk.enqueue_wiki_review(&source_context_id)?)
                }
                WikiCommand::Review {
                    queue_id,
                    accept,
                    dismiss,
                } => {
                    let state = match (accept, dismiss) {
                        (true, false) => "accepted",
                        (false, true) => "dismissed",
                        _ => anyhow::bail!("Choose exactly one of --accept or --dismiss."),
                    };
                    print_json(&desk.review_wiki_queue(&queue_id, state)?)
                }
                WikiCommand::New {
                    title,
                    body,
                    project,
                    tags,
                    source_ids,
                } => print_json(&desk.create_or_update_wiki(WikiDraft {
                    title,
                    body,
                    project_slug: project,
                    tags,
                    source_ids,
                })?),
            }
        }
        Command::Skills { command } => {
            let desk = MyDesk::initialize()?;
            match command {
                SkillsCommand::List { scope } => {
                    validate_skill_scope(&scope)?;
                    print_json(&discover_standard_skills(&desk.paths, Some(&scope))?)
                }
                SkillsCommand::Managed => print_json(&list_managed_installations(&desk.paths)?),
                SkillsCommand::Preview { source, target } => print_json(&preview_install(
                    &desk.paths,
                    &source.display().to_string(),
                    &target,
                )?),
                SkillsCommand::Install { source, target } => print_json(&install_skill(
                    &desk.paths,
                    &source.display().to_string(),
                    &target,
                )?),
                SkillsCommand::Uninstall { managed_id } => {
                    let removed = uninstall_skill(&desk.paths, &managed_id)?;
                    println!(
                        "Removed managed skill {}. The source was not changed.",
                        removed.destination
                    );
                    Ok(())
                }
            }
        }
        Command::Agent { command } => match command {
            AgentCommand::Connect { agent } => print_agent_connection(agent),
        },
        Command::Daemon { command } => match command {
            DaemonCommand::Start => {
                println!(
                    "Run mydesk-daemon in another PowerShell window to expose local query methods through \\\\.\\pipe\\mydesk-v1."
                );
                Ok(())
            }
            DaemonCommand::Status => {
                println!(
                    "The daemon status endpoint is the local named pipe \\\\.\\pipe\\mydesk-v1."
                );
                Ok(())
            }
        },
        Command::Mcp => {
            println!("Configure agent MCP stdio with the mydesk-mcp executable.");
            Ok(())
        }
    }
}

fn search_and_print(desk: &MyDesk, arguments: SearchArgs) -> Result<()> {
    let results = desk.search(&SearchRequest {
        query: arguments.query,
        filter: SearchFilter {
            agent: arguments.agent,
            project_slug: arguments.project,
            kind: arguments.kind,
        },
        limit: arguments.limit,
    })?;
    print_json(&results)
}

fn mome_request_from_args(arguments: MomeRecallArgs) -> Result<MomeRecallRequest> {
    let providers = arguments
        .providers
        .iter()
        .map(|provider| parse_mome_provider(provider))
        .collect::<Result<Vec<_>>>()?;
    Ok(MomeRecallRequest {
        query: arguments.query,
        workspace_id: arguments.workspace_id,
        checkout_id: arguments.checkout_id,
        providers,
        max_tokens: arguments.max_tokens,
    })
}

fn parse_mome_provider(value: &str) -> Result<AgentKind> {
    let provider = value.parse::<AgentKind>()?;
    if !provider.is_supported() {
        anyhow::bail!("Unsupported Mome provider {value}. Use codex, claude, pi, or grok.");
    }
    Ok(provider)
}

fn validate_skill_scope(scope: &str) -> Result<()> {
    if matches!(scope, "all" | "global" | "project") {
        return Ok(());
    }
    anyhow::bail!("Unknown scope {scope}. Use all, global, or project.")
}

fn require_supported_agent(agent: &AgentKind) -> Result<()> {
    if !agent.is_supported() {
        anyhow::bail!("Choose codex, claude, pi, or grok.")
    }
    Ok(())
}

fn print_agent_connection(agent: AgentKind) -> Result<()> {
    let command = match agent {
        AgentKind::Codex => "codex mcp add mydesk -- mydesk-mcp",
        AgentKind::Claude => "claude mcp add mydesk -- mydesk-mcp",
        AgentKind::Pi => "Add mydesk-mcp to the Pi MCP extension configuration.",
        AgentKind::Grok => "Add mydesk-mcp to the Grok MCP configuration.",
        AgentKind::Apodex | AgentKind::Unknown => "Choose a supported agent: codex, claude, pi, grok.",
    };
    println!("{command}");
    Ok(())
}

fn print_json<T: serde::Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn run_tui(desk: MyDesk) -> Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let result = tui_loop(&mut terminal, &desk);
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    result
}

fn tui_loop(terminal: &mut Terminal<CrosstermBackend<Stdout>>, desk: &MyDesk) -> Result<()> {
    loop {
        let status = desk.health()?;
        let projects = desk.database.list_projects()?;
        let contexts = desk.search(&SearchRequest {
            query: String::new(),
            limit: 12,
            ..SearchRequest::default()
        })?;

        terminal.draw(|frame| {
            let page = frame.area();
            let vertical = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Length(3), Constraint::Min(1), Constraint::Length(2)])
                .split(page);
            let body = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Length(28), Constraint::Min(52), Constraint::Length(34)])
                .split(vertical[1]);

            frame.render_widget(
                Paragraph::new(Line::from(vec![
                    Span::styled(" MyDesk ", Style::default().fg(Color::LightBlue).add_modifier(Modifier::BOLD)),
                    Span::raw("PowerShell workbench  /  Local-first  /  q to exit"),
                ]))
                .block(Block::default().borders(Borders::ALL).title("Workspace")),
                vertical[0],
            );

            let project_items = if projects.is_empty() {
                vec![ListItem::new("No project indexed yet")]
            } else {
                projects
                    .iter()
                    .map(|project| ListItem::new(format!("• {project}")))
                    .collect()
            };
            frame.render_widget(
                List::new(project_items).block(Block::default().borders(Borders::ALL).title("Projects")),
                body[0],
            );

            let context_items = if contexts.is_empty() {
                vec![ListItem::new("Run mydesk notes new or import a source session.")]
            } else {
                contexts
                    .iter()
                    .map(|context| {
                        ListItem::new(vec![
                            Line::from(Span::styled(
                                format!("{}  {}", context.kind, context.title),
                                Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
                            )),
                            Line::from(Span::styled(
                                context.summary.clone(),
                                Style::default().fg(Color::DarkGray),
                            )),
                        ])
                    })
                    .collect()
            };
            frame.render_widget(
                List::new(context_items)
                    .block(Block::default().borders(Borders::ALL).title("Recent context")),
                body[1],
            );

            let detail = format!(
                "Index: {} contexts\nSessions: {}\nNotes: {}\nBoards: {}\n\nPS> mydesk recall \"memory\"\nPS> /ask @project:mydesk",
                status.contexts, status.sessions, status.notes, status.boards
            );
            frame.render_widget(
                Paragraph::new(detail)
                    .wrap(Wrap { trim: true })
                    .block(Block::default().borders(Borders::ALL).title("Context rail")),
                body[2],
            );

            frame.render_widget(
                Paragraph::new(" q / Esc: exit   •   mydesk sessions search <query> for full results")
                    .style(Style::default().fg(Color::DarkGray)),
                vertical[2],
            );
        })?;

        if event::poll(Duration::from_millis(200))?
            && let Event::Key(key) = event::read()?
            && key.kind == KeyEventKind::Press
            && matches!(key.code, KeyCode::Char('q') | KeyCode::Esc)
        {
            return Ok(());
        }
    }
}
