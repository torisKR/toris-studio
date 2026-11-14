//! Offline contract tests for project chat: normalizing real-shaped Claude
//! Code and Codex output, the turn command lines, storage and planner replies.
//! No agent is started and nothing is sent anywhere.
use serde_json::json;
use std::path::Path;
use toris_studio_desktop::project_chat::{
    changes, handoff_code, hosted_prompt, normalize_claude, normalize_codex, preview_url,
    strip_code, title_from, tool_summary, turn_command, verify_worktree, work_folder, ChatAgent,
    ChatMode, HostedAssistant, Item, ItemKind, ProjectChat, Thread, CLAUDE_EFFORT, CLAUDE_MODEL,
    MAX_RUNNING,
};
use toris_studio_desktop::reason_agents::{checked_folder, typed_path};
use toris_studio_desktop::reason_network::Message;

const FOLDER: &str = "/Users/me/projects/app";

fn thread(agent: ChatAgent, mode: ChatMode, session: Option<&str>) -> Thread {
    Thread {
        id: "t1".into(),
        project_id: "p1".into(),
        title: "새 대화".into(),
        agent,
        mode,
        provider_session: session.map(str::to_owned),
        created_at: "now".into(),
        updated_at: "now".into(),
        running: false,
        worktree: None,
        preview_url: None,
    }
}

#[test]
fn project_chat_normalizes_claude_stream_json() {
    let init = normalize_claude(
        &json!({"type":"system","subtype":"init","cwd":FOLDER,"session_id":"c48-1","tools":[]}),
        FOLDER,
    );
    assert_eq!(init.session.as_deref(), Some("c48-1"));
    assert!(init.items.is_empty());

    // Hooks and token counters are noise, never chat items.
    for noise in [
        json!({"type":"system","subtype":"hook_response","output":"secret context"}),
        json!({"type":"system","subtype":"thinking_tokens","estimated_tokens":3}),
        json!({"type":"rate_limit_event","rate_limit_info":{}}),
    ] {
        assert_eq!(normalize_claude(&noise, FOLDER).items, Vec::<Item>::new());
    }

    let turn = normalize_claude(
        &json!({"type":"assistant","message":{"model":CLAUDE_MODEL,"content":[
            {"type":"thinking","thinking":"","signature":"x"},
            {"type":"text","text":"  \n"},
            {"type":"text","text":"파일을 만들게요."},
            {"type":"tool_use","id":"toolu_1","name":"Write","input":{"file_path":format!("{FOLDER}/src/hello.txt"),"content":"hi"}}
        ]}}),
        FOLDER,
    );
    let kinds: Vec<ItemKind> = turn.items.iter().map(|i| i.kind).collect();
    assert_eq!(
        kinds,
        [ItemKind::Assistant, ItemKind::Tool],
        "empty thinking and blank text dropped"
    );
    assert_eq!(turn.items[1].text, "src/hello.txt");
    assert_eq!(turn.items[1].tool.as_deref(), Some("Write"));
    assert_eq!(turn.items[1].tool_id.as_deref(), Some("toolu_1"));

    let result = normalize_claude(
        &json!({"type":"user","message":{"role":"user","content":[
            {"type":"tool_result","tool_use_id":"toolu_1","content":"This command requires approval","is_error":true},
            {"type":"text","text":"Stop hook feedback"}
        ]}}),
        FOLDER,
    );
    assert_eq!(
        result.items.len(),
        1,
        "hook text in a user turn is not shown as the user"
    );
    assert_eq!(result.items[0].kind, ItemKind::ToolResult);
    assert!(result.items[0].is_error);
    assert_eq!(result.items[0].tool_id.as_deref(), Some("toolu_1"));

    let done = normalize_claude(
        &json!({"type":"result","subtype":"success","is_error":false,"duration_ms":22039,"total_cost_usd":0.6459,"session_id":"c48-1","result":"done"}),
        FOLDER,
    );
    assert_eq!(done.items[0].kind, ItemKind::Result);
    assert_eq!(done.items[0].text, "완료 · 22초 · $0.65");
    assert_eq!(done.session.as_deref(), Some("c48-1"));

    let failed = normalize_claude(
        &json!({"type":"result","subtype":"error_max_turns","is_error":true}),
        FOLDER,
    );
    assert_eq!(failed.items[0].kind, ItemKind::Error);
    assert!(failed.items[0].text.contains("error_max_turns"));

    let denied = normalize_claude(
        &json!({"type":"system","subtype":"permission_denied","tool_name":"Bash","message":"This command requires approval"}),
        FOLDER,
    );
    assert_eq!(denied.items[0].kind, ItemKind::Notice);
    assert!(denied.items[0].is_error);
}

