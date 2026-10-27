import assert from "node:assert/strict";
import test from "node:test";
import { contentReady, extractJson, generateImage, generateText, modelLabel } from "../desktop/src/ai-client";
import type { AiStatus, BridgeInvoke } from "../desktop/src/ai-client";

const status: AiStatus = {
  providers: [
    { id: "claude-cli", label: "Claude Code", kind: "subscription", available: false, detail: "", suggestedModels: [] },
    { id: "openai", label: "OpenAI API", kind: "api", available: true, detail: "", suggestedModels: [] },
  ],
  contentModel: { provider: "openai", model: "gpt-5-mini" },
  agentModel: { provider: "claude-cli", model: "" },
  image: null,
};

test("content generation sends only the prompt and optional system text to the native command", async () => {
  const calls: Array<[string, unknown]> = [];
  const call: BridgeInvoke = async (command, args) => { calls.push([command, args]); return { text: "초안", provider: "openai", model: "gpt-5-mini" }; };
  assert.equal((await generateText("주제", undefined, call)).text, "초안");
  await generateText("주제", "시스템", call);
  assert.deepEqual(calls, [["ai_generate", { input: { prompt: "주제" } }], ["ai_generate", { input: { prompt: "주제", system: "시스템" } }]]);
  await assert.rejects(generateText("   ", undefined, call), /입력/);
  assert.equal(calls.length, 2);
});

test("image generation is tied to an existing asset job", async () => {
  const calls: Array<[string, unknown]> = [];
  await generateImage("job-1", "고양이", "1536x1024", async (command, args) => { calls.push([command, args]); return {}; });
  assert.deepEqual(calls, [["ai_generate_image", { input: { jobId: "job-1", prompt: "고양이", size: "1536x1024" } }]]);
});

test("JSON is recovered from fenced or chatty model output", () => {
  assert.deepEqual(extractJson('설명입니다.\n```json\n{"title":"a","tags":["x"]}\n```'), { title: "a", tags: ["x"] });
  assert.deepEqual(extractJson('{"a":"}{"} 끝'), { a: "}{" });
  assert.throws(() => extractJson("JSON 없음"), /JSON/);
});

test("content readiness follows the content model, falling back to the agent model", () => {
  assert.equal(contentReady(status), true);
  assert.equal(contentReady({ ...status, contentModel: null }), false, "agent model's CLI is not installed");
  assert.equal(contentReady(null), false);
  assert.equal(modelLabel(status, status.contentModel), "OpenAI API · gpt-5-mini");
  assert.equal(modelLabel(status, null), "모델 미선택");
});
