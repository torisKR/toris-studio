import { CalendarClock, CalendarDays, Check, CircleAlert, LoaderCircle, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { WORK_LABELS, byDay, deleteEvent, isoToLocalInput, loadToday, localInputToIso, overdue, saveEvent, saveWorkItem, syncCalendar, syncSummary, type EventDraft, type PlannerEvent, type PlannerToday, type WorkItem } from "./planner-client";
import "./PlannerPanel.css";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const dayLabel = (key: string) => new Date(`${key}T00:00`).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });

function blankDraft(): EventDraft {
  const start = new Date(); start.setMinutes(0, 0, 0); start.setHours(start.getHours() + 1);
  return { title: "", notes: "", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600_000).toISOString(), allDay: false };
}

/** Today, the week ahead, open work and the Google Calendar link in one place. */
export function PlannerPanel({ active, databaseConnected, onOpenOAuth, onOpenPublications }: { active: boolean; databaseConnected: boolean; onOpenOAuth: () => void; onOpenPublications: () => void }) {
  const [data, setData] = useState<PlannerToday | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"sync" | "save" | "work" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<EventDraft | null>(null);
  const [workTitle, setWorkTitle] = useState("");
  const [workDue, setWorkDue] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);

  const refresh = useCallback(async () => {
    if (!databaseConnected) return;
    setLoading(true); setError("");
    const from = new Date(); from.setHours(0, 0, 0, 0);
    try { setData(await loadToday(from, new Date(from.getTime() + 8 * 86400_000))); }
    catch (e) { setError(message(e)); }
    finally { setLoading(false); }
  }, [databaseConnected]);

  useEffect(() => { if (active) void refresh(); }, [active, refresh]);
  useEffect(() => { const node = dialog.current; if (!node) return; if (draft && !node.open) node.showModal(); if (!draft && node.open) node.close(); }, [draft]);

  async function sync() {
    setBusy("sync"); setError(""); setNotice("");
    try { setNotice(syncSummary(await syncCalendar())); await refresh(); }
    catch (e) { setError(message(e)); }
    finally { setBusy(null); }
  }

  async function submitEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setBusy("save"); setError("");
    try { await saveEvent(draft); setDraft(null); setNotice("일정을 저장했습니다. 다음 동기화 때 Google Calendar에 반영됩니다."); await refresh(); }
    catch (e) { setError(message(e)); }
    finally { setBusy(null); }
  }

  async function removeEvent(item: PlannerEvent) {
    setError("");
    try { await deleteEvent(item.id); setNotice("일정을 삭제했습니다. 다음 동기화 때 Google에서도 지웁니다."); await refresh(); }
    catch (e) { setError(message(e)); }
  }

  async function addWork(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = workTitle.trim();
    if (!title) return;
    setBusy("work"); setError("");
    try { await saveWorkItem({ title, dueAt: workDue ? localInputToIso(workDue) : null }); setWorkTitle(""); setWorkDue(""); await refresh(); }
    catch (e) { setError(message(e)); }
    finally { setBusy(null); }
  }

  async function setStatus(item: WorkItem, status: WorkItem["status"]) {
    setError("");
    try { await saveWorkItem({ ...item, status }); await refresh(); }
    catch (e) { setError(message(e)); }
  }

  if (!active) return null;
  if (!databaseConnected) return <div className="social-notice info"><CircleAlert size={18} /><span>일정·작업은 로컬 DB에 저장됩니다. 연결 설정에서 DB를 먼저 연결하세요.</span></div>;
  const late = data ? overdue(data.work, new Date()) : [];
  return <section className="planner" aria-label="일정과 작업">
    <div className="planner-bar">
      <span className={`planner-calendar ${data?.calendar.linked ? "linked" : ""}`}><CalendarDays size={15} aria-hidden="true" />{data?.calendar.linked ? `Google Calendar 연결됨${data.calendar.lastSyncedAt ? ` · ${new Date(data.calendar.lastSyncedAt).toLocaleString("ko-KR")} 동기화` : ""}` : "Google Calendar 미연결"}</span>
      {data?.calendar.lastError && <span className="planner-warn" role="status">{data.calendar.lastError}</span>}
      {data && data.openConflicts > 0 && <span className="planner-warn" role="status">확인할 동기화 충돌 {data.openConflicts}건</span>}
      <div className="planner-actions">
        <button className="social-button compact" onClick={onOpenOAuth}><CalendarDays size={14} />캘린더 연결 설정</button>
        <button className="social-button compact" disabled={!!busy} onClick={() => void sync()}>{busy === "sync" ? <LoaderCircle size={14} className="social-spin" /> : <RefreshCw size={14} />}지금 동기화</button>
        <button className="social-button primary compact" disabled={!!busy} onClick={() => setDraft(blankDraft())}><Plus size={14} />일정 추가</button>
      </div>
    </div>
    {error && <div className="social-notice error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
    {notice && <div className="social-notice success" role="status"><Check size={17} /><span>{notice}</span><button className="social-dismiss" aria-label="알림 닫기" onClick={() => setNotice("")}><X size={15} /></button></div>}
    <div className="planner-grid">
      <section className="planner-card" aria-label="다가오는 일정">
        <h2>다가오는 8일</h2>
        {loading && !data ? <p className="planner-empty"><LoaderCircle size={15} className="social-spin" />불러오는 중</p> : data && data.events.length ? byDay(data.events).map(([day, items]) => <div key={day} className="planner-day"><h3>{dayLabel(day)}</h3><ul>{items.map(item => <li key={item.id} data-owned={item.studioOwned || undefined}>
          <time>{item.allDay ? "종일" : timeLabel(item.startsAt)}</time><span className="planner-title">{item.title}</span>
          {item.studioOwned ? <button className="social-button compact subtle" onClick={onOpenPublications} title="게시 예약은 SNS 일괄 게시에서 바꿉니다"><CalendarClock size={13} />게시 예약</button>
            : <><button className="social-button compact subtle" onClick={() => setDraft({ id: item.id, title: item.title, notes: item.notes, startsAt: item.startsAt, endsAt: item.endsAt, allDay: item.allDay })}>편집</button><button className="social-button compact subtle icon-only" aria-label={`${item.title} 삭제`} onClick={() => void removeEvent(item)}><Trash2 size={13} /></button></>}
          {!item.synced && <small className="planner-pending">동기화 대기</small>}
        </li>)}</ul></div>) : <p className="planner-empty">일정이 없습니다. 게시 예약은 자동으로 여기에 표시됩니다.</p>}
      </section>
      <section className="planner-card" aria-label="작업">
        <h2>작업 {late.length > 0 && <span className="planner-late">마감 지남 {late.length}</span>}</h2>
        <form className="planner-work-form" onSubmit={event => void addWork(event)}><label className="social-sr-only" htmlFor="planner-work-title">새 작업</label><input id="planner-work-title" value={workTitle} maxLength={300} placeholder="새 작업 (예: 스토어 스크린샷 교체)" onChange={event => setWorkTitle(event.target.value)} /><label className="social-sr-only" htmlFor="planner-work-due">마감</label><input id="planner-work-due" type="datetime-local" value={workDue} onChange={event => setWorkDue(event.target.value)} /><button className="social-button compact" disabled={!workTitle.trim() || busy === "work"}><Plus size={14} />추가</button></form>
        <ul className="planner-work">{data?.work.map(item => <li key={item.id} data-late={late.includes(item) || undefined}>
          <span className="planner-title">{item.title}</span>{item.dueAt && <time>{new Date(item.dueAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>}
          {item.source !== "manual" && <small>{item.source === "ops" ? "운영 경고" : "에이전트"}</small>}
          <label className="social-sr-only" htmlFor={`work-${item.id}`}>{item.title} 상태</label><select id={`work-${item.id}`} value={item.status} onChange={event => void setStatus(item, event.target.value as WorkItem["status"])}>{Object.entries(WORK_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        </li>)}</ul>
        {data && !data.work.length && <p className="planner-empty">열린 작업이 없습니다.</p>}
      </section>
    </div>
    <dialog ref={dialog} className="social-dialog" aria-labelledby="planner-event-title" onClose={() => setDraft(null)}>
      {draft && <form onSubmit={event => void submitEvent(event)}>
        <div className="social-dialog-header"><div><h2 id="planner-event-title">{draft.id ? "일정 편집" : "일정 추가"}</h2><p>Studio 전용 Google 캘린더와 동기화됩니다.</p></div><button type="button" className="social-dismiss" aria-label="닫기" onClick={() => setDraft(null)}><X size={20} /></button></div>
        <label>제목<input required maxLength={300} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <div className="planner-times"><label>시작<input type="datetime-local" required value={isoToLocalInput(draft.startsAt)} onChange={event => { const iso = localInputToIso(event.target.value); if (iso) setDraft({ ...draft, startsAt: iso }); }} /></label><label>끝<input type="datetime-local" required value={isoToLocalInput(draft.endsAt)} onChange={event => { const iso = localInputToIso(event.target.value); if (iso) setDraft({ ...draft, endsAt: iso }); }} /></label></div>
        <label className="planner-check"><input type="checkbox" checked={draft.allDay} onChange={event => setDraft({ ...draft, allDay: event.target.checked })} />종일</label>
        <label>메모<textarea rows={3} maxLength={8000} value={draft.notes} onChange={event => setDraft({ ...draft, notes: event.target.value })} /></label>
        <div className="social-dialog-actions"><button type="button" className="social-button" onClick={() => setDraft(null)}>취소</button><button className="social-button primary" disabled={busy === "save" || !draft.title.trim()}>{busy === "save" ? <LoaderCircle size={15} className="social-spin" /> : <Check size={15} />}저장</button></div>
      </form>}
    </dialog>
  </section>;
}
