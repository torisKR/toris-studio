//! Manual end-to-end probe of the production runner with real models (no window, no IPC).
//! Usage: cargo run --release --example production_probe -- "<topic>" [durationSec] [quality]
//!        TORIS_PROBE_STOCK=1 cargo run --release --example production_probe   (licence-cleared photos, shorts card layout)
//! Uses the installed Wan2.1 MLX engine and the local Qwen3-TTS runtime; writes under TORIS_PROBE_HOME.
use serde_json::json;
use std::sync::Arc;
use toris_studio_desktop::{production, tts_runtime, video_runtime};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let topic = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "2050년 미래 서울을 보여주는 시네마틱 쇼츠".into());
    let duration: u32 = args.get(2).and_then(|d| d.parse().ok()).unwrap_or(15);
    let quality = args.get(3).cloned().unwrap_or_else(|| "preview".into());

    if let Some(existing) = std::env::var("TORIS_PROBE_JOB").ok() {
        let mut job =
            production::read_job(&production::root().unwrap(), &existing).expect("job to resume");
        production::recover(&mut job);
        if job["status"] == "failed" {
            job["status"] = json!("paused");
        }
        for scene in job["scenes"].as_array_mut().unwrap() {
            if scene["video"]["status"] == "running" || scene["video"]["status"] == "failed" {
                scene["video"]["status"] = json!("pending");
            }
        }
        production::write_json(
            &production::root().unwrap().join(&existing).join("job.json"),
            &job,
        )
        .unwrap();
        return run(existing).await;
    }

    if std::env::var_os("TORIS_PROBE_STOCK").is_some() {
        return stock().await;
    }
    let settings = production::parse_settings(&json!({"topic": topic, "durationSec": duration, "aspect": "9:16", "style": "cinematic", "narration": true,
        "subtitleStyle": "shorts-bold", "bgm": "ambient", "quality": quality, "engine": video_runtime::DEFAULT_ENGINE})).unwrap();
    // A fixed storyboard keeps the probe about the runner; the planner has its own tests.
    let scenes = production::scene_count(duration, "ai");
    let each = duration as f64 / scenes as f64;
    let shots = ["Aerial view of a futuristic Seoul skyline in 2050 at dusk, flying vehicles between glass towers",
                 "Han river at night with floating gardens and neon reflections, slow drone shot",
                 "Crowded futuristic Seoul street with holographic signs and people walking, tracking shot",
                 "Sunrise over Namsan tower surrounded by green vertical forests, wide shot"];
    let lines = [
        "2050년, 서울의 하늘길이 열립니다.",
        "한강 위에는 떠 있는 정원이 생겼습니다.",
        "거리는 빛과 사람으로 가득합니다.",
        "새로운 아침이 서울을 비춥니다.",
    ];
    let board = json!({"title": "2050 미래 서울", "story": "미래 서울의 하루", "style": {"look": "cinematic neon", "palette": "teal and amber", "consistency": "same futuristic Seoul skyline"},
        "scenes": (0..scenes).map(|i| json!({"id": format!("s{}", i + 1), "order": i + 1, "durationSec": (each * 10.0).round() / 10.0, "script": lines[i % 4], "narration": lines[i % 4], "caption": lines[i % 4], "prompt": shots[i % 4], "transition": "fade"})).collect::<Vec<_>>()});
    let mut job = production::new_job(&settings);
    production::apply_storyboard(&mut job, board).unwrap();
    let id = job["id"].as_str().unwrap().to_owned();
    production::write_json(
        &production::root().unwrap().join(&id).join("job.json"),
        &job,
    )
    .unwrap();
    println!(
        "job {id} · {} · {}",
        job["generation"]["size"], job["generation"]["output"]
    );
    run(id).await;
}

