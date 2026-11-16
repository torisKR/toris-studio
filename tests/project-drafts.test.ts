import assert from "node:assert/strict";
import test from "node:test";
import {
  DRAFT_CORRUPT, DRAFT_FULL, DRAFT_TOO_LONG, DRAFT_UNAVAILABLE, DRAFT_WRITE_FAILED, DRAFTS_STORAGE_KEY, DraftStore, MAX_DRAFT_BYTES, MAX_DRAFTS_BYTES,
  draftSlot, joinDraft, type DraftStorage
} from "../desktop/src/projects/project-drafts";

class Memory implements DraftStorage {
  data = new Map<string, string>();
  failWrites = false;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrites) throw new Error("QuotaExceededError"); this.data.set(key, value); }
  removeItem(key: string) { if (this.failWrites) throw new Error("denied"); this.data.delete(key); }
}
const a = draftSlot("p1", "t-a"), b = draftSlot("p1", "t-b"), fresh = draftSlot("p1", null), other = draftSlot("p2", null);
let now = 0;
const clock = () => ++now;

test("drafts are keyed by project and thread, with a separate key for each project's new conversation", () => {
  assert.notEqual(draftSlot("p1", null), draftSlot("p2", null));
  assert.notEqual(draftSlot("p1", "t"), draftSlot("p2", "t"), "the same thread ID in two projects does not share a draft");
  assert.notEqual(draftSlot("p1", "t"), draftSlot("p1", null));
  assert.notEqual(draftSlot("p", "1/t"), draftSlot("p/1", "t"), "no separator collisions");
  const store = new DraftStore(new Memory(), clock);
  store.set(a, "A"); store.set(b, "B"); store.set(fresh, "N"); store.set(other, "O");
  assert.deepEqual([store.get(a), store.get(b), store.get(fresh), store.get(other)], ["A", "B", "N", "O"]);
  assert.equal(store.get(draftSlot("p1", "t-z")), "");
});

test("a reopened store restores every draft with only its text", () => {
  const disk = new Memory();
  const first = new DraftStore(disk, clock);
  assert.equal(first.set(a, "A 초안\n둘째 줄"), null);
  first.set(fresh, "새 대화");
  const reopened = new DraftStore(disk, clock);
  assert.equal(reopened.get(a), "A 초안\n둘째 줄");
  assert.equal(reopened.get(fresh), "새 대화");
  assert.equal(reopened.loadNote, null);
  const raw = JSON.parse(disk.getItem(DRAFTS_STORAGE_KEY)!);
  assert.equal(raw.v, 1);
  for (const entry of Object.values(raw.drafts)) assert.deepEqual(Object.keys(entry as object).sort(), ["at", "text"]);
  first.set(a, ""); first.set(fresh, "");
  assert.equal(disk.getItem(DRAFTS_STORAGE_KEY), null, "no drafts, no entry");
});

test("a successful send clears only the text it sent; text typed meanwhile and other drafts stay; failures keep it", () => {
  const disk = new Memory();
  const store = new DraftStore(disk, clock);
  store.set(a, "보낼 내용"); store.set(b, "B 초안");
  // Failed or cancelled send: nothing is cleared (the caller simply does not call clearSent).
  assert.equal(store.get(a), "보낼 내용");
  // The user typed more while sending: the late success leaves the new text.
  store.set(a, "보낼 내용 그리고 더");
  assert.equal(store.clearSent(a, "보낼 내용"), false);
  assert.equal(store.get(a), "보낼 내용 그리고 더");
  // Unchanged since sending: cleared, on disk too; B untouched.
  assert.equal(store.clearSent(a, "보낼 내용 그리고 더"), true);
  const reopened = new DraftStore(disk, clock);
  assert.equal(reopened.get(a), "");
  assert.equal(reopened.get(b), "B 초안");
});

test("the new conversation's draft moves to the thread created by sending it", () => {
  const disk = new Memory();
  const store = new DraftStore(disk, clock);
  store.set(fresh, "첫 메시지");
  store.move(fresh, a);
  assert.equal(store.get(fresh), "");
  assert.equal(new DraftStore(disk, clock).get(a), "첫 메시지");
});

test("a planner prompt is added after an existing draft, never over it", () => {
  assert.equal(joinDraft("", "구현해줘"), "구현해줘");
  assert.equal(joinDraft("  \n", "구현해줘"), "구현해줘");
  assert.equal(joinDraft("내 메모\n", "구현해줘"), "내 메모\n\n구현해줘");
  assert.equal(joinDraft("내 메모\n\n구현해줘", "구현해줘"), "내 메모\n\n구현해줘", "the same plan twice is not duplicated");
});

