//! Offline contract tests for reviewed, file-by-file commits in a worktree
//! Studio created for a thread. Every repository is a scratch one in a temp
//! folder; nothing is pushed and no agent runs.
use std::{fs, path::Path, process::Command};
use toris_studio_desktop::project_chat::{ChatAgent, ChatMode, ProjectChat};
use toris_studio_desktop::project_git::{
    commit, commit_message, review, CommitRequest, CommitReview, PickedFile,
};
use toris_studio_desktop::project_worktrees;
use toris_studio_desktop::reason_agents::checked_folder;

fn git(folder: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(folder)
        .env_remove("GIT_DIR")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

struct Rig {
    _dir: tempfile::TempDir,
    chat: ProjectChat,
    app: std::path::PathBuf,
    wt: std::path::PathBuf,
    thread: String,
}

/// A repository with `a.txt`, `b.txt` and `gone.txt` committed, and an
/// isolated thread whose worktree Studio created.
fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    fs::create_dir_all(&app).unwrap();
    git(&app, &["init", "-q", "-b", "main"]);
    git(&app, &["config", "user.name", "Studio Test"]);
    git(&app, &["config", "user.email", "test@example.com"]);
    git(&app, &["config", "commit.gpgSign", "false"]);
    for (name, text) in [("a.txt", "a\n"), ("b.txt", "b\n"), ("gone.txt", "bye\n")] {
        fs::write(app.join(name), text).unwrap();
    }
    git(&app, &["add", "a.txt", "b.txt", "gone.txt"]);
    git(&app, &["commit", "-q", "-m", "init"]);
    let folder = checked_folder(&app).unwrap();
    let chat = ProjectChat::new(dir.path().join("store"));
    let project = chat.add_project(&folder).unwrap();
    let t = chat
        .create_thread(&project.id, ChatAgent::Claude, ChatMode::Edit)
        .unwrap();
    let t = project_worktrees::create(&chat, &t.id, |_| true)
        .unwrap()
        .expect("created");
    let wt = std::path::PathBuf::from(&t.worktree.as_ref().unwrap().path);
    Rig {
        app: std::path::PathBuf::from(folder),
        chat,
        wt,
        thread: t.id,
        _dir: dir,
    }
}

fn pick(review: &CommitReview, paths: &[&str], message: &str) -> CommitRequest {
    CommitRequest {
        thread_id: review.thread_id.clone(),
        head: review.head.clone(),
        files: paths
            .iter()
            .map(|p| {
                let f = review
                    .files
                    .iter()
                    .find(|f| f.path == *p)
                    .unwrap_or_else(|| panic!("{p} listed"));
                PickedFile {
                    path: f.path.clone(),
                    fingerprint: f.fingerprint.clone(),
                }
            })
            .collect(),
        message: message.into(),
    }
}

fn head(folder: &Path) -> String {
    git(folder, &["rev-parse", "HEAD"]).trim().to_owned()
}

fn status(folder: &Path) -> String {
    git(
        folder,
        &[
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
        ],
    )
}

#[test]
fn project_git_commits_only_the_picked_file_and_shows_sha_and_branch() {
    let rig = rig();
    fs::write(rig.wt.join("a.txt"), "a changed\n").unwrap();
    fs::write(rig.wt.join("b.txt"), "b changed\n").unwrap();
    let before = head(&rig.wt);
    let app_status = status(&rig.app);

    let r = review(&rig.chat, &rig.thread).unwrap();
    assert!(r.blocked.is_none(), "{:?}", r.blocked);
    assert_eq!(r.head, before);
    assert!(r.branch.starts_with("studio/"));
    let a = r.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert_eq!(a.change, "modified");
    assert!(a.fingerprint.starts_with("100644:"));
    assert!(a.diff.contains("+a changed"), "{}", a.diff);

    let mut asked = None;
    let done = commit(
        &rig.chat,
        &pick(&r, &["a.txt"], "  a만 고침  \n"),
        |plan| {
            asked = Some(project_git_confirm(plan));
            true
        },
    )
    .unwrap()
    .expect("committed");
    let asked = asked.unwrap();
    assert!(
        asked.contains("a.txt") && !asked.contains("b.txt"),
        "{asked}"
    );

    assert_eq!(done.sha, head(&rig.wt));
    assert_eq!(done.branch, r.branch);
    assert_eq!(done.files, vec!["a.txt".to_owned()]);
    assert!(done.index_updated);
    assert_eq!(
        git(&rig.wt, &["rev-parse", &format!("{}^", done.sha)]).trim(),
        before
    );
    // The commit's tree has only a.txt changed.
    assert_eq!(
        git(
            &rig.wt,
            &[
                "diff-tree",
                "--no-commit-id",
                "--name-only",
                "-r",
                &done.sha
            ]
        ),
        "a.txt\n"
    );
    assert_eq!(
        git(&rig.wt, &["show", &format!("{}:b.txt", done.sha)]),
        "b\n"
    );
    assert_eq!(
        git(&rig.wt, &["log", "-1", "--format=%B", &done.sha]).trim(),
        "a만 고침"
    );
    // b.txt stays modified and unstaged; a.txt is clean; nothing is staged.
    assert_eq!(status(&rig.wt), " M b.txt\n");
    assert_eq!(
        fs::read_to_string(rig.wt.join("b.txt")).unwrap(),
        "b changed\n"
    );
    // The original checkout and its branch are untouched; nothing was pushed or merged.
    assert_eq!(status(&rig.app), app_status);
    assert_eq!(git(&rig.app, &["rev-parse", "main"]).trim(), before);
}