#[test]
fn project_chat_normalizes_codex_exec_json() {
    let started = normalize_codex(
        &json!({"type":"thread.started","thread_id":"01a1-d816"}),
        FOLDER,
    );
    assert_eq!(started.session.as_deref(), Some("01a1-d816"));

    // Codex reports config warnings as error items before the turn; they are not failures.
    let warning = normalize_codex(
        &json!({"type":"item.completed","item":{"id":"item_0","type":"error","message":"Ignoring malformed agent role"}}),
        FOLDER,
    );
    assert!(warning.items.is_empty());

    let run = normalize_codex(
        &json!({"type":"item.started","item":{"id":"item_3","type":"command_execution","command":"/bin/zsh -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}),
        FOLDER,
    );
    assert_eq!(run.items[0].kind, ItemKind::Tool);
    assert_eq!(run.items[0].text, "/bin/zsh -lc ls");
    let out = normalize_codex(
        &json!({"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"ls","aggregated_output":"boom\n","exit_code":2,"status":"failed"}}),
        FOLDER,
    );
    assert_eq!(out.items[0].kind, ItemKind::ToolResult);
    assert!(out.items[0].is_error);
    assert_eq!(out.items[0].text, "boom\n(종료 코드 2)");
    assert_eq!(out.items[0].tool_id.as_deref(), Some("item_3"));

    let edit = normalize_codex(
        &json!({"type":"item.completed","item":{"id":"item_5","type":"file_change","changes":[{"path":format!("{FOLDER}/a.ts"),"kind":"update"}]}}),
        FOLDER,
    );
    assert_eq!(edit.items[0].text, "update a.ts");

    let say = normalize_codex(
        &json!({"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"ok"}}),
        FOLDER,
    );
    assert_eq!(
        (say.items[0].kind, say.items[0].text.as_str()),
        (ItemKind::Assistant, "ok")
    );

    let done = normalize_codex(
        &json!({"type":"turn.completed","usage":{"input_tokens":63850,"output_tokens":41}}),
        FOLDER,
    );
    assert_eq!(done.items[0].text, "완료 · 출력 41 토큰");
    let failed = normalize_codex(
        &json!({"type":"turn.failed","error":{"message":"quota"}}),
        FOLDER,
    );
    assert_eq!(failed.items[0].kind, ItemKind::Error);
}

#[test]
fn project_chat_turn_commands_pin_model_and_never_grant_full_access() {
    let claude = turn_command(&thread(ChatAgent::Claude, ChatMode::Edit, None));
    assert_eq!(claude.program, "claude");
    let args = claude.args.join(" ");
    assert!(args.contains("-p --output-format stream-json --verbose --input-format text"));
    assert!(args.contains(&format!("--model {CLAUDE_MODEL}")));
    assert!(args.contains("--permission-mode acceptEdits"));
    assert!(!args.contains("--resume"));
    assert!(claude
        .env
        .contains(&("CLAUDE_CODE_EFFORT_LEVEL", CLAUDE_EFFORT.to_owned())));
    assert_eq!(CLAUDE_MODEL, "claude-opus-5-5");
    assert_eq!(CLAUDE_EFFORT, "medium");

    let plan = turn_command(&thread(ChatAgent::Claude, ChatMode::Plan, Some("c48")));
    let args = plan.args.join(" ");
    assert!(args.contains("--permission-mode plan"));
    assert!(args.ends_with("--resume c48"));

    let codex = turn_command(&thread(ChatAgent::Codex, ChatMode::Edit, None));
    assert_eq!(codex.program, "codex");
    assert_eq!(codex.args[0], "exec");
    assert_eq!(codex.args[1], "--json");
    assert!(codex
        .args
        .contains(&"sandbox_mode=\"workspace-write\"".to_owned()));
    assert_eq!(
        codex.args.last().map(String::as_str),
        Some("-"),
        "prompt comes from stdin"
    );

    let resumed = turn_command(&thread(ChatAgent::Codex, ChatMode::Plan, Some("01a1")));
    assert_eq!(&resumed.args[..2], ["exec", "resume"]);
    assert!(resumed
        .args
        .contains(&"sandbox_mode=\"read-only\"".to_owned()));
    let n = resumed.args.len();
    assert_eq!(&resumed.args[n - 2..], ["01a1", "-"]);

    for command in [claude, plan, codex, resumed] {
        let args = command.args.join(" ");
        for forbidden in [
            "bypassPermissions",
            "dangerously",
            "danger-full-access",
            "--full-access",
        ] {
            assert!(!args.contains(forbidden), "{forbidden} in {args}");
        }
    }
}

#[test]
fn project_chat_summaries_and_titles_are_plain_and_capped() {
    assert_eq!(
        tool_summary("Bash", &json!({"command":"pnpm test"}), FOLDER),
        "pnpm test"
    );
    assert_eq!(
        tool_summary(
            "TodoWrite",
            &json!({"todos":[{"content":"a","status":"completed"},{"content":"b","status":"pending"}]}),
            FOLDER
        ),
        "[x] a\n[ ] b"
    );
    assert!(tool_summary("Other", &json!({"x":"y".repeat(5000)}), FOLDER).ends_with("…(잘림)"));
    assert_eq!(
        title_from("\n  로그인 화면 만들어줘\n둘째 줄"),
        "로그인 화면 만들어줘"
    );
    assert_eq!(title_from("   "), "새 대화");
    assert_eq!(title_from(&"가".repeat(80)).chars().count(), 61);
    assert_eq!(title_from("a\u{202e}b"), "ab", "bidi controls stripped");
}

#[test]
fn project_chat_stores_projects_threads_and_items() {
    let root = tempfile::tempdir().unwrap();
    let chat = ProjectChat::new(root.path().join("chat"));
    let project = chat.add_project("/Users/me/projects/app").unwrap();
    assert_eq!(project.name, "app");
    assert_eq!(
        chat.add_project("/Users/me/projects/app").unwrap().id,
        project.id,
        "same folder, same project"
    );

    let t = chat
        .create_thread(&project.id, ChatAgent::Claude, ChatMode::Edit)
        .unwrap();
    assert!(chat
        .create_thread("missing", ChatAgent::Claude, ChatMode::Edit)
        .is_err());
    assert!(chat
        .create_thread("../x", ChatAgent::Claude, ChatMode::Edit)
        .is_err());
    chat.append(
        &t.id,
        &[
            Item::new(ItemKind::User, "안녕"),
            Item::new(ItemKind::Assistant, "네"),
        ],
    )
    .unwrap();
    let items = chat.items(&t.id);
    assert_eq!(
        items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(),
        ["안녕", "네"]
    );

    let updated = chat
        .update_thread(&t.id, |thread| {
            thread.provider_session = Some("c48".into());
            Ok(())
        })
        .unwrap();
    assert_eq!(updated.provider_session.as_deref(), Some("c48"));

    // Reopening reads the same state from disk.
    let again = ProjectChat::new(root.path().join("chat"));
    let (projects, threads) = again.projects();
    assert_eq!(projects.len(), 1);
    assert_eq!(threads[0].provider_session.as_deref(), Some("c48"));

    chat.claim(&t.id, 42).unwrap();
    assert!(chat.claim(&t.id, 43).is_err(), "one turn per thread");
    assert!(chat.projects().1[0].running);
    assert!(chat.delete_thread(&t.id).is_err(), "running thread kept");
    assert!(
        chat.remove_project(&project.id).is_err(),
        "running project kept"
    );
    for n in 1..MAX_RUNNING {
        chat.claim(&format!("other-{n}"), 1).unwrap();
    }
    assert!(chat.claim("one-more", 1).is_err(), "global cap");
    chat.release(&t.id);
    for n in 1..MAX_RUNNING {
        chat.release(&format!("other-{n}"));
    }

    // Editing turns in one folder run one at a time; reading turns and other folders do not wait.
    chat.claim_in("e1", 1, Some("/w/app"), true).unwrap();
    let busy = chat.claim_in("e2", 1, Some("/w/app"), true).unwrap_err();
    assert!(busy.contains("같은 작업 폴더"), "{busy}");
    assert!(chat.check_slot("e2", "/w/app", true).is_err());
    chat.check_slot("e2", "/w/app", false).unwrap();
    chat.check_slot("e2", "/w/app-wt", true).unwrap();
    chat.claim_in("p1", 1, Some("/w/app"), false).unwrap();
    chat.claim_in("e3", 1, Some("/w/app-wt"), true).unwrap();
    for id in ["e1", "p1", "e3"] {
        chat.release(id);
    }
    chat.claim_in("e2", 1, Some("/w/app"), true).unwrap();
    chat.release("e2");

    chat.remove_project(&project.id).unwrap();
    assert!(chat.projects().1.is_empty());
    assert!(
        chat.items(&t.id).is_empty(),
        "items removed with the project"
    );
}

#[test]
fn project_chat_reads_threads_stored_before_worktrees() {
    let root = tempfile::tempdir().unwrap();
    let store = root.path().join("chat");
    std::fs::create_dir_all(&store).unwrap();
    std::fs::write(
        store.join("projects.json"),
        r#"{"projects":[{"id":"p1","name":"app","folder":"/Users/me/projects/app","addedAt":"x"}],
            "threads":[{"id":"t1","projectId":"p1","title":"옛 대화","agent":"codex","mode":"edit",
            "providerSession":"th-1","createdAt":"x","updatedAt":"x"}]}"#,
    )
    .unwrap();
    let chat = ProjectChat::new(store);
    let thread = chat.thread("t1").unwrap();
    assert_eq!(
        thread.worktree, None,
        "an old thread keeps the project folder"
    );
    assert_eq!(thread.provider_session.as_deref(), Some("th-1"));
    let saved = serde_json::to_value(&thread).unwrap();
    assert!(
        saved.get("worktree").is_none(),
        "nothing new is written for it"
    );
}

fn git_in(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// A repository `app` with one commit and staged, unstaged and untracked
/// changes, its worktree `app-wt` on `feature/x`, and an unrelated `other` repo.
struct Repos {
    _dir: tempfile::TempDir,
    root: std::path::PathBuf,
    app: String,
    wt: String,
    other: String,
}

fn repos() -> Repos {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    for name in ["app", "other"] {
        let repo = root.join(name);
        std::fs::create_dir_all(&repo).unwrap();
        git_in(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        std::fs::write(repo.join("b.txt"), "base\n").unwrap();
        git_in(&repo, &["add", "."]);
        git_in(&repo, &["commit", "-qm", "init"]);
    }
    let app = root.join("app");
    git_in(
        &app,
        &["worktree", "add", "-q", "-b", "feature/x", "../app-wt"],
    );
    // The user's own work in progress in the original checkout.
    std::fs::write(app.join("a.txt"), "staged\n").unwrap();
    git_in(&app, &["add", "a.txt"]);
    std::fs::write(app.join("b.txt"), "unstaged\n").unwrap();
    std::fs::write(app.join("mine.txt"), "untracked\n").unwrap();
    let text = |name: &str| checked_folder(&root.join(name)).unwrap();
    Repos {
        app: text("app"),
        wt: text("app-wt"),
        other: text("other"),
        root,
        _dir: dir,
    }
}

impl Repos {
    /// The original checkout's status and file contents, to prove they never change.
    fn original(&self) -> (String, Vec<String>) {
        let app = Path::new(&self.app);
        (
            git_in(app, &["status", "--porcelain=v1", "--untracked-files=all"]),
            ["a.txt", "b.txt", "mine.txt"]
                .iter()
                .map(|f| std::fs::read_to_string(app.join(f)).unwrap())
                .collect(),
        )
    }
}

#[test]
fn project_chat_links_only_a_worktree_of_the_same_repository() {
    let r = repos();
    let before = r.original();
    assert_eq!(before.0, "M  a.txt\n M b.txt\n?? mine.txt");

    let ok = verify_worktree(&r.app, &r.wt).unwrap();
    assert_eq!(ok.path, r.wt);
    assert_eq!(ok.branch.as_deref(), Some("feature/x"));
    assert_eq!(ok.base, git_in(Path::new(&r.app), &["rev-parse", "HEAD"]));

    let err = |candidate: &str| verify_worktree(&r.app, candidate).unwrap_err();
    assert!(err(&r.app).contains("원본 프로젝트 폴더"));
    assert!(err(&r.other).contains("다른 Git 저장소"));
    std::fs::create_dir_all(r.root.join("plain")).unwrap();
    assert!(err(r.root.join("plain").to_str().unwrap()).contains("Git worktree가 아닙니다"));
    std::fs::create_dir_all(r.root.join("app-wt/src")).unwrap();
    assert!(err(r.root.join("app-wt/src").to_str().unwrap()).contains("최상위"));
    assert!(
        verify_worktree(r.root.join("plain").to_str().unwrap(), &r.wt)
            .unwrap_err()
            .contains("프로젝트 폴더가 Git 저장소가 아니어서")
    );
    // A worktree of an unrelated repository with the same folder name is still refused.
    git_in(
        Path::new(&r.other),
        &["worktree", "add", "-q", "-b", "y", "../elsewhere/app-wt"],
    );
    assert!(err(r.root.join("elsewhere/app-wt").to_str().unwrap()).contains("다른 Git 저장소"));

    assert_eq!(r.original(), before, "the original checkout is untouched");
}

#[cfg(unix)]
#[test]
fn project_chat_thread_works_in_its_linked_worktree() {
    let r = repos();
    let before = r.original();
    let store = tempfile::tempdir().unwrap();
    let chat = ProjectChat::new(store.path().join("chat"));
    let project = chat.add_project(&r.app).unwrap();
    let plain = chat
        .create_thread(&project.id, ChatAgent::Claude, ChatMode::Edit)
        .unwrap();
    let t = chat
        .create_thread(&project.id, ChatAgent::Codex, ChatMode::Edit)
        .unwrap();

    assert!(chat.link_worktree(&t.id, &r.other).is_err());
    assert_eq!(
        chat.thread(&t.id).unwrap().worktree,
        None,
        "a refused link stores nothing"
    );
    let linked = chat.link_worktree(&t.id, &r.wt).unwrap();
    let wt = linked.worktree.clone().unwrap();
    assert_eq!(
        (wt.path.as_str(), wt.branch.as_deref()),
        (r.wt.as_str(), Some("feature/x"))
    );

    // Restart: the link is read back from disk, and turns, planner snapshots
    // and the changes panel all use the same folder.
    let again = ProjectChat::new(store.path().join("chat"));
    let reopened = again.thread(&t.id).unwrap();
    assert_eq!(reopened.worktree.as_ref(), Some(&wt));
    assert_eq!(work_folder(&project, &reopened).unwrap(), r.wt);
    assert_eq!(
        work_folder(&project, &plain).unwrap(),
        r.app,
        "other threads keep the project folder"
    );

    std::fs::write(Path::new(&r.wt).join("feature.txt"), "x").unwrap();
    let in_wt = changes(&work_folder(&project, &reopened).unwrap());
    assert_eq!(in_wt.folder, r.wt);
    assert_eq!(in_wt.branch.as_deref(), Some("feature/x"));
    assert_eq!(in_wt.files, ["?? feature.txt"]);
    let in_app = changes(&r.app);
    assert_eq!(in_app.branch.as_deref(), Some("main"));
    assert!(!in_app.files.iter().any(|f| f.ends_with("feature.txt")));

    // Fixed once the thread has started.
    chat.append(&t.id, &[Item::new(ItemKind::User, "시작")])
        .unwrap();
    assert!(chat
        .link_worktree(&t.id, &r.wt)
        .unwrap_err()
        .contains("작업 폴더를 바꿀 수 없습니다"));
    chat.update_thread(&plain.id, |t| {
        t.provider_session = Some("s".into());
        Ok(())
    })
    .unwrap();
    assert!(
        chat.link_worktree(&plain.id, &r.wt).is_err(),
        "a resumed session keeps its folder"
    );
    let running = chat
        .create_thread(&project.id, ChatAgent::Claude, ChatMode::Edit)
        .unwrap();
    chat.claim(&running.id, 1).unwrap();
    assert!(chat.link_worktree(&running.id, &r.wt).is_err());
    chat.release(&running.id);

    // Deleting the thread leaves the worktree and its files alone.
    chat.delete_thread(&t.id).unwrap();
    assert!(Path::new(&r.wt).join("feature.txt").is_file());
    assert!(Path::new(&r.wt).join(".git").exists());

    // A worktree swapped for a link to another repository, or gone, is refused before use.
    let moved = r.root.join("app-wt-moved");
    std::fs::rename(&r.wt, &moved).unwrap();
    std::os::unix::fs::symlink(&r.other, &r.wt).unwrap();
    let swapped = work_folder(&project, &reopened).unwrap_err();
    assert!(swapped.contains("찾을 수 없거나 바뀌었습니다"), "{swapped}");
    std::fs::remove_file(&r.wt).unwrap();
    assert!(
        work_folder(&project, &reopened).is_err(),
        "missing worktree"
    );
    // A different checkout put at the same path is not the same repository.
    std::fs::create_dir_all(&r.wt).unwrap();
    git_in(Path::new(&r.wt), &["init", "-q"]);
    assert!(work_folder(&project, &reopened)
        .unwrap_err()
        .contains("다른 Git 저장소"));

    assert_eq!(r.original(), before, "the original checkout is untouched");
}

mod new_worktrees {
    use super::*;
    use toris_studio_desktop::project_worktrees::{
        create, create_then, forget, git_path, pending, plan, resume,
    };

    /// Windows canonical paths carry the verbatim prefix, which git for
    /// Windows cannot use (`//?/C:/…: Invalid argument`). It is removed only
    /// when the plain path names the same folder; otherwise git gets nothing.
    #[test]
    fn git_path_drops_the_windows_verbatim_prefix_only_when_it_is_the_same_folder() {
        let ok = |from: &str, to: &str| assert_eq!(git_path(from).as_deref(), Some(to), "{from}");
        ok(
            r"\\?\C:\Users\runneradmin\AppData\Local\Temp\.tmpAb\app-worktrees\1c351e1f",
            r"C:\Users\runneradmin\AppData\Local\Temp\.tmpAb\app-worktrees\1c351e1f",
        );
        ok(r"\\?\d:\프로젝트\app", r"d:\프로젝트\app");
        ok(
            r"\\?\UNC\server\share\app-worktrees\x",
            r"\\server\share\app-worktrees\x",
        );
        ok(r"C:\plain\app", r"C:\plain\app");
        ok(
            "/Users/me/app-worktrees/1c351e1f",
            "/Users/me/app-worktrees/1c351e1f",
        );
        for refused in [
            r"\\?\C:\work\name.\x",
            r"\\?\C:\work\name \x",
            r"\\?\C:\work\NUL\x",
            r"\\?\C:\work\com1.txt\x",
            r"\\?\C:\work\a/b\x",
            r"\\?\C:\work\..\x",
            r"\\?\C:\work\\x",
            r"\\?\Volume{0b1c}\work",
            r"\\?\GLOBALROOT\Device\x",
        ] {
            assert_eq!(git_path(refused), None, "{refused}");
        }
        let long = format!(r"\\?\C:\{}", "a\\".repeat(130));
        assert_eq!(git_path(&long), None, "over the classic length limit");
        assert_eq!(git_path(r"\\?\C:\a\한글").as_deref(), Some(r"C:\a\한글"));
        assert_eq!(
            git_path(r"\\?\C:\a\a한").as_deref(),
            Some(r"C:\a\a한"),
            "no panic on multibyte names"
        );
    }

    fn rig(r: &Repos) -> (tempfile::TempDir, ProjectChat, String) {
        let store = tempfile::tempdir().unwrap();
        let chat = ProjectChat::new(store.path().join("chat"));
        let project = chat.add_project(&r.app).unwrap();
        (store, chat, project.id)
    }

    fn head(dir: &str) -> String {
        git_in(Path::new(dir), &["rev-parse", "HEAD"])
    }

    #[test]
    fn project_chat_creates_a_branch_and_worktree_from_the_committed_head() {
        let r = repos();
        let before = r.original();
        let (_store, chat, project) = rig(&r);
        let t = chat
            .create_thread(&project, ChatAgent::Claude, ChatMode::Edit)
            .unwrap();
        let tag: String =
            t.id.chars()
                .filter(char::is_ascii_alphanumeric)
                .take(8)
                .collect();

        let p = plan(&chat, &t.id).unwrap();
        assert_eq!(p.project_folder, r.app);
        assert_eq!(
            p.path,
            r.root.join("app-worktrees").join(&tag).to_str().unwrap()
        );
        assert_eq!(p.branch, format!("studio/{tag}"));
        assert_eq!(p.base, head(&r.app));

        // Cancelling the OS confirmation creates nothing.
        assert_eq!(create(&chat, &t.id, |_| false).unwrap(), None);
        assert!(!Path::new(&p.path).exists());
        assert!(pending(&chat).is_empty());

        // A second click while the first is still in its dialog is refused.
        let made = create(&chat, &t.id, |shown| {
            assert_eq!(shown, &p, "the confirmation names exactly what is created");
            let twice = create(&chat, &t.id, |_| true).unwrap_err();
            assert!(twice.contains("이미 만드는 중"), "{twice}");
            true
        })
        .unwrap()
        .unwrap();
        let wt = made.worktree.clone().unwrap();
        assert_eq!(
            (wt.path.as_str(), wt.branch.as_deref(), wt.base.as_str()),
            (p.path.as_str(), Some(p.branch.as_str()), p.base.as_str())
        );
        assert_eq!(head(&wt.path), p.base);
        assert_eq!(
            git_in(Path::new(&wt.path), &["symbolic-ref", "--short", "HEAD"]),
            p.branch
        );
        // Committed files only: nothing uncommitted is copied or stashed.
        assert_eq!(
            std::fs::read_to_string(Path::new(&wt.path).join("a.txt")).unwrap(),
            "one\n"
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&wt.path).join("b.txt")).unwrap(),
            "base\n"
        );
        assert!(!Path::new(&wt.path).join("mine.txt").exists());
        assert_eq!(git_in(Path::new(&wt.path), &["status", "--porcelain"]), "");
        assert_eq!(git_in(Path::new(&r.app), &["stash", "list"]), "");
        assert_eq!(
            work_folder(&chat.project(&project).unwrap(), &made).unwrap(),
            wt.path
        );
        assert!(
            pending(&chat).is_empty(),
            "a finished creation leaves no record"
        );

        // Clicking again after it finished does not make a second one.
        assert!(create(&chat, &t.id, |_| true)
            .unwrap_err()
            .contains("이미 worktree가 연결"));
        // Restart: the thread still works in it.
        let again = ProjectChat::new(chat.root().to_path_buf());
        assert_eq!(again.thread(&t.id).unwrap().worktree, Some(wt));
        assert_eq!(r.original(), before, "the original checkout is untouched");
        assert_eq!(
            git_in(Path::new(&r.app), &["symbolic-ref", "--short", "HEAD"]),
            "main"
        );
    }

    #[test]
    fn project_chat_new_worktree_never_overwrites_and_explains_refusals() {
        let r = repos();
        let before = r.original();
        let (_store, chat, project) = rig(&r);
        let t = chat
            .create_thread(&project, ChatAgent::Claude, ChatMode::Edit)
            .unwrap();
        let p = plan(&chat, &t.id).unwrap();

        // An existing folder at the planned path stays as it is.
        std::fs::create_dir_all(&p.path).unwrap();
        std::fs::write(Path::new(&p.path).join("keep.txt"), "mine").unwrap();
        let err = create(&chat, &t.id, |_| true).unwrap_err();
        assert!(err.contains("이미 있습니다"), "{err}");
        assert_eq!(
            std::fs::read_to_string(Path::new(&p.path).join("keep.txt")).unwrap(),
            "mine"
        );
        std::fs::remove_dir_all(&p.path).unwrap();

        // An existing branch is not moved.
        git_in(Path::new(&r.app), &["branch", &p.branch, "HEAD"]);
        assert!(create(&chat, &t.id, |_| true)
            .unwrap_err()
            .contains("브랜치"));
        git_in(Path::new(&r.app), &["branch", "-D", &p.branch]);

        // A started thread cannot move into a new folder.
        chat.append(&t.id, &[Item::new(ItemKind::User, "hi")])
            .unwrap();
        assert!(plan(&chat, &t.id).unwrap_err().contains("시작한 뒤"));

        // Not a git repository, and a repository without commits.
        for (name, init, reason) in [
            ("plain", false, "Git 저장소가 아닙니다"),
            ("empty", true, "커밋이 없습니다"),
        ] {
            let dir = r.root.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            if init {
                git_in(&dir, &["init", "-q", "-b", "main"]);
            }
            let p = chat.add_project(&checked_folder(&dir).unwrap()).unwrap();
            let t = chat
                .create_thread(&p.id, ChatAgent::Claude, ChatMode::Edit)
                .unwrap();
            let err = create(&chat, &t.id, |_| true).unwrap_err();
            assert!(err.contains(reason), "{name}: {err}");
            assert!(!r.root.join(format!("{name}-worktrees")).exists());
        }
        assert!(pending(&chat).is_empty());
        assert_eq!(r.original(), before);
    }

    #[cfg(unix)]
    #[test]
    fn project_chat_failed_worktree_creation_changes_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let r = repos();
        let before = r.original();
        let (_store, chat, project) = rig(&r);
        let t = chat
            .create_thread(&project, ChatAgent::Claude, ChatMode::Edit)
            .unwrap();
        let p = plan(&chat, &t.id).unwrap();
        let container = r.root.join("app-worktrees");
        std::fs::create_dir_all(&container).unwrap();
        std::fs::set_permissions(&container, std::fs::Permissions::from_mode(0o555)).unwrap();
        let err = create(&chat, &t.id, |_| true).unwrap_err();
        std::fs::set_permissions(&container, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(err.contains("worktree를 만들"), "{err}");
        assert!(!Path::new(&p.path).exists());
        let branch_left = std::process::Command::new("git")
            .args([
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{}", p.branch),
            ])
            .current_dir(&r.app)
            .status()
            .unwrap()
            .success();
        if branch_left {
            // git kept the branch: the record stays, so it can be explained.
            assert_eq!(pending(&chat).len(), 1);
            assert_eq!(pending(&chat)[0].state, "missing");
        } else {
            assert!(err.contains("아무것도 바뀌지 않았습니다"), "{err}");
            assert!(pending(&chat).is_empty());
        }
        assert_eq!(chat.thread(&t.id).unwrap().worktree, None);
        assert_eq!(r.original(), before);
    }

    #[test]
    fn project_chat_unsaved_worktree_is_recovered_after_restart() {
        let r = repos();
        let before = r.original();
        let (_store, chat, project) = rig(&r);
        let t = chat
            .create_thread(&project, ChatAgent::Claude, ChatMode::Edit)
            .unwrap();
        let p = plan(&chat, &t.id).unwrap();
        // The thread disappears between `git worktree add` and saving the link.
        let err = create_then(
            &chat,
            &t.id,
            |_| true,
            || chat.delete_thread(&t.id).unwrap(),
        )
        .unwrap_err();
        assert!(err.contains("저장하지 못했습니다"), "{err}");
        assert!(
            Path::new(&p.path).join("a.txt").exists(),
            "the folder is kept"
        );

        // After a restart the leftover is recognized as Studio's own.
        let again = ProjectChat::new(chat.root().to_path_buf());
        let left = pending(&again);
        assert_eq!(left.len(), 1);
        let rec = &left[0];
        assert_eq!(
            (
                rec.path.as_str(),
                rec.branch.as_str(),
                rec.base.as_str(),
                rec.state.as_str()
            ),
            (p.path.as_str(), p.branch.as_str(), p.base.as_str(), "ready")
        );
        assert!(rec.guidance.contains("git worktree remove"));

        // A started thread or another project's thread cannot take it.
        let busy = again
            .create_thread(&project, ChatAgent::Codex, ChatMode::Edit)
            .unwrap();
        again
            .append(&busy.id, &[Item::new(ItemKind::User, "hi")])
            .unwrap();
        assert!(resume(&again, &rec.id, &busy.id).is_err());
        // A fresh thread continues in it; the record is then gone.
        let fresh = again
            .create_thread(&project, ChatAgent::Codex, ChatMode::Edit)
            .unwrap();
        let linked = resume(&again, &rec.id, &fresh.id).unwrap();
        assert_eq!(
            linked.worktree.as_ref().map(|w| w.path.as_str()),
            Some(p.path.as_str())
        );
        assert!(pending(&again).is_empty());

        // A record whose folder is gone, or replaced by something else, is only
        // explained and forgotten; Studio deletes nothing.
        let t2 = again
            .create_thread(&project, ChatAgent::Claude, ChatMode::Edit)
            .unwrap();
        let p2 = plan(&again, &t2.id).unwrap();
        create_then(
            &again,
            &t2.id,
            |_| true,
            || again.delete_thread(&t2.id).unwrap(),
        )
        .unwrap_err();
        git_in(Path::new(&r.app), &["worktree", "remove", &p2.path]);
        std::fs::create_dir_all(&p2.path).unwrap();
        std::fs::write(Path::new(&p2.path).join("other.txt"), "x").unwrap();
        let odd = pending(&again);
        assert_eq!(odd[0].state, "unknown");
        let t3 = again
            .create_thread(&project, ChatAgent::Claude, ChatMode::Edit)
            .unwrap();
        assert!(resume(&again, &odd[0].id, &t3.id).is_err());
        forget(&again, &odd[0].id).unwrap();
        assert!(pending(&again).is_empty());
        assert!(Path::new(&p2.path).join("other.txt").exists());
        assert_eq!(r.original(), before);
    }
}

fn message(id: &str, from: &str, reply_to: Option<&str>) -> Message {
    serde_json::from_value(json!({"id":id,"from":from,"fromName":"Muse","text":"기획안","createdAt":null,"replyTo":reply_to})).unwrap()
}

#[test]
fn project_chat_links_only_replies_from_the_asked_planner() {
    let root = tempfile::tempdir().unwrap();
    let chat = ProjectChat::new(root.path().to_path_buf());
    let project = chat.add_project("/Users/me/projects/app").unwrap();
    let t = chat
        .create_thread(&project.id, ChatAgent::Claude, ChatMode::Plan)
        .unwrap();
    let mut request = Item::new(ItemKind::PeerRequest, "로그인 기획해줘");
    request.peer = Some("muse@mac".into());
    request.message_id = Some("sent-1".into());
    chat.append(&t.id, &[request]).unwrap();

    let mail = [
        message("m1", "muse@mac", Some("sent-1")),
        message("m2", "dots@mac", Some("sent-1")),
        message("m3", "muse@mac", Some("other")),
        message("m4", "muse@elsewhere", Some("sent-1")),
    ];
    let fresh = chat.sync_replies(&t.id, &mail).unwrap();
    assert_eq!(fresh.len(), 1);
    assert_eq!(fresh[0].message_id.as_deref(), Some("m1"));
    assert_eq!(fresh[0].kind, ItemKind::PeerReply);
    assert!(
        chat.sync_replies(&t.id, &mail).unwrap().is_empty(),
        "no duplicates"
    );
}

fn mail(id: &str, from: &str, text: &str) -> Message {
    serde_json::from_value(
        json!({"id":id,"from":from,"fromName":"Dots","text":text,"createdAt":null,"replyTo":null}),
    )
    .unwrap()
}

#[test]
fn project_chat_hosted_prompt_names_studio_and_code() {
    let code = handoff_code();
    assert!(code.starts_with("TS-") && code.len() == 13, "{code}");
    assert_ne!(code, handoff_code(), "codes are fresh");
    let prompt = hosted_prompt(
        HostedAssistant::Dots,
        "pocket-app",
        "로그인 화면 기획",
        "구성: Next.js",
        "toris/toris-studio@mac",
        &code,
    );
    assert!(prompt.contains("OpenAI Dots"));
    assert!(prompt.contains("`toris/toris-studio@mac`"));
    assert!(prompt.contains(&format!("`[{code}]`")));
    assert!(prompt.contains("send_message") && prompt.contains("check_inbox"));
    assert!(prompt.contains("로그인 화면 기획") && prompt.contains("구성: Next.js"));
    assert_eq!(serde_json::to_value(HostedAssistant::Grok).unwrap(), "grok");
    assert!(serde_json::from_str::<HostedAssistant>("\"claude\"").is_err());
}

#[test]
fn project_chat_strip_code_needs_it_on_the_first_line() {
    let code = "TS-ABCDEF1234";
    assert_eq!(
        strip_code("\n[TS-ABCDEF1234]\n## 목표\n로그인", code).as_deref(),
        Some("## 목표\n로그인")
    );
    assert_eq!(
        strip_code("[TS-ABCDEF1234] 로그인 기획\n1. 화면", code).as_deref(),
        Some("로그인 기획\n1. 화면")
    );
    assert_eq!(
        strip_code("[ts-abcdef1234]\n본문", code).as_deref(),
        Some("본문"),
        "case-insensitive match"
    );
    assert!(
        strip_code("안녕\n[TS-ABCDEF1234]", code).is_none(),
        "not on first line"
    );
    assert!(
        strip_code("[TS-ABCDEF9999]\n본문", code).is_none(),
        "other code"
    );
    assert!(strip_code("[TS-ABCDEF1234]", code).is_none(), "empty body");
}

#[test]
fn project_chat_files_hosted_replies_by_code_and_answers_their_sender() {
    let root = tempfile::tempdir().unwrap();
    let chat = ProjectChat::new(root.path().to_path_buf());
    let project = chat.add_project("/Users/me/projects/app").unwrap();
    let t = chat
        .create_thread(&project.id, ChatAgent::Claude, ChatMode::Plan)
        .unwrap();
    let other = chat
        .create_thread(&project.id, ChatAgent::Claude, ChatMode::Plan)
        .unwrap();
    let mut request = Item::new(ItemKind::HostedRequest, "로그인 기획");
    request.code = Some("TS-AAAA000011".into());
    request.peer_name = Some("OpenAI Dots".into());
    chat.append(&t.id, &[request]).unwrap();

    let inbox = [
        mail(
            "h1",
            "toris/chatgpt",
            "[TS-AAAA000011]\n## 로그인 기획\n1. 이메일",
        ),
        mail("h2", "toris/chatgpt", "아무 메시지"),
        mail("h3", "toris/grok", "[TS-BBBB000011]\n다른 대화"),
    ];
    let fresh = chat.sync_replies(&t.id, &inbox).unwrap();
    assert_eq!(fresh.len(), 1);
    assert_eq!(fresh[0].kind, ItemKind::PeerReply);
    assert_eq!(fresh[0].text, "## 로그인 기획\n1. 이메일");
    assert_eq!(
        fresh[0].peer.as_deref(),
        Some("toris/chatgpt"),
        "reply address kept"
    );
    assert_eq!(fresh[0].peer_name.as_deref(), Some("Dots"));
    assert!(
        chat.sync_replies(&t.id, &inbox).unwrap().is_empty(),
        "no duplicates"
    );
    assert!(
        chat.sync_replies(&other.id, &inbox).unwrap().is_empty(),
        "code belongs to one thread"
    );
    assert!(chat.reply_item(&t.id, "h1").is_some());
    assert!(chat.reply_item(&t.id, "h2").is_none());
    assert!(chat.reply_item(&other.id, "h1").is_none());

    // A later answer to Studio's reply comes back through the normal reply path.
    let mut answer = Item::new(ItemKind::PeerRequest, "결제도 넣어줘");
    answer.peer = Some("toris/chatgpt".into());
    answer.message_id = Some("sent-9".into());
    chat.append(&t.id, &[answer]).unwrap();
    let follow: Message = serde_json::from_value(json!({"id":"h4","from":"toris/chatgpt","fromName":"Dots","text":"결제 기획","createdAt":null,"replyTo":"sent-9"})).unwrap();
    let fresh = chat.sync_replies(&t.id, &[follow]).unwrap();
    assert_eq!(fresh.len(), 1);
    assert_eq!(fresh[0].text, "결제 기획");

    // A message without a code can be filed by hand, once.
    let linked = chat.link_message(&other.id, &inbox[1]).unwrap().unwrap();
    assert_eq!(linked.kind, ItemKind::PeerReply);
    assert_eq!(linked.peer.as_deref(), Some("toris/chatgpt"));
    assert!(chat.link_message(&other.id, &inbox[1]).unwrap().is_none());
}

#[test]
fn project_chat_folders_follow_the_agent_rules() {
    let home = dirs::home_dir().unwrap();
    assert!(checked_folder(&home).is_err());
    assert!(checked_folder(Path::new("/")).is_err());
    assert!(checked_folder(Path::new("/etc")).is_err());
    if home.join(".ssh").is_dir() {
        assert!(checked_folder(&home.join(".ssh")).is_err());
    }
    assert!(typed_path("relative/app").is_err());
    assert!(typed_path("~/x\u{0}").is_err());
    assert_eq!(
        typed_path("~/projects/app").unwrap(),
        home.join("projects/app")
    );
    let dir = tempfile::tempdir().unwrap();
    assert!(checked_folder(dir.path()).is_ok());
}

#[test]
fn project_chat_reads_changes_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().canonicalize().unwrap();
    let folder = folder.to_str().unwrap();
    assert!(!changes(folder).is_repo);
    let git = |args: &[&str]| {
        assert!(std::process::Command::new("git")
            .args(args)
            .current_dir(folder)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap()
            .status
            .success())
    };
    git(&["init", "-q", "-b", "main"]);
    std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "init"]);
    std::fs::write(dir.path().join("a.txt"), "two\n").unwrap();
    std::fs::write(dir.path().join("new.txt"), "x").unwrap();
    let result = changes(folder);
    assert!(result.is_repo);
    assert_eq!(result.branch.as_deref(), Some("main"));
    assert!(result.files.iter().any(|f| f == " M a.txt"));
    assert!(result.files.iter().any(|f| f == "?? new.txt"));
    assert!(result.diff.contains("-one") && result.diff.contains("+two"));
}

// ---------------------------------------------------------------------------
// Turns, with fake `claude` and `codex` scripts. No real agent runs.
#[cfg(unix)]
mod turns {
    use super::*;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };
    use toris_studio_desktop::project_chat::{start_turn, stop_turn};

    struct Rig {
        dir: tempfile::TempDir,
        chat: Arc<ProjectChat>,
        events: Arc<Mutex<Vec<serde_json::Value>>>,
        folder: String,
        bin: PathBuf,
    }

    fn rig(mode: &str) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        let project = dir.path().join("app");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&project).unwrap();
        let log = dir.path().to_str().unwrap().to_owned();
        let claude = r#"#!/bin/sh
printf '%s\n' "$@" > "@LOG@/args.txt"
pwd > "@LOG@/cwd.txt"
env > "@LOG@/env.txt"
cat > "@LOG@/stdin.txt"
echo '{"type":"system","subtype":"hook_response","output":"noise"}'
echo '{"type":"system","subtype":"init","session_id":"sess-1"}'
if [ '@MODE@' = 'hang' ]; then echo $$ > "@LOG@/pid.txt"; sleep 300 & wait; exit 0; fi
if [ '@MODE@' = 'crash' ]; then echo 'boom: not logged in' >&2; exit 3; fi
echo 'not json'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"만들게요"},{"type":"tool_use","id":"k1","name":"Write","input":{"file_path":"@DIR@/a.txt"}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"k1","content":"ok"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"duration_ms":1000,"total_cost_usd":0.01,"session_id":"sess-1"}'
"#;
        let codex = r#"#!/bin/sh
printf '%s\n' "$@" > "@LOG@/args.txt"
cat > "@LOG@/stdin.txt"
echo '{"type":"thread.started","thread_id":"th-9"}'
echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"ok"}}'
echo '{"type":"turn.completed","usage":{"output_tokens":5}}'
"#;
        let fill = |script: &str| {
            script
                .replace("@LOG@", &log)
                .replace("@MODE@", mode)
                .replace("@DIR@", project.to_str().unwrap())
        };
        for (name, body) in [("claude", fill(claude)), ("codex", fill(codex))] {
            let path = bin.join(name);
            fs::write(&path, body).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let chat = Arc::new(ProjectChat::new(dir.path().join("store")));
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        *chat.emit.lock().unwrap() = Some(Arc::new(move |event| sink.lock().unwrap().push(event)));
        let folder = project.to_str().unwrap().to_owned();
        Rig {
            dir,
            chat,
            events,
            folder,
            bin,
        }
    }

    impl Rig {
        fn path(&self) -> Vec<PathBuf> {
            vec![self.bin.clone(), "/usr/bin".into(), "/bin".into()]
        }
    }

    async fn idle(chat: &ProjectChat, thread: &str) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while chat.is_running(thread) {
            assert!(Instant::now() < deadline, "turn did not finish");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    fn log(rig: &Rig, name: &str) -> String {
        fs::read_to_string(rig.dir.path().join(name)).unwrap_or_default()
    }

    #[tokio::test]
    async fn project_chat_turn_streams_items_and_resumes_the_conversation() {
        let rig = rig("ok");
        let project = rig.chat.add_project(&rig.folder).unwrap();
        let t = rig
            .chat
            .create_thread(&project.id, ChatAgent::Claude, ChatMode::Edit)
            .unwrap();
        let prompt = "--model evil\n로그인 화면을 만들어줘";
        let started = start_turn(
            rig.chat.clone(),
            t.clone(),
            rig.folder.clone(),
            prompt.into(),
            rig.path(),
        )
        .await
        .unwrap();
        assert!(started.running);
        assert_eq!(started.title, "--model evil");
        assert!(
            start_turn(
                rig.chat.clone(),
                t.clone(),
                rig.folder.clone(),
                "again".into(),
                rig.path()
            )
            .await
            .is_err(),
            "one turn per thread"
        );
        idle(&rig.chat, &t.id).await;

        assert_eq!(log(&rig, "stdin.txt"), prompt, "prompt only on stdin");
        let args = log(&rig, "args.txt");
        assert!(
            !args.contains("evil")
                && args.contains("acceptEdits")
                && args.contains("claude-opus-5-5")
        );
        assert_eq!(
            fs::canonicalize(log(&rig, "cwd.txt").trim()).unwrap(),
            fs::canonicalize(&rig.folder).unwrap()
        );
        assert!(log(&rig, "env.txt").contains("CLAUDE_CODE_EFFORT_LEVEL=medium"));

        let items = rig.chat.items(&t.id);
        let kinds: Vec<ItemKind> = items.iter().map(|i| i.kind).collect();
        assert_eq!(
            kinds,
            [
                ItemKind::User,
                ItemKind::Assistant,
                ItemKind::Tool,
                ItemKind::ToolResult,
                ItemKind::Result
            ]
        );
        assert_eq!(items[2].text, "a.txt");
        let thread = rig.chat.thread(&t.id).unwrap();
        assert_eq!(thread.provider_session.as_deref(), Some("sess-1"));
        assert!(!thread.running);
        let events = rig.events.lock().unwrap().clone();
        assert!(events
            .iter()
            .any(|e| e["kind"] == "state" && e["running"] == true));
        assert_eq!(events.last().unwrap()["running"], false);

        // The next turn resumes the CLI's own conversation.
        start_turn(
            rig.chat.clone(),
            thread,
            rig.folder.clone(),
            "다음".into(),
            rig.path(),
        )
        .await
        .unwrap();
        idle(&rig.chat, &t.id).await;
        assert!(log(&rig, "args.txt").ends_with("--resume\nsess-1\n"));
    }

    #[tokio::test]
    async fn project_chat_codex_turn_uses_its_sandbox_and_thread() {
        let rig = rig("ok");
        let project = rig.chat.add_project(&rig.folder).unwrap();
        let t = rig
            .chat
            .create_thread(&project.id, ChatAgent::Codex, ChatMode::Plan)
            .unwrap();
        start_turn(
            rig.chat.clone(),
            t.clone(),
            rig.folder.clone(),
            "살펴봐".into(),
            rig.path(),
        )
        .await
        .unwrap();
        idle(&rig.chat, &t.id).await;
        assert!(log(&rig, "args.txt").contains("sandbox_mode=\"read-only\""));
        assert_eq!(
            rig.chat.thread(&t.id).unwrap().provider_session.as_deref(),
            Some("th-9")
        );
        let texts: Vec<String> = rig.chat.items(&t.id).into_iter().map(|i| i.text).collect();
        assert_eq!(texts, ["살펴봐", "ok", "완료 · 출력 5 토큰"]);
    }

    #[tokio::test]
    async fn project_chat_failures_and_stops_are_reported_once() {
        let crashed = rig("crash");
        let rig = &crashed;
        let project = rig.chat.add_project(&rig.folder).unwrap();
        let t = rig
            .chat
            .create_thread(&project.id, ChatAgent::Claude, ChatMode::Edit)
            .unwrap();
        start_turn(
            rig.chat.clone(),
            t.clone(),
            rig.folder.clone(),
            "hi".into(),
            rig.path(),
        )
        .await
        .unwrap();
        idle(&rig.chat, &t.id).await;
        let last = rig.chat.items(&t.id).pop().unwrap();
        assert_eq!(last.kind, ItemKind::Error);
        assert!(last.text.contains("boom: not logged in"), "{}", last.text);

        let hung = super::turns::rig("hang");
        let rig = &hung;
        let project = rig.chat.add_project(&rig.folder).unwrap();
        let t = rig
            .chat
            .create_thread(&project.id, ChatAgent::Claude, ChatMode::Edit)
            .unwrap();
        start_turn(
            rig.chat.clone(),
            t.clone(),
            rig.folder.clone(),
            "hi".into(),
            rig.path(),
        )
        .await
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while log(&rig, "pid.txt").is_empty() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        stop_turn(rig.chat.clone(), &t.id);
        idle(&rig.chat, &t.id).await;
        let items = rig.chat.items(&t.id);
        assert_eq!(items.last().unwrap().text, "사용자가 중지했습니다.");
        assert!(
            !items.iter().any(|i| i.kind == ItemKind::Error),
            "a stop is not a failure"
        );
        let pid: i32 = log(&rig, "pid.txt").trim().parse().unwrap();
        assert_ne!(
            unsafe { libc::kill(pid, 0) },
            0,
            "the agent's process is gone"
        );

        let missing = start_turn(
            rig.chat.clone(),
            t,
            rig.folder.clone(),
            "hi".into(),
            vec![rig.dir.path().join("none")],
        )
        .await;
        assert!(missing.unwrap_err().contains("CLI를 찾지 못했습니다"));
    }

    #[tokio::test]
    async fn project_chat_turn_runs_in_the_linked_worktree_and_serializes_edits() {
        let rig = rig("ok");
        let app = std::path::Path::new(&rig.folder);
        super::git_in(app, &["init", "-q", "-b", "main"]);
        fs::write(app.join("a.txt"), "one\n").unwrap();
        super::git_in(app, &["add", "."]);
        super::git_in(app, &["commit", "-qm", "init"]);
        super::git_in(
            app,
            &["worktree", "add", "-q", "-b", "feature/t", "../app-wt"],
        );
        fs::write(app.join("a.txt"), "user's edit\n").unwrap();
        let folder = checked_folder(app).unwrap();
        let wt = checked_folder(&rig.dir.path().join("app-wt")).unwrap();
        let project = rig.chat.add_project(&folder).unwrap();
        let t = rig
            .chat
            .create_thread(&project.id, ChatAgent::Claude, ChatMode::Edit)
            .unwrap();
        let t = rig.chat.link_worktree(&t.id, &wt).unwrap();
        let cwd = work_folder(&project, &t).unwrap();
        assert_eq!(cwd, wt);

        // Another editing turn holds the same folder: refused before any CLI starts.
        rig.chat.claim_in("holder", 1, Some(&wt), true).unwrap();
        let refused = start_turn(
            rig.chat.clone(),
            t.clone(),
            cwd.clone(),
            "hi".into(),
            rig.path(),
        )
        .await
        .unwrap_err();
        assert!(refused.contains("같은 작업 폴더"), "{refused}");
        assert!(log(&rig, "cwd.txt").is_empty(), "no CLI was started");
        assert!(!rig.chat.is_running(&t.id));
        rig.chat.release("holder");

        start_turn(rig.chat.clone(), t.clone(), cwd, "hi".into(), rig.path())
            .await
            .unwrap();
        idle(&rig.chat, &t.id).await;
        assert_eq!(
            std::path::Path::new(log(&rig, "cwd.txt").trim())
                .canonicalize()
                .unwrap()
                .to_str()
                .unwrap(),
            wt,
            "the agent ran in the worktree"
        );
        assert!(
            rig.chat.link_worktree(&t.id, &wt).is_err(),
            "fixed after the run"
        );
        assert_eq!(
            fs::read_to_string(app.join("a.txt")).unwrap(),
            "user's edit\n"
        );
    }

    /// Live: runs the real Claude Code once in a scratch folder. `cargo test -- --ignored live`.
    #[tokio::test]
    #[ignore]
    async fn live_claude_turn_in_a_scratch_project() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let chat = Arc::new(ProjectChat::new(dir.path().join(".store")));
        let project = chat.add_project(&folder).unwrap();
        let t = chat
            .create_thread(&project.id, ChatAgent::Claude, ChatMode::Edit)
            .unwrap();
        start_turn(
            chat.clone(),
            t.clone(),
            folder.clone(),
            "Create hello.txt containing exactly: hi from studio. Then reply done.".into(),
            toris_studio_desktop::agent_runtime::search_path(),
        )
        .await
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(240);
        while chat.is_running(&t.id) {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        for item in chat.items(&t.id) {
            println!(
                "{:?} {:?} {}",
                item.kind,
                item.tool,
                item.text.chars().take(160).collect::<String>()
            );
        }
        println!(
            "session: {:?}",
            chat.thread(&t.id).unwrap().provider_session
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("hello.txt"))
                .unwrap()
                .trim(),
            "hi from studio"
        );
    }
}

