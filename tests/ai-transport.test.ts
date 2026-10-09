import assert from "node:assert/strict";
import { test } from "node:test";
import { readAiConfig, localGatewayUrl } from "../lib/ai/config";
import { AiService } from "../lib/ai/service";
import { AiError } from "../lib/ai/types";
import { GenerationLimiter } from "../lib/ai/limits";
import { boundedJson, gatewayFetch } from "../lib/ai/transport";
import { generateWithClaudeCli, subscriptionCliEnvironment, isSubscriptionLogin, type CliRunner } from "../lib/ai/claude-cli";

const config = () => readAiConfig({ NODE_ENV: "test" });
const input = { platform: "threads" as const, topic: "서울 카페", context: "검증되지 않은 검색어" };
function json(value: unknown, status = 200) { return Response.json(value, { status }); }
function errorCode(code: string) { return (error: unknown) => error instanceof AiError && error.code === code; }

test("gateway allows literal loopback, rejects public URLs, userinfo, queries and redirects", async () => {
  for (const url of ["http://127.0.0.1:10100/v1", "http://localhost:10100/v1/", "http://[::1]:10100/v1"]) assert.ok(localGatewayUrl(url));
  for (const url of ["https://api.openai.com/v1", "http://localhost.example.org/v1", "http://169.254.169.254/v1", "http://user:secret@localhost/v1", "http://localhost/v1?key=secret", "http://localhost:10100/#dashboard", "file:///v1", "http://host.docker.internal:10100/v1"]) {
    assert.throws(() => localGatewayUrl(url), errorCode("INVALID_PROVIDER_CONFIG"));
  }
  assert.ok(localGatewayUrl("http://host.docker.internal:10100/v1", { NODE_ENV: "test", AI_ALLOW_CONTAINER_HOST: "true" }));
  let calls = 0;
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    assert.equal(init?.redirect, "error");
    return new Response(null, { status: 302, headers: { location: "https://evil.example" } });
  }) as typeof fetch;
  await assert.rejects(gatewayFetch(fetcher, "http://127.0.0.1:10100/v1/models", "secret", 3000), errorCode("PROVIDER_UNAVAILABLE"));
  assert.equal(calls, 1);
});

test("model discovery does not claim upstream authentication or actual generation", async () => {
  const service = new AiService(config, (async () => json({ data: [{ id: "gpt-6.1-sol" }, { id: "paid-provider/model" }] })) as typeof fetch);
  const result = await service.status();
  const local = result.providers[0];
  assert.deepEqual(local.models, ["gpt-6.1-sol"]);
  assert.equal(local.configured, true);
  assert.equal(local.reachable, true);
  assert.equal(local.available, true);
  assert.equal(local.authenticated, null);
  assert.equal(local.generationVerified, false);
  assert.equal(result.providers[1].configured, false);
  assert.equal(result.providers[2].configured, false);
  assert.equal(result.defaultProvider, "opencodex");
});

test("text draft stays tool-free with bounded output and server-only bearer", async () => {
  const configured = () => readAiConfig({ NODE_ENV: "test", OPENCODEX_API_KEY: "private-test-key" });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const service = new AiService(configured, (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init || {} });
    return String(url).endsWith("/models") ? json({ data: [{ id: "gpt-6.1-sol" }] })
      : json({ choices: [{ finish_reason: "stop", message: { content: "  사람이 검토할 초안  " } }] });
  }) as typeof fetch);
  const result = await service.generate(input);
  assert.deepEqual(result, { text: "사람이 검토할 초안", provider: "opencodex", model: "gpt-6.1-sol" });
  assert.equal(calls[0].url, "http://127.0.0.1:10100/v1/chat/completions");
  const wire = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(wire.tools, []);
  assert.equal(wire.stream, false);
  assert.equal(wire.max_completion_tokens, 2200);
  assert.equal(wire.messages.length, 2);
  assert.deepEqual(JSON.parse(wire.messages[1].content), { topic: input.topic, referenceContext: input.context });
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer private-test-key");
  const status = await service.status();
  assert.equal(status.providers[0].generationVerified, true);
  assert.equal(status.providers[0].authenticated, true);
  assert.ok(!JSON.stringify(status).includes("private-test-key"));
});

