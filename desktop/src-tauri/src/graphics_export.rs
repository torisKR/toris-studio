//! Raw frames from the Rust compositor, encoded by the bundled CLI only.
use crate::{graphics, graphics_render::PreparedScene, media};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{fs, io::Cursor, path::Path, process::Stdio};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

pub fn still(project: Value, index: usize, time: f64) -> Result<Value, String> {
    media::validate_project(&project)?;
    let duration = project["scenes"][index]["durationSec"]
        .as_f64()
        .ok_or("장면 오류")?;
    if time < 0.0 || time >= duration || !time.is_finite() {
        return Err("미리보기 시각 범위 오류".into());
    }
    let mut prepared = PreparedScene::new(
        &project,
        index,
        540,
        &media::data_dir()?.join("motion-images"),
    )?;
    let frame = prepared.frame(time)?;
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(frame)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|_| "프레임 생성 오류")?;
    Ok(
        json!({"hash":graphics::hash(&project),"dataUrl":format!("data:image/png;base64,{}",STANDARD.encode(bytes.into_inner()))}),
    )
}
pub async fn preview(mut project: Value, index: usize) -> Result<Value, String> {
    media::validate_project(&project)?;
    let scene = project["scenes"].get(index).ok_or("장면 오류")?.clone();
    project["scenes"] = json!([scene]);
    let _permit = media::lock_for_video_activity()?;
    render_at(
        project,
        &media::data_dir()?.join("motion-previews"),
        &media::data_dir()?.join("motion-images"),
        360,
        None,
    )
    .await
}
pub async fn render_at(
    project: Value,
    dir: &Path,
    images: &Path,
    width: u32,
    observer: Option<&(dyn Fn(media::RenderProgress) + Send + Sync)>,
) -> Result<Value, String> {
    media::validate_project(&project)?;
    let hash = source_hash(&project, images)?;
    fs::create_dir_all(dir).map_err(|_| "모션 출력 폴더 오류")?;
    let output = dir.join(format!("motion-{hash}-{width}.mp4"));
    let scenes = project["scenes"].as_array().ok_or("장면 목록 오류")?;
    let duration = scenes
        .iter()
        .map(|s| (s["durationSec"].as_f64().unwrap_or(0.0) * 24.0).ceil() / 24.0)
        .sum::<f64>();
    let (dw, dh) = graphics::dimensions(&project);
    let height = ((dh as f64 * width as f64 / dw as f64 / 2.0).round() as u32).max(1) * 2;
    if !output.is_file() {
        let working = tempfile::tempdir_in(dir).map_err(|_| "출력 임시 폴더 오류")?;
        let mut concat = String::new();
        for (index, s) in scenes.iter().enumerate() {
            media::report_render_progress(
                observer,
                media::RenderStage::Rendering,
                index,
                scenes.len(),
            );
            let frames = (s["durationSec"].as_f64().ok_or("장면 길이 오류")? * 24.0).ceil() as u32;
            let part = working.path().join(format!("s{index}.mp4"));
            let mut cmd = Command::new(crate::media_runtime::resource("ffmpeg")?);
            cmd.args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-f",
                "rawvideo",
                "-pixel_format",
                "rgba",
                "-video_size",
                &format!("{width}x{height}"),
                "-framerate",
                "24",
                "-i",
                "pipe:0",
            ]);
            if let Some(audio) = s["audioPath"].as_str().filter(|a| !a.is_empty()) {
                cmd.args(["-protocol_whitelist", "file,pipe", "-i"])
                    .arg(media::resolve_asset_at(&media::public_dir()?, audio)?);
            } else {
                cmd.args(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]);
            }
            cmd.args([
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-t",
                &format!("{:.6}", frames as f64 / 24.0),
                "-af",
                "apad,aresample=48000",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
                "-movflags",
                "+faststart",
            ])
            .arg(&part)
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .stdout(Stdio::null())
            .kill_on_drop(true);
            #[cfg(windows)]
            cmd.creation_flags(0x08000000);
            let mut child = cmd.spawn().map_err(|_| "동봉 FFmpeg 실행 실패")?;
            let mut input = child.stdin.take().ok_or("출력 파이프 오류")?;
            let stderr = child.stderr.take().ok_or("진단 파이프 오류")?;
            let error = tokio::spawn(async move {
                let mut b = Vec::new();
                let _ = stderr.take(65536).read_to_end(&mut b).await;
                b
            });
            let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, String>>(2);
            let p = project.clone();
            let assets = images.to_path_buf();
            let producer = tokio::task::spawn_blocking(move || {
                let mut scene = match PreparedScene::new(&p, index, width, &assets) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = tx.blocking_send(Err(e));
                        return;
                    }
                };
                for frame in 0..frames {
                    let next = scene.frame(frame as f64 / 24.0).map(|i| i.into_raw());
                    if tx.blocking_send(next).is_err() {
                        break;
                    }
                }
            });
            let streamed =
                tokio::time::timeout(std::time::Duration::from_secs(120 + frames as u64), async {
                    while let Some(frame) = rx.recv().await {
                        input
                            .write_all(&frame?)
                            .await
                            .map_err(|_| "동봉 FFmpeg 프레임 전송 실패")?;
                    }
                    input.shutdown().await.map_err(|_| "영상 입력 종료 오류")?;
                    drop(input);
                    let status = child.wait().await.map_err(|_| "출력 프로세스 오류")?;
                    if !status.success() {
                        return Err("동봉 FFmpeg가 영상을 출력하지 못했습니다.".to_string());
                    }
                    Ok(())
                })
                .await
                .map_err(|_| "모션 출력 제한 시간을 초과했습니다.")?;
            drop(rx);
            let _ = producer.await;
            let diagnostics = error.await.unwrap_or_default();
            if let Err(message) = streamed {
                return Err(format!(
                    "{message}: {}",
                    String::from_utf8_lossy(&diagnostics)
                        .chars()
                        .take(1600)
                        .collect::<String>()
                ));
            }
            concat.push_str(&format!("file 's{index}.mp4'\n"));
        }
        fs::write(working.path().join("segments.txt"), concat)
            .map_err(|_| "장면 목록 저장 실패")?;
        media::report_render_progress(
            observer,
            media::RenderStage::Joining,
            scenes.len(),
            scenes.len(),
        );
        let args = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-protocol_whitelist",
            "file,pipe",
            "-f",
            "concat",
            "-safe",
            "1",
            "-i",
            "segments.txt",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "output.mp4",
        ]
        .map(String::from);
        media::run_command("ffmpeg", &args, Some(working.path()), 120).await?;
        fs::rename(working.path().join("output.mp4"), &output)
            .map_err(|_| "완성 영상 저장 실패")?;
    }
    media::report_render_progress(
        observer,
        media::RenderStage::Completed,
        scenes.len(),
        scenes.len(),
    );
    Ok(
        json!({"path":output.to_string_lossy(),"hash":hash,"durationSec":duration,"width":width,"height":height,"fps":24,"format":project["format"],"renderer":"rust-graphics-ffmpeg"}),
    )
}

