use anyhow::{Context, Result, anyhow};
use mydesk_core::{
    AgentKind, MAX_MOME_TOKENS, McpApprovalAttempt, McpApprovalStore, MomeRecallRequest, MyDesk,
    Session, SessionQuery,
};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    str::FromStr,
};

const PROTOCOL_VERSION: &str = "2025-06-18";
const MAX_CONTEXT_CHARS: usize = 48_000;

fn main() -> Result<()> {
    let desk = MyDesk::initialize().context("could not open the local Möbius vault")?;
    let approvals = McpApprovalStore::for_paths(&desk.paths)
        .context("could not open the local Möbius MCP approval store")?;
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(error) => {
                write_response(
                    &mut stdout,
                    rpc_error(Value::Null, -32700, format!("parse error: {error}")),
                )?;
                continue;
            }
        };
        if let Some(response) = handle_request(&desk, &approvals, request) {
            write_response(&mut stdout, response)?;
        }
    }
    Ok(())
}

fn write_response(stdout: &mut impl Write, value: Value) -> Result<()> {
    serde_json::to_writer(&mut *stdout, &value)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}

fn rpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message.into()}})
}

fn handle_request(desk: &MyDesk, approvals: &McpApprovalStore, request: Value) -> Option<Value> {
    let object = match request.as_object() {
        Some(value) => value,
        None => return Some(rpc_error(Value::Null, -32600, "request must be an object")),
    };
    let id = object.get("id").cloned();
    let method = match object.get("method").and_then(Value::as_str) {
        Some(value) => value,
        None => {
            return Some(rpc_error(
                id.unwrap_or(Value::Null),
                -32600,
                "request must include a method",
            ));
        }
    };
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities":{"tools":{},"resources":{}},
            "serverInfo":{"name":"mobius","version":env!("CARGO_PKG_VERSION")},
            "instructions":"Möbius lists locally approved session metadata by default. Message search, transcript ranges, and @session resolution require a short-lived approval token created by the desktop app after the user selects the exact scope. Native session files are read-only."
        })),
        "notifications/initialized" | "notifications/cancelled" => return None,
        "ping" => Ok(json!({})),
        "resources/list" => Ok(json!({"resources":[]})),
        "tools/list" => Ok(json!({"tools":tool_definitions()})),
        "tools/call" => call_tool(desk, approvals, &params),
        "shutdown" => Ok(Value::Null),
        _ => Err(anyhow!("method not found: {method}")),
    };
    match (id, result) {
        (None, _) => None,
        (Some(id), Ok(result)) => Some(json!({"jsonrpc":"2.0","id":id,"result":result})),
        (Some(id), Err(error)) => Some(rpc_error(id, -32602, error.to_string())),
    }
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required}})
}

fn tool_definitions() -> Vec<Value> {
    vec![
        tool(
            "list_sessions",
            "List indexed native-session metadata. It never reads transcript messages.",
            json!({"workspace_id":{"type":"string"},"checkout_id":{"type":"string"},"providers":{"type":"array","items":{"enum":["codex","claude","pi","grok"]}},"limit":{"type":"integer","minimum":1,"maximum":100}}),
            &[],
        ),
        tool(
            "get_session",
            "Get one native session identity and capabilities without loading its transcript. Duplicate provider/native IDs are rejected as ambiguous.",
            json!({"provider":{"type":"string"},"session_id":{"type":"string"}}),
            &["provider", "session_id"],
        ),
        tool(
            "get_index_health",
            "Return indexed-session counts and local health metadata. It never traverses unapproved source roots.",
            json!({}),
            &[],
        ),
        tool(
            "search_sessions",
            "Search message-level history only after a user has granted an exact desktop search approval token.",
            json!({"approval_token":{"type":"string"},"query":{"type":"string"},"workspace_id":{"type":"string"},"checkout_id":{"type":"string"},"providers":{"type":"array","items":{"enum":["codex","claude","pi","grok"]}},"limit":{"type":"integer","minimum":1,"maximum":100}}),
            &["approval_token", "query", "providers"],
        ),
        tool(
            "mome_recall",
            "Recall a bounded, precisely cited local context package only after explicit desktop approval. It searches the regenerable local SQLite FTS/BM25 index; this build does not invoke a semantic model during recall.",
            json!({"approval_token":{"type":"string"},"query":{"type":"string"},"workspace_id":{"type":"string"},"checkout_id":{"type":"string"},"providers":{"type":"array","minItems":1,"items":{"enum":["codex","claude","pi","grok"]}},"max_tokens":{"type":"integer","minimum":1,"maximum":MAX_MOME_TOKENS}}),
            &["approval_token", "query", "providers"],
        ),
        tool(
            "get_messages",
            "Read one explicit, approval-bounded inclusive message range.",
            json!({"approval_token":{"type":"string"},"provider":{"type":"string"},"session_id":{"type":"string"},"start":{"type":"integer","minimum":0},"end":{"type":"integer","minimum":0},"max_chars":{"type":"integer","minimum":1,"maximum":MAX_CONTEXT_CHARS}}),
            &["approval_token", "provider", "session_id", "start", "end"],
        ),
        tool(
            "resolve_reference",
            "Resolve a unique @session:provider/id#mN or #mN-mM only after desktop approval for that source range. Duplicate provider/native IDs are rejected as ambiguous.",
            json!({"approval_token":{"type":"string"},"reference":{"type":"string"},"max_chars":{"type":"integer","minimum":1,"maximum":MAX_CONTEXT_CHARS}}),
            &["approval_token", "reference"],
        ),
        tool(
            "get_artifacts",
            "List metadata for artifacts associated with a native session; it does not read artifact contents.",
            json!({"provider":{"type":"string"},"session_id":{"type":"string"}}),
            &["provider", "session_id"],
        ),
        tool(
            "request_session_approval",
            "Return desktop approval requirements. This MCP server cannot mint an approval token itself.",
            json!({"operation":{"enum":["search_sessions","get_messages","resolve_reference","mome_recall"]}}),
            &["operation"],
        ),
    ]
}

