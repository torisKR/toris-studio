import assert from "node:assert/strict";
import test from "node:test";
import type { ChatItem } from "../desktop/src/projects/project-chat-client";
import {
  addItems, applySnapshot, EMPTY_TRANSCRIPT, failureText, itemsFor, LatestRequest, viewKey, ViewTracker, type Transcript
} from "../desktop/src/projects/project-view-state";

const item = (id: string, text = id): ChatItem => ({ id, kind: "assistant", text, at: "2026-11-14T03:00:00.000Z" });
const ids = (items: ChatItem[]) => items.map(i => i.id);

test("a screen key is its thread, or its project's new conversation", () => {
  assert.equal(viewKey({ projectId: "p", threadId: "t1" }), "t1");
  assert.equal(viewKey({ projectId: "p", threadId: null }), "new:p");
  assert.equal(viewKey({ projectId: null, threadId: null }), "new:");
});

test("a ticket is fresh until its screen is left; leaving and coming back is a new generation", () => {
  const view = new ViewTracker({ projectId: "p", threadId: "a" });
  const first = view.ticket();
  view.show({ projectId: "p", threadId: "a" }); // re-render of the same screen
  assert.equal(view.fresh(first), true);
  view.show({ projectId: "p", threadId: "b" });
  assert.equal(view.fresh(first), false);
  assert.equal(view.showing(first), false);
  view.show({ projectId: "p", threadId: "a" }); // A→B→A
  const second = view.ticket();
  assert.equal(view.fresh(first), false, "A's earlier read must not replace the newer A read");
  assert.equal(view.showing(first), true, "but A is shown again, so A's own items still merge");
  assert.equal(view.fresh(second), true);
  assert.equal(view.showing("a"), true);
  assert.equal(view.showing("b"), false);
});

test("a project's new conversation and a thread are different screens", () => {
  const view = new ViewTracker({ projectId: "p", threadId: null });
  const draft = view.ticket();
  view.show({ projectId: "q", threadId: null });
  assert.equal(view.fresh(draft), false);
  view.show({ projectId: "p", threadId: "t" });
  assert.equal(view.key, "t");
});

test("a live item that beats the initial read survives the older snapshot, once", () => {
  let t: Transcript = EMPTY_TRANSCRIPT;
  t = addItems(t, "a", "a", [item("live")]);
  t = applySnapshot(t, "a", "a", [item("s1"), item("s2")]);
  assert.deepEqual(ids(itemsFor(t, "a")), ["s1", "s2", "live"]);
  // The next snapshot already holds the live item: stored order wins, no duplicate.
  t = applySnapshot(t, "a", "a", [item("s1"), item("live", "stored copy"), item("s2")]);
  assert.deepEqual(ids(itemsFor(t, "a")), ["s1", "live", "s2"]);
  assert.equal(itemsFor(t, "a")[1].text, "stored copy");
});

test("repeated and overlapping items are merged by ID", () => {
  let t = addItems(EMPTY_TRANSCRIPT, "a", "a", [item("1"), item("2")]);
  const same = addItems(t, "a", "a", [item("1"), item("2")]);
  assert.equal(same, t, "nothing new keeps the same state");
  t = addItems(t, "a", "a", [item("2"), item("3"), item("3")]);
  assert.deepEqual(ids(itemsFor(t, "a")), ["1", "2", "3"]);
});

test("items, snapshots and late send results of another thread never land on the shown one", () => {
  let t = addItems(EMPTY_TRANSCRIPT, "b", "b", [item("b1")]);
  const before = t;
  t = addItems(t, "b", "a", [item("a-late")]); // A's send answered while B is shown
  t = applySnapshot(t, "b", "a", [item("a-old")]); // A's read answered while B is shown
  assert.equal(t, before);
  assert.deepEqual(ids(itemsFor(t, "b")), ["b1"]);
  assert.equal(addItems(t, null, "a", [item("x")]), t, "a project's new conversation shows no thread's items");
});

test("after a switch the previous thread's rows are hidden, and the new thread starts clean", () => {
  let t = addItems(EMPTY_TRANSCRIPT, "a", "a", [item("a1")]);
  assert.deepEqual(itemsFor(t, "b"), [], "B never shows A's rows while its own read is on the way");
  t = addItems(t, "b", "b", [item("b-live")]); // B's event before B's read
  assert.deepEqual(ids(itemsFor(t, "b")), ["b-live"]);
  t = applySnapshot(t, "b", "b", [item("b1")]);
  assert.deepEqual(ids(itemsFor(t, "b")), ["b1", "b-live"]);
  assert.deepEqual(itemsFor(t, "a"), []);
});

test("A→B→A: only the fresh read of A is applied", () => {
  const view = new ViewTracker({ projectId: "p", threadId: "a" });
  let t: Transcript = EMPTY_TRANSCRIPT;
  const oldRead = view.ticket();
  view.show({ projectId: "p", threadId: "b" });
  view.show({ projectId: "p", threadId: "a" });
  const newRead = view.ticket();
  const apply = (ticket: typeof oldRead, stored: ChatItem[]) => { if (view.fresh(ticket)) t = applySnapshot(t, "a", "a", stored); };
  apply(newRead, [item("new")]);
  apply(oldRead, [item("old")]); // answers last
  assert.deepEqual(ids(itemsFor(t, "a")), ["new"]);
});

test("an error shows only on the screen whose work failed", () => {
  const failure = { key: "a", text: "A의 전송이 실패했습니다." };
  assert.equal(failureText(failure, "b"), "");
  assert.equal(failureText(failure, "a"), "A의 전송이 실패했습니다.");
  assert.equal(failureText(null, "a"), "");
});

test("only the latest request's answer may be shown", () => {
  const latest = new LatestRequest();
  const a = latest.begin();
  const b = latest.begin();
  assert.equal(latest.isLatest(a), false, "A's diff answering after B's is dropped");
  assert.equal(latest.isLatest(b), true);
});