test("broken or unavailable storage warns and never loses what is typed", () => {
  const broken = new Memory();
  broken.data.set(DRAFTS_STORAGE_KEY, "{not json");
  const store = new DraftStore(broken, clock);
  assert.equal(store.loadNote, DRAFT_CORRUPT);
  assert.equal(store.get(a), "");
  assert.equal(store.set(a, "새로 입력"), null, "the next draft replaces the broken value");
  assert.equal(store.note(a), null);
  assert.equal(new DraftStore(broken, clock).get(a), "새로 입력");

  for (const shape of ['{"v":2,"drafts":{}}', '{"v":1,"drafts":[]}', "null", '"x"']) {
    const disk = new Memory(); disk.data.set(DRAFTS_STORAGE_KEY, shape);
    assert.equal(new DraftStore(disk, clock).loadNote, DRAFT_CORRUPT, shape);
  }
  // Bad entries are skipped, good ones kept.
  const mixed = new Memory();
  mixed.data.set(DRAFTS_STORAGE_KEY, JSON.stringify({ v: 1, drafts: { [a]: { text: "ok", at: 1 }, "not-a-slot": { text: "x", at: 1 }, [b]: { text: 5, at: 1 } } }));
  const kept = new DraftStore(mixed, clock);
  assert.equal(kept.get(a), "ok"); assert.equal(kept.get(b), ""); assert.equal(kept.loadNote, null);

  const none = new DraftStore(null, clock);
  assert.equal(none.loadNote, DRAFT_UNAVAILABLE);
  assert.equal(none.set(a, "남아요"), DRAFT_UNAVAILABLE);
  assert.equal(none.get(a), "남아요");

  const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() {}, removeItem() {} };
  assert.equal(new DraftStore(throwing, clock).loadNote, DRAFT_UNAVAILABLE);

  const full = new Memory();
  const s = new DraftStore(full, clock);
  s.set(b, "저장됨");
  full.failWrites = true;
  assert.equal(s.set(a, "저장 안 됨"), DRAFT_WRITE_FAILED);
  assert.equal(s.get(a), "저장 안 됨", "the typed text stays in the session");
  assert.equal(s.note(a), DRAFT_WRITE_FAILED);
  full.failWrites = false;
  assert.equal(s.set(a, "저장 안 됨!"), null, "the warning clears once a write works");
  assert.equal(new DraftStore(full, clock).get(b), "저장됨", "a failed write never dropped the other drafts");
});

test("drafts stay within the send limit and a total cap; over it the text stays on screen only", () => {
  const disk = new Memory();
  const store = new DraftStore(disk, clock);
  const long = "가".repeat(Math.floor(MAX_DRAFT_BYTES / 3) + 1); // 3 UTF-8 bytes each: just over the limit
  store.set(a, "짧은 초안");
  assert.equal(store.set(a, long), DRAFT_TOO_LONG);
  assert.equal(store.get(a), long);
  assert.equal(new DraftStore(disk, clock).get(a), "", "an over-limit draft is not saved (nor its older copy)");
  const exact = "a".repeat(MAX_DRAFT_BYTES);
  assert.equal(store.set(a, exact), null, "exactly the limit is saved");

  const capped = new Memory();
  const many = new DraftStore(capped, clock);
  const chunk = "x".repeat(MAX_DRAFT_BYTES);
  const slots = Array.from({ length: MAX_DRAFTS_BYTES / MAX_DRAFT_BYTES }, (_, i) => draftSlot("p", "t" + i));
  for (const slot of slots) assert.equal(many.set(slot, chunk), null);
  const extra = draftSlot("p", "extra");
  assert.equal(many.set(extra, "y"), DRAFT_FULL);
  assert.equal(many.get(extra), "y");
  const reopened = new DraftStore(capped, clock);
  assert.equal(reopened.get(extra), "");
  for (const slot of slots) assert.equal(reopened.get(slot), chunk, "earlier drafts are not evicted");

  // A stored set that is somehow over the cap keeps the newest drafts.
  const oversized = new Memory();
  const drafts = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [draftSlot("p", "o" + i), { text: chunk, at: i }]));
  oversized.data.set(DRAFTS_STORAGE_KEY, JSON.stringify({ v: 1, drafts }));
  const trimmed = new DraftStore(oversized, clock);
  assert.equal(trimmed.get(draftSlot("p", "o9")), chunk);
  assert.equal(trimmed.get(draftSlot("p", "o0")), "");
});

test("deleting a conversation or project clears only its drafts", () => {
  const disk = new Memory();
  const store = new DraftStore(disk, clock);
  store.set(a, "A"); store.set(b, "B"); store.set(fresh, "N"); store.set(other, "O"); store.set(draftSlot("p2", "t-a"), "same id, other project");
  store.removeThread("p1", "t-a");
  assert.equal(store.get(a), ""); assert.equal(store.get(b), "B");
  assert.equal(store.get(draftSlot("p2", "t-a")), "same id, other project");
  store.removeProject("p1");
  const reopened = new DraftStore(disk, clock);
  assert.deepEqual([reopened.get(b), reopened.get(fresh)], ["", ""]);
  assert.equal(reopened.get(other), "O");
  assert.equal(reopened.get(draftSlot("p2", "t-a")), "same id, other project");
});
