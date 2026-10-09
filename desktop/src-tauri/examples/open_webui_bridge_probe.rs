//! Loopback adapter probe: initialize/tools-list only, never coding tool calls.
use serde_json::{json, Value};
use std::time::Duration;
use toris_studio_desktop::open_webui_bridge::{Controller, PORT};

fn message(bytes: &str) -> Result<Value, String> {
    if let Ok(value) = serde_json::from_str(bytes) {
        return Ok(value);
    }
    bytes
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .find_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .ok_or_else(|| "The local MCP response was not JSON or SSE JSON.".into())
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let serve_seconds = match args.next().as_deref() {
        None => None,
        Some("--serve-seconds") => Some(
            args.next()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| (1..=3600).contains(value))
                .ok_or("Pass --serve-seconds 1..3600.")?,
        ),
        Some(_) => return Err("Only --serve-seconds 1..3600 is supported.".into()),
    };
    if args.next().is_some() {
        return Err("Unexpected argument.".into());
    }
    let controller = Controller::default();
    controller.ensure_started().await?;
    if let Some(seconds) = serve_seconds {
        println!(
            "{}",
            json!({"service":"toris-studio-openwebui-mcp","port":PORT,"serveSeconds":seconds})
        );
        tokio::time::sleep(Duration::from_secs(seconds)).await;
        controller.stop().await;
        return Ok(());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| "Could not prepare the local probe.")?;
    let endpoint = format!("http://127.0.0.1:{PORT}/mcp");
    let initialize = client.post(&endpoint)
        .header("accept", "application/json, text/event-stream")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"toris-openwebui-readonly-probe","version":"1"}}}))
        .send().await.map_err(|_| "The local MCP initialize request failed.")?;
    if !initialize.status().is_success() {
        return Err("The adapter could not initialize the local MCP.".into());
    }
    let session = initialize.headers().get("mcp-session-id").cloned();
    let initialized = message(
        &initialize
            .text()
            .await
            .map_err(|_| "Could not read initialize response.")?,
    )?;
    if initialized.get("error").is_some() {
        return Err("The local MCP returned an initialize error.".into());
    }
    let protocol = initialized["result"]["protocolVersion"]
        .as_str()
        .ok_or("Missing protocol version.")?;
    let mut request = client
        .post(&endpoint)
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", protocol)
        .json(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}));
    if let Some(session) = session {
        request = request.header("mcp-session-id", session);
    }
    let listed = request
        .send()
        .await
        .map_err(|_| "The local MCP tools-list request failed.")?;
    if !listed.status().is_success() {
        return Err("The adapter could not list local MCP tools.".into());
    }
    let listed = message(
        &listed
            .text()
            .await
            .map_err(|_| "Could not read tools-list response.")?,
    )?;
    let tools = listed["result"]["tools"]
        .as_array()
        .ok_or("Missing tool catalog.")?;
    println!(
        "{}",
        json!({"adapterReady":true,"protocolVersion":protocol,"toolCount":tools.len(),"toolExecuted":false})
    );
    controller.stop().await;
    Ok(())
}