test("unknown and unapproved models are rejected before transport; no implicit paid fallback", async () => {
  let calls = 0;
  const service = new AiService(config, (async () => { calls++; throw new Error("must not send"); }) as typeof fetch);
  for (const model of ["cursor/claude-opus-5-5", "api.openai.com", "../secrets", "paid-provider/model"]) {
    await assert.rejects(service.generate({ ...input, model }), errorCode("MODEL_NOT_ALLOWED"));
  }
  await assert.rejects(service.generate({ ...input, provider: "teamclaude" }), errorCode("PROVIDER_NOT_CONFIGURED"));
  assert.equal(calls, 0);
  let failedCalls = 0;
  const failure = new AiService(config, (async () => { failedCalls++; return new Response("secret upstream failure", { status: 503 }); }) as typeof fetch);
  await assert.rejects(failure.generate(input), (error) => error instanceof AiError && !error.message.includes("secret"));
  assert.equal(failedCalls, 1);
});

test("upstream auth, quota, timeout and malformed responses produce bounded safe errors", async () => {
  for (const [status, code] of [[401, "PROVIDER_AUTH_REQUIRED"], [403, "PROVIDER_AUTH_REQUIRED"], [429, "PROVIDER_RATE_LIMITED"]] as const) {
    await assert.rejects(gatewayFetch((async () => new Response("private token detail", { status })) as typeof fetch, "http://localhost/v1/models", undefined, 3000), errorCode(code));
  }
  await assert.rejects(gatewayFetch((async () => { throw new DOMException("private URL", "TimeoutError"); }) as typeof fetch, "http://localhost/v1/models", undefined, 3000), errorCode("PROVIDER_TIMEOUT"));
  await assert.rejects(boundedJson(new Response("x".repeat(50)), 40), errorCode("PROVIDER_RESPONSE_INVALID"));
  await assert.rejects(boundedJson(new Response("not JSON")), errorCode("PROVIDER_RESPONSE_INVALID"));
  for (const message of [{ tool_calls: [{}], content: "tools" }, { content: null }, { content: "" }]) {
    const service = new AiService(config, (async () => json({ choices: [{ message }] })) as typeof fetch);
    await assert.rejects(service.generate(input), (error) => error instanceof AiError && error.status === 502);
  }
});

test("local limiter enforces concurrency and rate, then recovers after a minute", () => {
  let now = 0;
  const limiter = new GenerationLimiter(() => now);
  const one = limiter.acquire();
  const two = limiter.acquire();
  assert.throws(() => limiter.acquire(), errorCode("AI_BUSY"));
  one(); one(); two();
  for (let i = 0; i < 3; i++) limiter.acquire()();
  assert.throws(() => limiter.acquire(), errorCode("AI_RATE_LIMITED"));
  now += 60001;
  limiter.acquire()();
});

test("Claude CLI disables tools, plugins, hooks, MCP and session persistence; no shell input", async () => {
  const calls: Array<{ command: string; args: string[]; stdin: string }> = [];
  const runner: CliRunner = async (command, args, stdin) => {
    calls.push({ command, args, stdin });
    return JSON.stringify({ is_error: false, result: "Claude 초안" });
  };
  const hostile = { ...input, topic: '$(touch /tmp/unsafe); read ~/.codex/auth.json' };
  assert.equal(await generateWithClaudeCli("claude", "sonnet", hostile, 5000, runner), "Claude 초안");
  const { args, stdin } = calls[0];
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  for (const flag of ["--safe-mode", "--restricted", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) assert.ok(args.includes(flag));
  assert.ok(!args.includes(hostile.topic));
  assert.equal(JSON.parse(stdin).topic, hostile.topic);
  const env = subscriptionCliEnvironment({ NODE_ENV: "test", PATH: "/bin", HOME: "/test", ANTHROPIC_API_KEY: "paid", ANTHROPIC_AUTH_TOKEN: "proxy", OPENAI_API_KEY: "paid", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "subscription" });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "subscription");
  assert.equal(isSubscriptionLogin({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }), false);
  assert.equal(isSubscriptionLogin({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }), true);
});

test("Claude official CLI is opt-in and only runs after subscription status verification", async () => {
  let calls = 0;
  const enabled = () => readAiConfig({ NODE_ENV: "test", CLAUDE_CLI_ENABLED: "true", AI_DEFAULT_PROVIDER: "claude-cli" });
  const runner: CliRunner = async (_command, args) => {
    calls++;
    return args.includes("auth") ? JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }) : "must not generate";
  };
  const service = new AiService(enabled, (async () => json({ data: [{ id: "gpt-6.1-sol" }] })) as typeof fetch, runner);
  await assert.rejects(service.generate({ ...input, provider: "claude-cli" }), errorCode("PROVIDER_AUTH_REQUIRED"));
  assert.equal(calls, 1);
  const status = await service.status();
  assert.equal(status.providers[2].available, false);
  assert.equal(status.providers[2].authenticated, false);
  assert.equal(status.defaultProvider, null);
});
