// Explicit IPC fixtures only: no agent CLI, Reason account, network message or folder change.
// Drives the real rendered 프로젝트 screen: add a project, chat with streamed items, review
// changes, ask a Reason Network planner and hand its reply to the implementation agent.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createFixtureServer, openSection, shellFixture, unhandled } from "./ui-fixture-helpers.mjs";

const out = resolve(process.env.TORIS_QA_OUT ?? "/private/tmp/toris-project-chat-ui");
await mkdir(out, { recursive: true });
const report = { adapter: "Chromium + explicit native IPC fixtures; no agent, model or network send", checks: [], errors: [], unexpected: [] };
const calls = [];
const at = n => `2026-11-14T03:0${n}:00.000Z`;
const project = { id: "p-app", name: "pocket-app", folder: "/Users/qa/projects/pocket-app", addedAt: at(0) };
let projects = [], threads = [], items = {}, hostedPhase = false;
const inboxMessage = { id: "m-free", from: "toris/grok-bot", fromName: "Grok Bot", text: "코드 없이 보낸 결제 기획\n1. 구독", createdAt: at(8), replyTo: null, video: null, requestError: null, jobId: null };
const thread = (id, extra = {}) => ({ id, projectId: project.id, title: "새 대화", agent: "claude", mode: "edit", providerSession: null, createdAt: at(1), updatedAt: at(1), running: false, ...extra });
const peers = [
  { id: "toris/grok@cloud", name: "Grok Bot", kind: "grok", machine: "cloud", cwd: null, branch: null, busy: false },
  { id: "toris/muse@cloud", name: "Muse", kind: "muse", machine: "cloud", cwd: null, branch: null, busy: false },
  { id: "toris/dots@cloud", name: "OpenAI Dots", kind: "dots", machine: "cloud", cwd: null, branch: null, busy: false }
];
const diff = "diff --git a/src/Login.tsx b/src/Login.tsx\nnew file mode 100644\n--- /dev/null\n+++ b/src/Login.tsx\n@@ -0,0 +1,3 @@\n+export function Login() {\n+  return <form aria-label=\"로그인\" />;\n+}\ndiff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# app\n+# pocket-app";

