import assert from "node:assert/strict";
import test from "node:test";
import { commandShortcut, createSingleFlight, filterCommands, moveCommandSelection } from "../desktop/src/desktop-interactions";

test("concurrent workspace reads share a request and release it after resolution", async () => {
  const read = createSingleFlight<number>();
  let calls = 0, complete!: (value: number) => void;
  const action = () => { calls += 1; return new Promise<number>(resolve => { complete = resolve; }); };
  const first = read(action), second = read(action);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  complete(7);
  assert.equal(await second, 7);
  assert.equal(await read(async () => 9), 9);
});

test("failed reads are released and a retry does not retain the failed promise", async () => {
  const read = createSingleFlight<string>();
  await assert.rejects(read(async () => { throw new Error("fixture error"); }), /fixture error/);
  assert.equal(await read(async () => "reconnected"), "reconnected");
});

test("a committed write invalidates the old snapshot without its late completion clearing a fresh read", async () => {
  const read = createSingleFlight<string>();
  let oldComplete!: (value: string) => void, newComplete!: (value: string) => void;
  const old = read(() => new Promise(resolve => { oldComplete = resolve; }));
  await Promise.resolve();
  read.invalidate();
  const fresh = read(() => new Promise(resolve => { newComplete = resolve; }));
  await Promise.resolve();
  assert.notEqual(old, fresh);
  oldComplete("before save");
  assert.equal(await old, "before save");
  assert.equal(read(async () => "should not run"), fresh);
  newComplete("after save");
  assert.equal(await fresh, "after save");
});

test("native menu shortcut supports both desktop modifiers and ignores composing/repeat", () => {
  const key = { key: "k", metaKey: false, ctrlKey: true, altKey: false, isComposing: false, repeat: false };
  assert.equal(commandShortcut(key), "open");
  assert.equal(commandShortcut({ ...key, ctrlKey: false, metaKey: true, key: "K" }), "open");
  for (const change of [{ ctrlKey: false }, { isComposing: true }, { repeat: true }, { altKey: true }, { key: "r" }]) assert.equal(commandShortcut({ ...key, ...change }), null);
});

test("menu search combines real screen labels and groups without inventing actions", () => {
  const items = [{ id: "video", label: "영상 제작", group: "제작" }, { id: "settings", label: "연결 설정", group: "채널과 연결" }];
  assert.deepEqual(filterCommands(items, " 영상  제작 "), [items[0]]);
  assert.deepEqual(filterCommands(items, "연결"), [items[1]]);
  assert.deepEqual(filterCommands(items, "없는 화면"), []);
  assert.deepEqual(filterCommands(items, ""), items);
});

test("arrow navigation wraps safely, including an empty filtered result", () => {
  assert.equal(moveCommandSelection(0, -1, 3), 2);
  assert.equal(moveCommandSelection(2, 1, 3), 0);
  assert.equal(moveCommandSelection(0, -1, 0), 0);
});
