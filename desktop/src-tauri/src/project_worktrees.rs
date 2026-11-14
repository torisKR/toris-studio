//! New branch and git worktree for an isolated project chat thread.
//!
//! Studio names the branch and folder itself from the thread ID, shows them
//! with the committed HEAD they start from, and only after an OS confirmation
//! runs `git worktree add` with plain arguments (no shell, hooks off). Nothing
//! from the window or an agent becomes part of a command. The new worktree
//! starts from the last commit: uncommitted files, env files and dependencies
//! of the original checkout are never copied or stashed, and an existing path
//! or branch is never overwritten.
//!
//! Before git runs, a record of the planned creation is written next to the
//! chat store. It is removed once the worktree is linked to the thread through
//! the same checks as an existing worktree (`ProjectChat::link_worktree`). If
//! the app stops or the link fails in between, the record stays, so the folder
//! is recognized as Studio's own and can be linked to a new thread or left to
//! the user. Studio never deletes a folder or branch itself.
use crate::project_chat::{
    canonical, common_dir, cut, git, git_line, now, verify_worktree, ProjectChat, Thread,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

const PENDING_FILE: &str = "worktree-pending.json";
const BRANCH_PREFIX: &str = "studio/";
const MAX_PENDING: usize = 50;
const MAX_GIT_ERROR: usize = 400;

/// What Studio will create for a thread, shown before the OS confirmation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePlan {
    pub thread_id: String,
    /// The original checkout, which is left as it is.
    pub project_folder: String,
    /// The new worktree folder; it must not exist yet.
    pub path: String,
    /// The new branch; it must not exist yet.
    pub branch: String,
    /// The committed HEAD of the original checkout the branch starts from.
    pub base: String,
}

/// A creation that started but was not linked to its thread.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingWorktree {
    pub id: String,
    pub project_id: String,
    pub thread_id: String,
    pub path: String,
    pub branch: String,
    pub base: String,
    pub started_at: String,
    /// Read from disk when listed, never stored: `ready` (a worktree of the
    /// project on the planned branch that can be linked), `missing` (no folder)
    /// or `unknown` (something else is there now).
    #[serde(default, skip_deserializing)]
    pub state: String,
    /// What the user can do; Studio does not remove anything itself.
    #[serde(default, skip_deserializing)]
    pub guidance: String,
}

/// Threads with a creation in progress in this process (a second click waits).
static CREATING: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// Serializes reads and writes of the pending records.
static RECORDS: Mutex<()> = Mutex::new(());

struct Claim(String);

impl Claim {
    fn take(thread: &str) -> Result<Self, String> {
        let mut set = CREATING.lock().unwrap_or_else(|p| p.into_inner());
        if !set
            .get_or_insert_with(HashSet::new)
            .insert(thread.to_owned())
        {
            return Err(
                "이 대화의 worktree를 이미 만드는 중입니다. 끝날 때까지 기다리세요.".into(),
            );
        }
        Ok(Self(thread.to_owned()))
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        let mut set = CREATING.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(set) = set.as_mut() {
            set.remove(&self.0);
        }
    }
}

fn pending_path(chat: &ProjectChat) -> PathBuf {
    chat.root().join(PENDING_FILE)
}