fn project_git_confirm(plan: &toris_studio_desktop::project_git::CommitPlan) -> String {
    toris_studio_desktop::project_git::confirm_message(plan)
}

#[test]
fn project_git_commits_new_deleted_and_oddly_named_files() {
    let rig = rig();
    let odd = "공백 '따옴표\" $(touch x) -n.txt";
    fs::create_dir_all(rig.wt.join("src/새 폴더")).unwrap();
    fs::write(rig.wt.join("src/새 폴더").join(odd), "odd\n").unwrap();
    fs::write(rig.wt.join("-dash.txt"), "dash\n").unwrap();
    fs::write(rig.wt.join("*.txt"), "star\n").unwrap();
    fs::remove_file(rig.wt.join("gone.txt")).unwrap();
    fs::write(rig.wt.join("run.sh"), "#!/bin/sh\n").unwrap();
    // The executable bit exists only on unix; elsewhere run.sh is a plain new file.
    #[cfg(unix)]
    {
        let mut perms = fs::metadata(rig.wt.join("run.sh")).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
        fs::set_permissions(rig.wt.join("run.sh"), perms).unwrap();
    }

    let r = review(&rig.chat, &rig.thread).unwrap();
    let odd_path = format!("src/새 폴더/{odd}");
    let gone = r.files.iter().find(|f| f.path == "gone.txt").unwrap();
    assert_eq!(
        (gone.change.as_str(), gone.fingerprint.as_str()),
        ("deleted", "deleted")
    );
    let new = r.files.iter().find(|f| f.path == odd_path).unwrap();
    assert_eq!(new.change, "added");
    assert!(new.diff.contains("+odd"));
    #[cfg(unix)]
    assert!(r
        .files
        .iter()
        .find(|f| f.path == "run.sh")
        .unwrap()
        .fingerprint
        .starts_with("100755:"));

    let done = commit(
        &rig.chat,
        &pick(
            &r,
            &[&odd_path, "-dash.txt", "gone.txt", "run.sh"],
            "여러 파일",
        ),
        |_| true,
    )
    .unwrap()
    .unwrap();
    let mut names: Vec<String> = git(
        &rig.wt,
        &[
            "diff-tree",
            "-z",
            "--no-commit-id",
            "--name-only",
            "-r",
            &done.sha,
        ],
    )
    .split('\0')
    .filter(|n| !n.is_empty())
    .map(str::to_owned)
    .collect();
    names.sort();
    let mut want = vec![
        "-dash.txt".to_owned(),
        "gone.txt".to_owned(),
        odd_path.clone(),
        "run.sh".to_owned(),
    ];
    want.sort();
    assert_eq!(names, want);
    let tree = git(&rig.wt, &["ls-tree", "-r", &done.sha]);
    assert!(tree.contains("run.sh"), "{tree}");
    #[cfg(unix)]
    assert!(tree.contains("100755 blob"), "{tree}");
    // The `*.txt` file was not picked: a literal path never matched it as a glob.
    assert_eq!(status(&rig.wt), "?? *.txt\n");
    assert!(!rig.wt.join("x").exists(), "nothing in a name ran");
}

#[test]
fn project_git_refuses_existing_staged_changes() {
    let rig = rig();
    fs::write(rig.wt.join("a.txt"), "a changed\n").unwrap();
    fs::write(rig.wt.join("b.txt"), "b staged\n").unwrap();
    git(&rig.wt, &["add", "b.txt"]);
    let before = head(&rig.wt);
    let r = review(&rig.chat, &rig.thread).unwrap();
    assert!(
        r.blocked.as_deref().unwrap().contains("staged"),
        "{:?}",
        r.blocked
    );
    assert!(r
        .files
        .iter()
        .find(|f| f.path == "b.txt")
        .unwrap()
        .refused
        .is_some());
    let mut asked = false;
    let err = commit(&rig.chat, &pick(&r, &["a.txt"], "x"), |_| {
        asked = true;
        true
    })
    .unwrap_err();
    assert!(err.contains("staged"), "{err}");
    assert!(!asked, "refused before the OS confirmation");
    assert_eq!(head(&rig.wt), before);
    assert_eq!(status(&rig.wt), " M a.txt\nM  b.txt\n");
}

