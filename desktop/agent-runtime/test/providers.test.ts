import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { failureReason, parseCliOutput } from "../src/llm/cli.js";
import { apiModel, localUrl } from "../src/llm/http.js";
import { generateImage } from "../src/llm/image.js";
import { ChromaClient } from "../src/rag/chroma.js";
import { Runtime, parseSettings } from "../src/runtime.js";
import { runCommand } from "../src/tools/terminal.js";

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function stubFetch(reply: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    const { status = 200, body } = reply(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}
const body = (call: Call) => JSON.parse(String(call.init.body));
const headers = (call: Call) => call.init.headers as Record<string, string>;

test("build/test commands run without provider keys in their environment and secrets are masked in logs", async () => {
  process.env.OPENAI_API_KEY = "sk-should-not-leak-0000000000000000";
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-cmd-"));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('key=' + (process.env.OPENAI_API_KEY ?? 'none')); console.log('token sk-ant-api03-abcdefghijklmnopqrstu'); process.exit(3)\"" } }));
    const result = await runCommand(["npm", "test"], dir, [], []);
    assert.equal(result.exitCode, 3);
    assert.match(result.log, /key=none/);
    assert.doesNotMatch(result.log, /sk-ant-api03/);
  } finally { delete process.env.OPENAI_API_KEY; }
});

test("subscription CLI failures surface the login reason and Claude errors are not treated as answers", () => {
  assert.equal(failureReason("claude-cli", JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" }), ""), "Not logged in · Please run /login");
  assert.match(failureReason("gemini-cli", "", "Loaded cached credentials\nError authenticating: IneligibleTierError: no longer supported\n    at x"), /IneligibleTierError/);
  assert.throws(() => parseCliOutput("claude-cli", JSON.stringify({ is_error: true, result: "Credit balance is too low" }), ""), /Credit balance/);
  assert.equal(parseCliOutput("claude-cli", JSON.stringify({ is_error: false, result: "답변" }), ""), "답변");
  assert.equal(parseCliOutput("gemini-cli", JSON.stringify({ response: "젬" }), ""), "젬");
  assert.equal(parseCliOutput("kiro-cli", "\u001b[32m> 안녕\u001b[0m\n", ""), "안녕");
});

test("Anthropic, OpenAI and Gemini requests use each API's own auth header and token field", async () => {
  const calls = stubFetch(call => ({ body: call.url.includes("anthropic") ? { content: [{ type: "text", text: "A" }] } : call.url.includes("googleapis") ? { candidates: [{ content: { parts: [{ text: "G" }] } }] } : { choices: [{ message: { content: "O" } }] } }));
  const input = { system: "S", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 50 };
  const keys = { anthropic: "ak", openai: "ok", google: "gk" };
  assert.equal(await apiModel("anthropic", "claude-x", keys, "").complete(input), "A");
  assert.equal(await apiModel("openai", "gpt-x", keys, "").complete(input), "O");
  assert.equal(await apiModel("google", "gemini-x", keys, "").complete(input), "G");
  assert.equal(headers(calls[0])["x-api-key"], "ak");
  assert.deepEqual(body(calls[0]), { model: "claude-x", max_tokens: 50, system: "S", messages: input.messages });
  assert.equal(headers(calls[1]).authorization, "Bearer ok");
  assert.equal(body(calls[1]).max_completion_tokens, 50);
  assert.deepEqual(body(calls[1]).messages[0], { role: "system", content: "S" });
  assert.equal(headers(calls[2])["x-goog-api-key"], "gk");
  assert.match(calls[2].url, /models\/gemini-x:generateContent$/);
});

test("provider errors hint at the key and never echo it", async () => {
  stubFetch(() => ({ status: 401, body: { error: { message: "Incorrect API key provided: sk-proj-secretsecretsecretsecret" } } }));
  await assert.rejects(apiModel("openai", "gpt-x", { openai: "sk-proj-secretsecretsecretsecret" }, "").complete({ system: "", messages: [] }), (error: Error) => {
    assert.match(error.message, /401.*API 키를 확인하세요/);
    assert.doesNotMatch(error.message, /secretsecret/);
    return true;
  });
  assert.throws(() => apiModel("anthropic", "m", {}, ""), /API 키/);
});

test("local services (Ollama, ChromaDB) only accept this computer's loopback address", () => {
  assert.equal(localUrl("http://127.0.0.1:11434/x"), "http://127.0.0.1:11434");
  for (const raw of ["http://10.0.0.2:11434", "https://127.0.0.1:11434", "http://user:pw@127.0.0.1:1", "http://evil.test"]) assert.throws(() => localUrl(raw), /127\.0\.0\.1/, raw);
  assert.throws(() => new ChromaClient("http://192.168.0.5:8000"), /127\.0\.0\.1/);
  assert.doesNotThrow(() => new ChromaClient("http://127.0.0.1:18765"));
});

test("image generation returns base64 from OpenAI and Gemini and needs a key", async () => {
  const calls = stubFetch(call => ({ body: call.url.includes("openai") ? { data: [{ b64_json: "T1BFTg==" }] } : { candidates: [{ content: { parts: [{ inlineData: { data: "R0VN", mimeType: "image/webp" } }] } }] } }));
  const base = parseSettings({ keys: { openai: "ok", google: "gk" } });
  const openai = await generateImage({ ...base, image: { provider: "openai", model: "" } }, "고양이", "1536x1024");
  assert.deepEqual(openai, { base64: "T1BFTg==", mime: "image/png", provider: "openai", model: "gpt-image-1" });
  assert.equal(body(calls[0]).size, "1536x1024");
  const gemini = await generateImage({ ...base, image: { provider: "google", model: "" } }, "고양이", "bogus");
  assert.equal(gemini.mime, "image/webp");
  assert.deepEqual(body(calls[1]).generationConfig, { responseModalities: ["IMAGE"] });
  await assert.rejects(generateImage({ ...base, keys: {}, image: { provider: "openai", model: "" } }, "x", "auto"), /OpenAI API 키/);
  await assert.rejects(generateImage({ ...base, image: null }, "x", "auto"), /이미지 생성 모델/);
});

test("content completion falls back to the agent model and unknown methods are refused", async () => {
  const calls = stubFetch(() => ({ body: { choices: [{ message: { content: "로컬 답" } }] } }));
  const runtime = new Runtime(() => {});
  await runtime.handle("configure", { agentModel: { provider: "ollama", model: "qwen" }, contentModel: null });
  assert.deepEqual(await runtime.handle("complete", { prompt: "안녕" }), { text: "로컬 답", provider: "ollama", model: "qwen" });
  assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:11434\/v1\/chat\/completions$/);
  await assert.rejects(runtime.handle("shell.exec", {}), /알 수 없는 요청/);
});