/// Installer diagnostics use synthetic assets only; they never load saved settings.
pub async fn smoke() -> Result<Value, String> {
    let root = tempfile::tempdir().map_err(|_| "미디어 진단 폴더 오류")?;
    image::RgbaImage::from_pixel(32, 32, image::Rgba([245u8, 185, 30, 255]))
        .save(root.path().join("sample.png"))
        .map_err(|_| "미디어 진단 이미지 오류")?;
    let mut p = json!({"id":"7a4d583c-f86a-41c6-9cc1-5efef139cfcf","title":"모션 설치 검사","template":"reference-briefing","language":"ko","format":"shorts","motionGraphics":{"version":1,"description":"synthetic installer diagnostic","tables":[{"id":"t","name":"실적","rows":[{"label":"Q3","value":18}]}],"images":[{"id":"sample","width":32,"height":32,"description":"synthetic square"}]},"scenes":[{"id":"s","headline":"","body":"","narration":"","durationSec":0.75,"graphics":{"version":1,"background":"#101820","elements":[{"id":"title","kind":"text","x":100,"y":100,"width":800,"height":300,"z":1,"color":"#ffffff","start":0,"duration":1,"animation":"rise","text":"한글 실적 18%","fontSize":80},{"id":"chart","kind":"bar","x":100,"y":500,"width":800,"height":400,"z":2,"color":"#8ae3bb","start":0,"duration":1,"animation":"draw","tableId":"t"},{"id":"image","kind":"image","x":700,"y":1200,"width":200,"height":200,"z":3,"color":"#ffffff","start":0,"duration":1,"animation":"zoom","assetId":"sample"}]}}]});
    let mut prepared = PreparedScene::new(&p, 0, 540, root.path())?;
    let first = prepared.frame(0.0)?;
    let later = prepared.frame(0.5)?;
    if first == later {
        return Err("미디어 진단 모션 프레임이 변하지 않습니다.".into());
    }
    let full = render_at(p.clone(), root.path(), root.path(), 1080, None).await?;
    let arguments = [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        full["path"].as_str().ok_or("출력 경로 오류")?,
    ]
    .map(String::from);
    let metadata: Value =
        serde_json::from_slice(&media::run_command("ffprobe", &arguments, None, 20).await?)
            .map_err(|_| "미디어 검사 결과 오류")?;
    if metadata["streams"][0]["codec_name"] != "h264"
        || metadata["streams"][0]["width"] != 1080
        || metadata["streams"][0]["height"] != 1920
        || metadata["streams"][0]["r_frame_rate"] != "24/1"
        || metadata["streams"][1]["codec_name"] != "aac"
    {
        return Err("미디어 설치 검사: 코덱·해상도·프레임률 오류".into());
    }
    // Landscape preview must have an even coded size for H.264/yuv420p.
    p["format"] = json!("youtube-landscape");
    let preview = render_at(p, root.path(), root.path(), 360, None).await?;
    if preview["height"].as_u64().unwrap_or(1) % 2 != 0 {
        return Err("가로 미리보기 해상도 오류".into());
    }
    Ok(
        json!({"ok":true,"ffmpeg":"9.0.2","architecture":std::env::consts::ARCH,"width":1080,"height":1920,"fps":24,"video":"h264","audio":"aac","landscapePreview":true,"sameRustCompositor":true,"userDataAccessed":false}),
    )
}

