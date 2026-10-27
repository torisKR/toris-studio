import { nativeInvoke, type BridgeInvoke } from "./ai-client";

export type PlannerEvent = { id: string; title: string; notes: string; startsAt: string; endsAt: string; allDay: boolean; link: "none" | "work_item" | "publication_job"; linkId: string | null; synced: boolean; studioOwned: boolean };
export type WorkItem = { id: string; title: string; notes: string; status: "todo" | "doing" | "done" | "dropped"; dueAt: string | null; productId: string | null; source: string; updatedAt: string };
export type CalendarLink = { linked: boolean; lastSyncedAt: string | null; lastError: string | null };
export type PlannerToday = { events: PlannerEvent[]; work: WorkItem[]; openConflicts: number; calendar: CalendarLink };
export type SyncReport = { pushed: number; pulled: number; imported: number; conflicts: number; reverted: number; deleted: number; fullResync: boolean };
export type EventDraft = { id?: string; title: string; notes: string; startsAt: string; endsAt: string; allDay: boolean };

export const WORK_LABELS: Record<WorkItem["status"], string> = { todo: "할 일", doing: "진행 중", done: "완료", dropped: "보류" };

export function loadToday(from: Date, to: Date, call: BridgeInvoke = nativeInvoke): Promise<PlannerToday> {
  return call("planner_today", { input: { from: from.toISOString(), to: to.toISOString() } }) as Promise<PlannerToday>;
}
export function saveEvent(draft: EventDraft, call: BridgeInvoke = nativeInvoke): Promise<PlannerEvent> {
  return call("planner_save_event", { input: draft }) as Promise<PlannerEvent>;
}
export function deleteEvent(id: string, call: BridgeInvoke = nativeInvoke): Promise<void> {
  return call("planner_delete_event", { id }) as Promise<void>;
}
export function saveWorkItem(item: Partial<WorkItem> & { title: string }, call: BridgeInvoke = nativeInvoke): Promise<WorkItem> {
  const { id, title, notes, status, dueAt } = item;
  return call("planner_save_work_item", { input: { ...(id ? { id } : {}), title, notes: notes ?? "", status: status ?? "todo", dueAt: dueAt ?? null } }) as Promise<WorkItem>;
}
export function syncCalendar(call: BridgeInvoke = nativeInvoke): Promise<SyncReport> {
  return call("planner_sync_calendar") as Promise<SyncReport>;
}

/** "YYYY-MM-DDTHH:mm" from a datetime-local input, read as local time, to an ISO instant. */
export function localInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Groups events by local day key (YYYY-MM-DD), in start order. */
export function byDay(events: readonly PlannerEvent[]): Array<[string, PlannerEvent[]]> {
  const groups = new Map<string, PlannerEvent[]>();
  for (const event of [...events].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
    const key = isoToLocalInput(event.startsAt).slice(0, 10);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.entries()];
}

/** Work due before `now` and still open. */
export function overdue(work: readonly WorkItem[], now: Date): WorkItem[] {
  return work.filter(item => (item.status === "todo" || item.status === "doing") && item.dueAt !== null && new Date(item.dueAt) < now);
}

export function syncSummary(report: SyncReport): string {
  const parts = [
    report.pushed && `${report.pushed}건 보냄`, report.pulled && `${report.pulled}건 받음`, report.imported && `${report.imported}건 새로 가져옴`,
    report.deleted && `${report.deleted}건 삭제`, report.conflicts && `충돌 ${report.conflicts}건(최신 쪽 적용)`, report.reverted && `게시 예약 ${report.reverted}건 되돌림`,
  ].filter(Boolean);
  return (report.fullResync ? "전체 다시 동기화 · " : "") + (parts.length ? parts.join(" · ") : "바뀐 일정이 없습니다");
}
