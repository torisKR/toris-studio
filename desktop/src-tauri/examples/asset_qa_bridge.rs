//! Test-only IPC adapter used by scripts/verify-asset-studio.mjs.
//! Never registered as an MCP server or included in the application bundle.
use serde_json::{json, Value};
use std::io::{Read, Write};

fn main() {
    let result = (|| -> Result<Value, String> {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(70 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let request: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let action = request["action"].as_str().ok_or("missing action")?;
        toris_studio_desktop::assets::dispatch(action, request["input"].clone())
    })();
    let envelope = match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(error) => json!({"ok":false,"error":error}),
    };
    let _ = writeln!(std::io::stdout(), "{envelope}");
}
