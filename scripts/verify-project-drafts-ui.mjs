// Explicit IPC fixtures only: no agent CLI, Reason account, network message or folder change.
// Drives the real rendered 프로젝트 screen to check composer drafts: each conversation and each
// project's unsaved new conversation keeps its own draft across switches and a page reload, a
// failed send keeps it, a late successful send clears only the text it sent, the planner's
// "이 기획으로 구현" adds to a draft instead of replacing it, deleting a conversation drops only its
// draft, broken or full storage warns without losing what is typed, and Enter/IME still behave.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createFixtureServer, openSection, shellFixture, unhandled } from "./ui-fixture-helpers.mjs";

const out = resolve(process.env.TORIS_QA_OUT ?? "/private/tmp/toris-project-drafts-ui");
await mkdir(out, { recursive: true });
const report = { adapter: "Chromium + explicit native IPC fixtures; no agent, model or network send", checks: [], errors: [], unexpected: [] };
const calls = [];
const at = n => `2026-11-14T03:0${n}:00.000Z`;
const project = { id: "p-app", name: "pocket-app", folder: "/Users/qa/projects/pocket-app", addedAt: at(0) };
const other = { id: "p-admin", name: "admin-web", folder: "/Users/qa/projects/admin-web", addedAt: at(1) };
const thread = (id, title, projectId = project.id) => ({ id, projectId, title, agent: "claude", mode: "edit", providerSession: null, createdAt: at(1), updatedAt: at(1), running: false });
const projects = [project, other];
let threads = [thread("t-a", "로그인 대화"), thread("t-b", "결제 대화"), thread("t-c", "알림 대화"), thread("t-x", "관리자 대화", other.id)];
const plannerReply = { id: "rep1", kind: "peer_reply", text: "## 로그인 기획\n1. 이메일 입력", peer: "toris/muse@cloud", peerName: "Muse", messageId: "m-1", at: at(5) };
const items = { "t-a": [{ id: "u1", kind: "user", text: "기획해줘", at: at(2) }, plannerReply], "t-b": [], "t-c": [], "t-x": [] };
let sendFails = 0;
const held = [];
const hold = threadId => { const h = { threadId, hit: false }; h.promise = new Promise(r => { h.release = r; }); held.push(h); return h; };
const sends = () => calls.filter(c => c.command === "project_chat_send");
const until = async (check, message, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) assert.fail(`${message} (waited ${timeout}ms)`);
    await new Promise(r => setTimeout(r, 25));
  }
};

