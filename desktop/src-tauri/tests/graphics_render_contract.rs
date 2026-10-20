use serde_json::json;
use toris_studio_desktop::graphics_render;
#[test]
fn same_compositor_is_deterministic_and_missing_images_fail() {
    let p = json!({"format":"shorts","motionGraphics":{"version":1,"description":"","tables":[],"images":[]},"scenes":[{"id":"s","durationSec":1,"graphics":{"version":1,"background":"#102030","elements":[{"id":"box","kind":"rectangle","x":10,"y":20,"width":100,"height":80,"z":0,"color":"#ff0000","start":0,"duration":1,"animation":"slide"}]}}]});
    let dir = tempfile::tempdir().unwrap();
    let mut scene = graphics_render::PreparedScene::new(&p, 0, 108, dir.path()).unwrap();
    let a = scene.frame(0.0).unwrap();
    let b = scene.frame(0.5).unwrap();
    assert_ne!(a, b);
    assert_eq!(b, scene.frame(0.5).unwrap());
    assert_eq!(b.dimensions(), (108, 192));
    let mut broken = p;
    broken["scenes"][0]["graphics"]["elements"][0]["kind"] = json!("image");
    broken["scenes"][0]["graphics"]["elements"][0]["assetId"] = json!("absent");
    assert!(graphics_render::PreparedScene::new(&broken, 0, 108, dir.path()).is_err());
}
#[test]
fn preview_jobs_are_bounded_and_landscape_height_is_even() {
    let first = graphics_render::try_preview_permit().unwrap();
    assert!(graphics_render::try_preview_permit().is_err());
    drop(first);
    assert!(graphics_render::try_preview_permit().is_ok());
    let p = json!({"format":"youtube-landscape","motionGraphics":{"version":1,"description":"","tables":[],"images":[]},"scenes":[{"id":"s","durationSec":1,"graphics":{"version":1,"background":"#102030","elements":[]}}]});
    let dir = tempfile::tempdir().unwrap();
    let mut s = graphics_render::PreparedScene::new(&p, 0, 360, dir.path()).unwrap();
    assert_eq!(s.frame(0.5).unwrap().height() % 2, 0);
}