#[test]
fn project_chat_preview_urls_are_loopback_http_only() {
    for (raw, kept) in [
        ("http://localhost:5173", "http://localhost:5173/"),
        (
            "  https://LOCALHOST:3000/app?x=1#top ",
            "https://localhost:3000/app?x=1#top",
        ),
        ("http://127.0.0.1:8080/", "http://127.0.0.1:8080/"),
        ("http://[::1]:4000/a", "http://[::1]:4000/a"),
    ] {
        assert_eq!(preview_url(raw).unwrap().as_deref(), Some(kept), "{raw}");
    }
    assert_eq!(preview_url("").unwrap(), None, "empty clears");
    assert_eq!(preview_url("   ").unwrap(), None);
    for raw in [
        "localhost:5173",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "ftp://localhost/",
        "ws://localhost:5173/",
        "http://user:pw@localhost:5173/",
        "http://user@127.0.0.1/",
        "http://example.com/",
        "http://localhost.example.com/",
        "http://127.0.0.2/",
        "http://0.0.0.0:3000/",
        "http://192.168.0.10:3000/",
        "http://[::ffff:127.0.0.1]/",
        "http://localhost:5173/a b",
        "http://localhost:5173/\nx",
        "http://localhost:99999/",
    ] {
        assert!(preview_url(raw).is_err(), "{raw}");
    }
    assert!(preview_url(&format!("http://localhost/{}", "a".repeat(2048))).is_err());
}

