import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeInvoke } from "../desktop/src/ai-client";
import {
  addProject, askPeer, diffLines, implementationPrompt, listProjects, mergeItems, normalizeEvent, normalizeItem, readThread, sendMessage, toRows, type ChatItem
} from "../desktop/src/projects/project-chat-client";

const item = (id: string, kind: ChatItem["kind"], extra: Partial<ChatItem> = {}): ChatItem => ({ id, kind, text: id, at: "2026-11-14T00:00:00Z", ...extra });
const recorder = (reply: unknown) => {
  const calls: Array<[string, unknown]> = [];
  const call: BridgeInvoke = async (command, args) => { calls.push([command, args]); return reply; };
  return { calls, call };
};

test("project and thread lists drop rows the host could not describe and sort newest first", async () => {
  const { call } = recorder({
    projects: [{ id: "p1", name: "app", folder: "/Users/me/app", addedAt: "x" }, { id: "", folder: "/x" }, null],
    threads: [
      { id: "t1", projectId: "p1", title: "old", agent: "claude", mode: "edit", updatedAt: "2026-01-01", createdAt: "", running: false },
      { id: "t2", projectId: "p1", title: "new", agent: "codex", mode: "plan", updatedAt: "2026-02-01", createdAt: "", running: true },
      { id: "t3", projectId: "p1", agent: "gpt", mode: "edit" },
      { id: "t4", projectId: "p1", agent: "claude", mode: "full" }
    ]
  });
  const data = await listProjects(call);
  assert.deepEqual(data.projects.map(p => p.id), ["p1"]);
  assert.deepEqual(data.threads.map(t => t.id), ["t2", "t1"]);
  assert.equal(data.threads[0].running, true);
});

test("adding a project sends only the typed path, and a cancelled confirmation adds nothing", async () => {
  const added = recorder({ cancelled: false, project: { id: "p1", name: "app", folder: "/Users/me/app" } });
  assert.equal((await addProject(" ~/app ", added.call))?.id, "p1");
  assert.deepEqual(added.calls, [["project_chat_add_project", { input: { path: "~/app" } }]]);
  const picked = recorder({ cancelled: true });
  assert.equal(await addProject(null, picked.call), null);
  assert.deepEqual(picked.calls, [["project_chat_add_project", { input: {} }]], "no path: the host opens the folder dialog");
  await assert.rejects(addProject("relative/app", added.call));
  await assert.rejects(addProject("  ", added.call));
});

test("sending and asking a planner reject empty text before calling the host", async () => {
  const { calls, call } = recorder(null);
  await assert.rejects(sendMessage("t1", "   ", call));
  await assert.rejects(askPeer("t1", "", "기획해줘", call));
  await assert.rejects(askPeer("t1", "muse@mac", " ", call));
  assert.equal(calls.length, 0);
  const sent = recorder({ id: "t1", projectId: "p1", agent: "claude", mode: "edit", running: true });
  assert.equal((await sendMessage("t1", "로그인 만들어줘", sent.call)).running, true);
  assert.deepEqual(sent.calls[0], ["project_chat_send", { input: { threadId: "t1", text: "로그인 만들어줘" } }]);
});

test("items are validated, merged without duplicates and tool calls pair with their results", async () => {
  assert.equal(normalizeItem({ id: "x", kind: "shell", text: "rm -rf /" }), null);
  const { call } = recorder({ thread: { id: "t1", projectId: "p1", agent: "claude", mode: "edit" }, items: [item("a", "user"), { id: "b", kind: "html" }] });
  assert.deepEqual((await readThread("t1", call)).items.map(i => i.id), ["a"]);

  const base = [item("u", "user"), item("c1", "tool", { toolId: "k1" })];
  const merged = mergeItems(base, [item("c1", "tool", { toolId: "k1" }), item("r1", "tool_result", { toolId: "k1" }), item("orphan", "tool_result", { toolId: "zz" }), item("a", "assistant")]);
  assert.deepEqual(merged.map(i => i.id), ["u", "c1", "r1", "orphan", "a"]);
  assert.equal(mergeItems(merged, [merged[0]]), merged, "unchanged list keeps its identity");
  const rows = toRows(merged);
  assert.deepEqual(rows.map(r => r.type === "tool" ? `tool:${r.call.id}>${r.result?.id ?? "-"}` : r.item.id), ["u", "tool:c1>r1", "orphan", "a"]);
  assert.deepEqual(toRows([item("c2", "tool", { toolId: "k2" })]).map(r => r.type === "tool" && r.result), [null], "pending call");
});

test("a planner reply becomes an implementation prompt that quotes it", () => {
  const prompt = implementationPrompt(item("m1", "peer_reply", { peer: "Muse", text: "1. 로그인 화면" }));
  assert.match(prompt, /Muse가 보낸 기획/);
  assert.match(prompt, /--- 기획 ---\n1\. 로그인 화면\n---/);
});

test("events and diffs are parsed defensively", () => {
  assert.equal(normalizeEvent({ kind: "items" }), null);
  const event = normalizeEvent({ threadId: "t1", kind: "items", items: [item("a", "assistant"), { id: "b" }] });
  assert.ok(event && event.kind === "items" && event.items.length === 1);
  const state = normalizeEvent({ threadId: "t1", kind: "state", running: false });
  assert.ok(state && state.kind === "state" && state.running === false);
  assert.deepEqual(diffLines("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-one\n+two\n same").map(l => l.kind), ["file", "ctx", "ctx", "hunk", "del", "add", "ctx"]);
});
