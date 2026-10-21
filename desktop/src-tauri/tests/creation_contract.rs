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

fn isolated_stdio(
    messages: Vec<serde_json::Value>,
    creation_home: &std::path::Path,
    draft_home: &std::path::Path,
) -> Vec<serde_json::Value> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let assets = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_toris-studio-desktop"))
        .arg("--studio-mcp")
        .env_clear()
        .env("TORIS_STUDIO_ASSET_HOME", assets.path())
        .env("TORIS_STUDIO_CREATION_TEST_HOME", creation_home)
        .env("TORIS_STUDIO_DRAFT_TEST_HOME", draft_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || {
        for message in messages {
            writeln!(stdin, "{message}").unwrap();
        }
    });
    let output = child.wait_with_output().unwrap();
    writer.join().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn compiled_stdio_accepts_maximum_multibyte_text_and_bounded_video_receipts() {
    let root = tempfile::tempdir().unwrap();
    let drafts = tempfile::tempdir().unwrap();
    let mut messages = vec![json!({"jsonrpc":"2.0","id":1,"method":"initialize"})];
    let text = "🎬".repeat(40_000);
    let project = json!({"title":"🎬".repeat(300),"format":"shorts","template":"adaptive-promo","language":"ko","scenes":(0..12).map(|i|json!({"id":format!("scene-{i}"),"headline":"🎬".repeat(300),"body":"🎬".repeat(2000),"narration":"🎬".repeat(2000),"durationSec":15,"motion":{"preset":"kinetic-title","intensity":0.5}})).collect::<Vec<_>>()});
    let mut saved = Vec::new();
    for (kind, draft) in [
        ("text", json!({"text":text})),
        ("video", json!({"project":project})),
    ] {
        let request = creation::create_at(
            root.path(),
            json!({"kind":kind,"title":"최대 크기 검증","prompt":"검토용 요청"}),
        )
        .unwrap()["request"]
            .clone();
        messages.push(json!({"jsonrpc":"2.0","id":messages.len()+1,"method":"tools/call","params":{"name":"studio_creation_request_get","arguments":{"requestId":request["id"],"revision":request["revision"]}}}));
        let receive = json!({"jsonrpc":"2.0","id":messages.len()+1,"method":"tools/call","params":{"name":"studio_creation_draft_receive","arguments":{"requestId":request["id"],"revision":request["revision"],"draft":draft}}});
        assert!(receive.to_string().len() > 128 * 1024);
        messages.push(receive);
        saved.push((request, draft));
    }
    let responses = isolated_stdio(messages, root.path(), drafts.path());
    assert_eq!(responses.len(), 5);
    for response in &responses[1..] {
        assert_eq!(response["result"]["isError"], false, "{response}");
    }
    for (request, draft) in saved {
        assert_eq!(
            creation::get_at(root.path(), request["id"].as_str().unwrap()).unwrap()["draft"],
            draft
        );
    }
}

#[test]
fn compiled_stdio_rejects_transport_overflow_then_resumes_next_message() {
    let root = tempfile::tempdir().unwrap();
    let drafts = tempfile::tempdir().unwrap();
    let responses = isolated_stdio(
        vec![
            json!({"jsonrpc":"2.0","id":1,"method":"ping","padding":"x".repeat(512*1024)}),
            json!({"jsonrpc":"2.0","id":2,"method":"ping"}),
        ],
        root.path(),
        drafts.path(),
    );
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0]["error"]["code"], -32700);
    assert_eq!(responses[0]["error"]["message"], "Request exceeds 512 KiB");
    assert_eq!(responses[1]["id"], 2);
    assert_eq!(responses[1]["result"], json!({}));
    assert!(!root.path().join("requests.json").exists());
}

#[test]
fn archived_newer_sns_request_still_blocks_old_first_receipt_through_compiled_stdio() {
    use toris_studio_desktop::chatgpt_drafts;
    let root = tempfile::tempdir().unwrap();
    let drafts = tempfile::tempdir().unwrap();
    let publication = uuid::Uuid::new_v4().to_string();
    // Seed a legacy inbox: A is waiting and B has already received its draft.
    let old = json!({"id":uuid::Uuid::new_v4().to_string(),"publicationId":publication,"revision":1,"topic":"old","context":"","status":"waiting","createdAt":"2026-10-20T00:00:00Z"});
    let newer = json!({"id":uuid::Uuid::new_v4().to_string(),"publicationId":publication,"revision":2,"topic":"new","context":"","status":"received","createdAt":"2026-10-20T01:00:00Z","draft":{"title":"새 제목","description":"새 설명","tags":[],"hashtags":[]}});
    let mut inbox = vec![old.clone(), newer.clone()];
    inbox.extend(
        (0..198).map(|_| json!({"id":uuid::Uuid::new_v4().to_string(),"status":"waiting"})),
    );
    std::fs::write(
        drafts.path().join("inbox.json"),
        serde_json::to_vec(&inbox).unwrap(),
    )
    .unwrap();
    // A new request triggers normal archival of received B, preserving A.
    std::env::set_var("TORIS_STUDIO_DRAFT_TEST_HOME", drafts.path());
    let archived = chatgpt_drafts::request(json!({"topic":"archive trigger"}));
    std::env::remove_var("TORIS_STUDIO_DRAFT_TEST_HOME");
    archived.unwrap();
    assert!(drafts
        .path()
        .join("archive")
        .join(format!("{}.json", newer["id"].as_str().unwrap()))
        .exists());
    let responses = isolated_stdio(
        vec![
            json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"studio_publication_draft_receive","arguments":{"requestId":old["id"],"revision":1,"title":"늦은 제목","description":"늦은 본문","tags":[],"hashtags":[]}}}),
        ],
        root.path(),
        drafts.path(),
    );
    assert_eq!(responses[0]["result"]["isError"], true, "{responses:?}");
    let retained: Vec<serde_json::Value> =
        serde_json::from_slice(&std::fs::read(drafts.path().join("inbox.json")).unwrap()).unwrap();
    assert_eq!(
        retained.iter().find(|r| r["id"] == old["id"]).unwrap()["status"],
        "waiting"
    );
}

#[test]
fn compiled_stdio_keeps_application_limits_below_the_transport_cap() {
    let root = tempfile::tempdir().unwrap();
    let drafts = tempfile::tempdir().unwrap();
    let request = creation::create_at(
        root.path(),
        json!({"kind":"text","title":"한도 검증","prompt":"검토용 요청"}),
    )
    .unwrap()["request"]
        .clone();
    let responses = isolated_stdio(
        vec![
            json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"studio_creation_request_get","arguments":{"requestId":request["id"],"revision":request["revision"]}}}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"studio_creation_draft_receive","arguments":{"requestId":request["id"],"revision":request["revision"],"draft":{"text":"🎬".repeat(40_001)}}}}),
        ],
        root.path(),
        drafts.path(),
    );
    assert_eq!(responses[1]["id"], 2);
    assert_eq!(responses[1]["result"]["isError"], true);
    assert!(responses[1].get("error").is_none());
    assert_eq!(
        creation::get_at(root.path(), request["id"].as_str().unwrap()).unwrap()["status"],
        "read"
    );
}
