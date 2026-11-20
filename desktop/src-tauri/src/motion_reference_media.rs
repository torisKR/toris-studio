//! Media analysis for motion references: the colours of a local image or video the user picked.
//! Images are decoded with the `image` crate; videos are sampled with the bundled FFmpeg/FFprobe,
//! local files only. Cut rhythm is not measured, so speed and layout come from the base reference.
use crate::motion_reference::{
    contrast, hex, mix, normalize, readable_on, saturation, MediaKind, Origin, Palette, Reference,
    Rgb, Source, MAX_IMAGE_BYTES, MAX_MEDIA_SIDE, MAX_VIDEO_BYTES, MAX_VIDEO_SEC,
    MIN_ACCENT_CONTRAST, MIN_TEXT_CONTRAST, SAMPLE_SIDE, UNMEASURED_NOTE, VIDEO_SAMPLES,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

/// Up to six distinct colours, most frequent first. 4-bit bins keep the result stable.
pub fn dominant_colors(pixels: &[Rgb]) -> Vec<Rgb> {
    let mut bins: std::collections::BTreeMap<u16, (u64, [u64; 3])> = Default::default();
    for p in pixels {
        let key = ((p[0] as u16 >> 4) << 8) | ((p[1] as u16 >> 4) << 4) | (p[2] as u16 >> 4);
        let bin = bins.entry(key).or_insert((0, [0; 3]));
        bin.0 += 1;
        for c in 0..3 {
            bin.1[c] += p[c] as u64;
        }
    }
    let mut ranked: Vec<(u64, u16, Rgb)> = bins
        .into_iter()
        .map(|(key, (n, sum))| {
            (
                n,
                key,
                [(sum[0] / n) as u8, (sum[1] / n) as u8, (sum[2] / n) as u8],
            )
        })
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut out: Vec<Rgb> = Vec::new();
    for (_, _, c) in ranked {
        let distinct = out.iter().all(|o| {
            (0..3)
                .map(|i| (o[i] as f64 - c[i] as f64).powi(2))
                .sum::<f64>()
                .sqrt()
                >= 40.0
        });
        if distinct {
            out.push(c);
        }
        if out.len() == 6 {
            break;
        }
    }
    out
}

/// A reference whose palette comes from pixels; everything else is copied from `base`.
pub fn from_pixels(
    pixels: &[Rgb],
    base: &Reference,
    name: &str,
    source: Source,
) -> Result<Reference, String> {
    let colors = dominant_colors(pixels);
    let bg = *colors.first().ok_or("색을 읽을 수 있는 픽셀이 없습니다.")?;
    let rest: Vec<Rgb> = colors[1..].to_vec();
    // Text in motion graphics is usually near neutral: the least saturated readable colour wins,
    // and frequency breaks ties (colours arrive most frequent first).
    let text = rest
        .iter()
        .copied()
        .filter(|c| contrast(*c, bg) >= MIN_TEXT_CONTRAST)
        .min_by_key(|c| saturation(*c))
        .unwrap_or_else(|| readable_on(bg));
    let mut vivid: Vec<Rgb> = rest
        .iter()
        .copied()
        .filter(|c| *c != text && contrast(*c, bg) >= MIN_ACCENT_CONTRAST)
        .collect();
    vivid.sort_by(|a, b| saturation(*b).cmp(&saturation(*a)));
    let accent = vivid.first().copied().unwrap_or(text);
    let accent2 = rest
        .iter()
        .copied()
        .filter(|c| *c != text && *c != accent)
        .max_by_key(|c| saturation(*c))
        .map(hex)
        .unwrap_or_else(|| base.palette.accent2.clone());
    let mut r = Reference {
        version: 1,
        id: uuid::Uuid::new_v4().to_string(),
        name: name.trim().into(),
        origin: Origin::Media,
        source: Some(source),
        palette: Palette {
            background: hex(bg),
            surface: hex(mix(bg, text, 0.08)),
            text: hex(text),
            accent: hex(accent),
            accent2,
        },
        notes: vec![
            UNMEASURED_NOTE.into(),
            format!("기준 레퍼런스: {}", base.name),
        ],
        ..base.clone()
    };
    normalize(&mut r)?;
    Ok(r)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|_| "파일을 읽을 수 없습니다.")?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|_| "파일을 읽을 수 없습니다.")?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn image_pixels(path: &Path) -> Result<(Vec<[u8; 3]>, u32, u32), String> {
    let bytes = std::fs::read(path).map_err(|_| "이미지를 읽을 수 없습니다.")?;
    let format = image::guess_format(&bytes).map_err(|_| "이미지 형식 오류")?;
    if !matches!(
        format,
        image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP
    ) {
        return Err("PNG·JPEG·WebP 이미지를 선택하세요.".into());
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_MEDIA_SIDE);
    limits.max_image_height = Some(MAX_MEDIA_SIDE);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| "이미지가 손상되었거나 크기를 넘습니다.")?;
    let (width, height) = (decoded.width(), decoded.height());
    let small = decoded
        .thumbnail(128, 128)
        .to_rgb8()
        .pixels()
        .map(|p| p.0)
        .collect();
    Ok((small, width, height))
}

/// The bundled FFmpeg/FFprobe only, local files only, a fixed demuxer list.
pub(crate) fn media_args(path: &Path, head: &[&str]) -> Vec<String> {
    let mut args: Vec<String> = head.iter().map(|s| s.to_string()).collect();
    args.extend(
        [
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            "mov,matroska,webm",
            "-i",
        ]
        .map(String::from),
    );
    args.push(path.to_string_lossy().into_owned());
    args
}