#[test]
fn project_git_asks_for_a_new_review_when_a_file_or_head_changed() {
    let rig = rig();
    fs::write(rig.wt.join("a.txt"), "reviewed\n").unwrap();
    let r = review(&rig.chat, &rig.thread).unwrap();
    let before = head(&rig.wt);

    // Changed after the review, before the confirmation.
    fs::write(rig.wt.join("a.txt"), "sneaky\n").unwrap();
    let err = commit(&rig.chat, &pick(&r, &["a.txt"], "x"), |_| true).unwrap_err();
    assert!(err.contains("다시 검토"), "{err}");
    assert_eq!(head(&rig.wt), before);

    // Changed while the OS dialog was open.
    fs::write(rig.wt.join("a.txt"), "reviewed\n").unwrap();
    let r = review(&rig.chat, &rig.thread).unwrap();
    let wt = rig.wt.clone();
    let err = commit(&rig.chat, &pick(&r, &["a.txt"], "x"), move |_| {
        fs::write(wt.join("a.txt"), "during dialog\n").unwrap();
        true
    })
    .unwrap_err();
    assert!(err.contains("다시 검토"), "{err}");
    assert_eq!(head(&rig.wt), before);
    assert_eq!(
        fs::read_to_string(rig.wt.join("a.txt")).unwrap(),
        "during dialog\n"
    );

    // HEAD moved after the review.
    fs::write(rig.wt.join("a.txt"), "reviewed\n").unwrap();
    let r = review(&rig.chat, &rig.thread).unwrap();
    git(
        &rig.wt,
        &["commit", "-q", "--allow-empty", "-m", "elsewhere"],
    );
    let err = commit(&rig.chat, &pick(&r, &["a.txt"], "x"), |_| true).unwrap_err();
    assert!(err.contains("HEAD"), "{err}");
    assert_eq!(status(&rig.wt), " M a.txt\n");
}

#[test]
fn project_git_refuses_paths_outside_the_list_links_and_bad_names() {
    let rig = rig();
    fs::write(rig.wt.join("a.txt"), "a changed\n").unwrap();
    fs::write(rig.wt.parent().unwrap().join("outside.txt"), "x\n").unwrap();
    // Making a symbolic link needs extra rights on Windows: the link part runs on unix.
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/hosts", rig.wt.join("link.txt")).unwrap();
    let r = review(&rig.chat, &rig.thread).unwrap();
    #[cfg(unix)]
    {
        let link = r.files.iter().find(|f| f.path == "link.txt").unwrap();
        assert!(
            link.refused.as_deref().unwrap().contains("링크"),
            "{link:?}"
        );
        assert!(link.fingerprint.is_empty());
    }

    for (path, fingerprint) in [
        ("../outside.txt", "100644:0"),
        ("/etc/hosts", "100644:0"),
        ("b.txt", "100644:0"),
        ("link.txt", ""),
    ] {
        let request = CommitRequest {
            thread_id: rig.thread.clone(),
            head: r.head.clone(),
            files: vec![PickedFile {
                path: path.into(),
                fingerprint: fingerprint.into(),
            }],
            message: "x".into(),
        };
        let err = commit(&rig.chat, &request, |_| true).unwrap_err();
        assert!(!err.is_empty(), "{path}");
    }
    // A picked file listed twice, and no file at all.
    let mut twice = pick(&r, &["a.txt"], "x");
    twice.files.push(twice.files[0].clone());
    assert!(commit(&rig.chat, &twice, |_| true)
        .unwrap_err()
        .contains("두 번"));
    let mut none = pick(&r, &["a.txt"], "x");
    none.files.clear();
    assert!(commit(&rig.chat, &none, |_| true).is_err());
    assert_eq!(head(&rig.wt), r.head);
}

