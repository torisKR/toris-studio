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
const adminProject = { id: "p-admin", name: "admin-web", folder: "/Users/qa/projects/admin-web", addedAt: at(9) };
let projects = [], threads = [], items = {}, hostedPhase = false, nextThread = 1, linkReplies = [], deletable = new Set(), planReplies = [], createReplies = [], leftovers = [];
const planFor = id => ({ threadId: id, projectFolder: project.folder, path: `${project.folder}-worktrees/${id}`, branch: `studio/${id}`, base: "89abcdef0123456789abcdef0123456789abcdef" });
const worktree = { path: "/Users/qa/projects/pocket-app-wt", branch: "feature/login", base: "0123456789abcdef0123456789abcdef01234567", linkedAt: at(9) };
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
      if (args.input.path === "~/projects/admin-web") {
        projects = [...projects, adminProject];
        threads = [{ id: "t9", projectId: adminProject.id, title: "로그인 화면", agent: "codex", mode: "edit", providerSession: null, createdAt: at(9), updatedAt: at(9), running: true }, ...threads];
        items.t9 = [{ id: "a1", kind: "user", text: "관리자 로그인", at: at(9) }];
        return { cancelled: false, project: adminProject };
      }
      assert.deepEqual(args.input, { path: "~/projects/pocket-app" }, "the page sends only the typed path");
      projects = [project]; return { cancelled: false, project };
    case "project_chat_thread_create": {
      assert.deepEqual(args.input, { projectId: project.id, agent: "claude", mode: "edit" });
      const id = "t" + nextThread++;
      threads = [thread(id), ...threads]; items[id] = []; return threads[0];
    }
    case "project_chat_link_worktree": {
      assert.deepEqual(Object.keys(args.input), ["threadId"], "only the thread ID leaves the page; the host picks the folder");
      const reply = linkReplies.shift();
      if (reply === "cancel" || reply === "error") deletable.add(args.input.threadId);
      if (reply === "cancel") return { cancelled: true };
      if (reply === "error") throw new Error("선택한 폴더는 이 프로젝트와 다른 Git 저장소입니다.");
      threads = threads.map(t => t.id === args.input.threadId ? { ...t, worktree } : t);
      return { cancelled: false, thread: threads.find(t => t.id === args.input.threadId) };
    }
    case "project_chat_worktree_pending": return leftovers;
    case "project_chat_worktree_plan": {
      assert.deepEqual(Object.keys(args.input), ["threadId"], "only the thread ID leaves the page; the host names folder and branch");
      deletable.add(args.input.threadId);
      if (planReplies.shift() === "error") throw new Error("저장소에 커밋이 없습니다. 첫 커밋을 만든 뒤 격리된 대화를 만들 수 있습니다.");
      return planFor(args.input.threadId);
    }
    case "project_chat_create_worktree": {
      assert.deepEqual(Object.keys(args.input), ["threadId"], "creation sends only the thread ID; the host confirms in an OS dialog");
      if (createReplies.shift() === "cancel") return { cancelled: true };
      const plan = planFor(args.input.threadId);
      threads = threads.map(t => t.id === args.input.threadId ? { ...t, worktree: { path: plan.path, branch: plan.branch, base: plan.base, linkedAt: at(9) } } : t);
      return { cancelled: false, thread: threads.find(t => t.id === args.input.threadId) };
    }
    case "project_chat_worktree_resume": {
      assert.deepEqual(Object.keys(args.input).sort(), ["recordId", "threadId"]);
      const left = leftovers.find(l => l.id === args.input.recordId);
      assert.equal(left?.state, "ready", "only a ready leftover is offered for resuming");
      leftovers = leftovers.filter(l => l !== left);
      threads = threads.map(t => t.id === args.input.threadId ? { ...t, worktree: { path: left.path, branch: left.branch, base: left.base, linkedAt: at(9) } } : t);
      return { cancelled: false, thread: threads.find(t => t.id === args.input.threadId) };
    }
    case "project_chat_worktree_forget":
      assert.deepEqual(args.input, { recordId: "r-missing" });
      leftovers = leftovers.filter(l => l.id !== args.input.recordId); return null;
    case "project_chat_thread_delete":
      if (!deletable.delete(args.input.threadId)) { report.unexpected.push(command); throw new Error("unexpected: " + command); }
      threads = threads.filter(t => t.id !== args.input.threadId); return null;
    case "project_chat_thread_get": return { thread: threads.find(t => t.id === args.input.threadId), items: items[args.input.threadId] ?? [] };
    case "project_chat_send":
      threads = threads.map(t => t.id === args.input.threadId ? { ...t, running: true, title: args.input.text.split("\n")[0].slice(0, 60), updatedAt: at(2) } : t);
      return threads.find(t => t.id === args.input.threadId);
    case "project_chat_thread_update":
      threads = threads.map(t => t.id === args.input.threadId ? { ...t, ...("mode" in args.input ? { mode: args.input.mode } : {}) } : t);
      return threads.find(t => t.id === args.input.threadId);
    case "project_chat_changes": {
      const linked = threads.find(t => t.id === args.input.threadId)?.worktree;
      if (linked) return { folder: linked.path, isRepo: true, branch: linked.branch, files: ["?? src/Checkout.tsx"], diff: "", truncated: false };
      return { folder: project.folder, isRepo: true, branch: "main", files: ["?? src/Login.tsx", " M README.md"], diff, truncated: false };
    }
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
    case "project_chat_thread_preview": {
      assert.deepEqual(Object.keys(args.input).sort(), ["threadId", "url"], "only the thread ID and typed address leave the page");
      const url = args.input.url ? new URL(args.input.url).href : null;
      threads = threads.map(t => t.id === args.input.threadId ? { ...t, previewUrl: url } : t);
      return threads.find(t => t.id === args.input.threadId);
    }
    case "open_external": return null;
    case "project_chat_stop":
      assert.deepEqual(args.input, { threadId: "t9" }, "stop reaches the thread opened from search");
      return null;
    case "project_chat_remove_project":
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
  const search = root.getByLabel("프로젝트·대화 검색", { exact: true });
  await search.fill("앱");
  await root.getByText("아직 프로젝트가 없습니다. 먼저 앱 폴더를 추가하세요.", { exact: true }).waitFor();
  await search.press("Escape");
  assert.equal(await search.inputValue(), "");
  report.checks.push("Searching with no projects says there are no projects (not 'no results'); Escape clears it.");

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

  const workdir = root.getByLabel("작업 폴더", { exact: true });
  await workdir.getByText(/원본 프로젝트 폴더/).waitFor();
  assert.equal(await workdir.getByRole("button", { name: "기존 worktree 연결", exact: true }).isVisible(), true, "a new conversation can pick a worktree");

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

  // Title search across projects: a draft in t1 stays with t1, a running thread opened from search gets the stop and its own events.
  await box.fill("초안 유지");
  await root.getByRole("button", { name: "프로젝트 추가", exact: true }).first().click();
  await root.getByLabel("프로젝트 폴더 경로", { exact: true }).fill("~/projects/admin-web");
  await root.getByRole("button", { name: "추가", exact: true }).click();
  await root.getByText("admin-web에서 무엇을 만들까요?").waitFor();
  assert.equal(await box.inputValue(), "", "the other project's new thread starts without t1's draft");
  await search.fill("  로그인  ");
  const hitList = root.getByRole("list", { name: "검색 결과", exact: true });
  await hitList.getByRole("button").first().waitFor();
  const hitTexts = await hitList.getByRole("button").allTextContents();
  assert.equal(hitTexts.length, 2, hitTexts.join(" | "));
  assert.match(hitTexts[0], /^로그인 화면admin-web · Codex · 실행 중$/);
  assert.match(hitTexts[1], /^로그인 화면을 만들어줘pocket-app · Claude · 대기$/);
  await root.getByText(/제목 검색 결과 2개/).waitFor();
  await page.screenshot({ path: resolve(out, "06-search.png") });
  await search.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), hitTexts[0], "↓ moves into the results");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await root.locator(".pc-title strong").getByText("로그인 화면", { exact: true }).waitFor();
  await root.getByText("관리자 로그인", { exact: true }).waitFor();
  assert.equal(await box.inputValue(), "", "t1's draft does not follow into t9");
  assert.equal(await root.getByText(/Codex이\(가\) 작업 중입니다/).count(), 1, "t9 shows as running");
  await emit({ threadId: "t1", kind: "items", items: [{ id: "late-t1", kind: "assistant", text: "t1에 늦게 온 답", at: at(9) }] });
  await emit({ threadId: "t9", kind: "items", items: [{ id: "a2", kind: "assistant", text: "관리자 화면 작업 중", at: at(9) }] });
  await root.getByText("관리자 화면 작업 중", { exact: true }).waitFor();
  assert.equal(await root.getByText("t1에 늦게 온 답").count(), 0, "another thread's events stay out of the opened thread");
  await root.getByRole("button", { name: "중지", exact: true }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(last("project_chat_stop").args, { input: { threadId: "t9" } });
  assert.equal(count("project_chat_send") + count("project_chat_thread_create"), 2, "opening results starts nothing");
  await hitList.getByRole("button").nth(1).click();
  await root.locator(".pc-title strong").getByText("로그인 화면을 만들어줘", { exact: true }).waitFor();
  assert.equal(await box.inputValue(), "초안 유지", "t1 gets its own draft back");
  await search.fill("ADMIN");
  assert.deepEqual(await hitList.getByRole("button").allTextContents(), ["admin-web프로젝트 · 대화 1개 · 실행 중"], "case-insensitive project match");
  await search.fill("없는 제목");
  await root.getByText(/"없는 제목"와\(과\) 일치하는 프로젝트·대화가 없습니다\./).waitFor();
  await search.fill("로그인");
  await search.press("ArrowDown");
  await page.keyboard.press("Escape");
  assert.equal(await search.inputValue(), "", "Escape in the results clears the search");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "프로젝트·대화 검색");
  await root.getByRole("button", { name: "admin-web", exact: true }).waitFor();
  assert.equal(await box.inputValue(), "초안 유지");
  report.checks.push("Title search (case/space-insensitive, duplicate titles kept apart with project·agent·state) opens threads by keyboard without moving drafts, events or the stop target; no-results and no-projects read differently.");

  // Per-thread preview address: typed and confirmed by the user, loopback only, opened only in the external browser.
  const preview = root.getByRole("group", { name: "미리보기 주소", exact: true });
  await preview.getByText(/로컬 미리보기 주소가 없습니다/).waitFor();
  await preview.getByRole("button", { name: "미리보기 주소 연결", exact: true }).click();
  const previewInput = preview.getByLabel("미리보기 주소 입력", { exact: true });
  for (const bad of ["http://example.com:3000", "javascript:alert(1)", "http://user:pw@localhost:5173", "localhost:5173"]) {
    await previewInput.fill(bad);
    await preview.getByRole("button", { name: "저장", exact: true }).click();
    await preview.getByRole("alert").getByText(/로컬 주소만 쓸 수 있습니다/).waitFor();
  }
  assert.equal(count("project_chat_thread_preview"), 0, "rejected addresses never reach the host");
  await previewInput.fill("http://localhost:5173");
  await previewInput.press("Enter");
  await preview.getByText("http://localhost:5173/", { exact: true }).waitFor();
  await preview.getByText("사용자가 연결한 주소 · 이 대화의 서버인지 확인하지 않음", { exact: true }).waitFor();
  assert.deepEqual(last("project_chat_thread_preview").args, { input: { threadId: "t1", url: "http://localhost:5173/" } });
  assert.equal(count("open_external"), 0, "saving opens nothing");
  await preview.getByRole("button", { name: "미리보기 열기", exact: true }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(last("open_external").args, { url: "http://localhost:5173/" }, "the saved address goes to the native opener");
  assert.equal(count("open_external"), 1);
  assert.equal(page.url().startsWith("http://127.0.0.1:"), true, "the app window did not navigate");
  assert.equal(await page.locator("iframe, webview").count(), 0, "nothing is embedded");
  await page.screenshot({ path: resolve(out, "07-preview.png") });
  // An agent mentioning a server address changes and opens nothing.
  await emit({ threadId: "t1", kind: "items", items: [{ id: "srv", kind: "assistant", text: "개발 서버: http://localhost:3000 을 열어 보세요", at: at(9) }] });
  await root.getByText(/개발 서버: http:\/\/localhost:3000/).waitFor();
  assert.equal(count("open_external"), 1, "agent output is never opened");
  assert.equal(count("project_chat_thread_preview"), 1, "agent output never sets the address");
  // Isolated per thread: t9 has none, and a half-typed edit there does not follow back to t1.
  await search.fill("로그인");
  await hitList.getByRole("button").first().click();
  await root.locator(".pc-title strong").getByText("로그인 화면", { exact: true }).waitFor();
  await preview.getByText(/로컬 미리보기 주소가 없습니다/).waitFor();
  await preview.getByRole("button", { name: "미리보기 주소 연결", exact: true }).click();
  await previewInput.fill("http://127.0.0.1:9");
  await hitList.getByRole("button").nth(1).click();
  await root.locator(".pc-title strong").getByText("로그인 화면을 만들어줘", { exact: true }).waitFor();
  await preview.getByText("http://localhost:5173/", { exact: true }).waitFor();
  assert.equal(await previewInput.count(), 0, "t9's unsaved edit stays with t9");
  assert.equal(count("project_chat_thread_preview"), 1);
  // Restored after a restart: the host's stored thread brings the address back.
  await page.reload({ waitUntil: "networkidle" });
  await openSection(page, "프로젝트");
  await root.getByLabel("프로젝트·대화 검색", { exact: true }).fill("로그인 화면을");
  await root.getByRole("list", { name: "검색 결과", exact: true }).getByRole("button").first().click();
  await root.locator(".pc-title strong").getByText("로그인 화면을 만들어줘", { exact: true }).waitFor();
  await preview.getByText("http://localhost:5173/", { exact: true }).waitFor();
  // Clearing sends an empty address.
  await preview.getByRole("button", { name: "미리보기 주소 바꾸기", exact: true }).click();
  await preview.getByRole("button", { name: "지우기", exact: true }).click();
  await preview.getByText(/로컬 미리보기 주소가 없습니다/).waitFor();
  assert.deepEqual(last("project_chat_thread_preview").args, { input: { threadId: "t1", url: "" } });
  report.checks.push("A thread's preview address is typed and saved by the user (remote, credentialed and non-HTTP addresses rejected before the host), labelled as user-linked, opened only through open_external, kept per thread across a reload, and never set or opened from agent output.");

  // A new conversation moves into an existing git worktree before it starts; the host picks,
  // verifies and confirms. Cancelled or refused links leave no empty thread behind.
  await root.getByLabel("프로젝트·대화 검색", { exact: true }).fill("");
  await root.getByRole("button", { name: "새 대화", exact: true }).click();
  const linkButton = workdir.getByRole("button", { name: "기존 worktree 연결", exact: true });
  const before = threads.length;
  linkReplies = ["cancel", "error", "ok"];
  await linkButton.click();
  await page.waitForTimeout(150);
  assert.equal(threads.length, before, "a cancelled pick leaves no thread");
  await linkButton.click();
  await root.getByText("선택한 폴더는 이 프로젝트와 다른 Git 저장소입니다.").waitFor();
  assert.equal(threads.length, before, "a refused folder leaves no thread");
  assert.equal(deletable.size, 0);
  await linkButton.click();
  await workdir.getByText("feature/login", { exact: true }).waitFor();
  await workdir.getByText("pocket-app-wt", { exact: true }).waitFor();
  await workdir.getByText("원본 /Users/qa/projects/pocket-app", { exact: true }).waitFor();
  await workdir.getByText("기준 0123456", { exact: true }).waitFor();
  const linkedId = last("project_chat_link_worktree").args.input.threadId;
  await changes.getByText("src/Checkout.tsx", { exact: true }).waitFor();
  await changes.getByText("worktree: " + worktree.path, { exact: true }).waitFor();
  assert.deepEqual(last("project_chat_changes").args, { input: { projectId: project.id, threadId: linkedId } }, "changes come from the thread's folder");
  await page.screenshot({ path: resolve(out, "06-worktree-linked.png") });
  await target.selectOption("agent:claude");
  await box.fill("결제 화면을 구현해줘");
  await box.press("Enter");
  await workdir.getByText("대화 시작 후 고정", { exact: true }).waitFor();
  assert.deepEqual(last("project_chat_send").args, { input: { threadId: linkedId, text: "결제 화면을 구현해줘" } });
  assert.equal(await workdir.getByRole("button").count(), 0, "the folder cannot change after the first message");
  await page.screenshot({ path: resolve(out, "07-worktree-fixed.png") });
  report.checks.push("A new conversation links an existing worktree via the host (cancel and refusal leave nothing), shows original vs. work folder and branch, reads changes there, and fixes it after the first message.");

  // An isolated new conversation: the host plans a new branch and folder from the committed HEAD,
  // the page shows them, and creation needs the host's OS confirmation. Refusals leave nothing.
  await root.getByRole("button", { name: "새 대화", exact: true }).click();
  const isolate = workdir.getByRole("button", { name: "격리된 새 대화", exact: true });
  const beforeIsolated = threads.length;
  planReplies = ["error"];
  await isolate.click();
  await root.getByText("저장소에 커밋이 없습니다.", { exact: false }).waitFor();
  assert.equal(threads.length, beforeIsolated, "a refused plan leaves no thread");
  await isolate.click();
  const planCard = root.getByRole("group", { name: "새 worktree 계획" });
  const planned = planFor(last("project_chat_worktree_plan").args.input.threadId);
  for (const text of [planned.projectFolder, planned.path, planned.branch, planned.base.slice(0, 12)]) await planCard.getByText(text, { exact: true }).waitFor();
  await planCard.getByText("커밋하지 않은 변경", { exact: false }).waitFor();
  await page.screenshot({ path: resolve(out, "08-isolated-plan.png") });
  await planCard.getByRole("button", { name: "취소", exact: true }).click();
  await planCard.waitFor({ state: "detached" });
  assert.equal(threads.length, beforeIsolated, "cancelling the plan removes the thread made for it");
  await isolate.click();
  const plan2 = planFor(last("project_chat_worktree_plan").args.input.threadId);
  createReplies = ["cancel", "ok"];
  await planCard.getByRole("button", { name: "만들기", exact: true }).click();
  await page.waitForTimeout(150);
  assert.equal(await planCard.isVisible(), true, "a cancelled OS confirmation keeps the plan on screen and creates nothing");
  leftovers = [
    { id: "r-ready", projectId: project.id, threadId: "gone", path: `${project.folder}-worktrees/old1`, branch: "studio/old1", base: plan2.base, startedAt: at(5), state: "ready", guidance: "Studio가 만든 worktree가 남아 있습니다. 새 대화로 이어서 연결하거나, 기록만 지우고 폴더를 그대로 둘 수 있습니다." },
    { id: "r-missing", projectId: project.id, threadId: "gone2", path: `${project.folder}-worktrees/old2`, branch: "studio/old2", base: plan2.base, startedAt: at(6), state: "missing", guidance: "폴더가 없습니다. 브랜치 studio/old2이(가) 남았을 수 있습니다." }
  ];
  await planCard.getByRole("button", { name: "만들기", exact: true }).click();
  await planCard.waitFor({ state: "detached" });
  await workdir.getByText(plan2.branch, { exact: true }).waitFor();
  await workdir.getByText(plan2.threadId, { exact: true }).waitFor();
  assert.equal(count("project_chat_create_worktree"), 2);
  const leftBox = root.getByRole("group", { name: "끝나지 않은 worktree 생성" });
  await leftBox.getByText(leftovers[1].path, { exact: true }).waitFor();
  assert.equal(await leftBox.getByRole("button", { name: "새 대화로 이어서 연결" }).count(), 1, "only a ready leftover can be continued");
  await page.screenshot({ path: resolve(out, "09-isolated-created.png") });
  await leftBox.getByRole("button", { name: "새 대화로 이어서 연결" }).click();
  await workdir.getByText("studio/old1", { exact: true }).waitFor();
  page.once("dialog", dialog => void dialog.accept());
  await leftBox.getByRole("button", { name: "기록 지우기" }).click();
  await leftBox.waitFor({ state: "detached" });
  assert.deepEqual(leftovers, []);
  await page.screenshot({ path: resolve(out, "10-leftover-resolved.png") });
  report.checks.push("An isolated new conversation shows the host's planned folder, branch and base HEAD, creates only after the host confirms (refusal and cancel leave nothing), and leftovers from an interrupted creation are continued in a new thread or forgotten without deleting folders.");

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
