use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::fs;
use toris_studio_desktop::assets::dispatch_at;

fn spec() -> Value {
    json!({"title":"복구 검증","prompt":"Test only","purpose":"project","project":"Audit","width":32,"height":32,"format":"png","fit":"contain","quantity":1})
}
fn png() -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&[255, 0, 0, 255])
            .unwrap();
    }
    bytes
}
#[test]
fn idempotent_receipt_must_not_report_missing_files_as_a_saved_result() {
    let root = tempfile::tempdir().unwrap();
    let jobs = dispatch_at(root.path(), "create_jobs", spec()).unwrap();
    let input = json!({"jobId":jobs["jobs"][0]["id"],"filename":"original.png","dataBase64":STANDARD.encode(png())});
    let result = dispatch_at(root.path(), "import", input.clone()).unwrap();
    fs::remove_file(result["asset"]["outputPath"].as_str().unwrap()).unwrap();
    assert!(
        dispatch_at(root.path(), "import", input).is_err(),
        "a missing completed output cannot be returned as successfully saved"
    );
    assert_eq!(
        dispatch_at(root.path(), "snapshot", json!({})).unwrap()["libraryTotal"],
        1
    );
    assert_eq!(
        fs::read(result["asset"]["originalPath"].as_str().unwrap()).unwrap(),
        png()
    );
}
#[test]
fn malformed_ascii_stl_cannot_be_registered_as_a_viewable_model() {
    let root = tempfile::tempdir().unwrap();
    for text in [
        "solid invalid\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendsolid invalid",
        "solid invalid\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendsolid invalid",
        "solid invalid\nfacet normal NaN 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid invalid",
    ] {
        assert!(dispatch_at(root.path(),"import",json!({"filename":"invalid.stl","dataBase64":STANDARD.encode(text),"spec":spec()})).is_err(),"malformed STL accepted: {text}");
    }
    assert_eq!(
        dispatch_at(root.path(), "snapshot", json!({})).unwrap()["libraryTotal"],
        0
    );
}
#[test]
fn standard_ascii_stl_and_multiple_named_solids_remain_supported() {
    let root = tempfile::tempdir().unwrap();
    let one="solid Triangle\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 0\n  endloop\n endfacet\nendsolid Triangle\n";
    for text in [one.to_owned(), format!("{one}\n{one}")] {
        let result = dispatch_at(
            root.path(),
            "import",
            json!({"filename":"valid.stl","dataBase64":STANDARD.encode(&text),"spec":spec()}),
        )
        .unwrap();
        assert_eq!(result["asset"]["kind"], "model3d");
        assert_eq!(
            result["asset"]["details"]["triangles"],
            text.matches("facet normal").count()
        );
    }
}
