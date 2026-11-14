//! Reviewed, file-by-file commits in a worktree Studio created for a thread.
//!
//! The first version only commits in the dedicated worktree Studio made for a
//! thread (`studio/<tag>` in `<project>-worktrees/<tag>`), never in the user's
//! own checkout or a worktree they linked. The flow is:
//!
//! 1. [`review`] lists the changed files with their diff and a fingerprint of
//!    each file's current content (`<mode>:<blob id>`), plus the HEAD commit.
//! 2. The user picks files, writes a message and confirms in an OS dialog.
//! 3. [`commit`] checks everything again (the folder, that it is still Studio's
//!    worktree on its branch, HEAD, no staged changes, no running agent, and
//!    that every picked file still has the reviewed fingerprint). Anything that
//!    moved since the review is refused and must be reviewed again.
//! 4. Each picked file is read once; its bytes are stored as a blob only if they
//!    hash to the reviewed fingerprint. A temporary index built from HEAD gets
//!    exactly those entries, `commit-tree` makes the commit and `update-ref`
//!    moves the branch only if it still points at the reviewed HEAD.
//!
//! There is no `git add .`, no push, merge or revert. Git runs with plain
//! arguments, no shell, repository hooks, fsmonitor, filters, textconv or
//! signing programs, and with literal pathspecs, so nothing configured in the
//! repository or written by an agent becomes a command.
use crate::project_chat::{cut, work_folder, Item, ItemKind, ProjectChat, Thread};
use crate::reason_pipeline::plain_text;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

/// Changed files listed in one review.
pub const MAX_FILES: usize = 300;
/// Files in one commit.
pub const MAX_SELECTED: usize = 100;
/// Size of one committed file.
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// Diff text shown for one file.
pub const MAX_FILE_DIFF: usize = 48 * 1024;
/// Commit message, in bytes.
pub const MAX_MESSAGE: usize = 4000;
const MAX_GIT_ERROR: usize = 400;
/// How long one file's `git diff` may take before the file is refused.
const DIFF_TIME_LIMIT: Duration = Duration::from_secs(20);
const DELETED: &str = "deleted";

/// One changed file as git sees it in the worktree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    /// Path relative to the worktree, as git reports it.
    pub path: String,
    /// `modified`, `added` (untracked or intent-to-add), `deleted` or `typechange`.
    pub change: String,
    /// `<mode>:<blob id>` of the current content, or `deleted`. Empty when the
    /// file cannot be committed.
    pub fingerprint: String,
    pub diff: String,
    pub truncated: bool,
    /// Why this file cannot be picked; none when it can.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
}

/// What the commit panel shows before the user picks files.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitReview {
    pub thread_id: String,
    pub folder: String,
    pub branch: String,
    pub head: String,
    pub files: Vec<CommitFile>,
    /// Why no commit can be made now (staged changes, a running agent, …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
    /// More changed files than listed.
    pub more: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PickedFile {
    pub path: String,
    pub fingerprint: String,
}

/// What the window asks to commit: the reviewed HEAD, the picked files with
/// the fingerprints it was shown, and the message.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitRequest {
    pub thread_id: String,
    pub head: String,
    pub files: Vec<PickedFile>,
    pub message: String,
}

/// Checked request, shown in the OS confirmation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitPlan {
    pub folder: String,
    pub branch: String,
    pub head: String,
    pub files: Vec<CommitFile>,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDone {
    pub sha: String,
    pub branch: String,
    pub folder: String,
    pub files: Vec<String>,
    /// False when the commit landed but the worktree's index could not be
    /// updated for the committed files (`git status` may then list them).
    pub index_updated: bool,
    /// Set when the commit landed but its receipt could not be stored in the
    /// thread's history. The commit stands; it is never retried.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt_warning: Option<String>,
}

// ---------------------------------------------------------------------------
// git

struct Git<'a> {
    folder: &'a str,
    index: Option<&'a Path>,
}