fn call_tool(desk: &MyDesk, approvals: &McpApprovalStore, params: &Value) -> Result<Value> {
    let name = required_string(params, "name")?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    match name {
        "list_sessions" => {
            let providers = parse_providers(&args)?;
            let results = desk.database.query_sessions(&SessionQuery {
                query: String::new(),
                workspace_id: optional_string(&args, "workspace_id"),
                checkout_id: optional_string(&args, "checkout_id"),
                providers,
                limit: bounded_usize(args.get("limit"), 50, 100),
            })?;
            Ok(tool_result(json!(results)))
        }
        "get_session" => Ok(tool_result(serde_json::to_value(resolve_session(
            desk, &args,
        )?)?)),
        "get_index_health" => Ok(tool_result(json!({
            "health": desk.health()?,
            "agents": desk.database.list_agent_summaries()?,
            "approved_sources": desk.approved_session_sources()?,
            "schema_version": desk.database.schema_version()?
        }))),
        "request_session_approval" => Ok(approval_required_result(
            required_string(&args, "operation")?,
            "Open Möbius desktop, select the exact provider/session or search scope, review the token budget, then create a short-lived approval token.",
        )),
        "search_sessions" => {
            let providers = parse_providers(&args)?;
            if providers.is_empty() {
                return Err(anyhow!(
                    "providers must contain one or more known Harnesses"
                ));
            }
            let query = required_string(&args, "query")?.to_string();
            let attempt = McpApprovalAttempt {
                operation: "search_sessions".into(),
                query: Some(query.clone()),
                workspace_id: optional_string(&args, "workspace_id"),
                checkout_id: optional_string(&args, "checkout_id"),
                providers: providers.iter().map(ToString::to_string).collect(),
                provider: None,
                session_id: None,
                start_ordinal: None,
                end_ordinal: None,
                requested_chars: 8_000,
            };
            if let Err(error) = authorize(approvals, &args, &attempt) {
                return Ok(approval_required_result(
                    "search_sessions",
                    &error.to_string(),
                ));
            }
            Ok(tool_result(serde_json::to_value(
                desk.database.query_sessions(&SessionQuery {
                    query,
                    workspace_id: attempt.workspace_id,
                    checkout_id: attempt.checkout_id,
                    providers,
                    limit: bounded_usize(args.get("limit"), 12, 100),
                })?,
            )?))
        }
        "mome_recall" => {
            let providers = parse_providers(&args)?;
            if providers.is_empty() {
                return Err(anyhow!(
                    "providers must contain one or more known Harnesses"
                ));
            }
            let query = required_string(&args, "query")?.to_string();
            let max_tokens =
                bounded_usize(args.get("max_tokens"), MAX_MOME_TOKENS, MAX_MOME_TOKENS);
            let attempt = McpApprovalAttempt {
                operation: "mome_recall".into(),
                query: Some(query.clone()),
                workspace_id: optional_string(&args, "workspace_id"),
                checkout_id: optional_string(&args, "checkout_id"),
                providers: providers.iter().map(ToString::to_string).collect(),
                provider: None,
                session_id: None,
                start_ordinal: None,
                end_ordinal: None,
                // Reserve a conservative character maximum before derived
                // transcript text is returned. The token cap is also enforced
                // by core and can never expand to an unbounded export.
                requested_chars: max_tokens.saturating_mul(4),
            };
            if let Err(error) = authorize(approvals, &args, &attempt) {
                return Ok(approval_required_result("mome_recall", &error.to_string()));
            }
            Ok(tool_result(serde_json::to_value(desk.mome_recall(
                &MomeRecallRequest {
                    query,
                    workspace_id: attempt.workspace_id,
                    checkout_id: attempt.checkout_id,
                    providers,
                    max_tokens: Some(max_tokens),
                },
            )?)?))
        }
        "get_messages" => {
            let session = resolve_session(desk, &args)?;
            let (start, end) = requested_range(&args)?;
            let max = bounded_usize(args.get("max_chars"), 18_000, MAX_CONTEXT_CHARS);
            let attempt = McpApprovalAttempt {
                operation: "get_messages".into(),
                query: None,
                workspace_id: None,
                checkout_id: None,
                providers: Vec::new(),
                provider: Some(session.provider.to_string()),
                session_id: Some(session.provider_session_id.clone()),
                start_ordinal: Some(start),
                end_ordinal: Some(end),
                requested_chars: max,
            };
            if let Err(error) = authorize(approvals, &args, &attempt) {
                return Ok(approval_required_result("get_messages", &error.to_string()));
            }
            Ok(tool_result(read_messages(desk, &session, start, end, max)?))
        }
        "resolve_reference" => {
            let reference = required_string(&args, "reference")?;
            let parsed = parse_reference(reference)?;
            let session = desk
                .database
                .get_provider_session(&parsed.provider, &parsed.session_id)?
                .ok_or_else(|| anyhow!("session not found"))?;
            let Some((start, end)) = parsed.range else {
                return Ok(tool_result(serde_json::to_value(session)?));
            };
            let max = bounded_usize(args.get("max_chars"), 18_000, MAX_CONTEXT_CHARS);
            let attempt = McpApprovalAttempt {
                operation: "resolve_reference".into(),
                query: None,
                workspace_id: None,
                checkout_id: None,
                providers: Vec::new(),
                provider: Some(parsed.provider),
                session_id: Some(parsed.session_id),
                start_ordinal: Some(start),
                end_ordinal: Some(end),
                requested_chars: max,
            };
            if let Err(error) = authorize(approvals, &args, &attempt) {
                return Ok(approval_required_result(
                    "resolve_reference",
                    &error.to_string(),
                ));
            }
            Ok(tool_result(read_messages(desk, &session, start, end, max)?))
        }
        "get_artifacts" => {
            let session = resolve_session(desk, &args)?;
            Ok(tool_result(serde_json::to_value(
                desk.database.list_session_artifacts(&session.id)?,
            )?))
        }
        _ => Err(anyhow!("unknown Möbius tool: {name}")),
    }
}