/// Real photo search + download + TTS + shorts composer, with a fixed storyboard like the reference shorts.
async fn stock() {
    let settings = production::parse_settings(&json!({"topic": "법의 허점을 노린 천재 건축가의 아파트", "durationSec": 15, "aspect": "9:16", "style": "documentary", "narration": true,
        "subtitleStyle": "shorts-bold", "bgm": "pulse", "quality": "preview", "engine": "", "visual": "stock", "layout": "card"})).unwrap();
    let lines = [
        (
            "밴쿠버에 이상한 아파트가 있어요.",
            "이상한 아파트",
            "vancouver house tower",
            "zoom-in",
            None,
        ),
        (
            "아랫부분이 위보다 훨씬 좁아요.",
            "아래가 더 좁은 모양",
            "twisted skyscraper",
            "pan-up",
            None,
        ),
        (
            "다리에서 30m 떨어져 지어야 했거든요.",
            "최소 30m 떨어져야",
            "granville bridge vancouver",
            "pan-left",
            Some(("30m", "다리와의 최소 거리")),
        ),
        (
            "그래서 위로 갈수록 넓혔습니다.",
            "위로 갈수록 넓게",
            "modern residential tower",
            "zoom-out",
            None,
        ),
        (
            "규제를 지키면서 공간을 얻은 거죠.",
            "공간을 얻은 비결",
            "vancouver skyline night",
            "pan-right",
            None,
        ),
    ];
    let mut job = production::new_job(&settings);
    let id = job["id"].as_str().unwrap().to_owned();
    let mut candidates = serde_json::Map::new();
    let mut taken = std::collections::HashSet::new();
    for (i, (_, _, query, _, _)) in lines.iter().enumerate() {
        let scene = format!("s{}", i + 1);
        match production::find_candidates(&id, &scene, query, "9:16", &taken).await {
            Ok(found) => {
                taken.insert(found[0]["url"].as_str().unwrap_or("").to_owned());
                println!(
                    "  {scene} {query}: {} photos · {}",
                    found.len(),
                    found[0]["license"]
                );
                candidates.insert(scene, json!(found));
            }
            Err(error) => println!("  {scene} {query}: {error}"),
        }
    }
    job["candidates"] = serde_json::Value::Object(candidates);
    let board = json!({"title": "법의 허점을 노린 천재 건축가의 아파트", "headline": {"top": "법의 허점(?)을 노린", "bottom": "천재 건축가의 아파트"}, "story": "다리 옆 규제를 피해 위로 갈수록 넓어지는 건물",
        "style": {"look": "documentary photo", "palette": "natural", "consistency": "real photos"},
        "scenes": lines.iter().enumerate().map(|(i, (narration, caption, query, camera, stat))| json!({"id": format!("s{}", i + 1), "order": i + 1, "durationSec": 3.0,
            "script": narration, "narration": narration, "caption": caption, "prompt": "", "transition": if i == 0 { "cut" } else { "fade" }, "search": query,
            "emphasis": if i == 2 { json!(["30m"]) } else { json!([]) }, "camera": camera, "stat": stat.map(|(v, l)| json!({"value": v, "label": l}))})).collect::<Vec<_>>()});
    production::apply_storyboard(&mut job, board).unwrap();
    production::write_json(
        &production::root().unwrap().join(&id).join("job.json"),
        &job,
    )
    .unwrap();
    println!("job {id} · stock shorts");
    run(id).await;
}

async fn run(id: String) {
    let jobs = production::shared();
    jobs.set_emitter(Arc::new(|event| {
        if event["kind"] == "progress" && event["done"].is_number() {
            if event["done"] == event["total"] {
                println!(
                    "  {} {} {}/{}",
                    event["stage"], event["sceneId"], event["done"], event["total"]
                );
            }
        } else if event["kind"] == "state" {
            println!("state {} {}", event["stage"], event["status"]);
        }
    }));
    let video = video_runtime::shared();
    let tts = tts_runtime::shared();
    let started = std::time::Instant::now();
    jobs.spawn(id.clone(), video, tts).unwrap();
    while jobs.running_id().is_some() {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    let job = production::read_job(&production::root().unwrap(), &id).unwrap();
    println!(
        "status {} in {:.0}s",
        job["status"],
        started.elapsed().as_secs_f64()
    );
    println!("qa {}", serde_json::to_string_pretty(&job["qa"]).unwrap());
    println!("outputs {}", job["outputs"]);
    println!("metrics {}", job["metrics"]);
    println!("errors {}", job["errors"]);
}
