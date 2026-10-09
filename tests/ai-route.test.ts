import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/ai/generate/route";
import { GET } from "../app/api/ai/status/route";
import { readDraftRequest, aiErrorResponse } from "../lib/ai/request";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/ai/generate", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
const valid = { platform: "threads", topic: "한국어 콘텐츠 초안" };

test("AI route rejects remote Host and cross-site requests before provider transport", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not send"); });
  const unsafeHeaders: Record<string, string>[] = [{ host: "studio.example.com" }, { origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { "x-forwarded-for": "203.0.113.1" }];
  for (const headers of unsafeHeaders) {
    const response = await POST(request(valid, headers));
    assert.equal(response.status, 403);
  }
  assert.equal((await GET(new Request("http://evil.example/api/ai/status"))).status, 403);
  assert.equal(calls, 0);
});

test("AI route rejects arbitrary endpoint fields, unsupported provider and invalid bounds", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not send"); });
  for (const input of [{ ...valid, baseUrl: "http://evil.example" }, { ...valid, provider: "openai-api" }, { ...valid, topic: " " }, { ...valid, topic: "가".repeat(601) }, { ...valid, context: "x".repeat(6001) }, { ...valid, platform: "unknown" }]) {
    assert.equal((await POST(request(input))).status, 400);
  }
  assert.equal((await POST(new Request("http://localhost:3000/api/ai/generate", { method: "POST", body: JSON.stringify(valid) }))).status, 415);
  assert.equal((await POST(new Request("http://localhost:3000/api/ai/generate", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }))).status, 400);
  assert.equal(calls, 0);
});

test("request body cap cannot be bypassed by omitting content-length", async () => {
  const response = await POST(request({ ...valid, context: "x".repeat(25000) }));
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.code, "REQUEST_TOO_LARGE");
});

test("all five platforms validate and draft input is trimmed", async () => {
  for (const platform of ["youtube", "threads", "naver_blog", "tiktok", "instagram"]) {
    assert.deepEqual(await readDraftRequest(request({ platform, topic: "  주제  ", context: "  참고  " })), { platform, topic: "주제", context: "참고" });
  }
  const response = aiErrorResponse(new Error("secret-provider-key-and-url"));
  assert.ok(!(await response.text()).includes("secret-provider"));
});