fn tool_result(payload: Value) -> Value {
    json!({"content":[{"type":"text","text":serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".into())}],"isError":false})
}

fn approval_required_result(operation: &str, reason: &str) -> Value {
    let payload = json!({
        "status": "needs_user_approval",
        "operation": operation,
        "reason": reason,
        "next_step": "In Möbius desktop, explicitly select the provider/session or query scope and create a short-lived, bounded approval token."
    });
    json!({"content":[{"type":"text","text":serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".into())}],"isError":true})
}

fn authorize(
    approvals: &McpApprovalStore,
    args: &Value,
    attempt: &McpApprovalAttempt,
) -> Result<()> {
    approvals.authorize(required_string(args, "approval_token")?, attempt)?;
    Ok(())
}

fn read_messages(
    desk: &MyDesk,
    session: &Session,
    start: i64,
    end: i64,
    max: usize,
) -> Result<Value> {
    let mut used = 0usize;
    let messages = desk
        .database
        .list_session_messages(&session.id)?
        .into_iter()
        .filter(|message| message.ordinal >= start && message.ordinal <= end)
        .take_while(|message| {
            used = used.saturating_add(message.content.chars().count());
            used <= max
        })
        .map(|message| {
            json!({
                "ref": format!("@session:{}/{}#m{}", session.provider, session.provider_session_id, message.ordinal),
                "message": message
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({"session":session,"messages":messages,"returned_chars":used.min(max)}))
}

fn resolve_session(desk: &MyDesk, args: &Value) -> Result<Session> {
    desk.database
        .get_provider_session(
            required_string(args, "provider")?,
            required_string(args, "session_id")?,
        )?
        .ok_or_else(|| anyhow!("session not found"))
}

#[derive(Debug)]
struct ParsedReference {
    provider: String,
    session_id: String,
    range: Option<(i64, i64)>,
}

fn parse_reference(reference: &str) -> Result<ParsedReference> {
    let raw = reference
        .strip_prefix("@session:")
        .ok_or_else(|| anyhow!("only @session references are supported"))?;
    let (identity, raw_range) = raw.split_once('#').unwrap_or((raw, ""));
    let (provider, session_id) = identity
        .split_once('/')
        .ok_or_else(|| anyhow!("reference needs provider/session-id"))?;
    let provider_kind = AgentKind::from_str(provider).unwrap_or_default();
    if !provider_kind.is_supported() || session_id.trim().is_empty() {
        return Err(anyhow!(
            "reference has an unsupported provider or empty session id"
        ));
    }
    let range = if raw_range.is_empty() {
        None
    } else {
        let raw_range = raw_range.trim_start_matches('m');
        let (start, end) = raw_range.split_once("-m").unwrap_or((raw_range, raw_range));
        let start = start.parse::<i64>()?;
        let end = end.parse::<i64>()?;
        if start < 0 || end < start || end - start >= 200 {
            return Err(anyhow!(
                "reference range must be ordered and at most 200 messages"
            ));
        }
        Some((start, end))
    };
    Ok(ParsedReference {
        provider: provider_kind.to_string(),
        session_id: session_id.to_string(),
        range,
    })
}

fn requested_range(args: &Value) -> Result<(i64, i64)> {
    let start = bounded_usize(args.get("start"), 0, usize::MAX) as i64;
    let end = bounded_usize(args.get("end"), start as usize, usize::MAX) as i64;
    if end < start || end - start >= 200 {
        return Err(anyhow!(
            "message range must be ordered and at most 200 messages"
        ));
    }
    Ok((start, end))
}

fn parse_providers(args: &Value) -> Result<Vec<AgentKind>> {
    let mut providers = Vec::new();
    if let Some(values) = args.get("providers").and_then(Value::as_array) {
        for value in values.iter().filter_map(Value::as_str) {
            let provider = AgentKind::from_str(value).unwrap_or_default();
            if !provider.is_supported() {
                return Err(anyhow!("unsupported Harness provider: {value}"));
            }
            if !providers.contains(&provider) {
                providers.push(provider);
            }
        }
    }
    Ok(providers)
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("missing required argument: {key}"))
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn bounded_usize(value: Option<&Value>, default: usize, maximum: usize) -> usize {
    value
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(default)
        .min(maximum)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_bounded_known_session_references() {
        let parsed = parse_reference("@session:codex/native-1#m4-m6").expect("reference");
        assert_eq!(parsed.provider, "codex");
        assert_eq!(parsed.range, Some((4, 6)));
        assert!(parse_reference("@session:unknown/x#m1").is_err());
        assert!(parse_reference("@session:codex/x#m9-m1").is_err());
        assert!(parse_reference("@session:codex/x#m1-m200").is_ok());
        assert!(parse_reference("@session:codex/x#m1-m201").is_err());
    }

    #[test]
    fn approval_response_never_contains_transcript_data() {
        let result = approval_required_result("get_messages", "MCP approval is missing or invalid");
        assert_eq!(result.get("isError").and_then(Value::as_bool), Some(true));
        let text = result["content"][0]["text"].as_str().unwrap_or_default();
        assert!(text.contains("needs_user_approval"));
        assert!(!text.contains("message.content"));
    }

    #[test]
    fn mome_tool_is_declared_as_approval_gated_and_bounded() {
        let tool = tool_definitions()
            .into_iter()
            .find(|tool| tool["name"] == "mome_recall")
            .expect("Mome tool");
        assert_eq!(
            tool["inputSchema"]["properties"]["max_tokens"]["maximum"],
            json!(MAX_MOME_TOKENS)
        );
        assert!(
            tool["inputSchema"]["required"]
                .as_array()
                .expect("required fields")
                .contains(&json!("approval_token"))
        );
    }
}