async fn video_pixels(path: &Path) -> Result<(Vec<[u8; 3]>, u32, u32, f64), String> {
    let mut probe = vec![
        "-v".to_string(),
        "error".into(),
        "-select_streams".into(),
        "v:0".into(),
        "-show_entries".into(),
        "stream=width,height:format=duration".into(),
        "-of".into(),
        "json".into(),
    ];
    probe.extend(media_args(path, &[]).into_iter().filter(|a| a != "-i"));
    let info: Value = serde_json::from_slice(
        &crate::media::run_command("ffprobe", &probe, None, 30)
            .await
            .map_err(|_| "영상 정보를 읽지 못했습니다. MP4·MOV·WebM·MKV 영상인지 확인하세요.")?,
    )
    .map_err(|_| "영상 정보 형식 오류")?;
    let stream = &info["streams"][0];
    let (width, height) = (
        stream["width"].as_u64().unwrap_or(0) as u32,
        stream["height"].as_u64().unwrap_or(0) as u32,
    );
    let duration: f64 = info["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse().ok())
        .unwrap_or(0.0);
    check_probe(width, height, duration)?;
    // Spread VIDEO_SAMPLES frames over the whole clip; each frame is SAMPLE_SIDE² pixels.
    let rate = (VIDEO_SAMPLES as f64 / duration).min(2.0);
    let mut args = media_args(path, &["-hide_banner", "-loglevel", "error", "-nostdin"]);
    args.extend([
        "-an".into(),
        "-vf".into(),
        format!("fps={rate:.6},scale={SAMPLE_SIDE}:{SAMPLE_SIDE}"),
        "-frames:v".into(),
        VIDEO_SAMPLES.to_string(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "rgb24".into(),
        "pipe:1".into(),
    ]);
    let raw = crate::media::run_command("ffmpeg", &args, None, 120)
        .await
        .map_err(|_| "영상에서 프레임을 뽑지 못했습니다. 다른 영상 파일을 선택하세요.")?;
    let pixels: Vec<[u8; 3]> = raw.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
    if pixels.is_empty() {
        return Err("영상에서 프레임을 뽑지 못했습니다.".into());
    }
    Ok((pixels, width, height, (duration * 100.0).round() / 100.0))
}

/// File size limit per kind: images 32 MiB, videos 1 GiB. Checked from metadata, before any read.
pub(crate) fn check_size(is_image: bool, bytes: u64) -> Result<(), String> {
    if is_image && bytes > MAX_IMAGE_BYTES {
        return Err("이미지는 32MiB 이하입니다.".into());
    }
    if bytes > MAX_VIDEO_BYTES {
        return Err("영상 파일은 1GiB 이하입니다.".into());
    }
    Ok(())
}
/// Video stream limits from FFprobe: 1~8192 px per side, 0 < duration ≤ 600 s.
pub(crate) fn check_probe(width: u32, height: u32, duration: f64) -> Result<(), String> {
    if !(1..=MAX_MEDIA_SIDE).contains(&width) || !(1..=MAX_MEDIA_SIDE).contains(&height) {
        return Err("영상 화면 크기를 읽지 못했거나 8192px을 넘습니다.".into());
    }
    if !(duration > 0.0 && duration <= MAX_VIDEO_SEC) {
        return Err(format!(
            "영상 길이는 0초 초과 {}분 이하여야 합니다.",
            MAX_VIDEO_SEC as u32 / 60
        ));
    }
    Ok(())
}

/// Colour reference from a local image or video the user picked. Videos are sampled with the
/// bundled FFmpeg; cut rhythm is not measured, so speed and layout come from `base`.
pub async fn from_media(path: &Path, name: &str, base: &Reference) -> Result<Reference, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| "파일을 찾을 수 없습니다.")?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("일반 파일을 선택하세요.".into());
    }
    // Size first, from metadata only: nothing larger than the video limit is opened.
    check_size(false, meta.len())?;
    // File reads (format sniff, hash) run on the blocking pool, not a runtime worker thread.
    let owned = path.to_path_buf();
    let is_image = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        use std::io::Read;
        let mut head = [0u8; 32];
        let mut file = std::fs::File::open(&owned).map_err(|_| "파일을 읽을 수 없습니다.")?;
        let n = file
            .read(&mut head)
            .map_err(|_| "파일을 읽을 수 없습니다.")?;
        if n == 0 {
            return Err("빈 파일입니다.".into());
        }
        Ok(image::guess_format(&head[..n]).is_ok_and(|f| {
            matches!(
                f,
                image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP
            )
        }))
    })
    .await
    .map_err(|_| "파일 확인 오류")??;
    check_size(is_image, meta.len())?;
    let owned = path.to_path_buf();
    let sha256 = tokio::task::spawn_blocking(move || sha256_file(&owned))
        .await
        .map_err(|_| "파일 해시 오류")??;
    let (pixels, source) = if is_image {
        let owned = path.to_path_buf();
        let (pixels, width, height) = tokio::task::spawn_blocking(move || image_pixels(&owned))
            .await
            .map_err(|_| "이미지 분석 오류")??;
        (
            pixels,
            Source {
                sha256: Some(sha256),
                kind: Some(MediaKind::Image),
                width: Some(width),
                height: Some(height),
                ..Source::default()
            },
        )
    } else {
        let (pixels, width, height, duration) = video_pixels(path).await?;
        (
            pixels,
            Source {
                sha256: Some(sha256),
                kind: Some(MediaKind::Video),
                width: Some(width),
                height: Some(height),
                duration_sec: Some(duration),
                ..Source::default()
            },
        )
    };
    from_pixels(&pixels, base, name, source)
}
