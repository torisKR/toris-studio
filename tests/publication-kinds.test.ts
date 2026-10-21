import assert from "node:assert/strict";
import test from "node:test";
import * as client from "../desktop/src/publication-client";

test("content kinds constrain destinations and changing kind preserves copy but removes incompatible media", () => {
  assert.equal(typeof client.platformsForContent, "function");
  assert.deepEqual(client.platformsForContent("video"), [...client.PUBLISH_PLATFORMS, "naver_clip", "x"]);
  assert.deepEqual(client.platformsForContent("text"), ["facebook", "threads", "naver_blog", "x"]);
  assert.deepEqual(client.platformsForContent("article"), ["naver_blog", "x"]);
  const original = { ...client.newPublication(), title: "원문", description: "본문", videoMediaId: "video", thumbnailMediaId: "cover", targets: [client.newTarget("youtube"), client.newTarget("threads")] };
  const changed = client.publicationForKind(original, "text");
  assert.equal(changed.contentKind, "text");
  assert.equal(changed.description, "본문");
  assert.equal(changed.videoMediaId, null);
  assert.equal(changed.thumbnailMediaId, null);
  assert.deepEqual(changed.targets.map(target => target.platform), ["threads"]);
  assert.equal(original.videoMediaId, "video");
  assert.equal(client.publicationForKind(original, "video"), original);
});

test("Naver is a manual handoff with explicit consent and cannot be converted into an automated schedule", () => {
  const target = client.newTarget("naver_blog");
  assert.equal(target.mode, "manual_handoff");
  assert.equal(target.options.confirmHandoff, false);
  const publication = { ...client.newPublication(), contentKind: "text" as const, targets: [target] };
  assert.throws(() => client.batchSchedule(publication, [target.id], "2030-12-31T09:00", 0, Date.parse("2026-10-19T00:00:00Z")), /수동/);
  const job = { id: "job", targetId: target.id, mode: "manual_handoff", status: "needs_human_publish", retryable: false, updatedAt: "", warnings: [] };
  assert.deepEqual(client.jobActions(job), ["export_handoff", "confirm_handoff", "cancel"]);
  assert.equal(client.JOB_LABELS.needs_human_publish, "수동 게시 필요");
});