fn source_hash(project: &Value, images: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut digest = Sha256::new();
    digest.update(graphics::hash(project));
    for scene in project["scenes"].as_array().ok_or("장면 오류")? {
        let mut paths = Vec::new();
        for e in scene["graphics"]["elements"]
            .as_array()
            .ok_or("요소 오류")?
        {
            if e["kind"] == "image" {
                paths.push(images.join(format!(
                    "{}.png",
                    e["assetId"].as_str().ok_or("이미지 ID 오류")?
                )));
            }
        }
        if let Some(audio) = scene["audioPath"].as_str().filter(|s| !s.is_empty()) {
            paths.push(media::resolve_asset_at(&media::public_dir()?, audio)?);
        }
        for path in paths {
            let meta = fs::symlink_metadata(&path)
                .map_err(|_| "연결한 이미지·음성 파일이 없습니다. 다시 가져오세요.")?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err("연결한 미디어 파일 형식 오류".into());
            }
            let mut file = fs::File::open(path).map_err(|_| "미디어 읽기 실패")?;
            let mut file_hash = Sha256::new();
            let mut buffer = [0u8; 65536];
            loop {
                let n = file.read(&mut buffer).map_err(|_| "미디어 읽기 실패")?;
                if n == 0 {
                    break;
                }
                file_hash.update(&buffer[..n]);
            }
            digest.update(file_hash.finalize());
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}
