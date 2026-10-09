//! One image pipeline for import and non-destructive library re-export.
use super::{err, presets, Spec, MAX_BYTES, MAX_PIXELS};
use image::{
    imageops, DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Rgba, RgbaImage,
};
use lcms2::{ColorSpaceSignature, Intent, PixelFormat, Profile, Transform};
use serde_json::{json, Value};
use std::{fs, io::Cursor, path::Path};

fn decode_srgb(bytes: &[u8]) -> Result<(DynamicImage, &'static str), String> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(err)?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Ico)
    ) {
        return Err("PNG·JPEG·WebP·ICO 이미지만 지원합니다.".into());
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(err)?;
    let (width, height) = decoder.dimensions();
    if width as u64 * height as u64 > MAX_PIXELS {
        return Err("입력 이미지의 전체 픽셀 수가 너무 큽니다.".into());
    }
    let orientation = decoder.orientation().map_err(err)?;
    let profile = decoder.icc_profile().map_err(err)?;
    if profile.as_ref().is_some_and(|p| p.len() > 4 * 1024 * 1024) {
        return Err("ICC 색상 프로파일이 너무 큽니다.".into());
    }
    let mut image = DynamicImage::from_decoder(decoder).map_err(err)?;
    image.apply_orientation(orientation);
    let Some(profile) = profile else {
        return Ok((image, "assumed-srgb"));
    };
    let source = Profile::new_icc(&profile)
        .map_err(|_| "ICC 프로파일을 읽지 못했습니다. sRGB PNG로 저장한 뒤 다시 가져오세요.")?;
    let target = Profile::new_srgb();
    let mut rgba = image.to_rgba8();
    let rgb = match source.color_space() {
        ColorSpaceSignature::RgbData => {
            let mut rgb = image.to_rgb8().into_raw();
            let transform: Transform<u8, u8> = Transform::new(
                &source,
                PixelFormat::RGB_8,
                &target,
                PixelFormat::RGB_8,
                Intent::Perceptual,
            )
            .map_err(err)?;
            transform.transform_in_place(&mut rgb);
            rgb
        }
        ColorSpaceSignature::GrayData => {
            let gray = image.to_luma8().into_raw();
            let mut rgb = vec![0; gray.len() * 3];
            let transform: Transform<u8, u8> = Transform::new(
                &source,
                PixelFormat::GRAY_8,
                &target,
                PixelFormat::RGB_8,
                Intent::Perceptual,
            )
            .map_err(err)?;
            transform.transform_pixels(&gray, &mut rgb);
            rgb
        }
        _ => {
            return Err(
                "RGB·회색조 ICC만 지원합니다. 원본을 sRGB PNG로 변환한 뒤 가져오세요.".into(),
            )
        }
    };
    for (pixel, rgb) in rgba.pixels_mut().zip(rgb.chunks_exact(3)) {
        pixel.0[..3].copy_from_slice(rgb);
    }
    Ok((DynamicImage::ImageRgba8(rgba), "icc-to-srgb"))
}
fn background(spec: &Spec) -> Rgba<u8> {
    // Spec validation establishes exactly six ASCII hexadecimal digits.
    let c = &spec.background_color;
    Rgba([
        u8::from_str_radix(&c[1..3], 16).unwrap(),
        u8::from_str_radix(&c[3..5], 16).unwrap(),
        u8::from_str_radix(&c[5..7], 16).unwrap(),
        255,
    ])
}
fn encode_png(image: &DynamicImage, rgba: bool) -> Result<Vec<u8>, String> {
    let pixels = if rgba {
        image.to_rgba8().into_raw()
    } else {
        image.to_rgb8().into_raw()
    };
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, image.width(), image.height());
        encoder.set_color(if rgba {
            png::ColorType::Rgba
        } else {
            png::ColorType::Rgb
        });
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Best);
        encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
        encoder
            .write_header()
            .map_err(err)?
            .write_image_data(&pixels)
            .map_err(err)?;
    }
    Ok(bytes)
}
pub(super) fn image_output(bytes: &[u8], spec: &Spec, directory: &Path) -> Result<Value, String> {
    let (source, color_handling) = decode_srgb(bytes)?;
    let mut resized = if spec.fit == "cover" {
        source.resize_to_fill(spec.width, spec.height, imageops::FilterType::Lanczos3)
    } else {
        let fitted = source
            .resize(spec.width, spec.height, imageops::FilterType::Lanczos3)
            .to_rgba8();
        let mut canvas = RgbaImage::new(spec.width, spec.height);
        imageops::overlay(
            &mut canvas,
            &fitted,
            ((spec.width - fitted.width()) / 2) as i64,
            ((spec.height - fitted.height()) / 2) as i64,
        );
        DynamicImage::ImageRgba8(canvas)
    };
    let solid = spec.background_mode == "solid" || spec.format == "jpeg";
    if solid {
        let mut canvas = RgbaImage::from_pixel(spec.width, spec.height, background(spec));
        imageops::overlay(&mut canvas, &resized.to_rgba8(), 0, 0);
        resized = DynamicImage::ImageRgba8(canvas);
    }
    let keep_alpha = presets::get(&spec.preset_id).is_some_and(|p| p.alpha == "rgba")
        || (!solid && spec.format != "jpeg");
    let encoded = match spec.format.as_str() {
        "png" => encode_png(&resized, keep_alpha)?,
        "jpeg" => {
            let mut out = Vec::new();
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92);
            encoder
                .set_icc_profile(Profile::new_srgb().icc().map_err(err)?)
                .map_err(err)?;
            encoder
                .encode_image(&DynamicImage::ImageRgb8(resized.to_rgb8()))
                .map_err(err)?;
            out
        }
        "ico" => {
            let mut out = Cursor::new(Vec::new());
            DynamicImage::ImageRgba8(resized.to_rgba8())
                .write_to(&mut out, ImageFormat::Ico)
                .map_err(err)?;
            out.into_inner()
        }
        "webp" => {
            let mut out = Vec::new();
            let mut encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
            encoder
                .set_icc_profile(Profile::new_srgb().icc().map_err(err)?)
                .map_err(err)?;
            if keep_alpha {
                encoder
                    .encode(
                        resized.to_rgba8().as_raw(),
                        spec.width,
                        spec.height,
                        image::ExtendedColorType::Rgba8,
                    )
                    .map_err(err)?;
            } else {
                encoder
                    .encode(
                        resized.to_rgb8().as_raw(),
                        spec.width,
                        spec.height,
                        image::ExtendedColorType::Rgb8,
                    )
                    .map_err(err)?;
            }
            out
        }
        _ => return Err("지원하지 않는 이미지 출력 형식입니다.".into()),
    };
    if let Some(max) = presets::get(&spec.preset_id).and_then(|p| p.max_bytes) {
        if encoded.len() as u64 > max {
            return Err(format!("Play 앱 아이콘이 최대 1024 KiB를 초과합니다 ({} KiB). 원본의 노이즈·세부 표현을 줄인 뒤 다시 내보내세요.",encoded.len().div_ceil(1024)));
        }
    }
    if encoded.len() > MAX_BYTES {
        return Err(
            "출력 파일이 32 MiB를 초과합니다. 크기를 줄이거나 다른 형식을 선택하세요.".into(),
        );
    }
    fs::write(directory.join(format!("export.{}", spec.format)), &encoded).map_err(err)?;
    let thumb = resized.thumbnail(480, 480).to_rgba8();
    let mut preview = RgbaImage::from_fn(thumb.width(), thumb.height(), |x, y| {
        if (x / 12 + y / 12) % 2 == 0 {
            Rgba([21, 30, 43, 255])
        } else {
            Rgba([32, 44, 60, 255])
        }
    });
    imageops::overlay(&mut preview, &thumb, 0, 0);
    DynamicImage::ImageRgba8(preview)
        .to_rgb8()
        .save_with_format(directory.join("preview.jpg"), ImageFormat::Jpeg)
        .map_err(err)?;
    Ok(
        json!({"width":spec.width,"height":spec.height,"originalWidth":source.width(),"originalHeight":source.height(),"upscaled":spec.width>source.width()||spec.height>source.height(),"outputBytes":encoded.len(),"hasAlphaChannel":if spec.format=="ico" {true} else {keep_alpha},"colorSpace":"sRGB","colorHandling":color_handling,"presetId":spec.preset_id}),
    )
}