const server = await createFixtureServer({ server: { port: 0, strictPort: false, watch: { ignored: ["**/src-tauri/**"] } } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", colorScheme: "dark" });
const page = await context.newPage();
page.on("pageerror", error => report.errors.push(error.message));
page.on("dialog", dialog => void dialog.accept());
await page.exposeFunction("__qaInvoke", async (command, args = {}) => {
  calls.push({ command, args });
  if (command === "get_dashboard") return { channels: [], content: [], trends: [], integrations: [], database: { connected: false, message: "fixture" } };
  switch (command) {
    case "project_chat_list": return { projects, threads };
    case "project_chat_thread_get": return { thread: threads.find(t => t.id === args.input.threadId), items: items[args.input.threadId] ?? [], attachments: [] };
    case "project_chat_send": {
      assert.deepEqual(Object.keys(args.input).sort(), ["text", "threadId"], "only the thread and typed text are sent");
      const h = held.find(x => !x.hit && x.threadId === args.input.threadId);
      if (h) { h.hit = true; await h.promise; }
      if (sendFails > 0) { sendFails--; throw new Error("에이전트를 시작하지 못했습니다."); }
      threads = threads.map(t => t.id === args.input.threadId ? { ...t, updatedAt: at(9) } : t);
      return threads.find(t => t.id === args.input.threadId);
    }
    case "project_chat_thread_update": return threads.find(t => t.id === args.input.threadId);
    case "project_chat_thread_delete":
      if (args.input.threadId !== "t-c") { report.unexpected.push(command); throw new Error("unexpected delete"); }
      threads = threads.filter(t => t.id !== args.input.threadId); return null;
    case "project_chat_changes": return { folder: project.folder, isRepo: true, branch: "main", files: [], diff: "", truncated: false };
    case "project_chat_worktree_pending": return [];
    case "project_chat_sync_peers": return [];
    case "reason_network_refresh": return { state: "disconnected", version: null, selfId: null, peers: [], messages: [], error: null };
    case "project_chat_thread_create": case "project_chat_ask_peer": case "project_chat_hosted_request": case "project_chat_remove_project":
      report.unexpected.push(command); throw new Error("unexpected: " + command);
  }
  const shared = shellFixture(command, args);
  if (shared !== unhandled) return shared;
  return null;
});
await page.addInitScript(() => {
  const callbacks = new Map(), events = new Map(); let next = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback: cb => { const id = next++; callbacks.set(id, cb); return id; },
    unregisterCallback: id => callbacks.delete(id),
    convertFileSrc: (path, protocol = "asset") => "http://" + protocol + ".localhost/" + encodeURIComponent(path),
    invoke: (command, args) => {
      if (command === "plugin:event|listen") { events.set(args.event, [...(events.get(args.event) ?? []), args.handler]); return Promise.resolve(args.handler); }
      if (command === "plugin:event|unlisten") return Promise.resolve(null);
      return window.__qaInvoke(command, args);
    }
  };
});

const url = "http://127.0.0.1:" + server.httpServer.address().port;
const root = page.getByRole("region", { name: "프로젝트 채팅", exact: true });
const box = root.getByLabel("메시지", { exact: true });
const nav = root.getByRole("navigation", { name: "프로젝트", exact: true });
const open = async title => { await nav.locator("button.pc-thread", { hasText: title }).click(); await root.locator(".pc-title strong", { hasText: title }).waitFor(); };
const openNew = async () => { await nav.getByRole("button", { name: "새 대화", exact: true }).click(); await root.locator(".pc-title strong", { hasText: "새 대화" }).waitFor(); };
const value = () => box.inputValue();
const expectBox = async (expected, message) => until(async () => await value() === expected, `${message}: box is ${JSON.stringify(await value())}, expected ${JSON.stringify(expected)}`);
const stored = () => page.evaluate(() => localStorage.getItem("toris.projects.drafts.v1"));
const boot = async () => {
  await page.goto(url, { waitUntil: "networkidle" });
  await openSection(page, "프로젝트");
  await nav.getByRole("button", { name: "pocket-app", exact: true }).waitFor();
  await root.locator(".pc-title strong", { hasText: "새 대화" }).waitFor();
};

try {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("toris.projects.project", "p-app"));
  await boot();

  // 1. Separate drafts for two conversations and the project's new conversation.
  await box.fill("새 대화 초안");
  await open("로그인 대화"); await expectBox("", "a conversation opens with its own (empty) draft");
  await box.fill("A 초안");
  await open("결제 대화"); await expectBox("", "B starts empty");
  await box.fill("B 초안");
  await open("로그인 대화"); await expectBox("A 초안", "A keeps its draft");
  await openNew(); await expectBox("새 대화 초안", "the new conversation keeps its draft");
  await nav.getByRole("button", { name: "admin-web", exact: true }).click();
  await root.locator(".pc-title span", { hasText: "admin-web" }).waitFor();
  await expectBox("", "another project's new conversation has its own key");
  await nav.getByRole("button", { name: "pocket-app", exact: true }).click();
  await expectBox("새 대화 초안", "back to the first project's new conversation");
  report.checks.push("Two conversations, the project's new conversation and another project's new conversation each keep their own draft.");

  // 2. Reopening the page restores every draft without sending anything.
  await page.reload({ waitUntil: "networkidle" });
  await openSection(page, "프로젝트");
  await nav.getByRole("button", { name: "pocket-app", exact: true }).waitFor();
  await expectBox("새 대화 초안", "the new conversation's draft survives a reload");
  await open("로그인 대화"); await expectBox("A 초안", "A survives a reload");
  await open("결제 대화"); await expectBox("B 초안", "B survives a reload");
  await root.getByText("초안은 이 기기에만 저장됩니다", { exact: false }).waitFor();
  assert.equal(sends().length, 0, "restoring a draft never sends it");
  const saved = JSON.parse(await stored());
  assert.deepEqual(Object.keys(saved.drafts).sort(), [JSON.stringify(["p-app", null]), JSON.stringify(["p-app", "t-a"]), JSON.stringify(["p-app", "t-b"])].sort());
  for (const entry of Object.values(saved.drafts)) assert.deepEqual(Object.keys(entry).sort(), ["at", "text"], "only text (and when) is stored");
  report.checks.push("After a page reload every draft comes back in its own conversation, nothing is sent, and only text is stored locally (with a visible notice).");

  // 3. A failed send keeps the draft.
  sendFails = 1;
  await box.press("Enter");
  await root.getByText("에이전트를 시작하지 못했습니다.", { exact: false }).waitFor();
  await expectBox("B 초안", "a failed send keeps the draft");
  report.checks.push("A failed send keeps the draft.");

  // 4. A late success clears only the text it sent: text typed while sending stays.
  const first = hold("t-b");
  await box.press("Enter");
  await until(() => first.hit, "the send reaches the host");
  await box.press("End");
  await box.pressSequentially(" 더");
  first.release();
  await until(async () => await root.locator(".pc-composer .social-spin").count() === 0, "the send finishes");
  await expectBox("B 초안 더", "text typed while sending stays");
  // Then a send finishing while another conversation is shown: only B's sent draft is cleared.
  await box.fill("B 다음");
  const second = hold("t-b");
  await box.press("Enter");
  await until(() => second.hit, "the second send reaches the host");
  await open("로그인 대화"); await expectBox("A 초안", "A shows its own draft while B sends");
  second.release();
  await until(async () => await root.locator(".pc-composer .social-spin").count() === 0, "the late send finishes");
  await expectBox("A 초안", "a late success for B leaves A's draft alone");
  await open("결제 대화"); await expectBox("", "B's sent draft is cleared");
  report.checks.push("A late successful send clears only the text it sent in its own conversation; text typed while sending and other drafts stay.");

  // 5. '이 기획으로 구현' adds to the existing draft instead of replacing it; nothing is sent.
  const sent = sends().length;
  await open("로그인 대화");
  await root.getByRole("button", { name: "이 기획으로 구현", exact: true }).click();
  await until(async () => (await value()).startsWith("A 초안\n\n") && (await value()).includes("로그인 기획"), `the plan is added after the draft: ${JSON.stringify(await value())}`);
  assert.equal(sends().length, sent, "implementing from a plan does not send");
  await page.screenshot({ path: resolve(out, "01-drafts-implement.png") });
  report.checks.push("'이 기획으로 구현' appends the plan after an existing draft and does not send.");

  // 6. Enter with the IME composing and Shift+Enter do not send.
  await box.fill("한글 입력");
  await box.focus();
  await box.evaluate(el => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true })));
  await box.press("Shift+Enter");
  await box.pressSequentially("둘째 줄");
  await expectBox("한글 입력\n둘째 줄", "Shift+Enter adds a line");
  assert.equal(sends().length, sent, "Enter while composing and Shift+Enter do not send");
  report.checks.push("Enter during IME composition and Shift+Enter do not send.");

  // 7. Deleting a conversation drops only its draft.
  await open("알림 대화"); await box.fill("C 초안");
  await nav.getByRole("button", { name: "알림 대화 대화 지우기", exact: true }).click();
  await until(async () => !(await stored()).includes("C 초안"), "the deleted conversation's draft is gone");
  const left = JSON.parse(await stored()).drafts;
  assert.equal(left[JSON.stringify(["p-app", "t-a"])].text, "한글 입력\n둘째 줄");
  assert.equal(left[JSON.stringify(["p-app", null])].text, "새 대화 초안");
  report.checks.push("Deleting a conversation removes only its draft.");

  // 8. Full storage: a warning, and the typed text stays on screen and in the session.
  await open("로그인 대화");
  await page.evaluate(() => { const original = Storage.prototype.setItem; window.__restoreSetItem = () => { Storage.prototype.setItem = original; }; Storage.prototype.setItem = function (k, v) { if (k === "toris.projects.drafts.v1") throw new DOMException("full", "QuotaExceededError"); return original.call(this, k, v); }; });
  await box.fill("저장 안 되는 초안");
  await root.getByText("초안을 이 기기에 저장하지 못했습니다", { exact: false }).waitFor();
  await expectBox("저장 안 되는 초안", "a full storage keeps the typed text");
  await open("결제 대화"); await open("로그인 대화");
  await expectBox("저장 안 되는 초안", "the unsaved draft still comes back within the session");
  await root.getByText("로그인 기획", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(out, "02-drafts-storage-full.png") });
  await page.evaluate(() => window.__restoreSetItem());
  report.checks.push("When storage refuses a write, a warning shows and the draft stays on screen and in the session.");

  // 9. A broken stored value: a warning, the page still works, and new typing saves again.
  await page.evaluate(() => localStorage.setItem("toris.projects.drafts.v1", "{broken"));
  await boot();
  await root.getByText("저장된 초안을 읽지 못해 비웠습니다", { exact: false }).waitFor();
  await expectBox("", "a broken store starts empty");
  await box.fill("다시 저장");
  await until(async () => (await stored())?.includes("다시 저장"), "a new draft is saved again");
  report.checks.push("A broken stored value warns, starts empty and is replaced by the next draft.");

  for (const width of [1100, 760]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `no horizontal overflow at ${width}px (${overflow})`);
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  console.log(JSON.stringify({ ok: true, checks: report.checks, output: out }, null, 2));
} finally {
  await writeFile(resolve(out, "verification.json"), JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
