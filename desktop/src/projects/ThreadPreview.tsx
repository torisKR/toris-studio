import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, Globe, LoaderCircle, Pencil } from "lucide-react";
import { useState, type FormEvent } from "react";
import { checkPreviewUrl, setThreadPreview, type Thread } from "./project-chat-client";

type Props = { thread: Thread; onSaved: (thread: Thread) => void };

const text = (cause: unknown) => typeof cause === "string" ? cause : cause instanceof Error ? cause.message : "처리하지 못했습니다.";

/**
 * One thread's user-linked local preview address. It is only stored and, on the
 * user's click, opened in the external browser through the host's `open_external`
 * (which re-validates it); it is never loaded in this window, never taken from
 * agent output and never checked against a running server. Mount with
 * `key={thread.id}` so edits never carry over to another thread.
 */
export function ThreadPreview({ thread, onSaved }: Props) {
  const saved = thread.previewUrl;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(saved ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async (value: string) => {
    const checked = checkPreviewUrl(value);
    if (checked.error !== undefined) { setError(checked.error); return; }
    setBusy(true); setError("");
    try {
      const next = await setThreadPreview(thread.id, checked.url ?? "");
      onSaved(next);
      setDraft(next.previewUrl ?? "");
      setEditing(false);
    } catch (cause) { setError(text(cause)); } finally { setBusy(false); }
  };
  const open = () => {
    if (!saved) return;
    setError("");
    void invoke("open_external", { url: saved }).catch((cause: unknown) => setError(typeof cause === "string" ? cause : "미리보기를 열지 못했습니다."));
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void save(draft); };

  return <div className="pc-preview" role="group" aria-label="미리보기 주소">
    <Globe size={13} aria-hidden="true" />
    {editing ? <form className="pc-preview-form" onSubmit={submit}>
      <input value={draft} autoFocus disabled={busy} aria-label="미리보기 주소 입력" placeholder="http://localhost:5173" spellCheck={false} autoComplete="off"
        onChange={event => { setDraft(event.target.value); setError(""); }}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setEditing(false); setDraft(saved ?? ""); setError(""); } }} />
      <button type="submit" className="social-button primary compact" disabled={busy}>{busy && <LoaderCircle size={12} className="social-spin" />}저장</button>
      {saved && <button type="button" className="social-button compact" disabled={busy} onClick={() => void save("")}>지우기</button>}
      <button type="button" className="social-button compact" disabled={busy} onClick={() => { setEditing(false); setDraft(saved ?? ""); setError(""); }}>취소</button>
    </form> : saved ? <>
      <span className="pc-preview-url" title={saved}>{saved}</span>
      <small className="pc-preview-note" title="사용자가 연결한 주소 · 이 대화의 서버인지 확인하지 않음">사용자가 연결한 주소 · 이 대화의 서버인지 확인하지 않음</small>
      <button type="button" className="social-button compact" onClick={open}><ExternalLink size={12} />미리보기 열기</button>
      <button type="button" className="pc-icon" aria-label="미리보기 주소 바꾸기" onClick={() => setEditing(true)}><Pencil size={12} /></button>
    </> : <>
      <small className="pc-preview-note">이 대화의 로컬 미리보기 주소가 없습니다. 서버는 직접 실행하세요.</small>
      <button type="button" className="social-button compact" onClick={() => setEditing(true)}>미리보기 주소 연결</button>
    </>}
    {error && <small className="pc-preview-error" role="alert">{error}</small>}
  </div>;
}
