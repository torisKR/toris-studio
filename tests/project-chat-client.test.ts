import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeInvoke } from "../desktop/src/ai-client";
import {
  addProject, askHosted, askPeer, awaitingPlanner, openPlannerRequests, plannerRequests, replyLink, syncPeers, linkMessage, linkWorktree, readChanges, planWorktree, createWorktree, pendingWorktrees, resumeWorktree, forgetWorktree, threadStarted, diffLines, implementationPrompt, listProjects, mergeItems, normalizeEvent, normalizeItem, readThread, sendMessage, searchKey, searchProjects, toRows, checkPreviewUrl, setThreadPreview, PREVIEW_URL_ERROR, normalizeThread, type ChatItem, type Project, type Thread, attachFile, attachmentBlock, attachmentsAllowed, detachFile, formatBytes, type Attachment, jobRows
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

test("a planner request stays open until a reply the host tied to it arrives", () => {
  assert.equal(awaitingPlanner([]), false);
  assert.equal(awaitingPlanner([item("a", "hosted_request")]), true);
  assert.equal(awaitingPlanner([item("a", "hosted_request"), item("b", "peer_reply", { requestId: "a" })]), false);
  assert.equal(awaitingPlanner([item("a", "peer_request"), item("b", "peer_reply", { requestId: "a" }), item("c", "peer_request")]), true);
  const states = (items: ChatItem[]) => plannerRequests(items).map(r => `${r.id}:${r.state}:${r.replies}`);

  // A and B asked; B answers first: A still waits, and the count says one is left.
  const ab = [item("A", "hosted_request", { peerName: "Muse", code: "TS-A" }), item("B", "hosted_request", { peerName: "Grok Bot", code: "TS-B" })];
  const bFirst = [...ab, item("rB", "peer_reply", { requestId: "B" })];
  assert.deepEqual(states(bFirst), ["A:waiting:0", "B:answered:1"]);
  assert.equal(openPlannerRequests(bFirst), 1);
  assert.equal(awaitingPlanner(bFirst), true);
  const both = [...bFirst, item("rA", "peer_reply", { requestId: "A" })];
  assert.deepEqual(states(both), ["A:answered:1", "B:answered:1"]);
  assert.equal(awaitingPlanner(both), false);

  // A plan the user filed by hand (no code, no reply_to match) closes nothing.
  const manual = [...ab, item("rM", "peer_reply", { unmatched: true })];
  assert.deepEqual(states(manual), ["A:waiting:0", "B:waiting:0"]);
  assert.equal(openPlannerRequests(manual), 2);
  assert.deepEqual(replyLink(manual[2], plannerRequests(manual)), { kind: "unmatched" });

  // An older record (reply saved without its request): the requests before it are unknown, not
  // answered and not waiting; a request made after it still waits.
  const legacy = [item("o1", "peer_request"), item("old", "peer_reply"), item("n1", "peer_request")];
  assert.deepEqual(states(legacy), ["o1:unknown:0", "n1:waiting:0"]);
  assert.deepEqual(replyLink(legacy[1], plannerRequests(legacy)), { kind: "legacy" });
  assert.equal(openPlannerRequests(legacy), 1);
  // A reply the host later ties to the old request still answers it.
  assert.deepEqual(states([...legacy, item("r1", "peer_reply", { requestId: "o1" })]), ["o1:answered:1", "n1:waiting:0"]);

  // Duplicate delivery of the same reply never shows twice, and a second reply only adds to its count.
  const dup = mergeItems(bFirst, [item("rB", "peer_reply", { requestId: "B" }), item("rB2", "peer_reply", { requestId: "B" })]);
  assert.deepEqual(states(dup), ["A:waiting:0", "B:answered:2"]);
  // A reply naming a request this thread does not hold closes nothing.
  assert.deepEqual(states([...ab, item("x", "peer_reply", { requestId: "elsewhere" })]), ["A:waiting:0", "B:waiting:0"]);
  const link = replyLink(bFirst[2], plannerRequests(bFirst));
  assert.equal(link.kind === "request" && link.request?.name, "Grok Bot");
  assert.match(implementationPrompt(item("r", "peer_reply", { peer: "toris/chatgpt", peerName: "Dots" })), /^아래는 Dots가 보낸 기획/);
});

test("planner reply links survive the bridge, and a failed check is an error", async () => {
  const kept = normalizeItem({ id: "r", kind: "peer_reply", text: "x", at: "", requestId: "q", unmatched: false });
  assert.deepEqual(kept, { id: "r", kind: "peer_reply", text: "x", at: "", requestId: "q" });
  assert.equal(normalizeItem({ id: "r", kind: "peer_reply", text: "x", at: "", unmatched: true })?.unmatched, true);
  assert.equal(normalizeItem({ id: "r", kind: "peer_reply", text: "x", at: "", unmatched: "yes", requestId: 3 })?.unmatched, undefined);
  const failing: BridgeInvoke = async () => { throw new Error("기획 답장을 확인하지 못했습니다(Reason Network): 연결 끊김"); };
  await assert.rejects(syncPeers("t1", failing), /연결 끊김/);
  let asked: unknown;
  const ok: BridgeInvoke = async (command, args) => { asked = { command, args }; return [{ id: "r", kind: "peer_reply", text: "x", at: "", requestId: "q" }]; };
  assert.deepEqual(await syncPeers("t1", ok), [{ id: "r", kind: "peer_reply", text: "x", at: "", requestId: "q" }]);
  assert.deepEqual(asked, { command: "project_chat_sync_peers", args: { input: { threadId: "t1" } } });
});

const proj = (id: string, name: string): Project => ({ id, name, folder: "/Users/me/" + name, addedAt: "" });
const thr = (id: string, projectId: string, title: string, extra: Partial<Thread> = {}): Thread =>
  ({ id, projectId, title, agent: "claude", mode: "edit", providerSession: null, createdAt: "", updatedAt: "2026-01-0" + id.slice(-1), running: false, worktree: null, previewUrl: null, lastRun: null, ...extra });
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
  const t = { id: "t1", projectId: "p1", title: "", agent: "claude" as const, mode: "edit" as const, providerSession: null, createdAt: "", updatedAt: "", running: false, worktree: null, previewUrl: null, lastRun: null };
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

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const att = (n: number, bytes = 10, extra: Partial<Attachment> = {}): Attachment => ({ id: ID(n), name: `f${n}.txt`, bytes, text: "x", changed: false, ...extra });

test("attaching asks the host to pick a file and keeps only what it describes; the window never sends a path", async () => {
  const picked = recorder({ cancelled: false, attachment: { id: ID(1), name: "src/a.ts", bytes: 12, text: "const a = 1;", changed: false, path: "/etc/passwd" } });
  const file = await attachFile("t1", [], picked.call);
  assert.deepEqual(file, { id: ID(1), name: "src/a.ts", bytes: 12, text: "const a = 1;", changed: false });
  assert.deepEqual(picked.calls, [["project_chat_attach", { input: { threadId: "t1" } }]]);
  assert.equal(await attachFile("t1", [], recorder({ cancelled: true }).call), null);
  await assert.rejects(attachFile("t1", [], recorder({ cancelled: false, attachment: { id: "x", name: "a", bytes: 1 } }).call), /첨부하지 못했습니다/);
  await assert.rejects(attachFile("t1", [], recorder({ cancelled: false, attachment: { id: ID(2), name: "a", bytes: 9000 } }).call), "over 8KiB is not a valid attachment");
  const full = recorder({});
  await assert.rejects(attachFile("t1", [att(1), att(2), att(3), att(4)], full.call), /4개/);
  await assert.rejects(attachFile("t1", [att(1, 8192), att(2, 8192)], full.call), /16KiB/);
  assert.deepEqual(full.calls, [], "limits are checked before the dialog opens");
  const left = recorder([{ id: ID(2), name: "b.md", bytes: 3, text: "hey", changed: true }, { id: "bad" }]);
  assert.deepEqual(await detachFile("t1", ID(1), left.call), [{ id: ID(2), name: "b.md", bytes: 3, text: "hey", changed: true }]);
  assert.deepEqual(left.calls, [["project_chat_detach", { input: { threadId: "t1", attachmentId: ID(1) } }]]);
});

test("sending carries attachment IDs only, to the agent or into a hosted prompt", async () => {
  const files = [att(1, 100, { text: "secret text" }), att(2)];
  const sent = recorder({ id: "t1", projectId: "p1", agent: "claude", mode: "edit", running: true });
  await sendMessage("t1", "고쳐줘", sent.call, files);
  assert.deepEqual(sent.calls, [["project_chat_send", { input: { threadId: "t1", text: "고쳐줘", attachments: [ID(1), ID(2)] } }]]);
  await sendMessage("t1", "고쳐줘", sent.call);
  assert.deepEqual(sent.calls[1], ["project_chat_send", { input: { threadId: "t1", text: "고쳐줘" } }], "no attachments, no field");
  const hosted = recorder([{ id: "h1", kind: "hosted_request", text: "기획", attachments: [{ name: "f1.txt", bytes: 100 }, { name: "", bytes: 1 }, { name: "x", bytes: -1 }], at: "x" }]);
  const [made] = await askHosted("t1", "dots", "기획", hosted.call, files);
  assert.deepEqual(hosted.calls, [["project_chat_hosted_request", { input: { threadId: "t1", assistant: "dots", text: "기획", attachments: [ID(1), ID(2)] } }]]);
  assert.deepEqual(made.attachments, [{ name: "f1.txt", bytes: 100 }], "a recorded message keeps names and sizes it can describe");
  assert.equal(normalizeItem({ id: "u", kind: "user", text: "hi", at: "x" })?.attachments, undefined, "older records have none");
  const read = await readThread("t1", recorder({ thread: { id: "t1", projectId: "p1", agent: "claude", mode: "edit" }, items: [], attachments: [{ id: ID(3), name: "c.md", bytes: 2, text: "hi", changed: true }, { id: ID(4) }] }).call);
  assert.deepEqual(read.attachments, [{ id: ID(3), name: "c.md", bytes: 2, text: "hi", changed: true }], "picked files come back after a reload");
});

test("attachment limits and targets", () => {
  assert.equal(attachmentBlock([]), null);
  assert.equal(attachmentBlock([att(1, 8192), att(2, 8191)]), null);
  assert.match(attachmentBlock([att(1, 8192), att(2, 8192)]) ?? "", /16KiB/);
  assert.match(attachmentBlock([att(1), att(2), att(3), att(4)]) ?? "", /4개/);
  assert.equal(attachmentsAllowed("agent", false), true);
  assert.equal(attachmentsAllowed("hosted:muse", false), true);
  assert.equal(attachmentsAllowed("peer-1", false), false, "Reason Network peers get no files");
  assert.equal(attachmentsAllowed("agent", true), false, "nor do replies");
  assert.deepEqual([formatBytes(12), formatBytes(3200), formatBytes(16384)], ["12B", "3.1KiB", "16KiB"]);
});

test("the jobs list shows running threads first, then finished ones, with agent, branch and project", () => {
  const base = { projectId: "p1", title: "x", agent: "claude", mode: "edit", createdAt: "", providerSession: null, worktree: null, lastRun: null, running: false };
  const raw = [
    { ...base, id: "idle", updatedAt: "2026-01-09" },
    { ...base, id: "done", updatedAt: "2026-01-02", lastRun: { outcome: "done", startedAt: "2026-01-01", finishedAt: "2026-01-02" } },
    { ...base, id: "failed", projectId: "p2", agent: "codex", updatedAt: "2026-01-03", lastRun: { outcome: "failed", startedAt: "2026-01-02", finishedAt: "2026-01-03" } },
    { ...base, id: "run", updatedAt: "2026-01-01", running: true, worktree: { path: "/w/a", branch: "studio/a", base: "a".repeat(40), linkedAt: "" }, lastRun: { outcome: "failed", startedAt: "", finishedAt: "2026-01-04" } },
    { ...base, id: "odd", updatedAt: "2026-01-05", lastRun: { outcome: "merged", startedAt: "", finishedAt: "2026-01-05" } }
  ];
  const threads = raw.map(normalizeThread).filter(t => t !== null);
  assert.equal(threads.find(t => t.id === "odd")!.lastRun, null, "an unknown outcome is dropped");
  const jobs = jobRows(threads, [{ id: "p1", name: "app", folder: "/a", addedAt: "" }]);
  assert.deepEqual(jobs.map(j => [j.thread.id, j.state, j.branch]), [["run", "running", "studio/a"], ["failed", "failed", null], ["done", "done", null]]);
  assert.equal(jobs[0].project?.name, "app");
  assert.equal(jobs[1].project, null, "a thread of a removed project still shows");
});
