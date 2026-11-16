import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, Copy, FileWarning, Trash2 } from "lucide-react";
import { useState } from "react";
import type { StoredDraft } from "./project-drafts";
import "./DraftRecovery.css";

const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
const when = (at: number) => { try { return new Date(at).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }); } catch { return ""; } };

export const COPIED_NOTE = "복사했습니다. 붙여넣을 프로젝트·대화와 받는 쪽을 직접 고른 뒤 보내세요. 복사만으로는 아무것도 보내지지 않습니다.";
export const DISCARD_CONFIRM = "이 기기에 저장된 이 초안만 지웁니다. 프로젝트 폴더·worktree·대화 기록은 그대로입니다. 지울까요?";

/** Copies a draft with the host's clipboard command (same limit as elsewhere). Never sends. */
export const copyDraft = (text: string) => invoke("copy_text", { text });

type Props = {
  /** Drafts whose conversation is not in the list shown now. */
  drafts: StoredDraft[];
  /** Project names the host listed; a draft of a project not listed shows its ID only. */
  projectName: (projectId: string) => string | null;
  /** Removes only this draft on this device; returns a note when the device refused. */
  onDiscard: (slot: string) => string | null;
};

/**
 * Drafts kept on this device for conversations the current list does not show. Not finding a
 * conversation does not mean it was deleted, so nothing here is removed unless the user asks.
 * The text is shown only when the user opens it, as plain text.
 */
export function DraftRecovery({ drafts, projectName, onDiscard }: Props) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [note, setNote] = useState<{ slot: string; text: string } | null>(null);
  if (!drafts.length) return null;
  const copy = (d: StoredDraft) => void copyDraft(d.text).then(() => setNote({ slot: d.slot, text: COPIED_NOTE })).catch(cause => setNote({ slot: d.slot, text: errorText(cause) }));
  const discard = (d: StoredDraft) => {
    if (!window.confirm(DISCARD_CONFIRM)) return;
    const refused = onDiscard(d.slot);
    setNote(refused ? { slot: d.slot, text: refused } : null);
  };
  return <section className="pc-recovery" aria-label="찾을 수 없는 대화의 초안">
    <button type="button" className="pc-recovery-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<FileWarning size={13} />찾을 수 없는 대화의 초안 {drafts.length}개
    </button>
    {open && <>
      <p className="pc-recovery-help">지금 목록에 없는 대화의 초안입니다. 삭제됐는지는 확인할 수 없어 그대로 둡니다. 복사해 원하는 대화에 붙여넣고 직접 보내세요.</p>
      <ul>{drafts.map(d => {
        const name = projectName(d.projectId);
        return <li key={d.slot}>
          <div className="pc-recovery-meta">
            <strong>{name ?? "확인되지 않은 프로젝트"}</strong>
            <small>{d.threadId ? "찾을 수 없는 대화" : "새 대화"} · {when(d.at)}{name ? "" : ` · ID ${d.projectId}`}</small>
          </div>
          <div className="pc-recovery-actions">
            <button type="button" className="social-button compact" aria-expanded={shown === d.slot} onClick={() => setShown(s => s === d.slot ? null : d.slot)}>{shown === d.slot ? "내용 숨기기" : "내용 보기"}</button>
            <button type="button" className="social-button compact" onClick={() => copy(d)}><Copy size={12} />복사</button>
            <button type="button" className="social-button compact" onClick={() => discard(d)}><Trash2 size={12} />이 기기에서 지우기</button>
          </div>
          {shown === d.slot && <pre className="pc-recovery-text">{d.text}</pre>}
          {note?.slot === d.slot && <p className="pc-recovery-note" role="status">{note.text}</p>}
        </li>;
      })}</ul>
    </>}
  </section>;
}
