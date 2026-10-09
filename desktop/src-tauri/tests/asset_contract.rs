use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::fs;
use toris_studio_desktop::assets::dispatch_at;

fn spec() -> Value {
    json!({"title":"영상 배경","prompt":"푸른 바다, 텍스트 없음","purpose":"video","project":"씬포켓","width":320,"height":180,"format":"png","fit":"contain","quantity":2})
}
fn source_png() -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 2, 2);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_image_data(&[
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
            ])
            .unwrap();
    }
    bytes
}
#[test]
fn assets_queue_is_persistent_and_not_generation() {
    let root = tempfile::tempdir().unwrap();
    let result = dispatch_at(root.path(), "create_jobs", spec()).unwrap();
    assert_eq!(result["jobs"].as_array().unwrap().len(), 2);
    assert_eq!(result["jobs"][0]["status"], "queued");
    assert_ne!(result["jobs"][0]["id"], result["jobs"][1]["id"]);
    let state = dispatch_at(root.path(), "snapshot", json!({})).unwrap();
    assert_eq!(state["total"], 0);
    assert_eq!(state["jobs"].as_array().unwrap().len(), 2);
}
#[test]
fn assets_reject_invalid_requests_without_partial_jobs() {
    let root = tempfile::tempdir().unwrap();
    for patch in [
        json!({"width":0}),
        json!({"width":8192,"height":8192}),
        json!({"quantity":101}),
        json!({"project":"../../.ssh"}),
        json!({"purpose":"unknown"}),
        json!({"format":"exe"}),
    ] {
        let mut request = spec();
        for (k, v) in patch.as_object().unwrap() {
            request[k] = v.clone();
        }
        assert!(dispatch_at(root.path(), "create_jobs", request).is_err());
    }
    assert_eq!(
        dispatch_at(root.path(), "snapshot", json!({})).unwrap()["jobs"],
        json!([])
    );
}
#[test]
fn assets_import_preserves_original_and_exact_dimensions_and_is_idempotent() {
    let root = tempfile::tempdir().unwrap();
    let jobs = dispatch_at(root.path(), "create_jobs", spec()).unwrap();
    let bytes = source_png();
    let input = json!({"filename":"원본.png","dataBase64":STANDARD.encode(&bytes),"jobId":jobs["jobs"][0]["id"],"source":"chatgpt"});
    let imported = dispatch_at(root.path(), "import", input.clone()).unwrap();
    let asset = &imported["asset"];
    assert_eq!(
        fs::read(asset["originalPath"].as_str().unwrap()).unwrap(),
        bytes
    );
    let decoder = png::Decoder::new(fs::File::open(asset["outputPath"].as_str().unwrap()).unwrap());
    let reader = decoder.read_info().unwrap();
    assert_eq!((reader.info().width, reader.info().height), (320, 180));
    assert_eq!(asset["purpose"], "video");
    assert_eq!(asset["project"], "씬포켓");
    let repeated = dispatch_at(root.path(), "import", input).unwrap();
    assert_eq!(repeated["asset"]["id"], asset["id"]);
    let state = dispatch_at(root.path(), "snapshot", json!({})).unwrap();
    assert_eq!(state["total"], 1);
    assert!(state["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|j| j["status"] == "completed"));
}
#[test]
fn assets_bad_media_and_cancelled_jobs_do_not_create_assets() {
    let root = tempfile::tempdir().unwrap();
    let jobs = dispatch_at(root.path(), "create_jobs", spec()).unwrap();
    let id = &jobs["jobs"][0]["id"];
    assert!(dispatch_at(
        root.path(),
        "import",
        json!({"filename":"bad.png","dataBase64":STANDARD.encode(b"not png"),"jobId":id})
    )
    .is_err());
    dispatch_at(
        root.path(),
        "set_job",
        json!({"id":id,"status":"cancelled"}),
    )
    .unwrap();
    assert!(dispatch_at(
        root.path(),
        "import",
        json!({"filename":"ok.png","dataBase64":STANDARD.encode(source_png()),"jobId":id})
    )
    .is_err());
    assert_eq!(
        dispatch_at(root.path(), "snapshot", json!({})).unwrap()["total"],
        0
    );
}
#[test]
fn assets_favorite_review_search_and_folder_settings_persist() {
    let root = tempfile::tempdir().unwrap();
    let output = tempfile::tempdir().unwrap();
    dispatch_at(root.path(), "settings", json!({"videoRoot":output.path()})).unwrap();
    let asset = dispatch_at(
        root.path(),
        "import",
        json!({"filename":"test.png","dataBase64":STANDARD.encode(source_png()),"spec":spec()}),
    )
    .unwrap()["asset"]
        .clone();
    assert!(std::path::Path::new(asset["outputPath"].as_str().unwrap())
        .starts_with(output.path().canonicalize().unwrap()));
    dispatch_at(
        root.path(),
        "update_asset",
        json!({"id":asset["id"],"favorite":true,"review":"approved","tags":["바다"]}),
    )
    .unwrap();
    let state = dispatch_at(
        root.path(),
        "snapshot",
        json!({"query":"바다","favorite":true}),
    )
    .unwrap();
    assert_eq!(state["total"], 1);
    assert_eq!(state["assets"][0]["review"], "approved");
    assert_eq!(
        dispatch_at(root.path(), "snapshot", json!({"purpose":"project"})).unwrap()["total"],
        0
    );
}
#[test]
fn assets_preview_shows_transparency_without_black_matte() {
    let root = tempfile::tempdir().unwrap();
    let result = dispatch_at(
        root.path(),
        "import",
        json!({"filename":"alpha.png","dataBase64":STANDARD.encode(source_png()),"spec":spec()}),
    )
    .unwrap();
    let asset = &result["asset"];
    let output = image::open(asset["outputPath"].as_str().unwrap())
        .unwrap()
        .to_rgba8();
    assert_eq!(output.get_pixel(0, 0).0[3], 0);
    let preview = image::open(asset["previewPath"].as_str().unwrap())
        .unwrap()
        .to_rgb8();
    assert!(
        preview.get_pixel(0, 0).0.iter().all(|v| *v > 5),
        "transparent preview must use a visible neutral matte"
    );
}
#[test]
fn assets_corrupt_store_is_not_silently_erased() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("library.json"), b"{broken").unwrap();
    assert!(dispatch_at(root.path(), "snapshot", json!({})).is_err());
    assert_eq!(
        fs::read(root.path().join("library.json")).unwrap(),
        b"{broken"
    );
}
#[test]
fn assets_native_import_retains_file_names_without_inventing_prompts() {
    let root = tempfile::tempdir().unwrap();
    let sources = tempfile::tempdir().unwrap();
    let file = sources.path().join("기존_배경.png");
    fs::write(&file, source_png()).unwrap();
    let result = dispatch_at(
        root.path(),
        "import_paths",
        json!({"paths":[file],"spec":spec()}),
    )
    .unwrap();
    let asset = &result["results"][0]["asset"];
    assert_eq!(asset["title"], "기존_배경");
    assert_eq!(asset["originalFilename"], "기존_배경.png");
    assert_eq!(asset["prompt"], "");
    assert_eq!(fs::read(file).unwrap(), source_png());
}
#[test]
fn assets_pending_filter_and_target_folder_are_stable() {
    let root = tempfile::tempdir().unwrap();
    let before = tempfile::tempdir().unwrap();
    let after = tempfile::tempdir().unwrap();
    dispatch_at(root.path(), "settings", json!({"videoRoot":before.path()})).unwrap();
    let jobs = dispatch_at(root.path(), "create_jobs", spec()).unwrap();
    dispatch_at(root.path(), "settings", json!({"videoRoot":after.path()})).unwrap();
    dispatch_at(
        root.path(),
        "set_job",
        json!({"id":jobs["jobs"][1]["id"],"status":"cancelled"}),
    )
    .unwrap();
    let pending = dispatch_at(
        root.path(),
        "snapshot",
        json!({"jobStatus":"pending","jobLimit":1}),
    )
    .unwrap();
    assert_eq!(pending["jobs"].as_array().unwrap().len(), 1);
    assert_eq!(pending["jobs"][0]["id"], jobs["jobs"][0]["id"]);
    let asset = dispatch_at(root.path(), "import", json!({"filename":"ok.png","dataBase64":STANDARD.encode(source_png()),"jobId":jobs["jobs"][0]["id"]})).unwrap()["asset"].clone();
    assert!(std::path::Path::new(asset["outputPath"].as_str().unwrap())
        .starts_with(before.path().canonicalize().unwrap()));
}
#[test]
fn assets_generate_real_glb_obj_and_stl_without_network() {
    let root = tempfile::tempdir().unwrap();
    for format in ["glb", "obj", "stl"] {
        let result = dispatch_at(root.path(), "create_mesh", json!({"spec":spec(),"shape":"box","size":[1.0,2.0,3.0],"color":"#92b8ff","format":format})).unwrap();
        let asset = &result["asset"];
        assert_eq!(asset["kind"], "model3d");
        let bytes = fs::read(asset["outputPath"].as_str().unwrap()).unwrap();
        if format == "glb" {
            assert_eq!(&bytes[..4], b"glTF");
            assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 2);
            assert_eq!(
                u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize,
                bytes.len()
            );
        } else if format == "stl" {
            assert_eq!(bytes.len(), 84 + 12 * 50);
        } else {
            assert!(String::from_utf8(bytes).unwrap().contains("f "));
        }
    }
}