impl Git<'_> {
    fn run(&self, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>, String> {
        self.run_within(args, input, None)
    }

    /// Like [`Git::run`], but git is stopped and `Err` returned once `limit`
    /// passes.
    fn run_within(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        limit: Option<Duration>,
    ) -> Result<Vec<u8>, String> {
        let hooks = if cfg!(windows) {
            "core.hooksPath=NUL"
        } else {
            "core.hooksPath=/dev/null"
        };
        let mut command = Command::new("git");
        command
            .args(["-c", hooks, "-c", "core.fsmonitor=false"])
            .args(["-c", "core.quotepath=off", "-c", "commit.gpgSign=false"])
            .args(["-c", "diff.external=", "--literal-pathspecs"])
            .args(args)
            .current_dir(self.folder)
            // Only the folder decides which repository git uses.
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_COMMON_DIR")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
            .env("GIT_PAGER", "cat")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(index) = self.index {
            command.env("GIT_INDEX_FILE", index);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "git을 실행하지 못했습니다.".to_owned())?;
        if let (Some(bytes), Some(mut stdin)) = (input, child.stdin.take()) {
            let bytes = bytes.to_vec();
            // Write from another thread so a full stdout pipe never blocks us.
            std::thread::spawn(move || {
                let _ = stdin.write_all(&bytes);
            });
        }
        let output = match limit {
            None => child.wait_with_output(),
            Some(limit) => wait_within(child, limit)?,
        }
        .map_err(|_| "git을 실행하지 못했습니다.".to_owned())?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            Err(cut(
                &plain_text(String::from_utf8_lossy(&output.stderr).trim()),
                MAX_GIT_ERROR,
            ))
        }
    }

    fn line(&self, args: &[&str]) -> Option<String> {
        let out = self.run(args, None).ok()?;
        let text = String::from_utf8(out).ok()?;
        let line = text.trim();
        (!line.is_empty() && !line.contains('\n')).then(|| line.to_owned())
    }
}

/// Waits for `child` and collects its output, killing it after `limit`.
fn wait_within(
    mut child: std::process::Child,
    limit: Duration,
) -> Result<std::io::Result<Output>, String> {
    fn drain(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut bytes = vec![];
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            bytes
        })
    }
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "git이 {}초 안에 끝나지 않았습니다.",
                    limit.as_secs()
                ));
            }
            Err(e) => break Err(e),
        }
    };
    Ok(status.map(|status| Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    }))
}

fn is_sha(text: &str) -> bool {
    matches!(text.len(), 40 | 64) && text.chars().all(|c| c.is_ascii_hexdigit())
}

// ---------------------------------------------------------------------------
// The worktree and its state

/// A thread's worktree that is Studio's own, checked right now.
struct Target {
    folder: String,
    branch: String,
    head: String,
}

/// The thread's worktree, only if Studio created it for this thread and it is
/// still that folder of the project's repository on that branch.
fn target(chat: &ProjectChat, thread: &Thread) -> Result<Target, String> {
    let project = chat.project(&thread.project_id)?;
    let linked = thread.worktree.as_ref().ok_or(
        "이 대화는 프로젝트 폴더에서 작업합니다. 선택 커밋은 Studio가 만든 전용 worktree(격리된 새 대화)에서만 할 수 있습니다.",
    )?;
    let (path, branch) = crate::project_worktrees::studio_target(&project.folder, &thread.id)?;
    if Some(linked.path.as_str()) != path.to_str() || linked.branch.as_deref() != Some(&branch) {
        return Err("이 대화의 worktree는 Studio가 만든 전용 worktree가 아닙니다(직접 연결한 worktree). 그 폴더의 커밋은 직접 하세요.".into());
    }
    let folder = work_folder(&project, thread)?;
    if folder != linked.path {
        return Err("작업 폴더가 연결할 때와 다릅니다. 커밋하지 않습니다.".into());
    }
    let git = Git {
        folder: &folder,
        index: None,
    };
    let current = git.line(&["symbolic-ref", "-q", "HEAD"]);
    if current.as_deref() != Some(&format!("refs/heads/{branch}")) {
        return Err(format!(
            "worktree가 {branch} 브랜치에 있지 않습니다(누가 브랜치를 바꿨습니다). 커밋하지 않습니다."
        ));
    }
    let head = git
        .line(&["rev-parse", "--verify", "-q", "HEAD^{commit}"])
        .filter(|h| is_sha(h))
        .ok_or("worktree의 HEAD 커밋을 읽지 못했습니다.")?;
    Ok(Target {
        folder,
        branch,
        head,
    })
}

