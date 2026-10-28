//! Manual probe: one real content-model call through motion_ai with an isolated inbox.
//! Usage: cargo run --example motion_ai_probe -- <kiro-cli model> "<instruction>"
use serde_json::{json, Value};
use std::process::Command;
use toris_studio_desktop::{motion_ai, motion_drafts};
#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let model = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "claude-opus-5.5".into());
    let instruction = args
        .get(2)
        .cloned()
        .unwrap_or_else(|| "이 분기 자료를 전사 회의용 30초 설명 영상으로 만들어 줘".into());
    let dir = tempfile::tempdir().unwrap();
    let project = json!({"id":"7a4d583c-f86a-41c6-9cc1-5efef139cfcf","title":"분기 보고","format":"shorts","template":"reference-briefing","language":"ko",
        "motionGraphics":{"version":1,"description":"3분기 매출이 전 분기보다 20% 늘었다. 신규 고객 유입이 주된 이유다.","tables":[{"id":"sales","name":"분기 매출(억 원)","rows":[{"label":"Q1","value":12},{"label":"Q2","value":15},{"label":"Q3","value":18}]}],"images":[]},
        "scenes":[{"id":"s1","headline":"타이틀","body":"","narration":"","durationSec":9,"graphics":{"version":1,"background":"#101820","elements":[]}}]});
    let r = motion_drafts::request_at(dir.path(), json!({"project":project,"instruction":instruction,"mode":"create","sceneIds":[],"elementIds":[]})).unwrap();
    let id = r["id"].as_str().unwrap().to_owned();
    let started = std::time::Instant::now();
    let result = motion_ai::generate(dir.path(), &id, |system, prompt| {
        let model = model.clone();
        async move {
            let scratch = tempfile::tempdir().map_err(|e| e.to_string())?;
            let output = Command::new("kiro-cli")
                .args([
                    "chat",
                    "--no-interactive",
                    "--trust-tools=",
                    "--model",
                    &model,
                    &format!("{system}\n\n---\n\n{prompt}"),
                ])
                .current_dir(scratch.path())
                .env("NO_COLOR", "1")
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(format!(
                    "kiro-cli failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                        .lines()
                        .last()
                        .unwrap_or("")
                ));
            }
            let text = String::from_utf8_lossy(&output.stdout).replace("\u{1b}[0m", "");
            Ok::<Value, String>(json!({"text": text, "provider": "kiro-cli", "model": model}))
        }
    })
    .await;
    match result {
        Ok(v) => {
            let next = motion_drafts::apply_at(dir.path(), &id, project).unwrap();
            let scenes = next["scenes"].as_array().unwrap();
            println!(
                "OK attempts={} seconds={} scenes={} total={:.1}s",
                v["attempts"],
                started.elapsed().as_secs(),
                scenes.len(),
                scenes
                    .iter()
                    .map(|s| s["durationSec"].as_f64().unwrap())
                    .sum::<f64>()
            );
            for s in scenes {
                println!(
                    "- {} | {}s | {} elements | {}",
                    s["id"],
                    s["durationSec"],
                    s["graphics"]["elements"].as_array().unwrap().len(),
                    s["headline"]
                );
            }
            std::fs::write(
                "/private/tmp/toris-motion-ai-probe.json",
                serde_json::to_vec_pretty(&next).unwrap(),
            )
            .unwrap();
        }
        Err(e) => println!("FAILED after {}s: {e}", started.elapsed().as_secs()),
    }
}