#[test]
fn project_git_refuses_a_running_agent_a_linked_worktree_and_the_project_folder() {
    let rig = rig();
    fs::write(rig.wt.join("a.txt"), "a changed\n").unwrap();
    let r = review(&rig.chat, &rig.thread).unwrap();
    rig.chat.claim(&rig.thread, 1).unwrap();
    let busy = review(&rig.chat, &rig.thread).unwrap();
    assert!(busy.blocked.as_deref().unwrap().contains("실행 중"));
    let err = commit(&rig.chat, &pick(&r, &["a.txt"], "x"), |_| true).unwrap_err();
    assert!(err.contains("실행 중"), "{err}");
    rig.chat.release(&rig.thread);

    // A worktree the user made and linked is not Studio's own.
    let project = rig.chat.projects().0[0].clone();
    let mine = rig.app.parent().unwrap().join("mine");
    git(
        &rig.app,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "mine",
            mine.to_str().unwrap(),
        ],
    );
    let t = rig
        .chat
        .create_thread(&project.id, ChatAgent::Claude, ChatMode::Edit)
        .unwrap();
    rig.chat
        .link_worktree(&t.id, &checked_folder(&mine).unwrap())
        .unwrap();
    assert!(review(&rig.chat, &t.id)
        .unwrap_err()
        .contains("Studio가 만든"));
    // A thread working in the project folder itself.
    let plain = rig
        .chat
        .create_thread(&project.id, ChatAgent::Claude, ChatMode::Edit)
        .unwrap();
    assert!(review(&rig.chat, &plain.id)
        .unwrap_err()
        .contains("전용 worktree"));

    // Studio's worktree switched to another branch: ownership unclear.
    git(&rig.wt, &["switch", "-q", "-c", "other"]);
    assert!(review(&rig.chat, &rig.thread)
        .unwrap_err()
        .contains("브랜치"));
}

#[test]
fn project_git_failed_commit_changes_nothing_and_runs_no_hooks() {
    let rig = rig();
    fs::write(rig.wt.join("a.txt"), "a changed\n").unwrap();
    // Hooks and a fsmonitor command the repository asks for must not run.
    let hooks = rig.app.join(".git/hooks");
    let marker = rig.app.parent().unwrap().join("hook-ran");
    for hook in [
        "pre-commit",
        "commit-msg",
        "post-commit",
        "reference-transaction",
    ] {
        let path = hooks.join(hook);
        fs::write(&path, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        // Git for Windows runs a hook without an executable bit.
        #[cfg(unix)]
        {
            let mut perms = fs::metadata(&path).unwrap().permissions();
            std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
            fs::set_permissions(&path, perms).unwrap();
        }
    }
    git(
        &rig.app,
        &[
            "config",
            "core.fsmonitor",
            &format!("touch '{}'; false", marker.display()),
        ],
    );
    let before = head(&rig.wt);
    let r = review(&rig.chat, &rig.thread).unwrap();

    // Another git holds the branch's lock: moving the branch fails after
    // the commit object was written. The branch, files and index stay as they were.
    let lock = rig.app.join(format!(".git/refs/heads/{}.lock", r.branch));
    fs::write(&lock, "").unwrap();
    let err = commit(&rig.chat, &pick(&r, &["a.txt"], "x"), |_| true).unwrap_err();
    assert!(err.contains("커밋하지 못했습니다"), "{err}");
    assert_eq!(head(&rig.wt), before);
    assert_eq!(
        fs::read_to_string(rig.wt.join("a.txt")).unwrap(),
        "a changed\n"
    );
    assert_eq!(status(&rig.wt), " M a.txt\n", "index unchanged");
    fs::remove_file(&lock).unwrap();

    let done = commit(&rig.chat, &pick(&r, &["a.txt"], "x"), |_| true)
        .unwrap()
        .unwrap();
    assert_ne!(done.sha, before);
    // Checked before this test's own `git status`, which would run fsmonitor.
    assert!(!marker.exists(), "no repository hook or fsmonitor ran");
    git(&rig.app, &["config", "--unset", "core.fsmonitor"]);
    assert_eq!(status(&rig.wt), "");
}

#[test]
fn project_git_cancel_changes_nothing() {
    let rig = rig();
    fs::write(rig.wt.join("a.txt"), "a changed\n").unwrap();
    let r = review(&rig.chat, &rig.thread).unwrap();
    assert!(commit(&rig.chat, &pick(&r, &["a.txt"], "x"), |_| false)
        .unwrap()
        .is_none());
    assert_eq!(head(&rig.wt), r.head);
    assert_eq!(status(&rig.wt), " M a.txt\n");
}

#[test]
fn project_git_commit_message_rules() {
    assert_eq!(
        commit_message("  제목  \r\n\r\n본문 \n").unwrap(),
        "제목\n\n본문"
    );
    assert!(commit_message("   \n ").is_err());
    assert!(commit_message("\n\n둘째 줄만").unwrap() == "둘째 줄만");
    assert!(commit_message("bell\u{7}").is_err());
    assert!(
        commit_message(&"가".repeat(2000)).is_err(),
        "over 4000 bytes"
    );
    assert!(commit_message(&"a".repeat(4000)).is_ok());
}