fn read_records(chat: &ProjectChat) -> Vec<PendingWorktree> {
    fs::read(pending_path(chat))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_records(chat: &ProjectChat, records: &[PendingWorktree]) -> Result<(), String> {
    fs::create_dir_all(chat.root()).map_err(|_| "대화 저장 폴더를 만들지 못했습니다.")?;
    let path = pending_path(chat);
    let tmp = chat.root().join(format!("{PENDING_FILE}.tmp"));
    let bytes = serde_json::to_vec_pretty(records).map_err(|e| e.to_string())?;
    fs::write(&tmp, bytes)
        .and_then(|_| fs::rename(&tmp, &path))
        .map_err(|_| "worktree 생성 기록을 저장하지 못했습니다.".into())
}

fn edit_records(
    chat: &ProjectChat,
    change: impl FnOnce(&mut Vec<PendingWorktree>) -> Result<(), String>,
) -> Result<(), String> {
    let _guard = RECORDS.lock().unwrap_or_else(|p| p.into_inner());
    let mut records = read_records(chat);
    change(&mut records)?;
    write_records(chat, &records)
}

/// A short, safe folder and branch part from a name: ASCII letters, digits,
/// `-` and `_`, lower case, never empty or starting with `-`.
fn safe_part(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    let mut part: String = trimmed.chars().take(40).collect();
    while part.ends_with('-') {
        part.pop();
    }
    if part.is_empty() {
        "project".into()
    } else {
        part
    }
}

/// The thread's own short tag: the first eight letters or digits of its ID.
fn thread_tag(thread: &str) -> Result<String, String> {
    let tag: String = thread
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();
    (tag.len() == 8)
        .then_some(tag)
        .ok_or_else(|| "대화 ID로 worktree 이름을 만들 수 없습니다.".into())
}

/// The folder and branch Studio creates for `thread_id` next to the project
/// folder: `<parent>/<name>-worktrees/<tag>` and `studio/<tag>`. Used to plan a
/// creation and later to recognize a thread's worktree as Studio's own.
pub fn studio_target(project_folder: &str, thread_id: &str) -> Result<(PathBuf, String), String> {
    let tag = thread_tag(thread_id)?;
    let name = safe_part(
        Path::new(project_folder)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("project"),
    );
    let parent = Path::new(project_folder)
        .parent()
        .ok_or("프로젝트 폴더의 상위 폴더가 없습니다.")?;
    Ok((
        parent.join(format!("{name}-worktrees")).join(&tag),
        format!("{BRANCH_PREFIX}{tag}"),
    ))
}

fn ensure_unstarted(chat: &ProjectChat, thread: &Thread) -> Result<(), String> {
    if !chat.items(&thread.id).is_empty()
        || thread.provider_session.is_some()
        || chat.is_running(&thread.id)
    {
        return Err(
            "대화를 시작한 뒤에는 작업 폴더를 바꿀 수 없습니다. 새 대화에서 격리된 worktree를 만드세요."
                .into(),
        );
    }
    Ok(())
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Works out, without changing anything, the folder, branch and base commit
/// Studio would create for `thread_id`. Refuses a folder that is not a git
/// repository, a repository without commits, a thread that has started or
/// already has a worktree, and any existing path or branch.
pub fn plan(chat: &ProjectChat, thread_id: &str) -> Result<WorktreePlan, String> {
    let thread = chat.thread(thread_id)?;
    let project = chat.project(&thread.project_id)?;
    if thread.worktree.is_some() {
        return Err("이 대화에는 이미 worktree가 연결되어 있습니다.".into());
    }
    ensure_unstarted(chat, &thread)?;
    let folder = crate::reason_agents::checked_folder(Path::new(&project.folder))
        .ok()
        .filter(|f| f == &project.folder)
        .ok_or("프로젝트 폴더를 찾을 수 없거나 바뀌었습니다. 프로젝트를 다시 추가하세요.")?;
    common_dir(&folder).ok_or(
        "프로젝트 폴더가 Git 저장소가 아닙니다. 격리된 대화는 Git 저장소에서만 만들 수 있습니다.",
    )?;
    let top = git_line(&folder, &["rev-parse", "--show-toplevel"]).and_then(|t| canonical(&t));
    if top.as_deref() != Some(Path::new(&folder)) {
        return Err(
            "저장소의 최상위 폴더로 추가한 프로젝트에서만 격리된 대화를 만들 수 있습니다.".into(),
        );
    }
    let base = git_line(&folder, &["rev-parse", "--verify", "-q", "HEAD^{commit}"])
        .filter(|sha| matches!(sha.len(), 40 | 64) && sha.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or("저장소에 커밋이 없습니다. 첫 커밋을 만든 뒤 격리된 대화를 만들 수 있습니다.")?;
    let (path, branch) = studio_target(&folder, &thread.id)?;
    let container = path
        .parent()
        .ok_or("프로젝트 폴더의 상위 폴더가 없습니다.")?;
    if let Ok(meta) = fs::symlink_metadata(&container) {
        if !meta.is_dir() {
            return Err(format!(
                "{}이(가) 폴더가 아니거나 링크입니다. 그 자리에는 worktree를 만들지 않습니다.",
                container.display()
            ));
        }
    }
    let path_text = path
        .to_str()
        .filter(|p| !p.chars().any(char::is_control))
        .ok_or("폴더 경로에 사용할 수 없는 문자가 있습니다.")?
        .to_owned();
    git_line(&folder, &["check-ref-format", "--branch", &branch])
        .filter(|b| b == &branch)
        .ok_or("브랜치 이름을 만들지 못했습니다.")?;
    if exists(&path) {
        return Err(format!(
            "{path_text}이(가) 이미 있습니다. 덮어쓰지 않습니다. 그 폴더를 쓰려면 \"기존 worktree 연결\"을 고르세요."
        ));
    }
    if git(
        &folder,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_some()
    {
        return Err(format!(
            "브랜치 {branch}이(가) 이미 있습니다. 덮어쓰지 않습니다."
        ));
    }
    if read_records(chat)
        .iter()
        .any(|r| r.thread_id == thread.id || r.path == path_text)
    {
        return Err("이 대화에 끝나지 않은 worktree 생성 기록이 있습니다. 프로젝트의 복구 안내를 확인하세요.".into());
    }
    Ok(WorktreePlan {
        thread_id: thread.id,
        project_folder: folder,
        path: path_text,
        branch,
        base,
    })
}

/// The confirmation text the OS dialog shows for a plan.
pub fn confirm_message(plan: &WorktreePlan) -> String {
    format!(
        "원본 프로젝트: {}\n새 worktree 폴더: {}\n새 브랜치: {}\n기준 커밋(HEAD): {}\n\n• 마지막 커밋에서 시작합니다. 원본 폴더의 커밋하지 않은 변경, .env 같은 파일, 설치한 의존성은 옮기지 않습니다.\n• 원본 폴더의 파일과 브랜치는 바꾸지 않습니다.\n• 이 대화의 Claude Code·Codex는 새 worktree에서만 읽고 씁니다.\n• 대화를 지워도 worktree 폴더와 브랜치는 남습니다. 지우려면 직접 `git worktree remove`로 정리하세요.",
        plan.project_folder,
        plan.path,
        plan.branch,
        &plan.base[..12],
    )
}

/// Creates the planned branch and worktree for an unstarted thread after
/// `confirm` agrees, and links it to the thread. `Ok(None)` when cancelled.
pub fn create(
    chat: &ProjectChat,
    thread_id: &str,
    confirm: impl FnOnce(&WorktreePlan) -> bool,
) -> Result<Option<Thread>, String> {
    create_then(chat, thread_id, confirm, || {})
}

/// [`create`] with a step run between `git worktree add` and saving the link,
/// where an app stop or failed save leaves a pending record behind.
pub fn create_then(
    chat: &ProjectChat,
    thread_id: &str,
    confirm: impl FnOnce(&WorktreePlan) -> bool,
    before_save: impl FnOnce(),
) -> Result<Option<Thread>, String> {
    let _claim = Claim::take(thread_id)?;
    let planned = plan(chat, thread_id)?;
    if !confirm(&planned) {
        return Ok(None);
    }
    // The dialog may have stayed open a while: everything must still hold.
    let again = plan(chat, thread_id)?;
    if again != planned {
        return Err("확인하는 동안 저장소의 HEAD나 폴더가 바뀌었습니다. 다시 시도하세요.".into());
    }
    let thread = chat.thread(thread_id)?;
    let record = PendingWorktree {
        id: uuid::Uuid::new_v4().to_string(),
        project_id: thread.project_id.clone(),
        thread_id: thread.id.clone(),
        path: planned.path.clone(),
        branch: planned.branch.clone(),
        base: planned.base.clone(),
        started_at: now(),
        state: String::new(),
        guidance: String::new(),
    };
    edit_records(chat, |records| {
        if records.len() >= MAX_PENDING {
            return Err(
                "끝나지 않은 worktree 생성 기록이 너무 많습니다. 복구 안내에서 먼저 정리하세요."
                    .into(),
            );
        }
        records.push(record.clone());
        Ok(())
    })?;
    if let Err(output) = worktree_add(&planned) {
        let left = exists(Path::new(&planned.path))
            || git(
                &planned.project_folder,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{}", planned.branch),
                ],
            )
            .is_some();
        if !left {
            let _ = forget_record(chat, &record.id);
            return Err(format!(
                "worktree를 만들지 못했습니다. 아무것도 바뀌지 않았습니다.\n{output}"
            ));
        }
        return Err(format!(
            "worktree를 만들다 멈췄습니다. 남은 폴더나 브랜치는 지우지 않았습니다. 프로젝트의 복구 안내를 확인하세요.\n{output}"
        ));
    }
    before_save();
    match link_created(chat, thread_id, &planned, true) {
        Ok(thread) => {
            let _ = forget_record(chat, &record.id);
            Ok(Some(thread))
        }
        Err(e) => Err(format!(
            "worktree는 만들었지만 대화에 저장하지 못했습니다: {e}\n폴더({})와 브랜치({})는 그대로 두었습니다. 프로젝트의 복구 안내에서 새 대화로 이어서 연결할 수 있습니다.",
            planned.path, planned.branch
        )),
    }
}

/// The folder path in the form git can use. On Windows a canonical path has
/// the verbatim prefix (`\\?\C:\…`, `\\?\UNC\server\share\…`), which git
/// for Windows misreads as `//?/C:/…` and cannot create. The prefix is only
/// removed when the plain path names the very same folder: a drive or UNC
/// path under the classic length limit whose parts Windows would not rewrite
/// (no trailing dot or space, no device names such as `NUL`, no `/`).
/// Any other verbatim path is refused; a path without the prefix is returned
/// unchanged.
pub fn git_path(path: &str) -> Option<String> {
    let Some(rest) = path.strip_prefix(r"\\?\") else {
        return Some(path.to_owned());
    };
    let (plain, parts) = if let Some(unc) = rest.strip_prefix(r"UNC\") {
        (format!(r"\\{unc}"), unc)
    } else {
        let bytes = rest.as_bytes();
        if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || &bytes[1..3] != br":\" {
            return None;
        }
        (rest.to_owned(), &rest[3..])
    };
    const DEVICES: [&str; 6] = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];
    let safe = |part: &str| {
        let stem = part.split('.').next().unwrap_or("").trim_end();
        let numbered = stem.len() == 4
            && ["COM", "LPT"]
                .iter()
                .any(|p| stem.get(..3).is_some_and(|s| s.eq_ignore_ascii_case(p)))
            && stem.as_bytes()[3].is_ascii_digit();
        !part.is_empty()
            && part != "."
            && part != ".."
            && !part.ends_with(['.', ' '])
            && !part.contains(['/', ':'])
            && !numbered
            && !DEVICES.iter().any(|d| stem.eq_ignore_ascii_case(d))
    };
    let trimmed = parts.strip_suffix('\\').unwrap_or(parts);
    (plain.len() < 260 && (trimmed.is_empty() || trimmed.split('\\').all(safe))).then_some(plain)
}

/// `git worktree add -b <branch> <path> <base>` in the original checkout, with
/// repository hooks turned off so nothing from the repository runs.
fn worktree_add(plan: &WorktreePlan) -> Result<(), String> {
    let path = git_path(&plan.path).ok_or(
        "이 폴더 경로는 git에 그대로 넘길 수 없습니다. 더 짧거나 일반적인 이름의 폴더에서 프로젝트를 추가하세요.",
    )?;
    let hooks = if cfg!(windows) {
        "core.hooksPath=NUL"
    } else {
        "core.hooksPath=/dev/null"
    };
    let output = std::process::Command::new("git")
        .args(["-c", hooks, "-c", "core.quotepath=off"])
        .args(["worktree", "add", "--quiet", "-b"])
        .arg(&plan.branch)
        .arg(&path)
        .arg(&plan.base)
        .current_dir(&plan.project_folder)
        // Only the folder decides which repository git writes to.
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|_| "git을 실행하지 못했습니다.".to_owned())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(cut(
            String::from_utf8_lossy(&output.stderr).trim(),
            MAX_GIT_ERROR,
        ))
    }
}

