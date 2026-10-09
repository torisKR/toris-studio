import { test } from "node:test";
import assert from "node:assert/strict";
import { channelSchema, contentSchema, contentPatchSchema, refreshSchema } from "../lib/social/schema";
import { readSocialJson } from "../lib/social/http";

test("five platform inputs reject credentials, executable URLs and unknown fields", () => {
  for (const platform of ["youtube", "threads", "naver_blog", "tiktok", "instagram"]) {
    assert.equal(channelSchema.safeParse({platform, name: "내 채널", handle: "@toris", url: "https://example.com"}).success, true);
  }
  for (const url of ["javascript:alert(1)", "http://example.com", "https://secret:token@example.com"]) {
    assert.equal(channelSchema.safeParse({platform: "youtube", name: "내 채널", url}).success, false);
  }
  assert.equal(channelSchema.safeParse({platform: "youtube", name: "채널", url: "https://example.com", token: "private"}).success, false);
});

test("scheduled and published states require concrete timestamp or external URL", () => {
  const draft = {platform: "threads", title: "제목", body: "본문", status: "draft"};
  assert.equal(contentSchema.safeParse(draft).success, true);
  assert.equal(contentSchema.safeParse({...draft, status: "scheduled"}).success, false);
  assert.equal(contentSchema.safeParse({...draft, status: "scheduled", scheduledAt: "2026-10-09T07:00:00+09:00"}).success, true);
  assert.equal(contentSchema.safeParse({...draft, status: "published", url: ""}).success, false);
  assert.equal(contentSchema.safeParse({...draft, status: "published", url: "https://www.threads.com/@toris/post/123"}).success, true);
  assert.equal(contentSchema.safeParse({...draft, body: "x".repeat(30001)}).success, false);
});

test("patches preserve absent optional fields and reject unsupported status", () => {
  assert.deepEqual(contentPatchSchema.parse({ title: "새 제목" }), { title: "새 제목" });
  assert.deepEqual(contentPatchSchema.parse({ channelId: "", url: "" }), { channelId: null, url: null });
  assert.equal(contentPatchSchema.safeParse({}).success, false);
  assert.equal(contentPatchSchema.safeParse({status: "auto_published"}).success, false);
  assert.equal(refreshSchema.safeParse({keyword: "x".repeat(101)}).success, false);
});

test("bounded JSON reader rejects huge chunked bodies, invalid JSON, and non-JSON", async () => {
  await assert.rejects(readSocialJson(new Request("http://localhost/api/social/content", {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({body: "x".repeat(140000)}),
  })), (error: unknown) => error instanceof Response && error.status === 413);
  await assert.rejects(readSocialJson(new Request("http://localhost/api/social/content", {
    method: "POST", headers: {"content-type": "application/json"}, body: "{",
  })), (error: unknown) => error instanceof Response && error.status === 400);
  await assert.rejects(readSocialJson(new Request("http://localhost/api/social/content", {
    method: "POST", headers: {"content-type": "text/plain"}, body: "{}",
  })), (error: unknown) => error instanceof Response && error.status === 415);
});
