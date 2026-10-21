//! Explicit isolated request seeding/inspection for the live RDC stdio check.
//! This example never loads AppConfig, credentials, projects or a database.
use serde_json::{json, Value};
use std::io::Read;
fn main() {
    let result = (|| -> Result<Value, String> {
        let root = std::env::var_os("TORIS_STUDIO_CREATION_TEST_HOME")
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_absolute())
            .ok_or("isolated test home required")?;
        let mut input = String::new();
        std::io::stdin()
            .take(100_000)
            .read_to_string(&mut input)
            .map_err(|_| "read error")?;
        let input: Value = serde_json::from_str(&input).map_err(|_| "JSON required")?;
        match input["action"].as_str() {
            Some("create") => {
                toris_studio_desktop::creation::create_at(&root, input["input"].clone())
            }
            Some("list") => toris_studio_desktop::creation::list_at(&root),
            _ => Err("create/list only".into()),
        }
    })();
    println!(
        "{}",
        match result {
            Ok(value) => json!({"ok":true,"result":value}),
            Err(error) => json!({"ok":false,"error":error}),
        }
    );
}
