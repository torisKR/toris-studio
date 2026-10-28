import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliLogin, parseCodexModels, parseCursorModels, parseKiroModels } from "../src/llm/cli.js";
import { checkProvider } from "../src/llm/index.js";
import { parseSettings } from "../src/runtime.js";

test("account model lists are read from each CLI's own output", () => {
  const kiro = parseKiroModels(JSON.stringify({ models: [
    { model_name: "auto", model_id: "auto", description: "Models chosen by task", rate_multiplier: 1 },
    { model_name: "claude-opus-5.5", model_id: "claude-opus-5.5", description: "Opus", rate_multiplier: 2 },
    { model_name: "broken" },
  ] }));
  assert.deepEqual(kiro.map(m => m.id), ["auto", "claude-opus-5.5"]);
  assert.match(kiro[1].detail ?? "", /^2x 크레딧 · Opus/);
  const cursor = parseCursorModels("\u001b[1mAvailable models\u001b[0m\n\nauto - Auto (default)\ngpt-5.3-codex - Codex 5.3\ngrok-4.7-low-fast - Grok 4.7  Low Fast\u200b\u200b\nTip: use --model\n");
  assert.deepEqual(cursor.map(m => m.id), ["auto", "gpt-5.3-codex", "grok-4.7-low-fast"]);
  assert.equal(cursor[0].label, "Auto");
  assert.equal(cursor[0].detail, "기본 모델");
  assert.equal(cursor[2].label, "Grok 4.7  Low Fast");
  const codex = parseCodexModels(JSON.stringify({ models: [
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "Frontier", visibility: "list" },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
  ] }));
  assert.deepEqual(codex, [{ id: "gpt-6-astra", label: "GPT-6-Astra", detail: "Frontier" }]);
});

test("login state comes from the CLI status output, and signed-out never reads as connected", () => {
  assert.equal(parseCliLogin("claude-cli", 0, JSON.stringify({ loggedIn: false, authMethod: "none" }), "").signedIn, false);
  const claude = parseCliLogin("claude-cli", 0, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "me@example.com" }), "");
  assert.deepEqual([claude.signedIn, claude.account], [true, "me@example.com"]);
  assert.equal(parseCliLogin("codex-cli", 0, "Logged in using ChatGPT", "").signedIn, true);
  assert.equal(parseCliLogin("codex-cli", 1, "Not logged in", "").signedIn, false);
  assert.equal(parseCliLogin("cursor-cli", 0, "\u001b[32m✓\u001b[0m Logged in as me@example.com", "").account, "me@example.com");
  assert.equal(parseCliLogin("cursor-cli", 0, "Not logged in", "").signedIn, false);
  const kiro = parseCliLogin("kiro-cli", 0, "Logged in with Google\nEmail: me@example.com", "");
  assert.deepEqual([kiro.signedIn, kiro.account, kiro.detail], [true, "me@example.com", "Kiro 계정 로그인됨 · Google"]);
  assert.equal(parseCliLogin("kiro-cli", 1, "", "error: not logged in").signedIn, false);
});

test("models.check: API providers need a key, a bad key is an error, a good key lists live models", async () => {
  const realFetch = globalThis.fetch;
  try {
    const none = await checkProvider("openai", parseSettings({}));
    assert.equal(none.state, "needs-key");
    assert.equal(none.source, "suggested");
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "Incorrect API key sk-proj-secretsecretsecretsecret" } }), { status: 401 })) as typeof fetch;
    const bad = await checkProvider("openai", parseSettings({ keys: { openai: "sk-proj-secretsecretsecretsecret" } }));
    assert.equal(bad.state, "error");
    assert.match(bad.detail, /401.*API 키/);
    assert.doesNotMatch(bad.detail, /secretsecret/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }, { id: "whisper-1" }, { id: "gpt-4.1" }] }), { status: 200 })) as typeof fetch;
    const good = await checkProvider("openai", parseSettings({ keys: { openai: "sk-proj-goodgoodgoodgoodgood" } }));
    assert.deepEqual([good.state, good.source, good.models.map(m => m.id)], ["connected", "account", ["gpt-4.1", "gpt-5"]]);
  } finally { globalThis.fetch = realFetch; }
});

