//! Real, read-only connection diagnostic. Registers this Studio session but never
//! sends, acknowledges messages, runs a model, renders, or publishes anything.
use serde_json::json;
use toris_studio_desktop::reason_network;

#[tokio::main]
async fn main() {
    let network = reason_network::shared();
    let snapshot = network.probe().await;
    println!(
        "{}",
        json!({
            "state": snapshot.state,
            "version": snapshot.version,
            "selfId": snapshot.self_id,
            "peerCount": snapshot.peers.len(),
            "messageCount": snapshot.messages.len(),
            "error": snapshot.error,
        })
    );
    network.shutdown();
}
