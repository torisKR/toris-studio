//! Read-only inventory of native creation MCP tool names; no chat or provider access.
fn main() {
    let names: Vec<_> = toris_studio_desktop::mcp_bridge::tools()
        .into_iter()
        .map(|tool| tool["name"].clone())
        .collect();
    println!(
        "{}",
        serde_json::json!({"transport":"stdio","args":["--studio-mcp"],"tools":names})
    );
}
