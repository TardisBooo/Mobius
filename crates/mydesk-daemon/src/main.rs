use anyhow::Result;
use mydesk_core::{MyDesk, SearchRequest, SessionQuery};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
};

const PIPE_NAME: &str = r"\\.\pipe\mydesk-v2";

#[derive(Debug, Deserialize)]
struct RpcRequest {
    #[serde(default = "protocol_version")]
    protocol_version: u8,
    #[serde(default)]
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct RpcResponse {
    protocol_version: u8,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn protocol_version() -> u8 {
    2
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_target(false)
        .init();
    let desk = MyDesk::initialize()?;
    tracing::info!(database = %desk.database.path().display(), "MyDesk daemon started");

    let mut first = true;
    loop {
        let server = create_pipe(first)?;
        first = false;
        server.connect().await?;
        let desk = desk.clone();
        tokio::spawn(async move {
            if let Err(error) = serve_connection(server, desk).await {
                tracing::warn!(%error, "named-pipe client disconnected");
            }
        });
    }
}

fn create_pipe(first: bool) -> Result<NamedPipeServer> {
    let mut options = ServerOptions::new();
    if first {
        options.first_pipe_instance(true);
    }
    Ok(options.create(PIPE_NAME)?)
}

async fn serve_connection(pipe: NamedPipeServer, desk: MyDesk) -> Result<()> {
    let (read_half, mut write_half) = tokio::io::split(pipe);
    let mut reader = BufReader::new(read_half);
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).await?;
        if read == 0 {
            return Ok(());
        }
        let response = match serde_json::from_str::<RpcRequest>(line.trim_start_matches('\u{feff}'))
        {
            Ok(request) => handle(request, &desk),
            Err(error) => RpcResponse {
                protocol_version: 2,
                id: Value::Null,
                result: None,
                error: Some(format!("invalid request: {error}")),
            },
        };
        write_half
            .write_all(serde_json::to_string(&response)?.as_bytes())
            .await?;
        write_half.write_all(b"\n").await?;
        write_half.flush().await?;
    }
}

fn handle(request: RpcRequest, desk: &MyDesk) -> RpcResponse {
    let result: Result<Value> = (|| match request.method.as_str() {
        _ if request.protocol_version != 2 => Err(anyhow::anyhow!(
            "unsupported protocol version {}; expected 2",
            request.protocol_version
        )),
        "ping" => Ok(json!({ "service": "mydesk-daemon", "version": env!("CARGO_PKG_VERSION") })),
        "status" => Ok(serde_json::to_value(desk.health()?)?),
        "search_context" => {
            let search = serde_json::from_value::<SearchRequest>(request.params.clone())?;
            Ok(serde_json::to_value(desk.search(&search)?)?)
        }
        "read_context" => {
            let id = request
                .params
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("read_context requires params.id"))?;
            Ok(serde_json::to_value(desk.database.get_context(id)?)?)
        }
        "resolve_mentions" => {
            let input = request
                .params
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("resolve_mentions requires params.text"))?;
            Ok(serde_json::to_value(desk.resolve_mentions(input)?)?)
        }
        "list_projects" => Ok(serde_json::to_value(desk.database.list_projects()?)?),
        "search_sessions" => {
            let query = serde_json::from_value::<SessionQuery>(request.params.clone())?;
            Ok(serde_json::to_value(desk.database.query_sessions(&query)?)?)
        }
        "get_messages" => {
            let id = request
                .params
                .get("session_id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("get_messages requires session_id"))?;
            Ok(serde_json::to_value(
                desk.database.list_session_messages(id)?,
            )?)
        }
        "list_workspaces" => Ok(serde_json::to_value(desk.database.list_workspaces_v2()?)?),
        _ => Err(anyhow::anyhow!("unknown method {}", request.method)),
    })();

    match result {
        Ok(result) => RpcResponse {
            protocol_version: 2,
            id: request.id,
            result: Some(result),
            error: None,
        },
        Err(error) => RpcResponse {
            protocol_version: 2,
            id: request.id,
            result: None,
            error: Some(error.to_string()),
        },
    }
}
