#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const out = process.env.TORIS_PUBLICATION_UI_ARTIFACTS || "/private/tmp/toris-publication-ui";
await mkdir(out, { recursive: true });
const now = "2026-10-10T08:00:00Z";
const report = { adapter: "Chromium with explicit native IPC fixtures; no OAuth, AI, upload or publishing network calls", checks: [], errors: [] };
const calls = [];
const profile = { mcpUrl: "http://127.0.0.1:21228/mcp", pluginUrl: "https://chatgpt.com/plugins/plugin_qa", conversationUrl: "", projectRoot: "/tmp/qa-studio", conversationId: "qa-chat" };
const capabilities = { video: true, title: true, description: true, tags: true, hashtags: true, thumbnail: true, thumbnailFrame: true, draft: true, direct: true, directPublicSupported: false };
const accounts = ["youtube", "instagram", "facebook", "threads", "tiktok"].map(platform => ({ platform, accountId: `${platform}-account`, name: `${platform} 검증 계정`, publishingAuthorized: true, capabilities, creatorInfo: platform === "tiktok" ? { privacyLevelOptions: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], commentDisabled: false, duetDisabled: true, stitchDisabled: false, maxVideoPostDurationSec: 180, checkedAt: now } : null }));
const media = [];
let saved, aiRequest, submits = 0, draftToolReady = true;
const server = await createServer({ configFile: resolve("desktop/vite.config.ts"), server: { port: 0, strictPort: false } });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1380, height: 1000 }, reducedMotion: "reduce" });
  page.on("pageerror", error => report.errors.push(error.message));
  await page.exposeFunction("__qaInvoke", async (command, args = {}) => {
    calls.push({ command, args });
    if (command === "get_dashboard") return { channels: [], content: [], trends: [], integrations: [], database: { connected: true, message: "QA" } };
    if (command === "codexify_connection_get") return profile;
    if (command === "codexify_connection_check") return { reachable: true, studioTools: draftToolReady ? ["studio_publication_draft_receive"] : [] };
    if (command === "publication_list") return { publications: saved ? [saved] : [], media, scheduler: { paused: false, running: false, message: "QA" } };
    if (command === "publication_media_sources") return { renders: [{ id: "render-qa", title: "기존 렌더 검증" }], assets: [{ id: "asset-qa", title: "ChatGPT 썸네일 검증" }] };
    if (command === "publication_preview_media") return { path: `qa://${args.id}`, kind: "thumbnail", mimeType: "image/png" };
    if (command === "publication_import_media") {
      const input = args.input;
      const item = { id: `${input.kind}-${input.source || "picker"}-${media.length}`, kind: input.kind, name: input.kind === "video" ? "검증 영상.mp4" : "검증 썸네일.png", bytes: 120000, sha256: "a".repeat(64), mime: input.kind === "video" ? "video/mp4" : "image/png", probe: { width: 1080, height: 1920, durationSeconds: 30 }, createdAt: now };
      media.push(item); return item;
    }
    if (command === "publication_accounts") return { accounts, warnings: [{ platform: "facebook", message: "QA 부분 권한 안내" }], checkedAt: now };
    if (command === "publication_save") { saved = { ...args.input, id: "qa-publication", revision: (saved?.revision || 0) + 1, jobs: saved?.jobs || [], createdAt: now, updatedAt: now }; return saved; }
    if (command === "publication_preflight") {
      const targets = saved.targets.filter(target => args.input.targetIds.includes(target.id));
      const checks = targets.map(target => ({ targetId: target.id, ready: target.platform !== "instagram" || target.options.confirmPublic === true, message: target.platform === "instagram" && target.options.confirmPublic !== true ? "Instagram 공개 게시 동의가 필요합니다." : "실제 게시가 아닌 검증 fixture", details: { warnings: ["QA 필드 적용 안내"] } }));
      return { publicationId: saved.id, revision: saved.revision, approvalHash: `approved-${saved.revision}`, ready: checks.every(check => check.ready), checks, media: { video: media.find(item => item.id === saved.videoMediaId), thumbnail: media.find(item => item.id === saved.thumbnailMediaId) } };
    }
    if (command === "publication_submit") {
      assert.equal(args.input.confirmed, true); assert.equal(args.input.revision, saved.revision); assert.equal(args.input.approvalHash, `approved-${saved.revision}`); submits++;
      saved.jobs = saved.targets.map((target, index) => ({ id: `job-${index}`, targetId: target.id, revision: saved.revision, platform: target.platform, accountId: target.accountId, accountTitle: target.accountTitle, status: target.platform === "tiktok" ? "draft_sent" : target.mode === "scheduled" ? "scheduled" : "published", mode: target.mode, scheduledAt: target.scheduledAt, warnings: [], error: null, updatedAt: now, retryable: false, url: target.platform === "youtube" ? "https://www.youtube.com/watch?v=abcdefghijk" : null })); return saved;
    }
    if (command === "publication_retry" || command === "publication_cancel" || command === "publication_reconcile") {
      const job = saved.jobs.find(item => item.id === args.input.jobId); assert.ok(job); assert.equal(args.input.confirmed, true);
      if (command === "publication_retry") { assert.equal(job.status, "failed"); job.status = "queued"; job.retryable = false; }
      if (command === "publication_cancel") { assert.equal(job.status, "scheduled"); job.status = "cancelled"; }
      if (command === "publication_reconcile" && args.input.resolution === "not_published") { job.status = "needs_confirmation"; job.retryable = false; }
      if (command === "publication_reconcile" && args.input.resolution === "published") { job.status = "published"; job.url = args.input.url; }
      return saved;
    }
    if (command === "publication_ai_request") { aiRequest = { id: "qa-ai-request", ...args.input, status: "waiting", createdAt: now }; return aiRequest; }
    if (command === "publication_ai_drafts") return { requests: aiRequest ? [aiRequest] : [] };
    if (command === "codexify_chats") return { chats: [{ id: "qa-chat", title: "QA", workspace: "qa-studio", projectMatches: true }], serverTimeMs: 1000 };
    if (command === "codexify_chat_read") return { messages: [{ id: "qa-reply", role: "agent", markdown: "ChatGPT에서 받은 검증 응답", start: 1, end: 10, created_at_ms: 1000 }], agent_waiting_until_ms: null, server_time_ms: 1000, delivered_through: 0, read_through: 0 };
    if (command === "codexify_chat_send") return { sent: { id: "qa-sent", end: 20, created_at_ms: 1000 } };
    if (command === "copy_text" || command === "open_external" || command === "publication_set_paused" || command.startsWith("plugin:event|")) return 0;
    if (command === "ai_generate" || command === "ai_status" || command.startsWith("open_webui")) throw new Error(`Forbidden old AI path ${command}`);
    throw new Error(`Unsupported QA IPC ${command}`);
  });
  await page.addInitScript(() => {
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = { invoke: (command, args) => window.__qaInvoke(command, args), transformCallback: () => 1, convertFileSrc: () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", unregisterCallback: () => {} };
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "SNS 일괄 게시", exact: true }).click();
  const studio = page.locator(".publication-studio");
  await studio.getByRole("heading", { name: "한 번 작성하고 채널별로 확인" }).waitFor();
  assert.equal(await studio.getByRole("button", { name: /네이버|^X$/ }).count(), 0);
  await studio.getByRole("button", { name: "MP4 가져오기", exact: true }).click();
  await studio.getByLabel("등록한 게시 영상", { exact: true }).selectOption(media[0].id);
  await studio.getByRole("button", { name: "썸네일 가져오기", exact: true }).click();
  await studio.getByLabel("게시 공통 제목", { exact: true }).fill("주제 기반 영상");
  await studio.getByLabel("게시 공통 설명", { exact: true }).fill("검증 설명과 출처");
  await studio.getByLabel("게시 공통 태그", { exact: true }).pressSequentially("AI, 생산성");
  await studio.getByLabel("게시 공통 해시태그", { exact: true }).pressSequentially("#AI #생산성");
  await studio.getByRole("button", { name: "계정 조회", exact: true }).click();
  await studio.getByRole("button", { name: "YouTube", exact: true }).click();
  await studio.getByRole("button", { name: "TikTok", exact: true }).click();
  await studio.getByRole("button", { name: "Instagram Reels", exact: true }).click();
  await studio.getByLabel("YouTube 게시 계정", { exact: true }).selectOption("youtube-account");
  await studio.getByLabel("TikTok 게시 계정", { exact: true }).selectOption("tiktok-account");
  await studio.getByLabel("Instagram Reels 게시 계정", { exact: true }).selectOption("instagram-account");
  const instagram = studio.getByRole("region", { name: "Instagram Reels 게시 설정", exact: true });
  const instagramConsent = instagram.getByLabel("선택한 계정에 콘텐츠를 공개 게시하는 것을 확인했습니다.", { exact: true });
  assert.equal(await instagramConsent.isChecked(), false);
  assert.equal(await studio.getByLabel("TikTok 공개 범위", { exact: true }).inputValue(), "");
  assert.equal(await studio.getByLabel("댓글 허용", { exact: true }).isChecked(), false);
  assert.equal(await studio.getByLabel("Duet 허용 · 계정에서 비활성", { exact: true }).isDisabled(), true);
  await studio.getByLabel("TikTok 게시 방식", { exact: true }).selectOption("tiktok_inbox");
  await studio.getByLabel("TikTok 음악 사용 확인", { exact: false }).check();
  await studio.getByLabel("표시된 계정·캡션·공개 범위와 TikTok 전송에 동의합니다.", { exact: true }).check();
  await studio.getByRole("button", { name: "사전 검사·대상 확인", exact: true }).click();
  await studio.locator(".publication-checks .blocked").filter({ hasText: "Instagram 공개 게시 동의가 필요합니다." }).waitFor();
  assert.equal(saved.targets.find(target => target.platform === "instagram").options.confirmPublic, false);
  assert.equal(await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).count(), 0);
  await instagramConsent.check();
  await studio.getByRole("button", { name: "사전 검사·대상 확인", exact: true }).click();
  await studio.getByText("승인할 파일과 게시 대상", { exact: true }).waitFor();
  assert.equal(saved.targets.find(target => target.platform === "instagram").options.confirmPublic, true);
  assert.equal(await studio.locator(".publication-checks .blocked").count(), 0);
  report.checks.push("Instagram public-post consent starts unchecked, blocks preflight until selected, and persists for the approved account");
  assert.equal(await studio.getByText("Facebook Page · QA 부분 권한 안내", { exact: true }).count(), 1);
  assert.equal(await studio.getByText("QA 필드 적용 안내", { exact: true }).count(), 3);
  assert.deepEqual(saved.tags, ["AI", "생산성"]); assert.deepEqual(saved.hashtags, ["AI", "생산성"]);
  assert.equal(saved.targets.find(target => target.platform === "tiktok").options.mode, "draft");
  const approval = studio.getByLabel("영상·문구·권한·대상 계정과 일정을 확인했으며 실제 전송·예약에 동의합니다.", { exact: true });
  assert.equal(await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).isDisabled(), true);
  await approval.check();
  await studio.getByLabel("게시 공통 제목", { exact: true }).fill("수정하면 재승인");
  assert.equal(await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).count(), 0);
  assert.equal(submits, 0);
  report.checks.push("Five selected destinations only; video/thumbnail import; editable tags; TikTok privacy no default and disabled duet; input edit invalidates persisted approval");
  await studio.getByRole("button", { name: "사전 검사·대상 확인", exact: true }).click();
  await approval.check();
  await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).click();
  await studio.getByText("초안 전송 완료", { exact: true }).waitFor();
  assert.equal(await studio.getByText("게시 확인됨", { exact: true }).count(), 2);
  assert.equal(await studio.getByRole("button", { name: "실패 대상 재시도", exact: true }).count(), 0);
  report.checks.push("Explicit reviewed revision submitted; YouTube published and TikTok draft-sent are distinct; successes offer no retry");
  saved.jobs[0].status = "failed"; saved.jobs[0].retryable = true; saved.jobs[0].error = "QA 권한 만료";
  await page.getByRole("button", { name: "워크스페이스 새로고침", exact: true }).click();
  await studio.getByRole("button", { name: "실패 대상 재시도", exact: true }).click();
  const jobConfirm = studio.getByRole("region", { name: "게시 작업 결과 확인", exact: true });
  assert.equal(await jobConfirm.getByRole("button", { name: "확인하고 실행", exact: true }).isDisabled(), true);
  await jobConfirm.getByLabel("표시된 콘텐츠와 대상의 현재 결과를 확인했습니다.", { exact: true }).check();
  await jobConfirm.getByRole("button", { name: "확인하고 실행", exact: true }).click();
  const retry = calls.filter(item => item.command === "publication_retry").at(-1);
  assert.equal(retry.args.input.jobId, "job-0"); assert.equal(saved.jobs[1].status, "draft_sent");
  report.checks.push("Partial failure retry requires destination review and affects only the failed job");
  saved.jobs[0].status = "uncertain"; saved.jobs[0].retryable = false;
  await page.getByRole("button", { name: "워크스페이스 새로고침", exact: true }).click();
  await studio.getByRole("button", { name: "결과 재확인", exact: true }).click();
  await studio.getByLabel("불명확한 게시 결과 확인 방식", { exact: true }).selectOption("published");
  await studio.getByLabel("직접 확인한 SNS 게시 URL", { exact: true }).fill("https://www.youtube.com/watch?v=abcdefghijk");
  await jobConfirm.getByLabel("표시된 콘텐츠와 대상의 현재 결과를 확인했습니다.", { exact: true }).check();
  await jobConfirm.getByRole("button", { name: "확인하고 실행", exact: true }).click();
  assert.equal(saved.jobs[0].status, "published");
  assert.equal(calls.filter(item => item.command === "publication_submit").length, 1);
  report.checks.push("Uncertain result reconciles with explicit external publication URL without resending");

  await studio.getByRole("button", { name: "초안 열기·수정", exact: true }).click();
  draftToolReady = false;
  await studio.getByRole("button", { name: "ChatGPT로 문구 작성", exact: true }).click();
  await studio.getByText(/SNS 초안 수신 도구가 연결되지 않았습니다/).waitFor();
  assert.equal(calls.filter(item => item.command === "publication_ai_request" || item.command === "codexify_chat_send").length, 0);
  draftToolReady = true;
  report.checks.push("Missing SNS draft MCP tool prevents sending and shows reconnection instructions");
  await studio.getByRole("button", { name: "ChatGPT로 문구 작성", exact: true }).click();
  await studio.getByText("요청 저장 · 실제 수신 대기", { exact: true }).waitFor();
  await studio.getByText("요청을 저장했습니다. 종료된 ChatGPT 대화에서 시작·재개한 뒤 응답을 확인하세요.", { exact: true }).waitFor();
  assert.match(calls.find(item => item.command === "codexify_chat_send").args.input.message, /studio_publication_draft_receive/);
  aiRequest.status = "received"; aiRequest.receivedAt = now; aiRequest.draft = { title: "수신한 ChatGPT 제목", description: "사용자가 적용해야 하는 초안", tags: ["검증"], hashtags: ["초안"] };
  await page.getByRole("button", { name: "워크스페이스 새로고침", exact: true }).click();
  await studio.getByRole("button", { name: "초안 적용", exact: true }).click();
  assert.equal(await studio.getByLabel("게시 공통 제목", { exact: true }).inputValue(), "수신한 ChatGPT 제목");
  assert.equal(submits, 1);
  report.checks.push("Actual ChatGPT request path uses request-bound draft receiver; explicit draft apply remains editable and unapproved");
  const checkbox = studio.getByLabel("이 채널의 문구를 따로 편집", { exact: true }).first();
  assert.equal(await checkbox.locator("..").evaluate(element => getComputedStyle(element).display), "flex");
  await studio.getByLabel("YouTube 게시 방식", { exact: true }).selectOption("scheduled");
  await studio.getByLabel("YouTube 예약 일시", { exact: true }).fill("2030-12-31T09:30");
  await studio.getByRole("button", { name: "초안 저장", exact: true }).click();
  assert.equal(saved.targets.find(target => target.platform === "youtube").scheduledAt, "2030-12-31T00:30:00.000Z");
  report.checks.push("KST reservation input persists UTC and checkbox labels remain aligned horizontally");

  await page.screenshot({ path: resolve(out, "publication-compose.png"), fullPage: true });
  await page.setViewportSize({ width: 820, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: resolve(out, "publication-narrow.png"), fullPage: true });
  report.checks.push("Narrow 820px layout has no horizontal page overflow");
  await page.getByRole("button", { name: "AI 작업실", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "AI로 작성", exact: true }).count(), 0);
  assert.equal(await page.getByText("직접 작성에 사용할 로컬 AI 제공자", { exact: false }).count(), 0);
  await page.getByRole("button", { name: "ChatGPT 최근 응답 가져오기", exact: true }).click();
  // This textarea gets its accessible name from <label htmlFor>, not aria-label.
  await page.waitForFunction(() => document.getElementById("social-ai-manual-output")?.value === "ChatGPT에서 받은 검증 응답");
  assert.equal(await page.getByLabel("ChatGPT 결과 붙여넣기·편집", { exact: true }).inputValue(), "ChatGPT에서 받은 검증 응답");
  assert.equal(calls.some(item => item.command === "ai_generate" || item.command === "ai_status" || item.command.startsWith("open_webui")), false);
  report.checks.push("Desktop AI path never calls local providers/Open WebUI; ChatGPT response can be imported and edited");
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(resolve(out, "verification.json"), JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
