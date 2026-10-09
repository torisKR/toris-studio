import assert from "node:assert/strict";
import test from "node:test";
import { PUBLISH_PLATFORMS, jobActions, kstSchedule, newPublication, newTarget, publicationApi, safePostUrl, scheduleInput, splitTags, submissionInput, targetCaption, targetContent } from "../desktop/src/publication-client";
import type { PublicationPreflight, PublishingJob } from "../desktop/src/publication-client";

test("new publishing destinations omit Naver and X; TikTok privacy and engagement require user choices", () => {
  assert.deepEqual(PUBLISH_PLATFORMS, ["youtube", "instagram", "facebook", "threads", "tiktok"]);
  const target = newTarget("tiktok");
  assert.equal(target.options.privacy, "");
  for (const key of ["allowComments", "allowDuet", "allowStitch", "musicConsent", "publishConsent"]) assert.equal(target.options[key], false);
  assert.equal(target.mode, "manual");
});

test("channel overrides preserve explicit empty text and caption mapping omits YouTube title", () => {
  const publication = { ...newPublication(), title: "공통 제목", description: "본문", tags: ["AI"], hashtags: ["생산성"] };
  const youtube = newTarget("youtube"), threads = { ...newTarget("threads"), overrides: { title: "", description: "채널별 본문", hashtags: [] } };
  assert.equal(targetCaption(publication, youtube), "본문\n\n#생산성");
  assert.equal(targetCaption(publication, threads), "채널별 본문");
  assert.equal(targetContent(publication, threads).title, "");
  assert.equal(publication.description, "본문");
  assert.deepEqual(splitTags("#AI #생산성, #AI", true), ["AI", "생산성"]);
  assert.deepEqual(splitTags("태그 하나, AI, AI"), ["태그 하나", "AI"]);
});

test("approval rejects stale revisions, blocked destinations, missing targets, and absent explicit consent", () => {
  const target = newTarget("youtube");
  const publication = { ...newPublication(), id: "publication-fixture", revision: 3, targets: [target] };
  const check: PublicationPreflight = { publicationId: publication.id, revision: 3, approvalHash: "approved-fixture", ready: true, checks: [{ targetId: target.id, ready: true, message: "준비" }], media: {} };
  assert.throws(() => submissionInput(publication, check, false), /동의/);
  assert.throws(() => submissionInput({ ...publication, revision: 4 }, check, true), /변경/);
  assert.throws(() => submissionInput(publication, { ...check, ready: false }, true), /사전 검사/);
  assert.throws(() => submissionInput(publication, { ...check, checks: [] }, true), /사전 검사/);
  assert.throws(() => submissionInput({ ...publication, targets: [] }, check, true), /사전 검사/);
  assert.deepEqual(submissionInput(publication, check, true), { publicationId: publication.id, revision: 3, targetIds: [target.id], approvalHash: "approved-fixture", confirmed: true });
  // Reapprove one delayed destination without including another already published channel.
  const publishedTarget = newTarget("threads");
  assert.deepEqual(submissionInput({ ...publication, targets: [target, publishedTarget] }, check, true).targetIds, [target.id]);
  assert.throws(() => submissionInput(publication, { ...check, checks: [check.checks[0], check.checks[0]] }, true), /사전 검사/);
});

test("successful posts and TikTok drafts never offer retry; uncertain sends offer result reads only", () => {
  const job: PublishingJob = { id: "job", targetId: "target", status: "published", mode: "manual", warnings: [], updatedAt: "", retryable: true };
  for (const status of ["published", "draft_sent", "cancelled"]) assert.deepEqual(jobActions({ ...job, status }), []);
  for (const status of ["uncertain", "processing", "sending"]) assert.deepEqual(jobActions({ ...job, status }), ["reconcile"]);
  assert.deepEqual(jobActions({ ...job, status: "failed" }), ["retry"]);
  assert.deepEqual(jobActions({ ...job, status: "failed", retryable: false }), []);
  assert.deepEqual(jobActions({ ...job, status: "scheduled" }), ["cancel"]);
  assert.deepEqual(jobActions({ ...job, status: "needs_confirmation", retryable: false }), ["review"]);
});

test("KST schedule round trip is independent of the host timezone and external URLs reject credentials", () => {
  assert.equal(kstSchedule("2026-10-12T09:30"), "2026-10-12T00:30:00.000Z");
  assert.equal(scheduleInput("2026-10-12T00:30:00.000Z"), "2026-10-12T09:30");
  assert.equal(kstSchedule(""), null);
  assert.throws(() => kstSchedule("invalid"));
  assert.equal(safePostUrl("https://www.youtube.com/watch?v=abcdefghijk"), "https://www.youtube.com/watch?v=abcdefghijk");
  for (const url of ["http://example.com", "javascript:alert(1)", "https://name:token@example.com"]) assert.equal(safePostUrl(url), undefined);
});

test("publication IPC uses a structured input and propagates native failure without manufacturing success", async () => {
  const calls: unknown[] = [];
  const result = await publicationApi("save", { title: "제목" }, async (command, args) => { calls.push([command, args]); return { id: "saved" }; });
  assert.deepEqual(result, { id: "saved" });
  assert.deepEqual(calls, [["publication_save", { input: { title: "제목" } }]]);
  await assert.rejects(publicationApi("submit", {}, async () => { throw new Error("DB 연결 실패"); }), /DB 연결 실패/);
});
