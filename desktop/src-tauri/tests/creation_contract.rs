use serde_json::json;
use toris_studio_desktop::creation;

#[test]
fn receipt_cannot_be_invented_and_duplicate_draft_is_idempotent() {
    let root = tempfile::tempdir().unwrap();
    let created = creation::create_at(
        root.path(),
        json!({"kind":"text","title":"게시글","prompt":"짧은 설명","sourceId":"same-source","sourceRevision":"v1"}),
    )
    .unwrap();
    let request = &created["request"];
    assert_eq!(request["status"], "saved");
    assert!(request["readAt"].is_null());
    let input = json!({"requestId":request["id"],"revision":request["revision"],"draft":{"text":"사용자가 검토할 실제 초안"}});
    assert!(creation::receive_at(root.path(), input.clone()).is_err());
    let read = creation::read_at(root.path(), &request["id"].as_str().unwrap(), None).unwrap();
    assert_eq!(read["status"], "read");
    let received = creation::receive_at(root.path(), input.clone()).unwrap();
    assert_eq!(received["status"], "draft-received");
    assert_eq!(
        creation::receive_at(root.path(), input.clone()).unwrap(),
        received
    );
    creation::create_at(root.path(),json!({"kind":"text","title":"새 요청","prompt":"다음 주제","sourceId":"same-source","sourceRevision":"v2"})).unwrap();
    assert_eq!(
        creation::receive_at(root.path(), input.clone()).unwrap(),
        received
    );
    let mut changed = input;
    changed["draft"]["text"] = json!("다른 초안");
    assert!(creation::receive_at(root.path(), changed).is_err());
}

#[test]
fn cancelled_and_stale_requests_reject_late_receipts_without_mutation() {
    let root = tempfile::tempdir().unwrap();
    let first = creation::create_at(root.path(), json!({"kind":"text","title":"글","prompt":"주제","sourceId":"content-1","sourceRevision":"v1"})).unwrap()["request"].clone();
    creation::read_at(root.path(), first["id"].as_str().unwrap(), None).unwrap();
    let second = creation::create_at(root.path(), json!({"kind":"text","title":"새 글","prompt":"주제 수정","sourceId":"content-1","sourceRevision":"v2"})).unwrap()["request"].clone();
    let reply = json!({"requestId":first["id"],"revision":first["revision"],"draft":{"text":"늦게 도착한 초안"}});
    assert!(creation::receive_at(root.path(), reply).is_err());
    let cancelled = creation::cancel_at(
        root.path(),
        json!({"requestId":second["id"],"revision":second["revision"]}),
    )
    .unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    assert!(creation::read_at(root.path(), second["id"].as_str().unwrap(), None).is_err());
    assert!(creation::receive_at(root.path(), json!({"requestId":second["id"],"revision":second["revision"],"draft":{"text":"취소 뒤 초안"}})).is_err());
}

#[test]
fn closed_draft_schema_and_store_bounds_reject_executable_authority() {
    let root = tempfile::tempdir().unwrap();
    assert!(creation::create_at(
        root.path(),
        json!({"kind":"shell","title":"실행","prompt":"명령"})
    )
    .is_err());
    assert!(creation::create_at(
        root.path(),
        json!({"kind":"text","title":"글","prompt":"x".repeat(24001)})
    )
    .is_err());
    let created = creation::create_at(
        root.path(),
        json!({"kind":"text","title":"글","prompt":"주제"}),
    )
    .unwrap();
    let id = created["request"]["id"].as_str().unwrap();
    creation::read_at(root.path(), id, None).unwrap();
    assert!(creation::receive_at(root.path(), json!({"requestId":id,"revision":created["request"]["revision"],"draft":{"text":"본문","command":"sh"}})).is_err());
}

