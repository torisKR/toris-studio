import assert from "node:assert/strict";
import test from "node:test";
import { byDay, isoToLocalInput, loadToday, localInputToIso, overdue, saveWorkItem, syncSummary, type PlannerEvent, type WorkItem } from "../desktop/src/planner-client";

const event = (id: string, startsAt: string): PlannerEvent => ({ id, title: id, notes: "", startsAt, endsAt: startsAt, allDay: false, link: "none", linkId: null, synced: false, studioOwned: false });

test("local input round-trips and rejects partial values", () => {
  const iso = localInputToIso("2026-10-27T09:30");
  assert.ok(iso);
  assert.equal(isoToLocalInput(iso!), "2026-10-27T09:30");
  for (const bad of ["2026-10-27", "2026-10-27 09:30", "", "2026-13-40T99:99"]) assert.equal(localInputToIso(bad), null, bad);
});

test("events group by local day in start order", () => {
  const a = localInputToIso("2026-10-28T09:00")!, b = localInputToIso("2026-10-27T18:00")!, c = localInputToIso("2026-10-27T08:00")!;
  const groups = byDay([event("a", a), event("b", b), event("c", c)]);
  assert.deepEqual(groups.map(([day, items]) => [day, items.map(item => item.id)]), [["2026-10-27", ["c", "b"]], ["2026-10-28", ["a"]]]);
});

test("overdue lists only open work past its due time", () => {
  const work = (id: string, status: WorkItem["status"], dueAt: string | null): WorkItem => ({ id, title: id, notes: "", status, dueAt, productId: null, source: "manual", updatedAt: "" });
  const now = new Date("2026-10-27T12:00:00Z");
  const items = [work("late", "todo", "2026-10-27T09:00:00Z"), work("doing-late", "doing", "2026-10-26T09:00:00Z"), work("done-late", "done", "2026-10-26T09:00:00Z"), work("later", "todo", "2026-10-28T09:00:00Z"), work("no-due", "todo", null)];
  assert.deepEqual(overdue(items, now).map(item => item.id), ["late", "doing-late"]);
});

test("planner calls send only the allowed fields", async () => {
  const calls: Array<[string, unknown]> = [];
  const call = async (command: string, args?: Record<string, unknown>) => { calls.push([command, args]); return {}; };
  await saveWorkItem({ title: "검토", source: "forged", productId: "x" } as never, call);
  assert.deepEqual(calls[0], ["planner_save_work_item", { input: { title: "검토", notes: "", status: "todo", dueAt: null } }], "source and productId never come from the form");
  await loadToday(new Date("2026-10-27T00:00:00Z"), new Date("2026-10-28T00:00:00Z"), call);
  assert.deepEqual(calls[1], ["planner_today", { input: { from: "2026-10-27T00:00:00.000Z", to: "2026-10-28T00:00:00.000Z" } }]);
});

test("sync summaries name what moved and say when nothing did", () => {
  const none = { pushed: 0, pulled: 0, imported: 0, conflicts: 0, reverted: 0, deleted: 0, fullResync: false };
  assert.equal(syncSummary(none), "바뀐 일정이 없습니다");
  assert.equal(syncSummary({ ...none, pushed: 2, reverted: 1, fullResync: true }), "전체 다시 동기화 · 2건 보냄 · 게시 예약 1건 되돌림");
});