/// Links a folder Studio created to `thread_id` through the ordinary checks,
/// and makes sure it is the planned branch at the planned commit.
fn link_created(
    chat: &ProjectChat,
    thread_id: &str,
    plan: &WorktreePlan,
    same_base: bool,
) -> Result<Thread, String> {
    let folder = crate::reason_agents::checked_folder(Path::new(&plan.path))?;
    let project = chat.project(&chat.thread(thread_id)?.project_id)?;
    let found = verify_worktree(&project.folder, &folder)?;
    if found.branch.as_deref() != Some(plan.branch.as_str()) {
        return Err(format!("폴더의 브랜치가 {}이(가) 아닙니다.", plan.branch));
    }
    if same_base && found.base != plan.base {
        return Err("폴더의 HEAD가 만들 때의 기준 커밋과 다릅니다.".into());
    }
    chat.link_worktree(thread_id, &folder)
}

fn forget_record(chat: &ProjectChat, id: &str) -> Result<(), String> {
    edit_records(chat, |records| {
        records.retain(|r| r.id != id);
        Ok(())
    })
}

/// Creations that did not finish, with what is on disk now and what to do.
/// Records whose folder is already some thread's worktree are finished and
/// dropped. Nothing on disk is changed.
pub fn pending(chat: &ProjectChat) -> Vec<PendingWorktree> {
    let (projects, threads) = chat.projects();
    let linked: HashSet<String> = threads
        .iter()
        .filter_map(|t| t.worktree.as_ref().map(|w| w.path.clone()))
        .collect();
    let mut done = vec![];
    let mut open = vec![];
    for mut record in read_records(chat) {
        if linked.contains(&record.path) {
            done.push(record.id.clone());
            continue;
        }
        let project = projects.iter().find(|p| p.id == record.project_id);
        let found = project.and_then(|p| verify_worktree(&p.folder, &record.path).ok());
        let manual = format!(
            "직접 정리하려면 원본 폴더에서 `git worktree remove {}`와 `git branch -d {}`를 확인한 뒤 실행하세요.",
            record.path, record.branch
        );
        if found
            .as_ref()
            .is_some_and(|w| w.branch.as_deref() == Some(record.branch.as_str()))
        {
            record.state = "ready".into();
            record.guidance = format!(
                "Studio가 만든 worktree가 남아 있습니다. 새 대화로 이어서 연결하거나, 기록만 지우고 폴더를 그대로 둘 수 있습니다. {manual}"
            );
        } else if !exists(Path::new(&record.path)) {
            record.state = "missing".into();
            record.guidance = format!(
                "폴더가 없습니다. 브랜치 {}이(가) 남았을 수 있습니다. 기록을 지워도 됩니다. 브랜치가 필요 없으면 `git branch -d {}`로 직접 지우세요.",
                record.branch, record.branch
            );
        } else {
            record.state = "unknown".into();
            record.guidance = format!(
                "그 자리에 Studio가 만든 worktree로 확인되지 않는 폴더가 있습니다. Studio는 지우지 않습니다. 내용을 확인한 뒤 직접 정리하세요. {manual}"
            );
        }
        open.push(record);
    }
    if !done.is_empty() {
        let _ = edit_records(chat, |records| {
            records.retain(|r| !done.contains(&r.id));
            Ok(())
        });
    }
    open
}

