use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{fs, io::Cursor, path::Path};
use toris_studio_desktop::assets::dispatch_at;

fn spec(w: u32, h: u32, preset: &str, format: &str) -> Value {
    json!({"title":"규격 검증","prompt":"원본 보존","purpose":"project","project":"출시 에셋","width":w,"height":h,"format":format,"fit":"contain","quantity":1,"presetId":preset,"backgroundColor":"#123456","backgroundMode":"transparent"})
}
fn png_bytes(w: u32, h: u32, rgba: Vec<u8>) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&rgba)
            .unwrap();
    }
    bytes
}
fn source() -> Vec<u8> {
    png_bytes(2, 1, vec![255, 0, 0, 255, 0, 0, 255, 0])
}
fn import(root: &Path, request: Value, bytes: &[u8]) -> Result<Value, String> {
    dispatch_at(
        root,
        "import",
        json!({"filename":"source.png","dataBase64":STANDARD.encode(bytes),"spec":request}),
    )
    .map(|r| r["asset"].clone())
}
fn png_read(asset: &Value) -> (png::OutputInfo, Vec<u8>, bool) {
    let mut reader = png::Decoder::new(Cursor::new(
        fs::read(asset["outputPath"].as_str().unwrap()).unwrap(),
    ))
    .read_info()
    .unwrap();
    let srgb = reader.info().srgb.is_some();
    let mut bytes = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut bytes).unwrap();
    bytes.truncate(info.buffer_size());
    (info, bytes, srgb)
}
#[test]
fn play_feature_and_screenshots_remove_the_alpha_channel_and_use_selected_background() {
    let root = tempfile::tempdir().unwrap();
    for (id, w, h) in [
        ("play-feature", 1024, 500),
        ("play-phone-portrait", 1080, 1920),
        ("play-tablet-landscape", 2560, 1440),
    ] {
        let asset = import(root.path(), spec(w, h, id, "png"), &source()).unwrap();
        let (info, bytes, _) = png_read(&asset);
        assert_eq!((info.width, info.height), (w, h));
        assert_eq!(
            info.color_type,
            png::ColorType::Rgb,
            "{id} must have no alpha channel"
        );
        assert_eq!(&bytes[..3], &[0x12, 0x34, 0x56]);
        assert_eq!(asset["details"]["hasAlphaChannel"], false);
        assert_eq!(asset["spec"]["backgroundMode"], "solid");
    }
}
#[test]
fn play_icon_is_rgba_srgb_512_and_within_maximum_bytes() {
    let root = tempfile::tempdir().unwrap();
    let asset = import(root.path(), spec(512, 512, "play-icon", "png"), &source()).unwrap();
    let (info, _, srgb) = png_read(&asset);
    assert_eq!((info.width, info.height), (512, 512));
    assert_eq!(info.color_type, png::ColorType::Rgba);
    assert_eq!(info.bit_depth, png::BitDepth::Eight);
    assert!(
        srgb,
        "PNG must explicitly identify the sRGB output color space"
    );
    assert!(
        fs::metadata(asset["outputPath"].as_str().unwrap())
            .unwrap()
            .len()
            <= 1024 * 1024
    );
}
#[test]
fn preset_claims_cannot_bypass_native_dimensions_formats_or_color_validation() {
    let root = tempfile::tempdir().unwrap();
    for invalid in [
        spec(512, 513, "play-icon", "png"),
        spec(512, 512, "play-icon", "webp"),
        spec(1024, 500, "play-feature", "ico"),
        spec(1920, 1080, "favicon-32", "png"),
        spec(32, 32, "unknown", "png"),
        spec(320, 320, "custom", "ico"),
        spec(32, 16, "custom", "ico"),
    ] {
        assert!(
            dispatch_at(root.path(), "create_jobs", invalid.clone()).is_err(),
            "{invalid}"
        );
    }
    let mut bad = spec(32, 32, "custom", "png");
    bad["backgroundColor"] = json!("#12345g");
    assert!(import(root.path(), bad, &source()).is_err());
    assert_eq!(
        dispatch_at(root.path(), "snapshot", json!({})).unwrap()["total"],
        0
    );
}
#[test]
fn actual_ico_container_is_encoded_at_every_favicon_size() {
    let root = tempfile::tempdir().unwrap();
    for size in [16, 32, 48, 64, 96] {
        let asset = import(
            root.path(),
            spec(size, size, &format!("favicon-{size}"), "ico"),
            &source(),
        )
        .unwrap();
        let bytes = fs::read(asset["outputPath"].as_str().unwrap()).unwrap();
        assert_eq!(&bytes[..6], &[0, 0, 1, 0, 1, 0]);
        assert_eq!((bytes[6] as u32, bytes[7] as u32), (size, size));
        let offset = u32::from_le_bytes(bytes[18..22].try_into().unwrap()) as usize;
        let length = u32::from_le_bytes(bytes[14..18].try_into().unwrap()) as usize;
        assert_eq!(offset + length, bytes.len());
        assert_eq!(asset["format"], "ico");
        let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Ico).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (size, size));
    }
}
#[test]
fn library_resize_always_reads_preserved_original_and_never_changes_source_or_old_outputs() {
    let root = tempfile::tempdir().unwrap();
    let original = source();
    let first = import(root.path(), spec(320, 50, "admob-mobile", "png"), &original).unwrap();
    let previous = fs::read(first["outputPath"].as_str().unwrap()).unwrap();
    let output = tempfile::tempdir().unwrap();
    dispatch_at(
        root.path(),
        "settings",
        json!({"projectRoot":output.path()}),
    )
    .unwrap();
    let result = dispatch_at(
        root.path(),
        "resize_asset",
        json!({"id":first["id"],"spec":spec(512,512,"play-icon","png")}),
    )
    .unwrap();
    let resized = &result["asset"];
    assert_ne!(first["id"], resized["id"]);
    assert_eq!(resized["source"], "converted");
    assert_eq!(resized["sourceAssetId"], first["id"]);
    assert_eq!(resized["details"]["originalWidth"], 2);
    assert_eq!(
        fs::read(resized["originalPath"].as_str().unwrap()).unwrap(),
        original
    );
    assert_eq!(
        fs::read(first["outputPath"].as_str().unwrap()).unwrap(),
        previous
    );
    assert!(Path::new(resized["outputPath"].as_str().unwrap())
        .starts_with(output.path().canonicalize().unwrap()));
    assert_eq!(
        dispatch_at(root.path(), "snapshot", json!({})).unwrap()["total"],
        2
    );
}
#[test]
fn embedded_linear_rgb_profile_is_converted_to_srgb_without_changing_alpha() {
    use image::ImageEncoder;
    use lcms2::{CIExyY, CIExyYTRIPLE, Profile, ToneCurve};
    let white = CIExyY {
        x: 0.3127,
        y: 0.3290,
        Y: 1.0,
    };
    let primaries = CIExyYTRIPLE {
        Red: CIExyY {
            x: 0.64,
            y: 0.33,
            Y: 1.0,
        },
        Green: CIExyY {
            x: 0.30,
            y: 0.60,
            Y: 1.0,
        },
        Blue: CIExyY {
            x: 0.15,
            y: 0.06,
            Y: 1.0,
        },
    };
    let linear = ToneCurve::new(1.0);
    let profile = Profile::new_rgb(&white, &primaries, &[&linear, &linear, &linear]).unwrap();
    let mut source = Vec::new();
    let mut encoder = image::codecs::png::PngEncoder::new(&mut source);
    encoder.set_icc_profile(profile.icc().unwrap()).unwrap();
    encoder
        .write_image(
            &[128u8, 128, 128, 127].repeat(16 * 16),
            16,
            16,
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let asset = import(root.path(), spec(16, 16, "custom", "png"), &source).unwrap();
    let (_, pixels, srgb) = png_read(&asset);
    assert!(srgb);
    assert_eq!(asset["details"]["colorHandling"], "icc-to-srgb");
    for pixel in pixels.chunks_exact(4) {
        assert!(
            (185..=191).contains(&pixel[0]),
            "linear 0.5 must become about 188 in sRGB, got {}",
            pixel[0]
        );
        assert_eq!(pixel[0], pixel[1]);
        assert_eq!(pixel[1], pixel[2]);
        assert_eq!(pixel[3], 127);
    }
}
#[test]
fn resize_rejects_missing_or_nonimage_assets_without_mutating_the_library() {
    let root = tempfile::tempdir().unwrap();
    let request = spec(32, 32, "favicon-32", "ico");
    assert!(dispatch_at(
        root.path(),
        "resize_asset",
        json!({"id":"missing","spec":request})
    )
    .is_err());
    let mesh = dispatch_at(
        root.path(),
        "create_mesh",
        json!({"spec":spec(32,32,"custom","png"),"shape":"box","size":[1,1,1],"format":"glb"}),
    )
    .unwrap();
    assert!(dispatch_at(
        root.path(),
        "resize_asset",
        json!({"id":mesh["asset"]["id"],"spec":request})
    )
    .is_err());
    assert_eq!(
        dispatch_at(root.path(), "snapshot", json!({})).unwrap()["total"],
        1
    );
}
#[test]
fn oversized_play_icon_is_not_silently_registered_or_saved_as_compliant() {
    let root = tempfile::tempdir().unwrap();
    let mut state = 123456789u32;
    let noise = (0..512 * 512 * 4)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as u8
        })
        .collect();
    let input = png_bytes(512, 512, noise);
    let result = import(root.path(), spec(512, 512, "play-icon", "png"), &input);
    assert!(result.is_err(), "incompressible RGBA icon exceeds 1024 KiB");
    assert!(result.unwrap_err().contains("1024"));
    assert_eq!(
        dispatch_at(root.path(), "snapshot", json!({})).unwrap()["total"],
        0
    );
}
#[test]
fn jpeg_and_opaque_png_use_the_same_solid_background_and_legacy_png_still_preserves_alpha() {
    let root = tempfile::tempdir().unwrap();
    let a = import(
        root.path(),
        spec(1200, 628, "campaign-landscape", "jpeg"),
        &source(),
    )
    .unwrap();
    let jpeg = image::open(a["outputPath"].as_str().unwrap())
        .unwrap()
        .to_rgb8();
    for (actual, expected) in jpeg
        .get_pixel(0, 0)
        .0
        .into_iter()
        .zip([0x12i16, 0x34, 0x56])
    {
        assert!((actual as i16 - expected).abs() < 5);
    }
    let mut legacy = spec(32, 32, "custom", "png");
    legacy.as_object_mut().unwrap().remove("presetId");
    let (_, bytes, _) = png_read(&import(root.path(), legacy, &source()).unwrap());
    assert_eq!(bytes[3], 0);
}
