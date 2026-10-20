//! Read-only check of the saved bridge profile. No credentials or conversation contents are printed.
#[tokio::main]
async fn main() {
    match toris_studio_desktop::codexify_connection::check().await {
        Ok(value) => println!(
            "{}",
            serde_json::json!({"reachable":value["reachable"],"ownerReady":value["ownerReady"],"studioTools":value["studioTools"],"missingStudioTools":value["missingStudioTools"],"checkedAt":value["checkedAt"],"message":value["message"]})
        ),
        Err(_) => println!(
            "{}",
            serde_json::json!({"reachable":false,"reason":"saved connection unavailable"})
        ),
    }
}
