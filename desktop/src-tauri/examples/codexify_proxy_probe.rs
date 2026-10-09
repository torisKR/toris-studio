//! Explicit live owned-tunnel check; never changes existing bridges, auth, or registered plugins.
use toris_studio_desktop::codexify_proxy::{ProxyController, ProxyProvider};
#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let provider = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["--live-check"] | ["--live-check", "--provider", "cloudflare"] => {
            ProxyProvider::Cloudflare
        }
        ["--live-check", "--provider", "ngrok"] => ProxyProvider::Ngrok,
        _ => {
            eprintln!("Use --live-check [--provider cloudflare|ngrok] to create and stop one temporary owned proxy.");
            std::process::exit(2);
        }
    };
    let proxy = ProxyController::default();
    let port = toris_studio_desktop::codexify_runtime::RuntimeController::new()
        .status()
        .await
        .unwrap()
        .port;
    match proxy.start_for(provider, port).await {
        Ok(status) => {
            println!("{}", serde_json::to_string(&status).unwrap());
            let stopped = proxy.stop_for(provider).await.unwrap();
            println!("{}", serde_json::to_string(&stopped).unwrap());
        }
        Err(error) => {
            proxy.shutdown();
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