#[test]
fn project_chat_preview_url_is_stored_per_thread_and_survives_restart() {
    let root = tempfile::tempdir().unwrap();
    let chat = ProjectChat::new(root.path().join("chat"));
    let project = chat.add_project(FOLDER).unwrap();
    let a = chat
        .create_thread(&project.id, ChatAgent::Claude, ChatMode::Edit)
        .unwrap();
    let b = chat
        .create_thread(&project.id, ChatAgent::Codex, ChatMode::Plan)
        .unwrap();
    assert_eq!(a.preview_url, None);
    let url = preview_url("http://localhost:5173").unwrap();
    chat.update_thread(&a.id, |t| {
        t.preview_url = url;
        Ok(())
    })
    .unwrap();

    let again = ProjectChat::new(root.path().join("chat"));
    assert_eq!(
        again.thread(&a.id).unwrap().preview_url.as_deref(),
        Some("http://localhost:5173/")
    );
    assert_eq!(again.thread(&b.id).unwrap().preview_url, None, "per thread");
    again
        .update_thread(&a.id, |t| {
            t.preview_url = preview_url("").unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(again.thread(&a.id).unwrap().preview_url, None, "cleared");

    // A thread saved before this field existed still loads.
    let old: Thread = serde_json::from_value(json!({
        "id": "t1", "projectId": "p1", "title": "x", "agent": "claude", "mode": "edit",
        "providerSession": null, "createdAt": "now", "updatedAt": "now"
    }))
    .unwrap();
    assert_eq!(old.preview_url, None);
    assert!(serde_json::to_value(&old)
        .unwrap()
        .get("previewUrl")
        .is_none());
}
