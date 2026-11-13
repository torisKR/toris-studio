// Explicit IPC fixtures only: no Reason account, external message, model, render or publication.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createFixtureServer, openSection, shellFixture, unhandled } from "./ui-fixture-helpers.mjs";

const out = resolve(process.env.TORIS_QA_OUT ?? "/private/tmp/toris-reason-network-ui");
await mkdir(out, { recursive: true });
const report = { adapter: "Chromium + explicit native IPC fixtures; no live Reason connection, model, rendering or posting", checks: [], errors: [], unexpected: [] };
const calls = [], copies = [];
const input = { topic: "우리 앱을 소개하는 30초 쇼츠", durationSec: 30, aspect: "9:16", style: "documentary", narration: true, speaker: "Sohee", subtitleStyle: "shorts-bold", bgm: "pulse", quality: "preview", engine: "", visual: "stock", layout: "card" };
const request = { schema: "toris-studio.video.v1", requestId: "shorts-request-1", settings: input };
const importedStoryboard = { title: "단월 업데이트 외부 초안", story: "외부 AI가 작성한 대본을 검토합니다.", scenes: [
  { id: "intro", durationSec: 10, script: "도입 장면", narration: "단월의 새로운 업데이트를 소개합니다.", caption: "새로운 시작" },
  { id: "equipment", durationSec: 10, script: "장비 소개", narration: "다양한 장비로 캐릭터를 성장시켜 보세요.", caption: "장비와 성장" },
  { id: "outro", durationSec: 10, script: "마무리", narration: "게임에서 직접 확인해 주세요.", caption: "단월에서 만나요" }
] };
const importedRequest = { ...request, requestId: "external-storyboard-1", storyboard: importedStoryboard };
const messages = [
  { id: "video-message", from: "toris/muse@cloud", fromName: "Muse", text: JSON.stringify(request), createdAt: "2026-11-13T05:00:00Z", replyTo: null, video: request, requestError: null, jobId: null },
  { id: "text-message", from: "toris/grok@cloud", fromName: "Grok Bot", text: "기획 초안을 확인해 주세요. <img src=x onerror=alert(1)>", createdAt: null, replyTo: null, video: null, requestError: null, jobId: null },
  { id: "invalid-message", from: "toris/other@cloud", fromName: "다른 에이전트", text: '{"schema":"toris-studio.video.v1","command":"sh"}', createdAt: null, replyTo: null, video: null, requestError: "영상 요청에 허용되지 않은 필드가 있습니다.", jobId: null },
  { id: "storyboard-message", from: "toris/dots", fromName: "Dots", text: JSON.stringify(importedRequest), createdAt: null, replyTo: null, video: importedRequest, requestError: null, jobId: null }
];
const peers = [
  { id: "toris/grok@cloud", name: "Grok Bot", kind: "grok", machine: "cloud", cwd: null, branch: null, busy: false },
  { id: "toris/muse@cloud", name: "Muse", kind: "muse", machine: "cloud", cwd: null, branch: null, busy: true }
];
const job = {
  id: "reason-video-7", status: "awaiting_approval", createdAt: "2026-11-13T05:01:00Z", updatedAt: "2026-11-13T05:01:00Z", settings: input,
  stages: [{ id: "plan", status: "done", done: 1, total: 1 }, { id: "storyboard", status: "waiting", done: 0, total: 1 }],
  storyboard: { title: "Reason에서 받은 영상", story: "앱의 제작 과정을 소개합니다.", style: { look: "clean", palette: "green", consistency: "same" },
    scenes: Array.from({ length: 6 }, (_, i) => ({ id: "s" + (i + 1), order: i + 1, durationSec: 5, script: "소개 장면", narration: "이것은 앱 제작 과정입니다.", caption: "앱 제작", prompt: "app creation", search: "computer", transition: "cut" })) },
  scenes: [], final: null, qa: [], provenance: null, candidates: {}, error: null
};
const importedJob = { ...job, id: "reason-imported-8", storyboard: importedStoryboard };
const settings = { projectsRoot: "/Users/qa/projects", ollamaUrl: "http://127.0.0.1:11434", agentModel: null, contentModel: null, image: null, embedding: { provider: "local", model: "" } };
let state = "connected", refreshFails = false, responseNull = false;
// Stage pipeline fixture: the host owns order, text and digest; the page only names actions.
const STAGE_IDS = ["design", "planning", "development", "audio", "deploy"];
let pipeline = null, deployFailsOnce = true, agentSessions = [], launchCancelled = true;
const agentDraft = { kind: "codex", folder: "/Users/qa/projects/demo", branch: "main", name: "mac-mini-codex-demo" };
const pipelineView = () => {
  const row = pipeline.stages.find(stage => !["replied", "skipped"].includes(stage.status));
  const quoted = pipeline.stages.filter(stage => stage.reply).map(stage => "> " + stage.reply).join("\n");
  const next = !pipeline.cancelled && row?.assignee && ["pending", "uncertain"].includes(row.status)
    ? { stage: row.stage, assignee: row.assignee, text: "[Toris Studio 단계 요청] " + row.stage + "\n" + quoted, digest: "digest-" + row.stage, resend: row.status === "uncertain" } : null;
  return structuredClone({ pipeline, current: pipeline.cancelled ? null : row?.stage ?? null, next, candidates: [] });
};
let holdNextRefresh = false, releaseRefresh = null;
const count = command => calls.filter(c => c.command === command).length;
const last = command => calls.filter(c => c.command === command).at(-1);
const server = await createFixtureServer({ server: { port: 0, strictPort: false } });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  page.on("pageerror", e => report.errors.push(e.message));
  await page.exposeFunction("__qaRefreshIsHeld", () => releaseRefresh !== null);
  await page.exposeFunction("__qaInvoke", async (command, args = {}) => {
    calls.push({ command, args });
    if (command === "get_dashboard") return { channels: [], content: [], trends: [], integrations: [], database: { connected: true, message: "fixture" } };
    if (command === "agent_settings_get") return { settings, keys: {}, chromaUrl: "http://127.0.0.1:18765" };
    if (command === "agent_call") {
      if (args.method === "status") return { version: "0.1", providers: [], chroma: true, projectsRoot: settings.projectsRoot };
      if (args.method === "projects.list") return { projects: [] };
      if (args.method === "run.list") return { runs: [] };
    }
    if (command === "reason_network_refresh") {
      if (refreshFails) throw new Error("Reason 연결이 중단되었습니다.");
      if (responseNull) return null;
      const value = structuredClone({ state, version: state === "missing" ? null : "0.12.17", selfId: state === "connected" ? "toris/studio@mac-mini" : null,
        peers: state === "connected" ? peers : [], messages: state === "connected" ? messages : [], error: state === "error" ? "네트워크 상태 확인 실패" : null });
      if (holdNextRefresh) {
        holdNextRefresh = false;
        await new Promise(resolve => { releaseRefresh = resolve; });
      }
      return value;
    }
    if (command === "reason_network_send") {
      assert.ok(args.input.target && !args.input.target.includes("*"));
      return { messageIds: ["sent-" + count(command)] };
    }
    if (command === "reason_network_accept_video") {
      assert.ok(["video-message", "storyboard-message"].includes(args.input.messageId));
      assert.deepEqual(Object.keys(args.input), ["messageId"]);
      const message = messages.find(message => message.id === args.input.messageId);
      const accepted = message.id === "storyboard-message" ? importedJob : job;
      const reused = message.jobId !== null;
      message.jobId = accepted.id;
      return { jobId: accepted.id, reused };
    }
    if (command === "reason_network_video_result") {
      assert.deepEqual(args, { input: { messageId: "video-message" } });
      return { jobId: job.id, status: "done", stage: "done", title: "완성된 쇼츠", hasVideo: true, requiresApproval: false, summary: "30초 영상 생성 완료. 품질 검사 5개 통과." };
    }
    if (command === "reason_network_send_result") {
      assert.deepEqual(args, { input: { messageId: "video-message" } });
      return { messageIds: ["result-sent-1"] };
    }
    if (command === "copy_text") { copies.push(args.text); return null; }
    if (command === "reason_pipeline_list") return pipeline ? [pipelineView()] : [];
    if (command === "reason_pipeline_create") {
      assert.deepEqual(Object.keys(args.input), ["brief", "assignees"]);
      pipeline = { id: "pipe-1", identity: "fixture", brief: args.input.brief, createdAt: "2026-11-13T05:00:00.000Z", cancelled: false,
        stages: STAGE_IDS.map((stage, index) => ({ stage, assignee: args.input.assignees[index], status: "pending", sendKey: null, sentId: null, sentAt: null, replyId: null, reply: null })) };
      return pipelineView();
    }
    if (command === "reason_pipeline_update") {
      const { action } = args.input, row = pipeline.stages.find(stage => stage.stage === action.stage);
      assert.equal(args.input.pipelineId, "pipe-1");
      if (action.type === "cancel") pipeline.cancelled = true;
      else if (action.type === "skip") row.status = "skipped";
      else if (action.type === "assumeSent") row.status = "waiting";
      else throw new Error("unexpected pipeline action: " + action.type);
      return pipelineView();
    }
    if (command === "reason_pipeline_send") {
      assert.deepEqual(Object.keys(args.input), ["pipelineId", "stage", "digest", "deployApproved"], "the page never supplies message text");
      const row = pipeline.stages.find(stage => stage.stage === args.input.stage);
      assert.equal(args.input.digest, "digest-" + row.stage);
      if (row.stage === "deploy") {
        assert.equal(args.input.deployApproved, true);
        if (deployFailsOnce) { deployFailsOnce = false; row.status = "uncertain"; throw new Error("전송 여부가 불확실할 수 있으므로 자동 재전송하지 않았습니다."); }
      }
      row.status = "waiting"; row.sentId = "sent-stage";
      return pipelineView();
    }
    if (command === "reason_agent_list") return structuredClone(agentSessions);
    if (command === "reason_agent_launch") {
      assert.deepEqual(args, { input: { kind: "codex" } }, "the page names only the agent kind");
      if (launchCancelled) return { cancelled: true };
      agentSessions = [{ ...agentDraft, id: "session-1", running: true, exitCode: null }];
      return { cancelled: false, sessions: structuredClone(agentSessions) };
    }
    if (command === "reason_agent_stop") { assert.deepEqual(args, { input: { id: "session-1" } }); agentSessions = []; return []; }
    if (command === "production_list") return [{ id: job.id, title: "Reason에서 받은 영상", topic: input.topic, status: job.status, updatedAt: job.updatedAt }];
    if (command === "production_get") {
      assert.ok([job.id, importedJob.id].includes(args.input.jobId));
      return args.input.jobId === importedJob.id ? importedJob : job;
    }
    if (/^(reason_network_|production_(create|approve|publication_draft))/.test(command)) { report.unexpected.push(command); throw new Error("unexpected mutation: " + command); }
    const shared = shellFixture(command, args);
    if (shared !== unhandled) return shared;
    return null;
  });
  await page.addInitScript(() => {
    const callbacks = new Map(); let next = 1;
    window.__TAURI_INTERNALS__ = {
      transformCallback: cb => { const id = next++; callbacks.set(id, cb); return id; },
      unregisterCallback: id => callbacks.delete(id),
      convertFileSrc: (path, protocol = "asset") => "http://" + protocol + ".localhost/" + encodeURIComponent(path),
      invoke: (command, args) => window.__qaInvoke(command, args)
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto("http://127.0.0.1:" + server.httpServer.address().port, { waitUntil: "networkidle" });
  await openSection(page, "제작", "Agent");
  const panel = page.getByRole("region", { name: "Reason Network", exact: true });
  await panel.getByText("toris/studio@mac-mini", { exact: true }).waitFor();
  const refresh = () => panel.getByRole("button", { name: "연결·받은 요청 확인", exact: true }).click();
  assert.equal(count("reason_network_send"), 0);
  assert.equal(count("reason_network_accept_video"), 0);
  assert.equal(count("reason_network_send_result"), 0);
  await panel.getByRole("button", { name: "주소 복사", exact: true }).click();
  assert.equal(copies.at(-1), "toris/studio@mac-mini");
  report.checks.push("Activation only refreshes; real address is copyable; no auto sends or job acceptance.");

  const sendButton = panel.getByRole("button", { name: "메시지 보내기", exact: true });
  assert.ok(await sendButton.isDisabled());
  await panel.getByLabel("보낼 메시지", { exact: true }).fill("주제를 검토해 주세요.");
  assert.ok(await sendButton.isDisabled(), "there is no default broadcast or recipient");
  await panel.getByLabel("받는 에이전트", { exact: true }).selectOption("toris/grok@cloud");
  await sendButton.click();
  await panel.getByText(/메시지를 전송했습니다/).waitFor();
  assert.deepEqual(last("reason_network_send").args, { input: { target: "toris/grok@cloud", text: "주제를 검토해 주세요." } });
  const textMessage = panel.getByRole("article", { name: "Grok Bot의 요청", exact: true });
  assert.equal(await textMessage.locator("img").count(), 0, "untrusted markup stays plain text");
  await textMessage.getByRole("button", { name: "답장 작성", exact: true }).click();
  await panel.getByLabel("보낼 메시지", { exact: true }).fill("초안 확인했습니다.");
  await sendButton.click();
  await panel.getByText(/메시지를 전송했습니다/).waitFor();
  assert.equal(last("reason_network_send").args.input.replyTo, "text-message");
  report.checks.push("Recipient selection, explicit send and reply correlation work; received HTML is never interpreted.");

  // Stage pipeline: creating, replying and refreshing never send; each send is one approval.
  assert.equal(count("reason_pipeline_send"), 0);
  await panel.getByLabel("프로젝트 브리프", { exact: true }).fill("무협 게임 출시");
  await panel.getByLabel("디자인 담당", { exact: true }).selectOption("toris/muse@cloud");
  await panel.getByLabel("기획 담당", { exact: true }).selectOption("toris/grok@cloud");
  await panel.getByLabel("배포 담당", { exact: true }).selectOption("toris/grok@cloud");
  assert.equal(await panel.getByLabel("디자인 담당", { exact: true }).locator("option").count(), peers.length + 1, "only roster agents can be assigned");
  await panel.getByRole("button", { name: "파이프라인 만들기", exact: true }).click();
  const card = panel.getByRole("article", { name: "단계 파이프라인: 무협 게임 출시", exact: true });
  const approval = stage => card.getByRole("group", { name: stage + " 단계 전송 승인", exact: true });
  await approval("디자인").waitFor();
  assert.deepEqual(last("reason_pipeline_create").args, { input: { brief: "무협 게임 출시", assignees: ["toris/muse@cloud", "toris/grok@cloud", null, null, "toris/grok@cloud"] } });
  assert.equal(count("reason_pipeline_send"), 0, "creating a pipeline sends nothing");
  await approval("디자인").getByText("[Toris Studio 단계 요청] design").waitFor();
  await approval("디자인").getByRole("button", { name: "승인하고 보내기", exact: true }).click();
  await card.getByText("답장 대기", { exact: true }).waitFor();
  assert.deepEqual(last("reason_pipeline_send").args, { input: { pipelineId: "pipe-1", stage: "design", digest: "digest-design", deployApproved: false } });
  assert.equal(await card.getByRole("group").count(), 0, "nothing to approve while waiting for the reply");
  Object.assign(pipeline.stages[0], { status: "replied", replyId: "reply-1", reply: "메인 컬러는 먹색 <img src=x onerror=alert(1)>" });
  await refresh();
  await approval("기획").getByText(/> 메인 컬러는 먹색/).waitFor();
  assert.equal(await card.locator("img").count(), 0, "a reply is quoted as plain text");
  assert.equal(count("reason_pipeline_send"), 1, "a reply never sends the next stage by itself");
  for (const following of ["개발", "음향", "배포"]) {
    await card.getByRole("button", { name: "이 단계 건너뛰기", exact: true }).click();
    await card.getByText(following + " 단계", { exact: true }).waitFor();
  }
  assert.equal(count("reason_pipeline_update"), 3);
  const deploySend = approval("배포").getByRole("button", { name: "승인하고 보내기", exact: true });
  await deploySend.waitFor();
  assert.ok(await deploySend.isDisabled(), "deploy needs its own approval");
  await approval("배포").getByLabel("이 에이전트가 배포를 진행하도록 승인합니다.").check();
  await deploySend.click();
  await approval("배포").getByRole("button", { name: "확인했고 다시 보내기", exact: true }).waitFor();
  assert.ok(await approval("배포").getByRole("button", { name: "확인했고 다시 보내기", exact: true }).isDisabled(), "one tick approves one attempt");
  await card.getByText(/같은 요청이 두 번 갈 수 있습니다/).waitFor();
  assert.equal(last("reason_pipeline_send").args.input.deployApproved, true);
  assert.equal(count("reason_pipeline_send"), 2, "an uncertain send is never repeated automatically");
  await approval("배포").getByRole("button", { name: "보낸 것으로 보고 답장 기다리기", exact: true }).click();
  await card.getByText("답장 대기", { exact: true }).waitFor();
  assert.deepEqual(last("reason_pipeline_update").args.input.action, { type: "assumeSent", stage: "deploy" });
  await card.getByRole("button", { name: "파이프라인 취소", exact: true }).click();
  await card.getByText("취소됨", { exact: true }).waitFor();
  assert.equal(count("reason_pipeline_send"), 2);
  report.checks.push("Stage pipeline: roster-only assignment, digest-only approval, plain-text reply quoting, separate deploy approval, no automatic resend.");

  // Development agent: the host picks and confirms the folder; a cancelled dialog starts nothing.
  const launcher = panel.getByRole("region", { name: "개발 에이전트 실행", exact: true });
  await launcher.getByText(/그 폴더의 파일을 묻지 않고 수정/).waitFor();
  await launcher.getByLabel("실행할 에이전트", { exact: true }).selectOption("codex");
  const launch = launcher.getByRole("button", { name: "폴더 선택 후 실행", exact: true });
  await launch.click();
  await launcher.getByText("0개 실행 중", { exact: true }).waitFor();
  assert.equal(count("reason_agent_launch"), 1);
  assert.equal(await launcher.locator(".reason-sessions li").count(), 0, "a cancelled dialog shows no session");
  launchCancelled = false;
  await launch.click();
  await launcher.getByText("네트워크 등록 대기 중", { exact: true }).waitFor();
  peers.push({ id: "toris/" + agentDraft.name + "@mac-mini", name: agentDraft.name, kind: "codex", machine: "mac-mini", cwd: agentDraft.folder, branch: "main", busy: false });
  await refresh();
  await launcher.getByText("연결됨", { exact: true }).waitFor();
  await launcher.getByRole("button", { name: agentDraft.name + " 중지", exact: true }).click();
  await launcher.getByText("0개 실행 중", { exact: true }).waitFor();
  assert.equal(count("reason_agent_stop"), 1);
  peers.pop();
  await launcher.getByText("다른 AI 연결하기 (피클·Muse·Grok Bot·OpenAI Dots)", { exact: true }).click();
  await launcher.getByRole("button", { name: "커넥터 주소 복사", exact: true }).click();
  assert.equal(copies.at(-1), "https://mcp.reasonmachines.com/mcp");
  await launcher.getByText("다른 AI 연결하기 (피클·Muse·Grok Bot·OpenAI Dots)", { exact: true }).click();
  await refresh();
  report.checks.push("Dev agent launcher: the page sends only the agent kind, a cancelled host dialog starts nothing, status follows the roster, stop works, remote agents get a connector guide.");

  await panel.getByText("AI에게 영상 제작 요청을 보내게 하려면", { exact: true }).click();
  await panel.getByRole("button", { name: "영상 요청 예시 복사", exact: true }).click();
  const example = JSON.parse(copies.at(-1));
  assert.equal(example.schema, "toris-studio.video.v1");
  assert.equal(example.settings.visual, "stock");
  await panel.getByRole("button", { name: "스토리보드 요청 예시 복사", exact: true }).click();
  const storyboardExample = JSON.parse(copies.at(-1));
  assert.equal(storyboardExample.storyboard.scenes.length, 3);
  assert.ok(storyboardExample.storyboard.scenes.every(scene => scene.narration));
  await panel.getByText("AI에게 영상 제작 요청을 보내게 하려면", { exact: true }).click();
  const invalid = panel.getByRole("article", { name: "다른 에이전트의 요청", exact: true });
  assert.equal(await invalid.getByRole("button", { name: "영상 기획 만들기" }).count(), 0);
  const video = panel.getByRole("article", { name: "Muse의 요청", exact: true });
  // Hold a pre-acceptance snapshot until after the acceptance response arrives.
  holdNextRefresh = true; await refresh();
  await page.waitForFunction(async () => window.__qaRefreshIsHeld());
  await video.getByRole("button", { name: "영상 기획 만들기", exact: true }).click();
  await video.getByRole("button", { name: "영상 제작으로 열기", exact: true }).waitFor();
  assert.equal(count("reason_network_accept_video"), 1);
  releaseRefresh(); releaseRefresh = null;
  await panel.getByRole("button", { name: "연결·받은 요청 확인", exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-labelledby="reason-network-title"]')?.getAttribute("aria-busy")?.includes("true"));
  assert.equal(await video.getByRole("button", { name: "영상 기획 만들기", exact: true }).count(), 0, "late pre-acceptance refresh cannot erase the confirmed job");
  await video.getByRole("button", { name: "영상 제작으로 열기", exact: true }).waitFor();
  report.checks.push("A refresh captured before acceptance cannot erase the newly accepted job link when it returns late.");
  assert.equal(count("production_approve"), 0);
  assert.equal(count("production_create"), 0);
  await video.getByRole("button", { name: "영상 제작으로 열기", exact: true }).click();
  await page.getByRole("heading", { name: "Reason에서 받은 영상", exact: true }).waitFor();
  assert.equal(last("production_get").args.input.jobId, job.id);
  assert.equal(count("production_approve"), 0, "opening a job never approves it");
  report.checks.push("Strict video requests create a host job, malformed requests cannot; exact existing job opens for storyboard approval.");

  await openSection(page, "제작", "Agent");
  await video.getByRole("button", { name: "영상 제작으로 열기", exact: true }).waitFor();
  assert.equal(await video.getByRole("button", { name: "영상 기획 만들기", exact: true }).count(), 0, "re-entering retains the host's accepted job");
  const gets = count("production_get");
  await video.getByRole("button", { name: "영상 제작으로 열기", exact: true }).click();
  await page.getByRole("heading", { name: "Reason에서 받은 영상", exact: true }).waitFor();
  assert.ok(count("production_get") > gets, "the same job can be explicitly reopened");
  await openSection(page, "제작", "Agent");
  await video.getByRole("button", { name: "작업 결과 확인", exact: true }).click();
  await video.getByText("30초 영상 생성 완료. 품질 검사 5개 통과.", { exact: true }).waitFor();
  assert.equal(count("reason_network_send_result"), 0);
  await video.getByRole("button", { name: "작업 상태 보내기", exact: true }).click();
  await panel.getByText(/최신 상태 요약을 요청자에게 보냈습니다/).waitFor();
  assert.equal(count("reason_network_send_result"), 1);
  report.checks.push("Job identity survives tab changes; results are queried first and sent only with a separate user action.");

  const imported = panel.getByRole("article", { name: "Dots의 요청", exact: true });
  await imported.getByText("받은 스토리보드 · 3개 장면", { exact: true }).click();
  await imported.getByText("단월의 새로운 업데이트를 소개합니다.", { exact: true }).waitFor();
  assert.equal(await imported.getByRole("button", { name: "영상 기획 만들기", exact: true }).count(), 0);
  await imported.getByRole("button", { name: "스토리보드 가져오기", exact: true }).click();
  await imported.getByRole("button", { name: "영상 제작으로 열기", exact: true }).click();
  await page.getByRole("heading", { name: importedStoryboard.title, exact: true }).waitFor();
  assert.equal(last("production_get").args.input.jobId, importedJob.id);
  assert.equal(count("production_create"), 0);
  assert.equal(count("production_approve"), 0);
  await openSection(page, "제작", "Agent");
  await imported.getByRole("button", { name: "영상 제작으로 열기", exact: true }).waitFor();
  report.checks.push("External storyboard preview preserves narration; explicit import opens the correct draft without production_create or production_approve IPC.");

  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await panel.scrollIntoViewIfNeeded();
    assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "Reason panel does not overflow at " + width);
    if (width === 320) {
      const address = await panel.locator(".reason-address").evaluate(element => {
        const label = element.querySelector("span").getBoundingClientRect();
        const code = element.querySelector("code").getBoundingClientRect();
        const button = element.querySelector("button").getBoundingClientRect();
        return { codeWidth: code.width, labelBottom: label.bottom, codeTop: code.top, codeBottom: code.bottom, buttonTop: button.top };
      });
      assert.ok(address.codeWidth >= 120, "mobile Studio address must have a readable width; got " + address.codeWidth);
      assert.ok(address.labelBottom <= address.codeTop + 1 && address.codeBottom <= address.buttonTop + 1, "mobile address label, code and copy action occupy separate rows");
    }
    await panel.screenshot({ path: resolve(out, "reason-" + width + ".png") });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel.getByLabel("받는 에이전트", { exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(await panel.getByLabel("보낼 메시지", { exact: true }).evaluate(el => document.activeElement === el), true);
  report.checks.push("Panel fits 320/768/1024/1440 widths and form is keyboard navigable.");

  state = "missing"; await refresh();
  await panel.getByText("이 컴퓨터에 Reason Network가 필요합니다.", { exact: true }).waitFor();
  assert.ok(await sendButton.isDisabled());
  assert.equal(await panel.getByRole("button", { name: "주소 복사", exact: true }).count(), 0);
  state = "setup_required"; await refresh();
  await panel.getByText("로그인·네트워크 설정 필요", { exact: true }).waitFor();
  refreshFails = true; await refresh();
  await panel.getByText("Reason 연결이 중단되었습니다.", { exact: true }).waitFor();
  refreshFails = false; responseNull = true; await refresh();
  await panel.getByText(/이 앱에서 Reason 연결 상태를 읽지 못했습니다/).waitFor();
  responseNull = false; state = "connected"; await refresh();
  await panel.getByText("toris/studio@mac-mini", { exact: true }).waitFor();
  report.checks.push("Missing, setup, transport error and legacy null responses remain usable and recover on refresh.");

  assert.equal(calls.some(c => /publish|upload/.test(c.command)), false);
  assert.equal(count("production_create"), 0);
  assert.equal(count("production_approve"), 0);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  console.log(JSON.stringify({ ok: true, checks: report.checks, output: out }, null, 2));
} finally {
  releaseRefresh?.();
  await writeFile(resolve(out, "verification.json"), JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