/// Why no commit may be made in `folder` now, if anything.
fn blocked(chat: &ProjectChat, thread: &Thread, folder: &str) -> Option<String> {
    let (projects, threads) = chat.projects();
    let busy = threads.iter().any(|t| {
        chat.is_running(&t.id)
            && (t.id == thread.id
                || t.worktree.as_ref().map(|w| w.path.as_str()).or_else(|| {
                    projects
                        .iter()
                        .find(|p| p.id == t.project_id)
                        .map(|p| p.folder.as_str())
                }) == Some(folder))
    });
    if busy {
        return Some(
            "이 작업 폴더에서 에이전트가 실행 중입니다. 끝나거나 중지한 뒤 커밋하세요.".into(),
        );
    }
    let git = Git {
        folder,
        index: None,
    };
    for (marker, what) in [
        ("MERGE_HEAD", "병합"),
        ("CHERRY_PICK_HEAD", "체리픽"),
        ("REVERT_HEAD", "되돌리기"),
        ("rebase-merge", "리베이스"),
        ("rebase-apply", "리베이스"),
    ] {
        let Some(path) = git.line(&["rev-parse", "--git-path", marker]) else {
            return Some("worktree의 git 상태를 읽지 못했습니다.".into());
        };
        let path = Path::new(folder).join(path);
        if fs::symlink_metadata(path).is_ok() {
            return Some(format!(
                "worktree에서 {what}이(가) 진행 중입니다. 끝낸 뒤 커밋하세요."
            ));
        }
    }
    None
}

struct Entry {
    code: [u8; 2],
    path: String,
    /// The name is valid UTF-8 and shows as it is stored.
    plain: bool,
}

/// `git status` of the worktree, without renames, untracked files expanded.
fn status(git: &Git) -> Result<Vec<Entry>, String> {
    let out = git
        .run(
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--no-renames",
                "--ignore-submodules=none",
            ],
            None,
        )
        .map_err(|e| format!("변경 사항을 읽지 못했습니다: {e}"))?;
    let mut entries = vec![];
    for record in out.split(|b| *b == 0).filter(|r| r.len() > 3) {
        let (path, plain) = match std::str::from_utf8(&record[3..]) {
            Ok(name) => (name.to_owned(), plain_text(name) == name),
            Err(_) => (String::from_utf8_lossy(&record[3..]).into_owned(), false),
        };
        entries.push(Entry {
            code: [record[0], record[1]],
            path: if plain { path } else { plain_text(&path) },
            plain,
        });
    }
    Ok(entries)
}

/// The path relative to the worktree, refused if it could leave it.
fn relative(path: &str) -> Result<&Path, String> {
    let rel = Path::new(path);
    let plain = !path.is_empty()
        && !path.chars().any(char::is_control)
        && rel
            .components()
            .all(|c| matches!(c, Component::Normal(name) if name != ".git"));
    plain
        .then_some(rel)
        .ok_or_else(|| "이 파일 이름은 커밋할 수 없습니다.".into())
}

/// The file at `rel` inside `folder`, refused when it or a folder on the way is
/// a link or it is not a plain file.
fn regular_file(folder: &str, rel: &Path) -> Result<Option<(PathBuf, fs::Metadata)>, String> {
    let full = Path::new(folder).join(rel);
    if let Some(parent) = full.parent() {
        match parent.canonicalize() {
            Ok(real) if real == parent => {}
            Ok(_) => return Err("링크된 폴더 안의 파일은 커밋하지 않습니다.".into()),
            Err(_) => return Ok(None),
        }
    }
    match fs::symlink_metadata(&full) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("파일을 읽지 못했습니다.".into()),
        Ok(meta) if meta.file_type().is_symlink() => Err("심볼릭 링크는 커밋하지 않습니다.".into()),
        Ok(meta) if !meta.is_file() => Err("폴더(하위 저장소)는 커밋하지 않습니다.".into()),
        Ok(meta) if meta.len() > MAX_FILE_BYTES => Err(format!(
            "{} MiB보다 큰 파일은 커밋하지 않습니다.",
            MAX_FILE_BYTES / 1024 / 1024
        )),
        Ok(meta) => Ok(Some((full, meta))),
    }
}

fn mode(meta: &fs::Metadata) -> &'static str {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 != 0 {
            return "100755";
        }
    }
    let _ = meta;
    "100644"
}

