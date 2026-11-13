//! Offline contract tests: a fake `reason` CLI shell script only.
//! No real agent is started, nothing joins a network, no project is edited.
#![cfg(unix)]
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use toris_studio_desktop::reason_agents::{session_name, AgentKind, ReasonAgents, MAX_SESSIONS};

struct Fixture {
    root: tempfile::TempDir,
    agents: ReasonAgents,
}
impl Fixture {
    /// `mode`: "serve" waits for TERM, "exit" quits with code 7, "stubborn" ignores TERM,
    /// "orphan" starts a worker that ignores TERM and then dies while the worker keeps running.
    fn new(mode: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        let script = r#"#!/bin/sh
dir='@ROOT@'
printf '%s\n' "$@" > "$dir/args.txt"
env > "$dir/env.txt"
[ '@MODE@' = 'exit' ] && exit 7
if [ '@MODE@' = 'stubborn' ]; then trap '' TERM; else trap 'echo term >> "$dir/term.txt"; exit 0' TERM; fi
if [ '@MODE@' = 'orphan' ]; then (trap '' TERM; exec sleep 300) & else sleep 300 & fi
echo $! >> "$dir/children.txt"
echo $$ >> "$dir/started.txt"
[ '@MODE@' = 'orphan' ] && exit 3
while :; do wait $! && break; done
"#
        .replace("@ROOT@", root.path().to_str().unwrap())
        .replace("@MODE@", mode);
        for (name, body) in [("reason", script.as_str()), ("claude", "#!/bin/sh\n")] {
            fs::write(bin.join(name), body).unwrap();
            fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        // The fake CLI is a shell script, so it also needs the system tools on PATH.
        let agents = ReasonAgents::with_cli(
            bin.join("reason"),
            vec![bin, "/bin".into(), "/usr/bin".into()],
        );
        Self { root, agents }
    }
    fn project(&self, name: &str) -> PathBuf {
        let path = self.root.path().join(name);
        fs::create_dir_all(path.join(".git")).unwrap();
        fs::write(path.join(".git/HEAD"), "ref: refs/heads/feature/demo\n").unwrap();
        path.canonicalize().unwrap()
    }
    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.root.path().join(name)).unwrap_or_default()
    }
    /// Offers a folder the way the native dialog would, then starts it.
    fn launch(
        &self,
        name: &str,
    ) -> Result<Vec<toris_studio_desktop::reason_agents::AgentSession>, String> {
        let draft = self
            .agents
            .offer(&self.project(name), AgentKind::Claude, "Mac-Studio")?;
        self.agents.start(AgentKind::Claude, &draft.folder)
    }
    fn wait_for(&self, file: &str, lines: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.read(file).lines().count() < lines {
            assert!(
                Instant::now() < deadline,
                "{file} never reached {lines} lines"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
fn alive(pid: &str) -> bool {
    unsafe { libc::kill(pid.trim().parse().unwrap(), 0) == 0 }
}
fn gone(pid: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) {
        assert!(Instant::now() < deadline, "process {pid} survived");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn reason_agent_runs_the_exact_serve_command_without_full_access() {
    std::env::set_var("CODEX_THREAD_ID", "inherited-session");
    let fixture = Fixture::new("serve");
    let folder = fixture.project("My Project!");
    let draft = fixture
        .agents
        .offer(&folder, AgentKind::Claude, "Mac-Studio")
        .unwrap();
    assert_eq!(draft.folder, folder.to_str().unwrap());
    assert_eq!(draft.branch.as_deref(), Some("feature/demo"));
    assert!(
        draft.name.starts_with("mac-studio-claude-my-project-"),
        "{}",
        draft.name
    );

    let sessions = fixture
        .agents
        .start(AgentKind::Claude, &draft.folder)
        .unwrap();
    assert_eq!(sessions.len(), 1);
    assert!(sessions[0].running && sessions[0].exit_code.is_none());
    assert_eq!(sessions[0].name, draft.name);
    fixture.wait_for("started.txt", 1);
    let args: Vec<String> = fixture
        .read("args.txt")
        .lines()
        .map(str::to_owned)
        .collect();
    assert_eq!(
        args,
        [
            "network",
            "serve",
            "claude",
            "--name",
            draft.name.as_str(),
            "--cwd",
            folder.to_str().unwrap(),
            "--non-interactive",
            "--no-color"
        ]
    );
    let env = fixture.read("env.txt");
    assert!(
        !env.contains("CODEX_THREAD_ID"),
        "another agent's session must not leak in"
    );
    assert!(
        env.lines().any(|line| line.starts_with("HOME=")),
        "the agent needs its own login"
    );
    let bin = fixture.root.path().join("bin");
    assert!(env
        .lines()
        .any(|line| line.starts_with("PATH=") && line.contains(bin.to_str().unwrap())));
    assert!(env.contains("NO_COLOR=1"));
}

#[test]
fn reason_agent_starts_only_the_folder_the_user_just_picked() {
    let fixture = Fixture::new("serve");
    let folder = fixture.project("picked");
    let other = fixture.project("other");
    let text = folder.to_str().unwrap();

    assert!(
        fixture.agents.start(AgentKind::Claude, text).is_err(),
        "nothing was picked"
    );
    fixture
        .agents
        .offer(&folder, AgentKind::Claude, "mac")
        .unwrap();
    assert!(fixture
        .agents
        .start(AgentKind::Claude, other.to_str().unwrap())
        .is_err());
    assert!(
        fixture.agents.start(AgentKind::Claude, text).is_err(),
        "a refused start consumes the pick"
    );
    fixture
        .agents
        .offer(&folder, AgentKind::Claude, "mac")
        .unwrap();
    assert!(
        fixture.agents.start(AgentKind::Codex, text).is_err(),
        "the confirmed kind is part of the pick"
    );
    assert!(fixture.read("args.txt").is_empty());

    fixture
        .agents
        .offer(&folder, AgentKind::Claude, "mac")
        .unwrap();
    assert_eq!(
        fixture.agents.start(AgentKind::Claude, text).unwrap().len(),
        1
    );
    assert!(
        fixture.agents.start(AgentKind::Claude, text).is_err(),
        "one confirmation, one launch"
    );
}

#[test]
fn reason_agent_folder_must_be_a_real_project_directory() {
    let fixture = Fixture::new("serve");
    let folder = fixture.project("real");
    let link = fixture.root.path().join("link");
    std::os::unix::fs::symlink(&folder, &link).unwrap();
    let draft = fixture
        .agents
        .offer(&link, AgentKind::Claude, "mac")
        .unwrap();
    assert_eq!(
        draft.folder,
        folder.to_str().unwrap(),
        "symlinks resolve to the real folder"
    );

    let file = fixture.root.path().join("file.txt");
    fs::write(&file, "x").unwrap();
    let home = dirs::home_dir().unwrap();
    let outside = [
        Path::new("/"),
        Path::new("/etc"),
        Path::new("/usr/local"),
        Path::new("/Applications"),
    ];
    let private = [
        home.clone(),
        home.join(".ssh"),
        home.join("Library"),
        home.join(".config"),
    ];
    let bad = [file.clone(), fixture.root.path().join("missing")];
    for bad in outside
        .iter()
        .map(|p| p.to_path_buf())
        .chain(private)
        .chain(bad)
        .filter(|p| p.exists() || p.ends_with("missing"))
    {
        let bad = bad.as_path();
        assert!(
            fixture.agents.offer(bad, AgentKind::Claude, "mac").is_err(),
            "{bad:?}"
        );
    }
    assert!(serde_json::from_str::<AgentKind>("\"claude\"").is_ok());
    for kind in ["\"grok\"", "\"Claude\"", "\"claude --full-access\""] {
        assert!(serde_json::from_str::<AgentKind>(kind).is_err(), "{kind}");
    }
}

#[test]
fn reason_agent_names_are_derived_and_bounded() {
    let name = session_name(
        "Toris's MacBook Pro.local",
        AgentKind::Codex,
        Path::new("/x/../../$(rm -rf)/한글 폴더"),
    );
    assert!(
        name.starts_with("toris-s-macbook-pr-codex-project-"),
        "{name}"
    );
    // Two folders called `app` must not share one network address.
    let (a, b) = (Path::new("/Users/qa/a/app"), Path::new("/Users/qa/b/app"));
    assert_ne!(
        session_name("mac", AgentKind::Claude, a),
        session_name("mac", AgentKind::Claude, b)
    );
    assert_eq!(
        session_name("mac", AgentKind::Claude, a),
        session_name("mac", AgentKind::Claude, a)
    );
    assert!(
        name.len() <= 48
            && name
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    );
    assert!(!session_name("", AgentKind::Claude, Path::new("/")).starts_with('-'));
}

#[test]
fn reason_agent_limits_sessions_and_reports_missing_tools() {
    let fixture = Fixture::new("serve");
    for index in 0..MAX_SESSIONS {
        assert_eq!(
            fixture.launch(&format!("p{index}")).unwrap().len(),
            index + 1
        );
    }
    assert!(
        fixture.launch("p0").is_err(),
        "one session per agent and folder"
    );
    assert!(
        fixture.launch("extra").unwrap_err().contains("4개"),
        "session cap"
    );
    assert_eq!(fixture.agents.list().len(), MAX_SESSIONS);

    let folder = fixture.project("codex");
    let codex = fixture
        .agents
        .offer(&folder, AgentKind::Codex, "mac")
        .unwrap();
    let error = fixture
        .agents
        .start(AgentKind::Codex, &codex.folder)
        .unwrap_err();
    assert!(error.contains("Codex"), "{error}");

    let missing = ReasonAgents::with_cli(
        fixture.root.path().join("no-reason"),
        vec![fixture.root.path().join("bin")],
    );
    let draft = missing.offer(&folder, AgentKind::Claude, "mac").unwrap();
    assert!(missing
        .start(AgentKind::Claude, &draft.folder)
        .unwrap_err()
        .contains("Reason"));
}

#[test]
fn reason_agent_stop_ends_the_whole_process_group() {
    let fixture = Fixture::new("serve");
    let id = fixture.launch("stop").unwrap()[0].id.clone();
    fixture.wait_for("started.txt", 1);
    let worker = fixture.read("children.txt");
    assert!(alive(&worker));

    assert!(fixture.agents.stop("unknown-id").is_err());
    assert!(fixture.agents.stop(&id).unwrap().is_empty());
    assert_eq!(
        fixture.read("term.txt").trim(),
        "term",
        "serve gets a chance to deregister"
    );
    gone(&worker);
    gone(&fixture.read("started.txt"));
}

#[test]
fn reason_agent_stop_kills_a_session_that_ignores_term() {
    let fixture = Fixture::new("stubborn");
    let id = fixture.launch("stubborn").unwrap()[0].id.clone();
    fixture.wait_for("started.txt", 1);
    assert!(fixture.agents.stop(&id).unwrap().is_empty());
    gone(&fixture.read("started.txt"));
    gone(&fixture.read("children.txt"));
}

#[test]
fn reason_agent_shutdown_and_drop_leave_no_session_behind() {
    let fixture = Fixture::new("serve");
    fixture.launch("a").unwrap();
    fixture.launch("b").unwrap();
    fixture.wait_for("started.txt", 2);
    fixture.agents.shutdown();
    assert!(fixture.agents.list().is_empty());
    for pid in fixture
        .read("started.txt")
        .lines()
        .chain(fixture.read("children.txt").lines())
    {
        gone(pid);
    }

    let dropped = Fixture::new("serve");
    dropped.launch("c").unwrap();
    dropped.wait_for("started.txt", 1);
    let pid = dropped.read("started.txt");
    let Fixture { root, agents } = dropped;
    drop(agents);
    gone(&pid);
    drop(root);
}

#[test]
fn reason_agent_exit_is_reported_and_never_restarted() {
    let fixture = Fixture::new("exit");
    let id = fixture.launch("exit").unwrap()[0].id.clone();
    let deadline = Instant::now() + Duration::from_secs(5);
    let session = loop {
        let session = fixture.agents.list().remove(0);
        if !session.running {
            break session;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(session.exit_code, Some(7));
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        fixture.read("args.txt").lines().count(),
        9,
        "the CLI ran exactly once"
    );
    // An exited row stays visible until the user dismisses it.
    assert_eq!(fixture.agents.list().len(), 1);
    assert!(fixture.agents.stop(&id).unwrap().is_empty());
}

#[test]
fn reason_agent_folder_swapped_after_the_pick_is_not_started() {
    let fixture = Fixture::new("serve");
    let folder = fixture.project("shown");
    let elsewhere = fixture.project("elsewhere");
    let draft = fixture
        .agents
        .offer(&folder, AgentKind::Claude, "mac")
        .unwrap();
    fs::rename(&folder, fixture.root.path().join("moved")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &folder).unwrap();
    assert!(fixture
        .agents
        .start(AgentKind::Claude, &draft.folder)
        .is_err());
    assert!(fixture.read("args.txt").is_empty());
}

#[test]
fn reason_agent_workers_left_by_a_dead_session_are_stopped_on_dismiss() {
    let fixture = Fixture::new("orphan");
    let id = fixture.launch("orphan").unwrap()[0].id.clone();
    fixture.wait_for("children.txt", 1);
    let deadline = Instant::now() + Duration::from_secs(5);
    while fixture.agents.list()[0].running {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(fixture.agents.list()[0].exit_code, Some(3));
    let worker = fixture.read("children.txt");
    assert!(alive(&worker), "the worker outlived the session leader");
    assert!(fixture.agents.stop(&id).unwrap().is_empty());
    gone(&worker);
}
