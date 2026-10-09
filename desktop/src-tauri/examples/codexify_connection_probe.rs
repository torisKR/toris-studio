//! Local read-only connection probe; --save reads a non-secret profile from stdin.
use std::io::Read;
use toris_studio_desktop::codexify_connection;

#[tokio::main]
async fn main() -> Result<(), String> {
    if std::env::args().any(|arg| arg == "--save") {
        let mut input = String::new();
        std::io::stdin()
            .take(16_384)
            .read_to_string(&mut input)
            .map_err(|_| "Could not read connection profile.")?;
        let profile = serde_json::from_str(&input).map_err(|_| "Invalid connection profile.")?;
        codexify_connection::save(profile)?;
    }
    let status = codexify_connection::check().await?;
    println!(
        "{}",
        serde_json::to_string(&status).map_err(|_| "Could not serialize status.")?
    );
    if std::env::args().any(|arg| arg == "--send-check") {
        let receipt = codexify_connection::chat_send(codexify_connection::SendInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            message: "앱 채팅 연결 테스트입니다. 파일 생성·수정·게시 없이 chat_write로 ‘앱 채팅 연결 확인 완료’만 응답해 주세요.".into(),
            expected_profile: codexify_connection::load()?,
        }).await?;
        println!(
            "{}",
            serde_json::json!({"messageSaved":receipt["sent"]["end"].is_u64()})
        );
    }
    if std::env::args().any(|arg| arg == "--chat-status") {
        let state = codexify_connection::chat_read().await?;
        let messages = state["messages"].as_array().ok_or("Invalid chat state.")?;
        println!(
            "{}",
            serde_json::json!({
                "projectVerified":true,
                "messageCount":messages.len(),
                "waiting":state["agent_waiting_until_ms"].as_u64().unwrap_or(0)>state["server_time_ms"].as_u64().unwrap_or(0),
                "probeReplyReceived":messages.iter().any(|message|message["role"]=="agent" && message["markdown"].as_str().unwrap_or("").contains("앱 채팅 연결 확인 완료")),
                "deliveredThrough":state["delivered_through"],
                "readThrough":state["read_through"]
            })
        );
    }
    Ok(())
}