/// Reads a plain file once, without following a link swapped in meanwhile,
/// with the mode of what was actually read.
fn read_once(full: &Path) -> Result<(Vec<u8>, &'static str), String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(full)
        .map_err(|_| "파일을 읽지 못했습니다(링크로 바뀌었거나 사라졌습니다).".to_owned())?;
    let meta = file
        .metadata()
        .ok()
        .filter(fs::Metadata::is_file)
        .ok_or("일반 파일이 아닙니다.")?;
    let mut bytes = vec![];
    Read::by_ref(&mut file)
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "파일을 읽지 못했습니다.".to_owned())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("파일이 너무 큽니다.".into());
    }
    Ok((bytes, mode(&meta)))
}

/// The blob id of `bytes`, stored in the repository when `write`. No filters
/// (clean/smudge, LFS) run: the bytes are committed exactly as read.
fn blob(git: &Git, bytes: &[u8], write: bool) -> Result<String, String> {
    let args: &[&str] = if write {
        &["hash-object", "-w", "--no-filters", "--stdin"]
    } else {
        &["hash-object", "--no-filters", "--stdin"]
    };
    let out = git.run(args, Some(bytes))?;
    let id = String::from_utf8_lossy(&out).trim().to_owned();
    is_sha(&id)
        .then_some(id)
        .ok_or_else(|| "파일 내용을 저장하지 못했습니다.".into())
}

/// A file's current content as `(fingerprint, bytes)`; `deleted` when gone.
fn content(git: &Git, entry: &Entry) -> Result<(String, Option<(String, Vec<u8>)>), String> {
    if !entry.plain {
        return Err(
            "파일 이름에 보이지 않는 문자나 UTF-8이 아닌 바이트가 있어 커밋하지 않습니다.".into(),
        );
    }
    let rel = relative(&entry.path)?;
    match regular_file(git.folder, rel)? {
        None if entry.code[1] == b'D' => Ok((DELETED.into(), None)),
        None => Err("파일을 찾지 못했습니다. 새로고침하세요.".into()),
        Some((full, _)) => {
            let (bytes, mode) = read_once(&full)?;
            let id = blob(git, &bytes, false)?;
            Ok((format!("{mode}:{id}"), Some((mode.to_owned(), bytes))))
        }
    }
}

/// The diff shown for one file and whether it was cut. `Err` when git could
/// not produce it (failed, timed out, unreadable object): the file was not
/// shown, so it must not be offered as reviewed. An empty `Ok` is a real empty
/// diff.
fn diff_text(git: &Git, entry: &Entry, bytes: Option<&[u8]>) -> Result<(String, bool), String> {
    let raw = if entry.code == *b"??" {
        match bytes {
            Some(b) if b.contains(&0) || std::str::from_utf8(b).is_err() => {
                return Ok(("(새 바이너리 파일)".into(), false))
            }
            Some(b) => {
                let text = String::from_utf8_lossy(b);
                let mut out = format!("새 파일 {}\n", entry.path);
                for line in text.lines() {
                    out.push('+');
                    out.push_str(line);
                    out.push('\n');
                }
                out
            }
            None => String::new(),
        }
    } else {
        git.run_within(
            &[
                "diff",
                "HEAD",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--",
                &entry.path,
            ],
            None,
            Some(DIFF_TIME_LIMIT),
        )
        .map(|out| String::from_utf8_lossy(&out).into_owned())
        .map_err(|e| {
            if e.is_empty() {
                "diff를 읽지 못해 변경 내용을 보여 줄 수 없어 커밋하지 않습니다.".to_owned()
            } else {
                format!("diff를 읽지 못해 변경 내용을 보여 줄 수 없어 커밋하지 않습니다: {e}")
            }
        })?
    };
    Ok(if raw.len() > MAX_FILE_DIFF {
        (cut(&raw, MAX_FILE_DIFF), true)
    } else {
        (plain_text(&raw), false)
    })
}

fn change_name(code: [u8; 2]) -> &'static str {
    match code {
        [b'?', b'?'] | [b' ', b'A'] => "added",
        [b' ', b'D'] => "deleted",
        [b' ', b'T'] => "typechange",
        _ => "modified",
    }
}

