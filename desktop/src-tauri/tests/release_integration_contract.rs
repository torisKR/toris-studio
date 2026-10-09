use serde_json::{json, Value};
use toris_studio_desktop::{mcp_bridge, publishing};

#[tokio::test]
async fn packaged_mcp_lists_real_tools_and_queues_without_credentials() {
    let root = tempfile::tempdir().unwrap();
    let initialized = mcp_bridge::handle_at(root.path(), json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}})).await.unwrap();
    assert_eq!(
        initialized["result"]["serverInfo"]["name"],
        "toris-studio-assets"
    );
    let list = mcp_bridge::handle_at(
        root.path(),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
    )
    .await
    .unwrap();
    let tools = list["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 9);
    let receive = tools
        .iter()
        .find(|t| t["name"] == "studio_asset_receive")
        .unwrap();
    assert_eq!(receive["_meta"]["openai/fileParams"], json!(["file"]));
    assert_eq!(
        receive["inputSchema"]["properties"]["file"]["required"],
        json!(["download_url", "file_id"])
    );
    let result = mcp_bridge::handle_at(root.path(),json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"studio_asset_request","arguments":{"title":"test","prompt":"blue sea","purpose":"project","project":"QA","width":320,"height":180,"format":"png","fit":"contain","quantity":1}}})).await.unwrap();
    assert_eq!(result["result"]["isError"], false);
    let payload: Value =
        serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(payload["jobs"][0]["status"], "queued");
    assert!(root.path().join("library.json").is_file());
    assert!(!root.path().join("settings.json").exists());
}
#[tokio::test]
async fn packaged_mcp_denies_arbitrary_paths_and_records_roundtrip_not_account_login() {
    let root = tempfile::tempdir().unwrap();
    let call = |name: &str, args: Value| json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}});
    let denied = mcp_bridge::handle_at(
        root.path(),
        call("import_paths", json!({"paths":["/etc/passwd"]})),
    )
    .await
    .unwrap();
    assert_eq!(denied["result"]["isError"], true);
    let denied=mcp_bridge::handle_at(root.path(),call("studio_asset_receive",json!({"file":{"download_url":"http://127.0.0.1/secret","file_id":"test"},"jobId":"test"}))).await.unwrap();
    assert_eq!(denied["result"]["isError"], true);
    mcp_bridge::handle_at(root.path(), call("studio_connection_check", json!({})))
        .await
        .unwrap();
    let status = mcp_bridge::status_at(root.path()).unwrap();
    assert!(status["lastToolCallAt"].is_string());
    assert_eq!(status["chatgptLoginVerified"], false);
    assert!(status["lastFileReceivedAt"].is_null());
}
#[test]
fn publication_contract_requires_exact_target_and_explicit_public_confirmation() {
    let base = json!({"platform":"youtube","channelId":"UCabcdefghijklmnopqrstuv","fileId":"00000000-0000-4000-8000-000000000001","title":"QA test","description":"test upload","privacy":"private","confirmPublic":false,"madeForKids":false});
    assert!(publishing::validate_draft(base.clone()).is_ok());
    for patch in [
        json!({"platform":"threads"}),
        json!({"channelId":""}),
        json!({"title":""}),
        json!({"fileId":"/etc/passwd"}),
        json!({"privacy":"public"}),
        json!({"madeForKids":"no"}),
    ] {
        let mut v = base.clone();
        for (k, x) in patch.as_object().unwrap() {
            v[k] = x.clone();
        }
        assert!(publishing::validate_draft(v).is_err());
    }
    let mut public = base;
    public["privacy"] = json!("public");
    public["confirmPublic"] = json!(true);
    assert!(publishing::validate_draft(public).is_ok());
}
#[test]
fn qa_sample_uses_the_native_video_contract() {
    let sample = publishing::sample_project();
    assert!(uuid::Uuid::parse_str(sample["id"].as_str().unwrap()).is_ok());
    assert_eq!(sample["language"], "ko");
    assert_eq!(sample["template"], "reference-briefing");
    assert_eq!(sample["scenes"][0]["durationSec"], 3.0);
}
#[test]
fn provider_receipt_must_match_the_authorized_channel_and_report_actual_privacy() {
    let channel = "UCabcdefghijklmnopqrstuv";
    let value = json!({"id":"abcdefghijk","snippet":{"channelId":channel},"status":{"privacyStatus":"private"}});
    assert_eq!(
        publishing::validate_receipt(&value, channel).unwrap().1,
        "private"
    );
    assert!(publishing::validate_receipt(&value, "UCzzzzzzzzzzzzzzzzzzzzzz").is_err());
    assert!(publishing::validate_receipt(&json!({"id":"abcdefghijk"}), channel).is_err());
}
#[test]
fn upload_session_url_rejects_redirect_and_credential_exfiltration_targets() {
    assert!(publishing::trusted_upload_url(
        "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc"
    ));
    for url in [
        "http://www.googleapis.com/upload/youtube/v3/videos",
        "https://www.googleapis.com.evil.test/upload/youtube/v3/videos",
        "https://www.googleapis.com:9443/upload/youtube/v3/videos",
        "https://u:p@www.googleapis.com/upload/youtube/v3/videos",
        "https://www.googleapis.com/other",
    ] {
        assert!(!publishing::trusted_upload_url(url));
    }
}
