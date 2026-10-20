//! Real, bounded fixture. Every file is synthetic and held in a temporary directory.
use serde_json::json;
use toris_studio_desktop::{graphics_export, graphics_render::PreparedScene, media_runtime};
#[tokio::test]
#[ignore = "requires the pinned bundled media runtime; no system FFmpeg or OS font"]
async fn bundled_tools_render_korean_chart_image_and_preview_matches_output() {
    let root = tempfile::tempdir().unwrap();
    let images = root.path().join("images");
    std::fs::create_dir(&images).unwrap();
    image::RgbaImage::from_pixel(32, 32, image::Rgba([245u8, 185, 30, 255]))
        .save(images.join("sample.png"))
        .unwrap();
    let p = json!({"id":"7a4d583c-f86a-41c6-9cc1-5efef139cfcf","title":"모션 미디어 검증","template":"reference-briefing","language":"ko","format":"shorts","motionGraphics":{"version":1,"description":"테스트","tables":[{"id":"sales","name":"분기 실적","rows":[{"label":"Q1","value":12},{"label":"Q3","value":18}]}],"images":[{"id":"sample","width":32,"height":32,"description":"노란 사각형"}]},"scenes":[{"id":"s1","headline":"","body":"","narration":"","durationSec":2,"graphics":{"version":1,"background":"#101820","elements":[{"id":"title","kind":"text","x":100,"y":150,"width":900,"height":200,"z":1,"color":"#ffffff","start":0,"duration":2,"animation":"rise","text":"한글 실적 18%","fontSize":88},{"id":"chart","kind":"bar","x":100,"y":600,"width":850,"height":700,"z":2,"color":"#8ae3bb","start":0,"duration":2,"animation":"draw","tableId":"sales"},{"id":"picture","kind":"image","x":750,"y":1400,"width":200,"height":200,"z":3,"color":"#ffffff","start":0,"duration":2,"animation":"zoom","assetId":"sample"}]}}]});
    let result = graphics_export::render_at(p.clone(), root.path(), &images, 1080, None)
        .await
        .unwrap();
    let path = result["path"].as_str().unwrap();
    let probe = std::process::Command::new(media_runtime::resource("ffprobe").unwrap())
        .args(["-v", "error", "-show_streams", "-of", "json", path])
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(probe.status.success());
    let metadata: serde_json::Value = serde_json::from_slice(&probe.stdout).unwrap();
    let stream = &metadata["streams"][0];
    assert_eq!(stream["width"], 1080);
    assert_eq!(stream["height"], 1920);
    assert_eq!(stream["codec_name"], "h264");
    assert_eq!(stream["r_frame_rate"], "24/1");
    assert_eq!(metadata["streams"][1]["codec_name"], "aac");
    let mut compositor = PreparedScene::new(&p, 0, 1080, &images).unwrap();
    let mut frames = Vec::new();
    for (label, time) in [("start", 0.0), ("middle", 1.0), ("end", 47.0 / 24.0)] {
        let frame = root.path().join(format!("{label}.png"));
        let decoded = std::process::Command::new(media_runtime::resource("ffmpeg").unwrap())
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                &time.to_string(),
                "-i",
                path,
                "-frames:v",
                "1",
            ])
            .arg(&frame)
            .env("PATH", "")
            .output()
            .unwrap();
        assert!(
            decoded.status.success(),
            "{}",
            String::from_utf8_lossy(&decoded.stderr)
        );
        let actual = image::open(&frame).unwrap().to_rgba8();
        let expected = compositor.frame(time).unwrap();
        let difference = actual
            .pixels()
            .zip(expected.pixels())
            .flat_map(|(a, b)| (0..3).map(move |i| a[i].abs_diff(b[i]) as u64))
            .sum::<u64>() as f64
            / (1080.0 * 1920.0 * 3.0);
        assert!(
            difference < 3.0,
            "preview vs MP4 frame mean difference {difference}"
        );
        frames.push(actual);
        if let Some(dest) = std::env::var_os("TORIS_MOTION_EVIDENCE") {
            std::fs::create_dir_all(&dest).unwrap();
            std::fs::copy(
                &frame,
                std::path::PathBuf::from(&dest).join(format!("{label}.png")),
            )
            .unwrap();
            if label == "end" {
                std::fs::copy(path, std::path::PathBuf::from(dest).join("fixture.mp4")).unwrap();
            }
        }
    }
    assert_ne!(frames[0], frames[1]);
    assert!(frames[1].get_pixel(850, 1500)[0].abs_diff(245) <= 3);
    // Cache is keyed by the complete editing content and resolution.
    assert_eq!(
        graphics_export::render_at(p.clone(), root.path(), &images, 1080, None)
            .await
            .unwrap()["path"],
        result["path"]
    );
    std::fs::remove_file(images.join("sample.png")).unwrap();
    assert!(
        graphics_export::render_at(p, root.path(), &images, 1080, None)
            .await
            .is_err(),
        "cached output cannot hide a missing source image"
    );
}
