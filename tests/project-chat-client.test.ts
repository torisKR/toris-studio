import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeInvoke } from "../desktop/src/ai-client";
import {
  addProject, askHosted, askPeer, awaitingPlanner, linkMessage, linkWorktree, readChanges, planWorktree, createWorktree, pendingWorktrees, resumeWorktree, forgetWorktree, threadStarted, diffLines, implementationPrompt, listProjects, mergeItems, normalizeEvent, normalizeItem, readThread, sendMessage, searchKey, searchProjects, toRows, checkPreviewUrl, setThreadPreview, PREVIEW_URL_ERROR, normalizeThread, type ChatItem, type Project, type Thread
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

test("hosted assistants get a prompt request; replies and pulls send only IDs and text", async () => {
  const { calls, call } = recorder([item("h1", "hosted_request", { code: "TS-1", prompt: "p", peerName: "Muse" }), { id: "z", kind: "shell" }]);
  const made = await askHosted("t1", "muse", "기획", call);
  assert.deepEqual(made.map(i => [i.kind, i.code, i.prompt, i.peerName]), [["hosted_request", "TS-1", "p", "Muse"]]);
  assert.deepEqual(calls[0], ["project_chat_hosted_request", { input: { threadId: "t1", assistant: "muse", text: "기획" } }]);
  await assert.rejects(askHosted("t1", "claude" as never, "x", call));
  await assert.rejects(askHosted("t1", "dots", "  ", call));
  await askPeer("t1", "toris/chatgpt", "답", call, "m1");
  assert.deepEqual(calls.at(-1), ["project_chat_ask_peer", { input: { threadId: "t1", peer: "toris/chatgpt", text: "답", replyTo: "m1" } }]);
  await linkMessage("t1", "m9", call);
  assert.deepEqual(calls.at(-1), ["project_chat_link_message", { input: { threadId: "t1", messageId: "m9" } }]);
  await assert.rejects(linkMessage("t1", "", call));
});

test("a planner request stays open until a reply follows it", () => {
  assert.equal(awaitingPlanner([]), false);
  assert.equal(awaitingPlanner([item("a", "hosted_request")]), true);
  assert.equal(awaitingPlanner([item("a", "hosted_request"), item("b", "peer_reply")]), false);
  assert.equal(awaitingPlanner([item("a", "peer_request"), item("b", "peer_reply"), item("c", "peer_request")]), true);
  assert.match(implementationPrompt(item("r", "peer_reply", { peer: "toris/chatgpt", peerName: "Dots" })), /^아래는 Dots가 보낸 기획/);
});

const proj = (id: string, name: string): Project => ({ id, name, folder: "/Users/me/" + name, addedAt: "" });
const thr = (id: string, projectId: string, title: string, extra: Partial<Thread> = {}): Thread =>
  ({ id, projectId, title, agent: "claude", mode: "edit", providerSession: null, createdAt: "", updatedAt: "2026-01-0" + id.slice(-1), running: false, worktree: null, previewUrl: null, ...extra });
const searchFixture = () => ({
  projects: [proj("p1", "Pocket App"), proj("p2", "결제 서버"), proj("p3", "notes")],
  threads: [
    thr("t1", "p1", "로그인 화면"), thr("t2", "p2", "로그인 화면", { agent: "codex", running: true }), thr("t3", "p1", "Payment  Flow"),
    thr("t4", "gone", "로그인 고아"), thr("t5", "p3", "README 정리")
  ]
});
const labels = (r: ReturnType<typeof searchProjects>) => r?.hits.map(h => h.kind === "project" ? "P:" + h.project.id : "T:" + h.thread.id);

test("an empty or blank query is not a search", () => {
  const { projects, threads } = searchFixture();
  assert.equal(searchProjects("", projects, threads), null);
  assert.equal(searchProjects("   \t\n", projects, threads), null);
});

test("title search ignores case, folds whitespace and matches Korean in NFC or NFD", () => {
  const { projects, threads } = searchFixture();
  assert.deepEqual(labels(searchProjects("POCKET", projects, threads)), ["P:p1"]);
  assert.deepEqual(labels(searchProjects("  pocket   app ", projects, threads)), ["P:p1"]);
  assert.deepEqual(labels(searchProjects("payment flow", projects, threads)), ["T:t3"], "double space in the title still matches");
  assert.deepEqual(labels(searchProjects("결제", projects, threads)), ["P:p2"]);
  const nfd = [proj("p9", "결제 서버".normalize("NFD"))];
  assert.deepEqual(labels(searchProjects("결제", nfd, [])), ["P:p9"], "macOS folder names arrive decomposed");
  assert.equal(searchKey("Ａ  b"), "ａ b");
  assert.deepEqual(searchProjects("없는제목", projects, threads)?.hits, [], "no hits is a search with zero results, not null");
  assert.deepEqual(searchProjects("로그인", [], [])?.hits, [], "no projects: still an empty result");
});

test("duplicate titles across projects stay separate hits with their project, agent and run state", () => {
  const { projects, threads } = searchFixture();
  const result = searchProjects("로그인", projects, threads)!;
  assert.deepEqual(labels(result), ["T:t2", "T:t1"], "newest first; a thread of a removed project is dropped");
  const [a, b] = result.hits;
  assert.ok(a.kind === "thread" && b.kind === "thread");
  assert.deepEqual([a.project.name, a.thread.agent, a.thread.running], ["결제 서버", "codex", true]);
  assert.deepEqual([b.project.name, b.thread.agent, b.thread.running], ["Pocket App", "claude", false]);
});

test("project hits come before thread hits and count their threads and running state", () => {
  const { projects, threads } = searchFixture();
  const result = searchProjects("e", projects, threads)!;
  assert.equal(result.hits[0].kind, "project");
  const server = searchProjects("서버", projects, threads)!.hits[0];
  assert.ok(server.kind === "project");
  assert.deepEqual([server.threadCount, server.running], [1, true]);
  assert.deepEqual(labels(searchProjects("notes", projects, threads)), ["P:p3"], "project names do not pull in every thread body or title");
});

test("a linked worktree is read with its thread, and old threads have none", async () => {
  const base = "a".repeat(40);
  const { call } = recorder({ projects: [], threads: [
    { id: "t1", projectId: "p1", agent: "claude", mode: "edit", updatedAt: "2", worktree: { path: "/Users/me/app-wt", branch: "feature/x", base, linkedAt: "x" } },
    { id: "t2", projectId: "p1", agent: "codex", mode: "edit", updatedAt: "1" },
    { id: "t3", projectId: "p1", agent: "codex", mode: "edit", updatedAt: "0", worktree: { path: "app-wt", base: "nothex" } }
  ] });
  const { threads } = await listProjects(call);
  assert.deepEqual(threads[0].worktree, { path: "/Users/me/app-wt", branch: "feature/x", base, linkedAt: "x" });
  assert.equal(threads[1].worktree, null);
  assert.equal(threads[2].worktree, null, "a relative path or a non-commit base is not a worktree");
});

test("linking a worktree sends only the thread ID (or a typed path) and the host picks and confirms", async () => {
  const base = "b".repeat(40);
  const linked = recorder({ cancelled: false, thread: { id: "t1", projectId: "p1", agent: "claude", mode: "edit", worktree: { path: "/w/app-wt", branch: null, base } } });
  assert.equal((await linkWorktree("t1", null, linked.call))?.worktree?.path, "/w/app-wt");
  assert.deepEqual(linked.calls, [["project_chat_link_worktree", { input: { threadId: "t1" } }]]);
  await linkWorktree("t1", " ~/w/app-wt ", linked.call);
  assert.deepEqual(linked.calls.at(-1), ["project_chat_link_worktree", { input: { threadId: "t1", path: "~/w/app-wt" } }]);
  await assert.rejects(linkWorktree("t1", "app-wt", linked.call));
  assert.equal(await linkWorktree("t1", null, recorder({ cancelled: true }).call), null);
  await assert.rejects(linkWorktree("t1", null, recorder({ cancelled: false, thread: { id: "t1", projectId: "p1", agent: "claude", mode: "edit" } }).call));
});

test("changes are read from the thread's folder when a thread is open", async () => {
  const r = recorder({ folder: "/w/app-wt", isRepo: true, branch: "feature/x", files: ["?? a"], diff: "", truncated: false });
  assert.equal((await readChanges("p1", r.call, "t1")).folder, "/w/app-wt");
  await readChanges("p1", r.call);
  assert.deepEqual(r.calls, [["project_chat_changes", { input: { projectId: "p1", threadId: "t1" } }], ["project_chat_changes", { input: { projectId: "p1" } }]]);
});

test("a thread is started once it has items, a provider session or a running turn", () => {
  const t = { id: "t1", projectId: "p1", title: "", agent: "claude" as const, mode: "edit" as const, providerSession: null, createdAt: "", updatedAt: "", running: false, worktree: null, previewUrl: null };
  assert.equal(threadStarted(null, []), false);
  assert.equal(threadStarted(t, []), false);
  assert.equal(threadStarted(t, [item("i1", "hosted_request")]), true);
  assert.equal(threadStarted({ ...t, providerSession: "s" }, []), true);
  assert.equal(threadStarted({ ...t, running: true }, []), true);
});

test("preview addresses are loopback HTTP(S) only, parsed with a URL parser", () => {
  assert.deepEqual(checkPreviewUrl("http://localhost:5173"), { url: "http://localhost:5173/" });
  assert.deepEqual(checkPreviewUrl("  https://LOCALHOST:3000/app?x=1#top "), { url: "https://localhost:3000/app?x=1#top" });
  assert.deepEqual(checkPreviewUrl("http://127.0.0.1:8080/"), { url: "http://127.0.0.1:8080/" });
  assert.deepEqual(checkPreviewUrl("http://[::1]:4000/a"), { url: "http://[::1]:4000/a" });
  assert.deepEqual(checkPreviewUrl("   "), { url: null }, "blank clears");
  for (const raw of ["localhost:5173", "file:///etc/passwd", "javascript:alert(1)", "ftp://localhost/", "ws://localhost:5173/",
    "http://user:pw@localhost:5173/", "http://user@127.0.0.1/", "http://example.com/", "http://localhost.example.com/", "http://127.0.0.2/",
    "http://0.0.0.0:3000/", "http://192.168.0.10:3000/", "http://[::ffff:127.0.0.1]/", "http://localhost:5173/a b", "http://localhost:5173/\nx",
    "http://localhost:99999/", "http://localhost/" + "a".repeat(2048)]) {
    assert.deepEqual(checkPreviewUrl(raw), { error: PREVIEW_URL_ERROR }, raw);
  }
});

test("a thread keeps only a valid preview address, and saving sends only the thread ID and typed text", async () => {
  const base = { id: "t1", projectId: "p1", agent: "claude", mode: "edit" };
  assert.equal(normalizeThread(base)?.previewUrl, null);
  assert.equal(normalizeThread({ ...base, previewUrl: "http://localhost:5173/" })?.previewUrl, "http://localhost:5173/");
  assert.equal(normalizeThread({ ...base, previewUrl: "https://evil.example/" })?.previewUrl, null, "a stored remote address is dropped");
  const { calls, call } = recorder({ ...base, previewUrl: "http://127.0.0.1:3000/" });
  const saved = await setThreadPreview("t1", "http://127.0.0.1:3000", call);
  assert.equal(saved.previewUrl, "http://127.0.0.1:3000/");
  assert.deepEqual(calls, [["project_chat_thread_preview", { input: { threadId: "t1", url: "http://127.0.0.1:3000" } }]]);
});

test("an isolated thread sends only IDs; the host names the folder and branch and confirms", async () => {
  const base = "c".repeat(40);
  const shown = recorder({ threadId: "t1", projectFolder: "/w/app", path: "/w/app-worktrees/abcd1234", branch: "studio/abcd1234", base });
  assert.deepEqual(await planWorktree("t1", shown.call), { threadId: "t1", projectFolder: "/w/app", path: "/w/app-worktrees/abcd1234", branch: "studio/abcd1234", base });
  assert.deepEqual(shown.calls, [["project_chat_worktree_plan", { input: { threadId: "t1" } }]]);
  await assert.rejects(planWorktree("t1", recorder({ path: "rel", projectFolder: "/w/app", branch: "b", base }).call));
  const made = recorder({ cancelled: false, thread: { id: "t1", projectId: "p1", agent: "claude", mode: "edit", worktree: { path: "/w/app-worktrees/abcd1234", branch: "studio/abcd1234", base } } });
  assert.equal((await createWorktree("t1", made.call))?.worktree?.branch, "studio/abcd1234");
  assert.deepEqual(made.calls, [["project_chat_create_worktree", { input: { threadId: "t1" } }]]);
  assert.equal(await createWorktree("t1", recorder({ cancelled: true }).call), null);
});

test("leftover creations are listed with the host's guidance and resolved by ID", async () => {
  const list = recorder([{ id: "r1", projectId: "p1", threadId: "t0", path: "/w/app-worktrees/x", branch: "studio/x", base: "d".repeat(40), startedAt: "s", state: "ready", guidance: "g" },
    { id: "r2", projectId: "p1", path: "/w/y", branch: "studio/y", state: "weird" }, { id: "r3", path: "rel" }]);
  const left = await pendingWorktrees(list.call);
  assert.deepEqual(left.map(l => [l.id, l.state]), [["r1", "ready"], ["r2", "unknown"]]);
  const r = recorder({ cancelled: true });
  assert.equal(await resumeWorktree("r1", "t9", r.call), null);
  await forgetWorktree("r1", r.call);
  assert.deepEqual(r.calls, [["project_chat_worktree_resume", { input: { recordId: "r1", threadId: "t9" } }], ["project_chat_worktree_forget", { input: { recordId: "r1" } }]]);
});