fn staged(code: [u8; 2]) -> bool {
    !matches!(code[0], b' ' | b'?')
}

/// Lists the worktree's changes with fingerprints. `Err` when this thread
/// cannot commit at all (not Studio's worktree, folder changed); `blocked`
/// when it could later (staged changes, a running agent, a merge in progress).
pub fn review(chat: &ProjectChat, thread_id: &str) -> Result<CommitReview, String> {
    let thread = chat.thread(thread_id)?;
    let target = target(chat, &thread)?;
    let git = Git {
        folder: &target.folder,
        index: None,
    };
    let entries = status(&git)?;
    let mut blocked = blocked(chat, &thread, &target.folder);
    if blocked.is_none() && entries.iter().any(|e| staged(e.code)) {
        blocked = Some("이 worktree에 이미 staged(git add된) 변경이 있습니다. Studio는 그 변경을 섞지 않으려고 커밋하지 않습니다. 터미널에서 `git restore --staged`로 내리거나 직접 커밋하세요.".into());
    }
    let more = entries.len() > MAX_FILES;
    let mut files = vec![];
    for entry in entries.iter().take(MAX_FILES) {
        let (fingerprint, diff, truncated, refused) = if staged(entry.code) {
            let (diff, truncated) = diff_text(&git, entry, None).unwrap_or_default();
            (
                String::new(),
                diff,
                truncated,
                Some("staged 변경".to_owned()),
            )
        } else {
            match content(&git, entry) {
                Ok((fingerprint, found)) => {
                    match diff_text(&git, entry, found.as_ref().map(|(_, b)| b.as_slice())) {
                        Ok((diff, truncated)) => (fingerprint, diff, truncated, None),
                        // Not shown means not reviewed: no fingerprint, refused.
                        Err(why) => (String::new(), String::new(), false, Some(why)),
                    }
                }
                Err(why) => (String::new(), String::new(), false, Some(why)),
            }
        };
        files.push(CommitFile {
            path: entry.path.clone(),
            change: change_name(entry.code).into(),
            fingerprint,
            diff,
            truncated,
            refused,
        });
    }
    Ok(CommitReview {
        thread_id: thread.id,
        folder: target.folder,
        branch: target.branch,
        head: target.head,
        files,
        blocked,
        more,
    })
}

/// Checks a request against a fresh review; the picked files in that review.
fn check(review: &CommitReview, request: &CommitRequest) -> Result<Vec<CommitFile>, String> {
    if let Some(why) = &review.blocked {
        return Err(why.clone());
    }
    if review.head != request.head {
        return Err(
            "검토한 뒤 브랜치에 새 커밋이 생겼습니다(HEAD가 바뀜). 변경 사항을 다시 검토하세요."
                .into(),
        );
    }
    let mut picked: Vec<CommitFile> = vec![];
    for wanted in &request.files {
        if picked.iter().any(|f| f.path == wanted.path) {
            return Err(format!("{}을(를) 두 번 골랐습니다.", wanted.path));
        }
        let file = review
            .files
            .iter()
            .find(|f| f.path == wanted.path)
            .ok_or_else(|| {
                format!(
                    "{}은(는) 지금 바뀐 파일 목록에 없습니다. 다시 검토하세요.",
                    wanted.path
                )
            })?;
        if let Some(why) = &file.refused {
            return Err(format!("{}: {why}", file.path));
        }
        if file.fingerprint != wanted.fingerprint {
            return Err(format!(
                "검토한 뒤 {}의 내용이 바뀌었습니다. 다시 검토하세요.",
                file.path
            ));
        }
        picked.push(file.clone());
    }
    Ok(picked)
}

/// The commit message, cleaned: trailing spaces off, control characters other
/// than line breaks and tabs refused, at most [`MAX_MESSAGE`] bytes.
pub fn commit_message(text: &str) -> Result<String, String> {
    let text = text.replace("\r\n", "\n");
    if text
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err("커밋 메시지에 쓸 수 없는 제어 문자가 있습니다.".into());
    }
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let message = lines.join("\n").trim().to_owned();
    if message.is_empty() || message.lines().next().unwrap_or("").trim().is_empty() {
        return Err("커밋 메시지(첫 줄)를 입력하세요.".into());
    }
    if message.len() > MAX_MESSAGE {
        return Err(format!(
            "커밋 메시지는 {MAX_MESSAGE}바이트까지 쓸 수 있습니다."
        ));
    }
    Ok(message)
}