#[test]
fn video_receipt_is_native_bounded_and_never_saves_or_executes_project() {
    let root = tempfile::tempdir().unwrap();
    let request = creation::create_at(
        root.path(),
        json!({"kind":"video","title":"영상","prompt":"영상 기획"}),
    )
    .unwrap()["request"]
        .clone();
    creation::read_at(root.path(), request["id"].as_str().unwrap(), None).unwrap();
    let project = json!({"title":"검토할 영상","format":"shorts","template":"adaptive-promo","language":"ko","scenes":[{"id":"scene-1","headline":"첫 장면","body":"본문","narration":"설명","durationSec":6,"motion":{"preset":"kinetic-title","intensity":0.5}}]});
    let mut input = json!({"requestId":request["id"],"revision":request["revision"],"draft":{"project":project}});
    for patch in [
        json!({"script":"alert(1)"}),
        json!({"mediaUrl":"file:///private/file"}),
        json!({"durationSec":181}),
    ] {
        let mut bad = input.clone();
        for (key, value) in patch.as_object().unwrap() {
            bad["draft"]["project"]["scenes"][0][key] = value.clone();
        }
        assert!(creation::receive_at(root.path(), bad).is_err());
    }
    let received = creation::receive_at(root.path(), input.clone()).unwrap();
    assert_eq!(received["reviewRequired"], true);
    assert_eq!(received["draft"]["project"], project);
    assert!(!root.path().join("projects.json").exists());
    input["revision"] = json!("stale");
    assert!(creation::receive_at(root.path(), input).is_err());
}

#[test]
fn corrupt_or_symlinked_stores_are_preserved() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("requests.json"), b"{corrupt").unwrap();
    assert!(creation::list_at(root.path()).is_err());
    assert_eq!(
        std::fs::read(root.path().join("requests.json")).unwrap(),
        b"{corrupt"
    );
    #[cfg(unix)]
    {
        let destination = tempfile::tempdir().unwrap();
        let link = root.path().join("linked");
        std::os::unix::fs::symlink(destination.path(), &link).unwrap();
        assert!(creation::list_at(&link).is_err());
        assert!(!destination.path().join("requests.lock").exists());
    }
}

#[test]
fn packaged_stdio_records_actual_read_and_draft_receipt_in_isolated_home() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let root = tempfile::tempdir().unwrap();
    let assets = tempfile::tempdir().unwrap();
    let request = creation::create_at(
        root.path(),
        json!({"kind":"text","title":"stdio 검증","prompt":"검토용 초안"}),
    )
    .unwrap()["request"]
        .clone();
    let mut child = Command::new(env!("CARGO_BIN_EXE_toris-studio-desktop"))
        .arg("--studio-mcp")
        .env_clear()
        .env("TORIS_STUDIO_ASSET_HOME", assets.path())
        .env("TORIS_STUDIO_CREATION_TEST_HOME", root.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let messages = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"studio_creation_request_get","arguments":{"requestId":request["id"],"revision":request["revision"]}}}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"studio_creation_draft_receive","arguments":{"requestId":request["id"],"revision":request["revision"],"draft":{"text":"실제 stdio 도구로 받은 검증 초안"}}}}),
    ];
    {
        let mut stdin = child.stdin.take().unwrap();
        for message in messages {
            writeln!(stdin, "{message}").unwrap();
        }
    }
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let responses: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(responses.len(), 3);
    assert_eq!(responses[1]["result"]["isError"], false);
    assert_eq!(responses[2]["result"]["isError"], false);
    let received = creation::get_at(root.path(), request["id"].as_str().unwrap()).unwrap();
    assert_eq!(received["status"], "draft-received");
    assert!(received["readAt"].as_str().is_some());
    assert!(received["draftReceivedAt"].as_str().is_some());
    assert!(!assets.path().join("settings.json").exists());
}

#[test]
fn inbox_capacity_rejects_overflow_without_dropping_any_user_request() {
    let root = tempfile::tempdir().unwrap();
    let mut ids = Vec::new();
    for number in 0..200 {
        let created = creation::create_at(
            root.path(),
            json!({"kind":"text","title":format!("요청 {number}"),"prompt":"검토용 요청"}),
        )
        .unwrap();
        ids.push(created["request"]["id"].clone());
    }
    assert!(creation::create_at(
        root.path(),
        json!({"kind":"text","title":"초과 요청","prompt":"기존 요청 보존"})
    )
    .is_err());
    let listed = creation::list_at(root.path()).unwrap();
    let saved: Vec<_> = listed["requests"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].clone())
        .collect();
    assert_eq!(saved, ids);
}