const server = await createFixtureServer({ server: { port: 0, strictPort: false, watch: { ignored: ["**/src-tauri/**"] } } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", colorScheme: "dark" });
page.on("pageerror", error => report.errors.push(error.message));
const last = command => calls.filter(c => c.command === command).at(-1);
const count = command => calls.filter(c => c.command === command).length;
await page.exposeFunction("__qaInvoke", async (command, args = {}) => {
  calls.push({ command, args });
  if (command === "get_dashboard") return { channels: [], content: [], trends: [], integrations: [], database: { connected: false, message: "fixture" } };
  switch (command) {
    case "project_chat_list": return { projects, threads };
    case "project_chat_add_project":
      if (!args.input.path) return { cancelled: true };
      assert.deepEqual(args.input, { path: "~/projects/pocket-app" }, "the page sends only the typed path");
      projects = [project]; return { cancelled: false, project };
    case "project_chat_thread_create":
      assert.deepEqual(args.input, { projectId: project.id, agent: "claude", mode: "edit" });
      threads = [thread("t1"), ...threads]; items.t1 = []; return threads[0];
    case "project_chat_thread_get": return { thread: threads.find(t => t.id === args.input.threadId), items: items[args.input.threadId] ?? [] };
    case "project_chat_send":
      assert.equal(args.input.threadId, "t1");
      threads = threads.map(t => t.id === "t1" ? { ...t, running: true, title: args.input.text.split("\n")[0].slice(0, 60), updatedAt: at(2) } : t);
      return threads.find(t => t.id === "t1");
    case "project_chat_thread_update":
      threads = threads.map(t => t.id === args.input.threadId ? { ...t, ...("mode" in args.input ? { mode: args.input.mode } : {}) } : t);
      return threads.find(t => t.id === args.input.threadId);
    case "project_chat_changes": return { isRepo: true, branch: "main", files: ["?? src/Login.tsx", " M README.md"], diff, truncated: false };
    case "project_chat_ask_peer":
      if (args.input.replyTo) {
        assert.deepEqual(args.input, { threadId: "t1", peer: "toris/chatgpt", text: "결제도 넣어줘", replyTo: "m-dots" }, "a reply goes to the planner's own address");
        return [{ id: "req2", kind: "peer_request", text: args.input.text, peer: "toris/chatgpt", peerName: "Dots", messageId: "sent-2", at: at(7) }];
      }
      assert.equal(args.input.peer, "toris/muse@cloud");
      return [{ id: "req1", kind: "peer_request", text: args.input.text, peer: "toris/muse@cloud", messageId: "sent-1", at: at(5) }];
    case "project_chat_sync_peers":
      if (hostedPhase) return [{ id: "rep2", kind: "peer_reply", text: "## 결제 기획\n1. 정기 결제", peer: "toris/chatgpt", peerName: "Dots", messageId: "m-dots", at: at(7) }];
      return [{ id: "rep1", kind: "peer_reply", text: "## 로그인 기획\n1. 이메일·비밀번호 입력\n2. **실패 시** 안내 문구\n<img src=x onerror=alert(1)>", peer: "Muse", messageId: "m-1", at: at(6) }];
    case "reason_network_refresh": return { state: "connected", version: "0.12.17", selfId: "toris/studio@mac", peers, messages: [inboxMessage], error: null };
    case "project_chat_hosted_request":
      assert.deepEqual(args.input, { threadId: "t1", assistant: "dots", text: "결제 화면을 기획해줘" }, "only the assistant kind and text leave the page");
      hostedPhase = true;
      return [{ id: "h1", kind: "hosted_request", text: args.input.text, peerName: "OpenAI Dots", code: "TS-ABCDEF1234", prompt: "[Toris Studio 기획 요청 · TS-ABCDEF1234]\nsend_message로 `toris/studio@mac`에게 보내 주세요.", at: at(7) }];
    case "project_chat_link_message":
      assert.deepEqual(args.input, { threadId: "t1", messageId: "m-free" }, "only IDs leave the page");
      return [{ id: "rep3", kind: "peer_reply", text: inboxMessage.text, peer: inboxMessage.from, peerName: "Grok Bot", messageId: "m-free", at: at(8) }];
    case "copy_text": return null;
    case "project_chat_stop": case "project_chat_remove_project": case "project_chat_thread_delete":
      report.unexpected.push(command); throw new Error("unexpected: " + command);
  }
  const shared = shellFixture(command, args);
  if (shared !== unhandled) return shared;
  return null;
});
await page.addInitScript(() => {
  const callbacks = new Map(), events = new Map(); let next = 1;
  window.__qaEvent = (name, payload) => { for (const handler of events.get(name) ?? []) callbacks.get(handler)?.({ event: name, id: handler, payload }); };
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
const emit = payload => page.evaluate(p => window.__qaEvent("project-chat-event", p), payload);

try {
  await page.goto("http://127.0.0.1:" + server.httpServer.address().port, { waitUntil: "networkidle" });
  await openSection(page, "프로젝트");
  const root = page.getByRole("region", { name: "프로젝트 채팅", exact: true });
  await root.getByText("앱 폴더를 넣고 채팅으로 만드세요", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(out, "01-empty.png") });
  report.checks.push("Projects is a top-level section with an empty state that explains adding an app folder.");

  // Folder picker cancelled: nothing added. Typed path: host confirms and adds.
  await root.getByRole("button", { name: "프로젝트 추가", exact: true }).first().click();
  await root.getByRole("button", { name: "폴더 선택", exact: true }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(last("project_chat_add_project").args, { input: {} });
  assert.equal(projects.length, 0);
  await root.getByLabel("프로젝트 폴더 경로", { exact: true }).fill("~/projects/pocket-app");
  await root.getByRole("button", { name: "추가", exact: true }).click();
  await root.getByRole("button", { name: "pocket-app", exact: true }).waitFor();
  await root.getByText("pocket-app에서 무엇을 만들까요?").waitFor();
  report.checks.push("Cancelled picker adds nothing; a typed path goes to the host as-is and the project opens.");

  // Composer: hosted assistants (copy a prompt) come first, then network peers; the default target is Claude Opus 5.5.
  const target = root.getByLabel("받는 에이전트", { exact: true });
  const options = await target.locator("option").allTextContents();
  assert.equal(options[0], "Claude Opus 5.5 · medium");
  assert.deepEqual(options.slice(2, 5), ["Muse", "OpenAI Dots", "Grok Bot"]);
  assert.match(options[5], /\(추천\)/);
  assert.equal(await root.getByRole("button", { name: "보내기", exact: true }).isDisabled(), true);

  const box = root.getByLabel("메시지", { exact: true });
  await box.fill("로그인 화면을 만들어줘");
  await box.press("Enter");
  await root.getByText("로그인 화면을 만들어줘", { exact: true }).first().waitFor();
  assert.deepEqual(last("project_chat_send").args, { input: { threadId: "t1", text: "로그인 화면을 만들어줘" } });
  await root.getByText(/작업 중입니다/).waitFor();
  assert.equal(await root.getByRole("button", { name: "보내기", exact: true }).isDisabled(), true, "one turn at a time");

  // Streamed items from the host.
  const streamed = [
    { id: "i1", kind: "user", text: "로그인 화면을 만들어줘", at: at(2) },
    { id: "i2", kind: "assistant", text: "`src/Login.tsx`를 만들겠습니다.\n- 폼\n- **접근성** 라벨", at: at(2) },
    { id: "i3", kind: "tool", text: "src/Login.tsx", tool: "Write", toolId: "k1", at: at(2) },
    { id: "i4", kind: "tool", text: "pnpm test", tool: "Bash", toolId: "k2", at: at(2) }
  ];
  items.t1 = streamed;
  await emit({ threadId: "t1", kind: "items", items: streamed });
  await emit({ threadId: "t1", kind: "items", items: streamed });
  assert.equal(await root.locator(".pc-msg.user .pc-bubble").count(), 1, "the repeated event is merged, not shown twice");
  await root.getByRole("button", { name: /Write src\/Login\.tsx/ }).waitFor();
  assert.equal(await root.getByLabel("실행 중").count(), 2, "both tool calls pending");
  const results = [
    { id: "i5", kind: "tool_result", text: "File created successfully", toolId: "k1", at: at(3) },
    { id: "i6", kind: "tool_result", text: "1 failing\n(종료 코드 1)", toolId: "k2", isError: true, at: at(3) },
    { id: "i7", kind: "assistant", text: "테스트를 고쳐 통과시켰습니다.", at: at(3) },
    { id: "i8", kind: "result", text: "완료 · 22초 · $0.65", at: at(3) }
  ];
  items.t1 = [...streamed, ...results];
  await emit({ threadId: "t1", kind: "items", items: results });
  await root.getByText("완료 · 22초 · $0.65", { exact: true }).waitFor();
  assert.equal(await root.getByLabel("실행 중").count(), 0);
  assert.equal(await root.getByText("File created successfully").count(), 0, "results stay folded into their call");
  await root.getByRole("button", { name: /Bash pnpm test/ }).click();
  await root.getByText(/1 failing/).waitFor();
  threads = threads.map(t => ({ ...t, running: false }));
  const changesBefore = count("project_chat_changes");
  await emit({ threadId: "t1", kind: "state", running: false });
  await page.waitForTimeout(150);
  assert.ok(count("project_chat_changes") > changesBefore, "changes reload when a turn ends");
  const changes = root.getByRole("complementary", { name: "변경 사항", exact: true });
  await changes.getByText("src/Login.tsx", { exact: true }).waitFor();
  assert.equal(await changes.locator(".pc-diff .add").count(), 4);
  assert.equal(await changes.locator(".pc-diff .del").count(), 1);
  assert.equal(await root.getByRole("button", { name: "보내기", exact: true }).isDisabled(), true, "empty composer");
  await page.screenshot({ path: resolve(out, "02-chat-and-changes.png") });
  report.checks.push("Streamed items render once; tool calls pair with results, errors are marked, and the changes panel shows the diff after the turn.");

  // Plan with Muse, then implement the reply.
  await target.selectOption("toris/muse@cloud");
  await box.fill("로그인 흐름을 기획해줘");
  await root.getByRole("button", { name: "보내기", exact: true }).click();
  await root.getByText("toris/muse@cloud에게 보냄").waitFor();
  assert.deepEqual(last("project_chat_ask_peer").args, { input: { threadId: "t1", peer: "toris/muse@cloud", text: "로그인 흐름을 기획해줘" } });
  await root.getByText(/기획 답장을 기다리는 중/).waitFor();
  await root.getByText("로그인 기획", { exact: true }).waitFor({ timeout: 12000 });
  assert.equal(await root.locator("img").count(), 0, "planner markup stays text");
  await root.getByRole("button", { name: "이 기획으로 구현", exact: true }).click();
  await page.waitForTimeout(100);
  const prompt = await box.inputValue();
  assert.match(prompt, /^아래는 Muse가 보낸 기획입니다/);
  assert.match(prompt, /1\. 이메일·비밀번호 입력/);
  assert.equal(await target.inputValue(), "agent:claude");
  await page.screenshot({ path: resolve(out, "03-planner-handoff.png") });
  report.checks.push("A planner request goes only to the chosen peer; its reply shows in the thread as text and '이 기획으로 구현' prefills the Claude prompt.");

  // Hosted assistant: Studio makes a code-tagged prompt to copy; the coded reply lands here and can be answered.
  await target.selectOption("hosted:dots");
  await box.fill("결제 화면을 기획해줘");
  await root.getByRole("button", { name: "보내기", exact: true }).click();
  await root.getByText("OpenAI Dots에게 기획 요청 ·").waitFor();
  await root.getByText("TS-ABCDEF1234", { exact: true }).waitFor();
  await root.getByRole("button", { name: "전달문 복사", exact: true }).click();
  await root.getByText(/복사했습니다\. OpenAI Dots에 붙여넣으세요/).waitFor();
  assert.match(last("copy_text").args.text, /TS-ABCDEF1234/);
  assert.equal(count("reason_network_send"), 0, "nothing is sent for a hosted request");
  await root.getByText("결제 기획", { exact: true }).waitFor({ timeout: 12000 });
  await page.screenshot({ path: resolve(out, "05-hosted-planner.png") });
  await root.locator(".pc-msg.peer-reply").last().getByRole("button", { name: "답장", exact: true }).click();
  await root.getByText(/Dots에게 답장/).waitFor();
  await box.fill("결제도 넣어줘");
  await root.getByRole("button", { name: "보내기", exact: true }).click();
  await root.getByText("Dots에게 보냄").waitFor();
  report.checks.push("Hosted assistants get a code-tagged prompt to copy (nothing sent), their coded reply lands in the thread, and 답장 goes back to the sender with reply_to.");

  // A message that arrived without a code can be pulled in by hand.
  await root.getByRole("button", { name: "받은 기획 가져오기", exact: true }).click();
  const inboxPanel = root.getByLabel("받은 메시지", { exact: true });
  await inboxPanel.getByText(/코드 없이 보낸 결제 기획/).waitFor();
  await inboxPanel.getByRole("button", { name: "이 대화에 붙이기", exact: true }).click();
  await root.locator(".pc-msg.peer-reply").getByText("Grok Bot의 기획", { exact: false }).waitFor();
  report.checks.push("An uncoded inbox message is filed in the thread only when the user picks it, by message ID.");

  for (const width of [1100, 760]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `no horizontal overflow at ${width}px (${overflow})`);
  }
  await page.screenshot({ path: resolve(out, "04-narrow.png"), fullPage: false });
  report.checks.push("Layout fits 1440/1100/760 widths without horizontal overflow.");

  assert.equal(count("reason_network_send"), 0);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  console.log(JSON.stringify({ ok: true, checks: report.checks, output: out }, null, 2));
} finally {
  await writeFile(resolve(out, "verification.json"), JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