/// Checks the request as it stands now, without changing anything.
pub fn prepare(chat: &ProjectChat, request: &CommitRequest) -> Result<CommitPlan, String> {
    let message = commit_message(&request.message)?;
    if request.files.is_empty() {
        return Err("커밋할 파일을 하나 이상 고르세요.".into());
    }
    if request.files.len() > MAX_SELECTED {
        return Err(format!(
            "한 번에 {MAX_SELECTED}개 파일까지 커밋할 수 있습니다."
        ));
    }
    let review = review(chat, &request.thread_id)?;
    let files = check(&review, request)?;
    Ok(CommitPlan {
        folder: review.folder,
        branch: review.branch,
        head: review.head,
        files,
        message,
    })
}

/// The confirmation text the OS dialog shows.
pub fn confirm_message(plan: &CommitPlan) -> String {
    let files: Vec<String> = plan
        .files
        .iter()
        .take(20)
        .map(|f| {
            let mark = match f.change.as_str() {
                "added" => "추가",
                "deleted" => "삭제",
                _ => "수정",
            };
            format!("  {mark}  {}", f.path)
        })
        .collect();
    let more = plan.files.len().saturating_sub(20);
    let first = plan.message.lines().next().unwrap_or("");
    format!(
        "worktree: {}\n브랜치: {}\n기준 커밋(HEAD): {}\n\n커밋할 파일 {}개:\n{}{}\n\n메시지: {}\n\n• 고른 파일만 검토한 내용 그대로 커밋합니다. 다른 변경은 그대로 남습니다.\n• push·병합·되돌리기는 하지 않습니다. 저장소 훅과 서명 프로그램은 실행하지 않습니다.",
        plan.folder,
        plan.branch,
        &plan.head[..12],
        plan.files.len(),
        files.join("\n"),
        if more > 0 { format!("\n  … 외 {more}개") } else { String::new() },
        cut(first, 200),
    )
}

/// Commits the picked files after `confirm` agrees. `Ok(None)` when cancelled.
pub fn commit(
    chat: &ProjectChat,
    request: &CommitRequest,
    confirm: impl FnOnce(&CommitPlan) -> bool,
) -> Result<Option<CommitDone>, String> {
    let planned = prepare(chat, request)?;
    if !confirm(&planned) {
        return Ok(None);
    }
    // The dialog may have stayed open: everything must still hold.
    let plan = prepare(chat, request)?;
    if plan != planned {
        return Err("확인하는 동안 변경 사항이 바뀌었습니다. 다시 검토하세요.".into());
    }
    let mut done = write_commit(&plan)?;
    // The receipt comes from git's own results, never from model output.
    let receipt = Item::new(ItemKind::Notice, receipt_text(&done));
    if let Err(e) = chat.append(&request.thread_id, &[receipt]) {
        done.receipt_warning = Some(format!(
            "커밋은 완료됐지만 이 대화 기록에 영수증을 남기지 못했습니다: {e}"
        ));
    }
    Ok(Some(done))
}

/// The most files a receipt lists by name.
const RECEIPT_FILES: usize = 50;

/// Plain-text receipt of a commit Studio made, kept in the thread's history.
pub fn receipt_text(done: &CommitDone) -> String {
    let files: Vec<String> = done
        .files
        .iter()
        .take(RECEIPT_FILES)
        .map(|f| format!("  {}", cut(&plain_text(f), 300)))
        .collect();
    let more = done.files.len().saturating_sub(RECEIPT_FILES);
    format!(
        "선택 커밋 완료\n커밋: {}\n브랜치: {}\nworktree: {}\n파일 {}개:\n{}{}\nindex: {}",
        done.sha,
        plain_text(&done.branch),
        plain_text(&done.folder),
        done.files.len(),
        files.join("\n"),
        if more > 0 {
            format!("\n  … 외 {more}개")
        } else {
            String::new()
        },
        if done.index_updated {
            "고른 파일 갱신됨"
        } else {
            "갱신하지 못함 (git status에 커밋한 파일이 남아 보일 수 있음)"
        },
    )
}

