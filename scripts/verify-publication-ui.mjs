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
const capabilities = { video: true, title: true, description: true, tags: true, hashtags: true, thumbnail: true, thumbnailFrame: true, draft: true, direct: true, directPublicSupported: false };
const accounts = ["youtube", "instagram", "facebook", "threads", "tiktok"].map(platform => ({ platform, accountId: `${platform}-account`, name: `${platform} 검증 계정`, publishingAuthorized: true, capabilities, creatorInfo: platform === "tiktok" ? { privacyLevelOptions: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], commentDisabled: false, duetDisabled: true, stitchDisabled: false, maxVideoPostDurationSec: 180, checkedAt: now } : null }));
const media = [];
let fixturePublicationSequence = 0;
let saved, aiRequest, submits = 0, modelFails = false;
const prompts = [];
const server = await createServer({ configFile: resolve("desktop/vite.config.ts"), server: { port: 0, strictPort: false } });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1380, height: 1000 }, reducedMotion: "reduce" });
  page.on("pageerror", error => report.errors.push(error.message));
  await page.exposeFunction("__qaInvoke", async (command, args = {}) => {
    calls.push({ command, args });
    if (command === "get_dashboard") return { channels: [], content: [], trends: [], integrations: [], database: { connected: true, message: "QA" } };
    if (command === "ai_status") return { providers: [{ id: "codex-cli", label: "Codex CLI", kind: "subscription", available: true, detail: "QA", suggestedModels: [] }], contentModel: { provider: "codex-cli", model: "" }, agentModel: null, image: null };
    if (command === "ai_generate") {
      if (modelFails) throw new Error("codex 실행 실패 (코드 1): Not logged in");
      prompts.push(args.input.prompt);
      return { text: '초안입니다.\n```json\n{"title":"AI가 쓴 제목","description":"사용자가 적용해야 하는 초안","tags":["검증"],"hashtags":["#초안"]}\n```', provider: "codex-cli", model: "" };
    }
    if (command === "publication_ai_receive") { aiRequest = { ...aiRequest, status: "received", receivedAt: now, draft: { title: args.input.title, description: args.input.description, tags: args.input.tags, hashtags: args.input.hashtags } }; return aiRequest; }
    if (command === "publication_list") return { publications: saved ? [saved] : [], media, scheduler: { paused: false, running: false, message: "QA" } };
    if (command === "publication_media_sources") return { renders: [{ id: "render-qa", title: "기존 렌더 검증" }], assets: [{ id: "asset-qa", title: "ChatGPT 썸네일 검증" }] };
    if (command === "publication_preview_media") return { path: `qa://${args.id}`, kind: "thumbnail", mimeType: "image/png" };
    if (command === "publication_import_media") {
      const input = args.input;
      const item = { id: `${input.kind}-${input.source || "picker"}-${media.length}`, kind: input.kind, name: input.kind === "video" ? "검증 영상.mp4" : "검증 썸네일.png", bytes: 120000, sha256: "a".repeat(64), mime: input.kind === "video" ? "video/mp4" : "image/png", probe: { width: 1080, height: 1920, durationSeconds: 30 }, createdAt: now };
      media.push(item); return item;
    }
    if (command === "publication_accounts") return { accounts, warnings: [{ platform: "facebook", message: "QA 부분 권한 안내" }], checkedAt: now };
    if (command === "publication_save") {
      const previous = saved;
      const editing = args.input.id != null;
      if (editing) {
        assert.ok(previous);
        assert.equal(args.input.id, previous.id);
        assert.equal(args.input.revision, previous.revision);
      }
      saved = {
        ...args.input,
        id: editing ? previous.id : `qa-publication-${++fixturePublicationSequence}`,
        revision: editing ? previous.revision + 1 : 1,
        jobs: editing ? structuredClone(previous.jobs || []) : [],
        createdAt: editing ? previous.createdAt : now,
        updatedAt: now,
      };
      return saved;
    }
    if (command === "publication_preflight") {
      const targets = saved.targets.filter(target => args.input.targetIds.includes(target.id));
      const checks = targets.map(target => ({ targetId: target.id, ready: target.platform === "naver_blog" ? target.options.confirmHandoff === true : target.platform !== "instagram" || target.options.confirmPublic === true, message: target.platform === "instagram" && target.options.confirmPublic !== true ? "Instagram 공개 게시 동의가 필요합니다." : target.platform === "naver_blog" && target.options.confirmHandoff !== true ? "수동 인계 확인이 필요합니다." : "실제 게시가 아닌 검증 fixture", details: { warnings: ["QA 필드 적용 안내"] } }));
      return { publicationId: saved.id, revision: saved.revision, approvalHash: `approved-${saved.revision}`, ready: checks.every(check => check.ready), checks, media: { video: media.find(item => item.id === saved.videoMediaId), thumbnail: media.find(item => item.id === saved.thumbnailMediaId) } };
    }
    if (command === "publication_submit") {
      const input = args.input;
      assert.equal(input.confirmed, true);
      assert.equal(input.publicationId, saved.id);
      assert.equal(input.revision, saved.revision);
      assert.equal(input.approvalHash, `approved-${saved.revision}`);
      assert.ok(Array.isArray(input.targetIds) && input.targetIds.length > 0);
      assert.equal(new Set(input.targetIds).size, input.targetIds.length);
      const selected = saved.targets.filter(target => input.targetIds.includes(target.id));
      assert.equal(selected.length, input.targetIds.length);
      const inspected = calls.filter(call => call.command === "publication_preflight").at(-1)?.args.input;
      assert.ok(inspected);
      assert.equal(inspected.publicationId, saved.id);
      assert.equal(inspected.revision, saved.revision);
      assert.deepEqual(input.targetIds, inspected.targetIds);
      const previous = saved.jobs || [];
      for (const target of selected) {
        const prior = previous.find(job => job.targetId === target.id && job.revision === saved.revision);
        assert.ok(!prior || ["cancelled", "needs_confirmation"].includes(prior.status));
      }
      const created = selected.map(target => {
        const prior = previous.find(job => job.targetId === target.id && job.revision === saved.revision);
        const status = target.platform === "naver_blog" ? "needs_human_publish" : target.mode === "scheduled" ? "scheduled" : target.platform === "tiktok" ? target.mode === "tiktok_inbox" ? "draft_sent" : "processing" : "published";
        return {
          id: prior?.id || `job-${saved.id}-${saved.revision}-${target.id}`,
          targetId: target.id, revision: saved.revision, platform: target.platform,
          accountId: target.accountId, accountTitle: target.accountTitle,
          status, mode: target.mode, scheduledAt: target.scheduledAt,
          warnings: [], error: null, updatedAt: now, retryable: false,
          url: target.platform === "youtube" && status === "published" ? "https://www.youtube.com/watch?v=abcdefghijk" : null,
        };
      });
      const retained = previous.filter(job => !(job.revision === saved.revision && input.targetIds.includes(job.targetId)));
      saved = { ...saved, jobs: [...retained, ...created] };
      submits++;
      return saved;
    }
    if (command === "publication_export_handoff") return { path: "/explicit-ipc-fixture/not-a-real-export", status: "needs_human_publish", images: 1 };
    if (command === "publication_confirm_handoff") {
      assert.equal(args.input.confirmed, true);
      const job = saved.jobs.find(item => item.id === args.input.jobId);
      assert.equal(job.status, "needs_human_publish");
      if (args.input.url !== "https://blog.naver.com/my_blog/12345") throw new Error("대상 블로그의 개별 게시글 URL을 입력하세요.");
      job.status = "published"; job.verification = "user_confirmed"; job.url = args.input.url;
      return saved;
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
    if (command === "copy_text" || command === "open_external" || command === "publication_set_paused" || command.startsWith("plugin:event|")) return 0;
    if (command.startsWith("open_webui") || command.startsWith("codexify_")) throw new Error(`Forbidden removed AI path ${command}`);
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
  await studio.getByText(/미심사 앱은 비공개 계정의 SELF_ONLY/).waitFor({ timeout: 5000 });
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
  const approval = studio.getByLabel("파일·문구·대상과 처리 방식을 확인했으며 선택한 전송 또는 수동 인계 등록에 동의합니다.", { exact: true });
  assert.equal(await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).isDisabled(), true);
  await approval.check();
  await studio.getByLabel("게시 공통 제목", { exact: true }).fill("수정하면 재승인");
  assert.equal(await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).count(), 0);
  assert.equal(submits, 0);
  report.checks.push("Selected video destinations; video/thumbnail import; editable tags; TikTok privacy no default and disabled duet; input edit invalidates persisted approval");
  await studio.getByRole("button", { name: "사전 검사·대상 확인", exact: true }).click();
  await approval.check();
  await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).click();
  await studio.getByText("초안 전송 완료", { exact: true }).waitFor();
  assert.equal(await studio.getByText("게시 확인됨", { exact: true }).count(), 2);
  assert.equal(await studio.getByRole("button", { name: "실패 대상 재시도", exact: true }).count(), 0);
  report.checks.push("Explicit reviewed revision submitted; YouTube published and TikTok draft-sent are distinct; successes offer no retry");
  const firstYouTubeJobId = saved.jobs.find(job => job.platform === "youtube").id;
  saved.jobs[0].status = "failed"; saved.jobs[0].retryable = true; saved.jobs[0].error = "QA 권한 만료";
  await page.getByRole("button", { name: "워크스페이스 새로고침", exact: true }).click();
  await studio.getByRole("button", { name: "실패 대상 재시도", exact: true }).click();
  const jobConfirm = studio.getByRole("region", { name: "게시 작업 결과 확인", exact: true });
  assert.equal(await jobConfirm.getByRole("button", { name: "확인하고 실행", exact: true }).isDisabled(), true);
  await jobConfirm.getByLabel("표시된 콘텐츠와 대상의 현재 결과를 확인했습니다.", { exact: true }).check();
  await jobConfirm.getByRole("button", { name: "확인하고 실행", exact: true }).click();
  const retry = calls.filter(item => item.command === "publication_retry").at(-1);
  assert.equal(retry.args.input.jobId, firstYouTubeJobId); assert.equal(saved.jobs[1].status, "draft_sent");
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
  modelFails = true;
  await studio.getByRole("button", { name: "AI로 문구 작성", exact: true }).click();
  await studio.getByText(/Not logged in/).waitFor();
  assert.equal(calls.filter(item => item.command === "publication_ai_receive").length, 0);
  modelFails = false;
  report.checks.push("A model failure surfaces its reason and stores no draft");
  await studio.getByRole("button", { name: "AI로 문구 작성", exact: true }).click();
  await studio.getByText(/초안을 받았습니다/).waitFor();
  assert.equal(calls.filter(item => item.command === "publication_ai_receive").at(-1).args.input.requestId, aiRequest.id);
  await studio.getByRole("button", { name: "초안 적용", exact: true }).click();
  assert.equal(await studio.getByLabel("게시 공통 제목", { exact: true }).inputValue(), "AI가 쓴 제목");
  assert.equal(submits, 1);
  report.checks.push("AI copy is generated, stored against the app request, and applied only on explicit click without approval");
  const checkbox = studio.getByLabel("이 채널의 문구를 따로 편집", { exact: true }).first();
  assert.equal(await checkbox.locator("..").evaluate(element => getComputedStyle(element).display), "flex");
  await studio.getByLabel("YouTube 게시 방식", { exact: true }).selectOption("scheduled");
  await studio.getByLabel("YouTube 예약 일시", { exact: true }).fill("2030-12-31T09:30");
  await studio.getByRole("button", { name: "초안 저장", exact: true }).click();
  assert.equal(saved.targets.find(target => target.platform === "youtube").scheduledAt, "2030-12-31T00:30:00.000Z");
  report.checks.push("KST reservation input persists UTC and checkbox labels remain aligned horizontally");

  await studio.getByRole("button", { name: "새 초안", exact: true }).click();
  await studio.getByLabel("게시 공통 제목", { exact: true }).fill("세 채널 일괄 예약 검증");
  await studio.getByLabel("등록한 게시 영상", { exact: true }).selectOption(media[0].id);
  for (const [label, platform] of [["Instagram Reels", "instagram"], ["Facebook Page", "facebook"], ["Threads", "threads"]]) {
    await studio.getByRole("button", { name: label, exact: true }).click();
    await studio.getByLabel(`${label} 게시 계정`, { exact: true }).selectOption(`${platform}-account`);
  }
  const batch = studio.getByRole("region", { name: "채널 일괄 예약", exact: true });
  await batch.waitFor({ timeout: 5000 });
  await batch.getByLabel("일괄 예약 시작 일시 · KST", { exact: true }).fill("2030-12-31T09:30");
  await batch.getByLabel("채널 사이 간격 · 분", { exact: true }).fill("15");
  const savesBeforeBatch = calls.filter(item => item.command === "publication_save").length;
  await batch.getByRole("button", { name: "예약 시간을 초안에 적용", exact: true }).click();
  for (const [index, label] of ["Instagram Reels", "Facebook Page", "Threads"].entries()) {
    assert.equal(await studio.getByLabel(`${label} 게시 방식`, { exact: true }).inputValue(), "scheduled");
    assert.equal(await studio.getByLabel(`${label} 예약 일시`, { exact: true }).inputValue(), ["2030-12-31T09:30", "2030-12-31T09:45", "2030-12-31T10:00"][index]);
  }
  assert.equal(calls.filter(item => item.command === "publication_save").length, savesBeforeBatch);
  assert.equal(calls.filter(item => item.command === "publication_submit").length, 1);
  assert.equal(await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).count(), 0);
  await studio.getByRole("button", { name: "초안 저장", exact: true }).click();
  assert.deepEqual(saved.targets.map(target => target.scheduledAt), ["2030-12-31T00:30:00.000Z", "2030-12-31T00:45:00.000Z", "2030-12-31T01:00:00.000Z"]);
  for (const consent of await studio.getByLabel("선택한 계정에 콘텐츠를 공개 게시하는 것을 확인했습니다.", { exact: true }).all()) await consent.check();
  await studio.getByRole("button", { name: "사전 검사·대상 확인", exact: true }).click();
  await approval.check();
  assert.equal(await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).isEnabled(), true);
  await batch.getByLabel("채널 사이 간격 · 분", { exact: true }).fill("0");
  await batch.getByRole("button", { name: "예약 시간을 초안에 적용", exact: true }).click();
  assert.equal(await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).count(), 0);
  assert.equal(await studio.getByLabel("Threads 예약 일시", { exact: true }).inputValue(), "2030-12-31T09:30");
  assert.equal(calls.filter(item => item.command === "publication_submit").length, 1);
  report.checks.push("Batch schedule applies three KST slots to drafts only, persists UTC on explicit save, and invalidates earlier preflight/consent without submitting");

  await studio.getByRole("button", { name: "초안 저장", exact: true }).click();
  await studio.getByRole("button", { name: "새 초안", exact: true }).click();
  await studio.getByLabel("게시 콘텐츠 종류", { exact: true }).selectOption("text", { timeout: 5000 });
  assert.equal(await studio.getByRole("button", { name: "MP4 가져오기", exact: true }).count(), 0);
  assert.equal(await studio.getByRole("button", { name: "Instagram Reels", exact: true }).count(), 0);
  assert.equal(await studio.getByRole("button", { name: "TikTok", exact: true }).count(), 0);
  await studio.getByText("TikTok은 영상 콘텐츠에서 선택할 수 있습니다. 이 릴리스는 TikTok 텍스트·사진 게시를 지원하지 않습니다.", { exact: true }).waitFor({ timeout: 5000 });
  await studio.getByLabel("게시 공통 제목", { exact: true }).fill("텍스트 게시 검증");
  await studio.getByLabel("게시 공통 설명", { exact: true }).fill("영상 없는 본문");
  for (const [label, platform] of [["Facebook Page", "facebook"], ["Threads", "threads"]]) {
    await studio.getByRole("button", { name: label, exact: true }).click();
    await studio.getByLabel(`${label} 게시 계정`, { exact: true }).selectOption(`${platform}-account`);
  }
  for (const consent of await studio.getByLabel("선택한 계정에 콘텐츠를 공개 게시하는 것을 확인했습니다.", { exact: true }).all()) await consent.check();
  await studio.getByRole("button", { name: "사전 검사·대상 확인", exact: true }).click();
  assert.equal(saved.contentKind, "text"); assert.equal(saved.videoMediaId, null);
  report.checks.push("Text content offers Page/Threads without video controls and persists its content kind with no MP4");
  const promptsBefore = prompts.length;
  await studio.getByRole("button", { name: "AI로 문구 작성", exact: true }).click();
  await studio.getByText(/초안을 받았습니다/).waitFor();
  assert.equal(prompts.length, promptsBefore + 1);
  assert.equal(JSON.parse(aiRequest.context).contentKind, "text");
  assert.deepEqual(JSON.parse(aiRequest.context).targets, ["facebook", "threads"]);
  assert.match(prompts.at(-1), /콘텐츠 종류.*선택된 채널/);
  assert.equal(submits, 1);
  report.checks.push("AI draft requests carry the current content kind and selected channels without assuming video or approving publication");
  await studio.getByRole("button", { name: "새 초안", exact: true }).click();
  await studio.getByLabel("게시 콘텐츠 종류", { exact: true }).selectOption("article");
  await studio.getByLabel("게시 공통 제목", { exact: true }).fill("블로그 인계 검증");
  await studio.getByLabel("게시 공통 설명", { exact: true }).fill("직접 게시할 블로그 원고");
  await studio.getByRole("button", { name: "네이버 블로그 · 수동 인계", exact: true }).click();
  await studio.getByLabel("네이버 블로그 ID", { exact: true }).fill("my_blog");
  const handoffConsent = studio.getByLabel("자동 게시가 아닌 네이버 수동 게시 인계임을 확인했습니다.", { exact: true });
  assert.equal(await handoffConsent.isChecked(), false);
  await studio.getByRole("button", { name: "블로그 이미지 가져오기", exact: true }).click();
  await studio.getByRole("button", { name: "사전 검사·대상 확인", exact: true }).click();
  await studio.locator(".publication-checks .blocked").filter({ hasText: "수동 인계 확인이 필요합니다." }).waitFor();
  await handoffConsent.check();
  await studio.getByRole("button", { name: "사전 검사·대상 확인", exact: true }).click();
  assert.equal(saved.targets[0].mode, "manual_handoff"); assert.equal(saved.imageMediaIds.length, 1);
  await approval.check();
  await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).click();
  await studio.getByText("수동 게시 필요", { exact: true }).waitFor();
  await studio.getByRole("button", { name: "인계 자료 내보내기", exact: true }).click();
  await studio.getByText(/explicit-ipc-fixture\/not-a-real-export/).waitFor();
  assert.equal(saved.jobs[0].status, "needs_human_publish");
  await studio.getByRole("button", { name: "수동 게시 완료 기록", exact: true }).click();
  await studio.getByLabel("직접 확인한 네이버 게시 URL", { exact: true }).fill("https://blog.naver.com/other/12345");
  await jobConfirm.getByLabel("표시된 콘텐츠와 대상의 현재 결과를 확인했습니다.", { exact: true }).check();
  await jobConfirm.getByRole("button", { name: "확인하고 실행", exact: true }).click();
  await studio.getByText("대상 블로그의 개별 게시글 URL을 입력하세요.", { exact: true }).waitFor();
  assert.equal(saved.jobs[0].status, "needs_human_publish");
  await studio.getByLabel("직접 확인한 네이버 게시 URL", { exact: true }).fill("https://blog.naver.com/my_blog/12345");
  await jobConfirm.getByLabel("표시된 콘텐츠와 대상의 현재 결과를 확인했습니다.", { exact: true }).check();
  await jobConfirm.getByRole("button", { name: "확인하고 실행", exact: true }).click();
  await studio.getByText("사용자 직접 확인 · API 검증 아님", { exact: true }).waitFor();
  assert.equal(saved.jobs[0].verification, "user_confirmed");
  assert.equal(calls.filter(item => item.command === "publication_begin_login" && item.args.platform === "naver_blog").length, 0);
  report.checks.push("Naver manual consent starts false; image export stays pending; completion requires a matching URL and remains explicitly user-verified, not API-verified (IPC fixtures)");

  const submitsBeforeTikTok = submits;
  await studio.getByRole("button", { name: "콘텐츠 작성", exact: true }).click();
  await studio.getByRole("button", { name: "새 초안", exact: true }).click();
  await studio.getByLabel("게시 공통 제목", { exact: true }).fill("TikTok 승인형 영상 예약");
  await studio.getByLabel("등록한 게시 영상", { exact: true }).selectOption(media[0].id);
  for (const [label, platform] of [["YouTube", "youtube"], ["TikTok", "tiktok"]]) {
    await studio.getByRole("button", { name: label, exact: true }).click();
    await studio.getByLabel(`${label} 게시 계정`, { exact: true }).selectOption(`${platform}-account`);
  }
  assert.deepEqual(await studio.getByLabel("TikTok 공개 범위", { exact: true }).locator("option").evaluateAll(options => options.map(option => option.value)), ["", "SELF_ONLY"]);
  await studio.getByLabel("TikTok 게시 방식", { exact: true }).selectOption("tiktok_inbox");
  await batch.getByLabel("일괄 예약 시작 일시 · KST", { exact: true }).fill("2030-12-31T09:30");
  await batch.getByLabel("채널 사이 간격 · 분", { exact: true }).fill("15");
  await batch.getByRole("button", { name: "예약 시간을 초안에 적용", exact: true }).click();
  assert.equal(await studio.getByLabel("YouTube 게시 방식", { exact: true }).inputValue(), "scheduled");
  assert.equal(await studio.getByLabel("TikTok 게시 방식", { exact: true }).inputValue(), "tiktok_inbox");
  assert.equal(await studio.getByLabel("TikTok 예약 일시", { exact: true }).count(), 0);
  assert.equal(submits, submitsBeforeTikTok);
  report.checks.push("TikTok inbox remains a user-finished draft and is excluded from automatic batch scheduling");

  await studio.getByLabel("TikTok 게시 방식", { exact: true }).selectOption("scheduled");
  await batch.getByRole("button", { name: "예약 시간을 초안에 적용", exact: true }).click();
  assert.equal(await studio.getByLabel("TikTok 예약 일시", { exact: true }).inputValue(), "2030-12-31T09:45");
  await studio.getByLabel("TikTok 공개 범위", { exact: true }).selectOption("SELF_ONLY");
  await studio.getByLabel("TikTok 음악 사용 확인", { exact: false }).check();
  await studio.getByLabel("표시된 계정·캡션·공개 범위와 TikTok 전송에 동의합니다.", { exact: true }).check();
  await studio.getByRole("button", { name: "사전 검사·대상 확인", exact: true }).click();
  const tiktokTarget = saved.targets.find(target => target.platform === "tiktok");
  assert.equal(tiktokTarget.options.mode, "direct");
  assert.equal(tiktokTarget.options.privacy, "SELF_ONLY");
  assert.equal(tiktokTarget.scheduledAt, "2030-12-31T00:45:00.000Z");
  assert.equal(submits, submitsBeforeTikTok);
  await approval.check();
  await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).click();
  const tiktokJob = saved.jobs.find(job => job.platform === "tiktok");
  assert.equal(tiktokJob.status, "scheduled");
  assert.equal(tiktokJob.mode, "scheduled");
  assert.equal(submits, submitsBeforeTikTok + 1);
  report.checks.push("TikTok Direct keeps explicitly selected SELF_ONLY privacy and KST-to-UTC slot; only reviewed approval creates a scheduled job (IPC fixture, not an API post)");

  await studio.getByRole("button", { name: "콘텐츠 작성", exact: true }).click();
  await page.screenshot({ path: resolve(out, "publication-compose.png"), fullPage: true });
  await page.setViewportSize({ width: 820, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: resolve(out, "publication-narrow.png"), fullPage: true });
  report.checks.push("Narrow 820px layout has no horizontal page overflow");
  await page.setViewportSize({ width: 1380, height: 1000 });
  const precedingPublicationId = saved.id;
  await studio.getByRole("button", { name: "새 초안", exact: true }).click();
  await studio.getByLabel("게시 공통 제목", { exact: true }).fill("부분 대상 승인 회귀");
  await studio.getByLabel("등록한 게시 영상", { exact: true }).selectOption(media[0].id);
  for (const [label, platform] of [["YouTube", "youtube"], ["Instagram Reels", "instagram"], ["TikTok", "tiktok"]]) {
    await studio.getByRole("button", { name: label, exact: true }).click();
    await studio.getByLabel(`${label} 게시 계정`, { exact: true }).selectOption(`${platform}-account`);
  }
  await studio.getByLabel("TikTok 게시 방식", { exact: true }).selectOption("tiktok_inbox");
  await studio.getByLabel("TikTok 음악 사용 확인", { exact: false }).check();
  await studio.getByLabel("표시된 계정·캡션·공개 범위와 TikTok 전송에 동의합니다.", { exact: true }).check();
  await studio.getByRole("button", { name: "초안 저장", exact: true }).click();
  assert.notEqual(saved.id, precedingPublicationId);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.jobs, []);
  report.checks.push("Fresh draft fixture gets a new identity/revision and never inherits another publication's jobs");
  const subset = studio.getByRole("group", { name: "이번에 검사·승인할 대상", exact: true });
  const chooseYouTube = subset.getByRole("checkbox", { name: /^YouTube ·/ });
  const chooseInstagram = subset.getByRole("checkbox", { name: /^Instagram Reels ·/ });
  const chooseTikTok = subset.getByRole("checkbox", { name: /^TikTok ·/ });
  await chooseInstagram.uncheck();
  await chooseTikTok.uncheck();
  const subsetTargets = Object.fromEntries(saved.targets.map(target => [target.platform, target.id]));
  const subsetSubmitsBefore = submits;
  await studio.getByRole("button", { name: "사전 검사·대상 확인", exact: true }).click();
  await studio.locator(".publication-checks > p > strong").first().waitFor();
  assert.deepEqual(calls.filter(call => call.command === "publication_preflight").at(-1).args.input.targetIds, [subsetTargets.youtube]);
  assert.deepEqual(await studio.locator(".publication-checks > p > strong").allTextContents(), ["YouTube"]);
  assert.equal(await studio.locator(".publication-checks .blocked").count(), 0);
  await approval.check();
  await chooseTikTok.check();
  assert.equal(await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).count(), 0);
  assert.equal(submits, subsetSubmitsBefore);
  await chooseTikTok.uncheck();
  await studio.getByRole("button", { name: "사전 검사·대상 확인", exact: true }).click();
  assert.equal(await approval.isChecked(), false);
  await approval.check();
  await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).click();
  const firstSubsetInput = calls.filter(call => call.command === "publication_submit").at(-1).args.input;
  assert.deepEqual(firstSubsetInput.targetIds, [subsetTargets.youtube]);
  assert.equal(saved.jobs.length, 1);
  assert.equal(saved.jobs[0].targetId, subsetTargets.youtube);
  assert.equal(saved.jobs[0].status, "published");
  assert.equal(submits, subsetSubmitsBefore + 1);
  const preservedYouTubeJob = structuredClone(saved.jobs[0]);
  const subsetRevision = saved.revision;
  report.checks.push("Subset approval sends only inspected YouTube; selection edits invalidate consent and unchecked blocked channels never create jobs");
  await studio.getByRole("button", { name: "콘텐츠 작성", exact: true }).click();
  assert.equal(await chooseYouTube.isDisabled(), true);
  assert.equal(await chooseYouTube.isChecked(), false);
  await chooseInstagram.uncheck();
  await chooseTikTok.check();
  assert.equal(await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).count(), 0);
  await studio.getByRole("button", { name: "사전 검사·대상 확인", exact: true }).click();
  assert.deepEqual(calls.filter(call => call.command === "publication_preflight").at(-1).args.input.targetIds, [subsetTargets.tiktok]);
  assert.equal(saved.revision, subsetRevision);
  assert.equal(await approval.isChecked(), false);
  await approval.check();
  await studio.getByRole("button", { name: "선택한 대상 일괄 승인", exact: true }).click();
  assert.deepEqual(calls.filter(call => call.command === "publication_submit").at(-1).args.input.targetIds, [subsetTargets.tiktok]);
  assert.equal(saved.jobs.length, 2);
  assert.deepEqual(saved.jobs.find(job => job.targetId === subsetTargets.youtube), preservedYouTubeJob);
  assert.equal(saved.jobs.find(job => job.targetId === subsetTargets.tiktok).status, "draft_sent");
  assert.equal(saved.jobs.some(job => job.targetId === subsetTargets.instagram), false);
  assert.equal(submits, subsetSubmitsBefore + 2);
  assert.equal(new Set(saved.jobs.map(job => job.id)).size, saved.jobs.length);
  report.checks.push("Second subset approval adds only TikTok inbox while preserving prior YouTube job identity/status and leaving Instagram untouched");
  await page.screenshot({ path: resolve(out, "publication-partial-approval.png"), fullPage: true });
  await page.getByRole("button", { name: "AI 작업실", exact: true }).click();
  assert.equal(await page.getByText("직접 작성에 사용할 로컬 AI 제공자", { exact: false }).count(), 0);
  assert.equal(calls.some(item => item.command.startsWith("open_webui") || item.command.startsWith("codexify_")), false);
  report.checks.push("Desktop AI path uses only the selected model command; no Open WebUI or Codexify calls");
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(resolve(out, "verification.json"), JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