/// Links the folder of a pending creation to an unstarted thread of the same
/// project, after the same checks as a fresh creation, and drops the record.
pub fn resume(chat: &ProjectChat, record_id: &str, thread_id: &str) -> Result<Thread, String> {
    let record = pending(chat)
        .into_iter()
        .find(|r| r.id == record_id)
        .ok_or("그 생성 기록을 찾지 못했습니다. 목록을 새로고침하세요.")?;
    if record.state != "ready" {
        return Err(
            "이어서 연결할 수 있는 worktree가 아닙니다. 안내에 따라 직접 정리하세요.".into(),
        );
    }
    let thread = chat.thread(thread_id)?;
    if thread.project_id != record.project_id {
        return Err("같은 프로젝트의 대화에만 연결할 수 있습니다.".into());
    }
    if thread.worktree.is_some() {
        return Err("이 대화에는 이미 worktree가 연결되어 있습니다.".into());
    }
    ensure_unstarted(chat, &thread)?;
    let _claim = Claim::take(thread_id)?;
    let planned = WorktreePlan {
        thread_id: thread.id.clone(),
        project_folder: chat.project(&record.project_id)?.folder,
        path: record.path.clone(),
        branch: record.branch.clone(),
        base: record.base.clone(),
    };
    // Commits made in it since are fine; the branch must still be Studio's.
    let linked = link_created(chat, thread_id, &planned, false)?;
    let _ = forget_record(chat, &record.id);
    Ok(linked)
}

/// Drops a pending record only; its folder and branch stay as they are.
pub fn forget(chat: &ProjectChat, record_id: &str) -> Result<(), String> {
    if !read_records(chat).iter().any(|r| r.id == record_id) {
        return Err("그 생성 기록을 찾지 못했습니다.".into());
    }
    forget_record(chat, record_id)
}
