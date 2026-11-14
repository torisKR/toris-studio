import { Check, ChevronDown, ChevronRight, FileDiff, GitBranch, GitCommitHorizontal, LoaderCircle, PanelRightClose, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  canCommitIn, commitFiles, commitMessageProblem, diffLines, pickableFiles, readChanges, reviewCommit,
  type Changes, type CommitChange, type CommitDone, type CommitReview, type Project, type Thread
} from "./project-chat-client";
import "./ChangesPanel.css";

const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
const MARK: Record<CommitChange, string> = { modified: "M", added: "A", deleted: "D", typechange: "T" };
const MARK_LABEL: Record<CommitChange, string> = { modified: "수정", added: "추가", deleted: "삭제", typechange: "종류 변경" };

function Diff({ text }: { text: string }) {
  const lines = useMemo(() => diffLines(text), [text]);
  return <pre className="pc-diff">{lines.map((line, i) => <span key={i} className={line.kind}>{line.text + "\n"}</span>)}</pre>;
}

/** Pick files of a Studio-made worktree, read their diff, write a message and commit after the host's OS confirmation. */
function CommitBox({ thread, onCommitted, onClose }: { thread: Thread; onCommitted: () => void; onClose: () => void }) {
  const [review, setReview] = useState<CommitReview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<CommitDone | null>(null);
  const load = useCallback(async () => {
    // A new review always starts with nothing picked: what was picked before may have changed.
    setBusy(true); setError(""); setPicked(new Set()); setOpen(new Set());
    try { setReview(await reviewCommit(thread.id)); } catch (cause) { setReview(null); setError(errorText(cause)); } finally { setBusy(false); }
  }, [thread.id]);
  useEffect(() => { void load(); }, [load]);
  const pickable = useMemo(() => new Set(pickableFiles(review).map(f => f.path)), [review]);
  const problem = commitMessageProblem(message);
  const toggle = (set: Set<string>, path: string) => { const next = new Set(set); if (next.has(path)) next.delete(path); else next.add(path); return next; };
  const submit = async () => {
    if (!review) return;
    setBusy(true); setError("");
    try {
      const result = await commitFiles(review, [...picked], message);
      if (result) { setDone(result); setMessage(""); onCommitted(); setReview(await reviewCommit(thread.id)); setPicked(new Set()); setOpen(new Set()); }
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  const stale = /다시 검토/.test(error);
  const running = thread.running;
  return <section className="pc-commit" aria-label="선택 파일 커밋">
    <header><strong><GitCommitHorizontal size={14} />선택 파일 커밋</strong>
      <button type="button" className="pc-icon" aria-label="커밋 목록 다시 검토" disabled={busy} onClick={() => void load()}><RefreshCw size={13} /></button>
      <button type="button" className="pc-icon" aria-label="선택 커밋 닫기" onClick={onClose}><X size={13} /></button>
    </header>
    {review && <p className="pc-muted pc-commit-where" title={review.folder}><GitBranch size={11} />{review.branch} · HEAD {review.head.slice(0, 12)}</p>}
    {done && <p className="pc-commit-done" role="status"><Check size={13} />커밋했습니다 <code title={done.sha}>{done.sha.slice(0, 12)}</code> · {done.branch} · 파일 {done.files.length}개{done.indexUpdated ? "" : " (작업 폴더 index는 갱신하지 못함)"}</p>}
    {review?.blocked && <p className="pc-error" role="alert">{review.blocked}</p>}
    {running && !review?.blocked && <p className="pc-error" role="alert">에이전트가 실행 중입니다. 끝나거나 중지한 뒤 커밋하세요.</p>}
    {error && <p className="pc-error" role="alert">{error}{stale && <> <button type="button" className="social-button compact" onClick={() => void load()}>다시 검토</button></>}</p>}
    {review && !review.files.length && <p className="pc-muted">커밋할 변경이 없습니다.</p>}
    {!!review?.files.length && <ul className="pc-commit-files">{review.files.map(file => {
      const can = pickable.has(file.path);
      const shown = open.has(file.path);
      return <li key={file.path} className={file.refused ? "refused" : undefined}>
        <div className="pc-commit-row">
          <input type="checkbox" aria-label={`${file.path} 커밋에 포함`} checked={picked.has(file.path)} disabled={!can || busy || running} onChange={() => setPicked(p => toggle(p, file.path))} />
          <code title={MARK_LABEL[file.change]}>{MARK[file.change]}</code>
          <button type="button" className="pc-commit-path" aria-expanded={shown} aria-label={`${file.path} diff ${shown ? "닫기" : "보기"}`} onClick={() => setOpen(o => toggle(o, file.path))}>
            {shown ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<span>{file.path}</span></button>
        </div>
        {file.refused && <small className="pc-muted">{file.refused}</small>}
        {shown && (file.diff ? <Diff text={file.diff} /> : <p className="pc-muted">표시할 diff가 없습니다.</p>)}
        {shown && file.truncated && <small className="pc-muted">diff가 커서 앞부분만 표시합니다.</small>}
      </li>;
    })}</ul>}
    {review?.more && <p className="pc-muted">바뀐 파일이 많아 앞부분만 표시합니다.</p>}
    {!!review?.files.length && <>
      <textarea aria-label="커밋 메시지" placeholder="커밋 메시지 (첫 줄은 요약)" rows={3} value={message} disabled={busy || !!review.blocked} onChange={event => setMessage(event.target.value)} />
      <p className="pc-muted pc-commit-note">고른 {picked.size}개 파일만 지금 본 내용 그대로 커밋합니다. OS 확인 창에서 한 번 더 확인하며, push·병합·되돌리기는 하지 않습니다.</p>
      <button type="button" className="social-button primary compact" disabled={busy || running || !!review.blocked || !picked.size || !!problem} title={problem || undefined} onClick={() => void submit()}>
        {busy ? <LoaderCircle size={13} className="social-spin" /> : <GitCommitHorizontal size={13} />}고른 파일 커밋…</button>
    </>}
  </section>;
}

export function ChangesPanel({ project, thread, refreshKey, onClose }: { project: Project; thread: Thread | null; refreshKey: number; onClose: () => void }) {
  const threadId = thread?.id ?? null;
  const [changes, setChanges] = useState<Changes | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [bump, setBump] = useState(0);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setChanges(await readChanges(project.id, undefined, threadId ?? undefined)); } catch (cause) { setChanges(null); setError(errorText(cause)); } finally { setLoading(false); }
  }, [project.id, threadId]);
  useEffect(() => { void load(); }, [load, refreshKey, bump]);
  const lines = useMemo(() => diffLines(changes?.diff ?? ""), [changes?.diff]);
  const commitable = canCommitIn(thread);
  return <aside className="pc-changes" aria-label="변경 사항">
    <header><strong><FileDiff size={15} />변경 사항</strong>
      <span>{changes?.branch && <><GitBranch size={12} />{changes.branch}</>}</span>
      {commitable && !committing && <button type="button" className="social-button compact" onClick={() => setCommitting(true)}><GitCommitHorizontal size={12} />선택 커밋</button>}
      <button type="button" className="pc-icon" aria-label="변경 사항 새로고침" onClick={() => void load()} disabled={loading}>{loading ? <LoaderCircle size={14} className="social-spin" /> : <RefreshCw size={14} />}</button>
      <button type="button" className="pc-icon" aria-label="변경 사항 닫기" onClick={onClose}><PanelRightClose size={15} /></button>
    </header>
    {changes?.folder && changes.folder !== project.folder && <p className="pc-muted pc-changes-folder" title={changes.folder}>worktree: {changes.folder}</p>}
    {commitable && committing && thread && <CommitBox key={thread.id + ":" + refreshKey} thread={thread} onCommitted={() => setBump(b => b + 1)} onClose={() => setCommitting(false)} />}
    {error && <p className="pc-error" role="alert">{error}</p>}
    {changes && !changes.isRepo && <p className="pc-muted">git 저장소가 아니어서 변경 사항을 보여 줄 수 없습니다.</p>}
    {changes?.isRepo && !changes.files.length && <p className="pc-muted">바뀐 파일이 없습니다.</p>}
    {!committing && !!changes?.files.length && <ul className="pc-files">{changes.files.map(file => <li key={file}><code>{file.slice(0, 2)}</code><span>{file.slice(3)}</span></li>)}</ul>}
    {!committing && !!changes?.diff && <pre className="pc-diff">{lines.map((line, i) => <span key={i} className={line.kind}>{line.text + "\n"}</span>)}</pre>}
    {!committing && changes?.truncated && <p className="pc-muted">diff가 커서 앞부분만 표시합니다.</p>}
  </aside>;
}
