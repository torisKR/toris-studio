use serde_json::{json, Value};
use toris_studio_desktop::graphics;
fn project() -> Value {
    json!({"id":"7a4d583c-f86a-41c6-9cc1-5efef139cfcf","title":"분기 실적","format":"shorts","template":"reference-briefing","language":"ko","motionGraphics":{"version":1,"description":"자료","tables":[{"id":"sales","name":"실적","rows":[{"label":"Q3","value":18.0}]}],"images":[]},"scenes":[{"id":"s1","headline":"","body":"","narration":"","durationSec":9,"graphics":{"version":1,"background":"#101820","elements":[{"id":"title","kind":"text","x":100,"y":100,"width":800,"height":200,"z":1,"color":"#ffffff","start":0,"duration":9,"animation":"rise","text":"한국어 실적","fontSize":72},{"id":"chart","kind":"bar","x":100,"y":400,"width":800,"height":600,"z":2,"color":"#8ae3bb","start":0,"duration":9,"animation":"draw","tableId":"sales"}]}}]})
}
#[test]
fn closed_contract_limits_and_legacy_compatibility() {
    assert!(graphics::validate(&project()).is_ok());
    let mut legacy = project();
    legacy.as_object_mut().unwrap().remove("motionGraphics");
    legacy["scenes"][0]
        .as_object_mut()
        .unwrap()
        .remove("graphics");
    assert!(graphics::validate(&legacy).is_ok());
    for (key, value) in [
        ("width", json!(-1)),
        ("animation", json!("eval(code)")),
        ("filter", json!("movie=/private/key")),
        ("fontSize", json!(900)),
    ] {
        let mut invalid = project();
        invalid["scenes"][0]["graphics"]["elements"][0][key] = value;
        assert!(graphics::validate(&invalid).is_err(), "{key}");
    }
    let mut invalid = project();
    invalid["scenes"][0]["durationSec"] = json!(181);
    assert!(graphics::validate(&invalid).is_err());
    let mut invalid = project();
    invalid["scenes"][0]["graphics"]["elements"][1]["tableId"] = json!("missing");
    assert!(graphics::validate(&invalid).is_err());
    let mut invalid = project();
    invalid["scenes"][0]["graphics"]["elements"][1]["id"] = json!("title");
    assert!(graphics::validate(&invalid).is_err());
}
#[test]
fn patches_preserve_other_elements_and_reject_conflicts() {
    let base = project();
    let draft = json!({"operations":[{"op":"set-duration","sceneId":"s1","durationSec":12}]});
    let next = graphics::apply_patch(&base, &draft).unwrap();
    assert_eq!(next["scenes"][0]["graphics"], base["scenes"][0]["graphics"]);
    assert_eq!(next["scenes"][0]["durationSec"].as_f64().unwrap(), 12.0);
    assert!(graphics::apply_patch(
        &base,
        &json!({"operations":[{"op":"delete-element","sceneId":"s1","elementId":"missing"}]})
    )
    .is_err());
    assert!(graphics::apply_patch(
        &base,
        &json!({"operations":[{"op":"code","source":"alert(1)"}]})
    )
    .is_err());
    let mut changed = base.clone();
    changed["title"] = json!("편집");
    assert_ne!(graphics::hash(&base), graphics::hash(&changed));
}
#[test]
fn deterministic_frame_has_animated_positions() {
    let base = project();
    let early = graphics::frame_state(&base, 0, 0.0).unwrap();
    let middle = graphics::frame_state(&base, 0, 3.0).unwrap();
    assert_eq!(middle, graphics::frame_state(&base, 0, 3.0).unwrap());
    assert_ne!(early, middle);
}