/// One index record for `git update-index -z --index-info`.
fn index_record(mode: &str, id: &str, path: &str) -> Vec<u8> {
    let mut record = format!("{mode} {id}\t").into_bytes();
    record.extend_from_slice(path.as_bytes());
    record.push(0);
    record
}

fn write_commit(plan: &CommitPlan) -> Result<CommitDone, String> {
    let git = Git {
        folder: &plan.folder,
        index: None,
    };
    let zero = "0".repeat(plan.head.len());
    // Store exactly the reviewed bytes; refuse if a file changed after the check.
    let mut records = vec![];
    for file in &plan.files {
        let rel = relative(&file.path)?;
        match regular_file(&plan.folder, rel)? {
            None if file.fingerprint == DELETED => {
                records.extend(index_record("0", &zero, &file.path));
            }
            None => {
                return Err(format!(
                    "{}이(가) 사라졌습니다. 다시 검토하세요.",
                    file.path
                ))
            }
            Some((full, _)) => {
                let (bytes, mode) = read_once(&full)?;
                let id = blob(&git, &bytes, true)?;
                if format!("{mode}:{id}") != file.fingerprint {
                    return Err(format!(
                        "검토한 뒤 {}의 내용이 바뀌었습니다. 커밋하지 않았습니다. 다시 검토하세요.",
                        file.path
                    ));
                }
                records.extend(index_record(mode, &id, &file.path));
            }
        }
    }
    // A private index starting from the reviewed HEAD gets only these entries.
    let index_rel = git
        .line(&[
            "rev-parse",
            "--git-path",
            &format!("toris-commit-{}.index", uuid::Uuid::new_v4()),
        ])
        .ok_or("임시 index 경로를 만들지 못했습니다.")?;
    let index_path = Path::new(&plan.folder).join(index_rel);
    struct Remove(PathBuf);
    impl Drop for Remove {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
            let _ = fs::remove_file(self.0.with_extension("index.lock"));
        }
    }
    let _cleanup = Remove(index_path.clone());
    let temp = Git {
        folder: &plan.folder,
        index: Some(&index_path),
    };
    let fail = |what: &str, e: String| {
        format!("커밋하지 못했습니다({what}). 브랜치와 파일은 그대로입니다.\n{e}")
    };
    temp.run(&["read-tree", &plan.head], None)
        .map_err(|e| fail("index 준비", e))?;
    temp.run(&["update-index", "-z", "--index-info"], Some(&records))
        .map_err(|e| fail("파일 등록", e))?;
    let tree = temp
        .line(&["write-tree"])
        .filter(|t| is_sha(t))
        .ok_or_else(|| fail("tree 작성", String::new()))?;
    let parent_tree = git.line(&["rev-parse", &format!("{}^{{tree}}", plan.head)]);
    if parent_tree.as_deref() == Some(tree.as_str()) {
        return Err("고른 파일이 HEAD와 같아 커밋할 내용이 없습니다.".into());
    }
    let sha = git
        .run(
            &[
                "commit-tree",
                &tree,
                "-p",
                &plan.head,
                "--no-gpg-sign",
                "-F",
                "-",
            ],
            Some(format!("{}\n", plan.message).as_bytes()),
        )
        .map_err(|e| fail("커밋 작성", e))
        .map(|out| String::from_utf8_lossy(&out).trim().to_owned())?;
    if !is_sha(&sha) {
        return Err(fail("커밋 작성", String::new()));
    }
    // Moves the branch only if it still points at the reviewed HEAD.
    git.run(
        &[
            "update-ref",
            "-m",
            "toris studio: 선택 파일 커밋",
            &format!("refs/heads/{}", plan.branch),
            &sha,
            &plan.head,
        ],
        None,
    )
    .map_err(|e| fail("브랜치 갱신 — 그사이 브랜치가 바뀌었을 수 있습니다", e))?;
    // The worktree's own index now matches the commit for the picked files;
    // other entries were already equal to HEAD (no staged changes).
    let index_updated = git
        .run(&["update-index", "-z", "--index-info"], Some(&records))
        .is_ok();
    Ok(CommitDone {
        sha,
        branch: plan.branch.clone(),
        folder: plan.folder.clone(),
        files: plan.files.iter().map(|f| f.path.clone()).collect(),
        index_updated,
        receipt_warning: None,
    })
}
