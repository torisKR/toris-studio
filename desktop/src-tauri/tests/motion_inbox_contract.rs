use serde_json::{json, Value};
use toris_studio_desktop::motion_drafts;
fn project() -> Value {
    json!({"id":"7a4d583c-f86a-41c6-9cc1-5efef139cfcf","title":"모션","format":"shorts","template":"reference-briefing","language":"ko","motionGraphics":{"version":1,"description":"원본","tables":[],"images":[]},"scenes":[{"id":"s1","headline":"","body":"","narration":"","durationSec":9,"graphics":{"version":1,"background":"#101820","elements":[]}}]})
}
#[test]
fn receipt_review_conflict_duplicate_cancel_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let p = project();
    let req=motion_drafts::request_at(dir.path(),json!({"project":p,"instruction":"장면 길이를 12초로","mode":"edit","sceneIds":["s1"],"elementIds":[]})).unwrap();
    let reply = json!({"requestId":req["id"],"projectId":p["id"],"baseHash":req["baseHash"],"draft":{"operations":[{"op":"set-duration","sceneId":"s1","durationSec":12}]}});
    let received = motion_drafts::receive_at(dir.path(), reply.clone()).unwrap();
    assert_eq!(received["status"], "received");
    assert_eq!(
        motion_drafts::receive_at(dir.path(), reply.clone()).unwrap(),
        received
    );
    let mut wrong = reply.clone();
    wrong["projectId"] = json!("wrong");
    assert!(motion_drafts::receive_at(dir.path(), wrong).is_err());
    let mut edited = p.clone();
    edited["title"] = json!("수동 편집");
    assert!(motion_drafts::apply_at(dir.path(), req["id"].as_str().unwrap(), edited).is_err());
    let resumed = motion_drafts::get_at(dir.path(), req["id"].as_str().unwrap()).unwrap();
    assert_eq!(resumed["draft"], reply["draft"]);
    let applied =
        motion_drafts::apply_at(dir.path(), req["id"].as_str().unwrap(), p.clone()).unwrap();
    assert_eq!(applied["scenes"][0]["durationSec"].as_f64().unwrap(), 12.0);
    let req = motion_drafts::request_at(
        dir.path(),
        json!({"project":p,"instruction":"수정","mode":"create","sceneIds":[],"elementIds":[]}),
    )
    .unwrap();
    motion_drafts::cancel_at(dir.path(), req["id"].as_str().unwrap()).unwrap();
    let mut late = reply;
    late["requestId"] = req["id"].clone();
    assert!(motion_drafts::receive_at(dir.path(), late).is_err());
}
#[test]
fn scope_and_unrequested_table_mutation_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let p = project();
    let req = motion_drafts::request_at(
        dir.path(),
        json!({"project":p,"instruction":"요소만 수정","mode":"edit","sceneIds":["s1"],"elementIds":["title"]}),
    );
    assert!(req.is_err(), "unknown selected IDs must be rejected");
}
#[test]
fn completed_requests_archive_and_explicit_value_changes_require_permission() {
    let dir = tempfile::tempdir().unwrap();
    let mut p = project();
    p["motionGraphics"]["tables"] =
        json!([{"id":"t","name":"매출","rows":[{"label":"Q3","value":12}]}]);
    let input = json!({"project":p,"instruction":"Q3를 18로 변경","mode":"edit","sceneIds":[],"elementIds":[]});
    let r = motion_drafts::request_at(dir.path(), input.clone()).unwrap();
    let draft = json!({"operations":[{"op":"set-table-value","tableId":"t","row":0,"label":"Q3","expectedValue":12,"value":18}]});
    let reply =
        json!({"requestId":r["id"],"projectId":p["id"],"baseHash":r["baseHash"],"draft":draft});
    assert!(motion_drafts::receive_at(dir.path(), reply.clone()).is_err());
    motion_drafts::cancel_at(dir.path(), r["id"].as_str().unwrap()).unwrap();
    let mut permitted = input.clone();
    permitted["allowDataEdits"] = json!(true);
    let r = motion_drafts::request_at(dir.path(), permitted).unwrap();
    let mut reply = reply;
    reply["requestId"] = r["id"].clone();
    assert!(motion_drafts::receive_at(dir.path(), reply.clone()).is_ok());
    let next = motion_drafts::apply_at(dir.path(), r["id"].as_str().unwrap(), p.clone()).unwrap();
    assert_eq!(
        next["motionGraphics"]["tables"][0]["rows"][0]["value"].as_f64(),
        Some(18.0)
    );
    assert_eq!(next["scenes"], p["scenes"]);
    for _ in 0..45 {
        let r = motion_drafts::request_at(dir.path(), input.clone()).unwrap();
        motion_drafts::cancel_at(dir.path(), r["id"].as_str().unwrap()).unwrap();
    }
    assert!(
        motion_drafts::receive_at(dir.path(), reply).is_ok(),
        "identical archived applied receipt is idempotent"
    );
}
#[test]
fn ai_request_exposes_only_graphics_context_and_no_local_file_or_unknown_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let mut p = project();
    p["privateMetadata"] = json!("do not send");
    p["scenes"][0]["audioPath"] = json!("/voice.wav");
    p["scenes"][0]["localNotes"] = json!("private path");
    let r = motion_drafts::request_at(
        dir.path(),
        json!({"project":p,"instruction":"수정","mode":"edit","sceneIds":[],"elementIds":[]}),
    )
    .unwrap();
    let public = motion_drafts::get_at(dir.path(), r["id"].as_str().unwrap()).unwrap();
    assert!(public["project"].get("privateMetadata").is_none());
    assert!(public["project"]["scenes"][0].get("audioPath").is_none());
    assert!(public["project"]["scenes"][0].get("localNotes").is_none());
}
