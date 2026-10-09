import assert from "node:assert/strict";
import test from "node:test";
import { applyProxyAction, applyRuntimeAction, canStopRuntime, copyPublicMcpUrl, getProxyStatus, getRuntimeStatus, publicMcpUrl, runRuntimeDoctor, runtimeConfiguration, runtimeIdentity, runtimeStateLabel } from "../desktop/src/codexify-runtime-client";
import type { BridgeInvoke } from "../desktop/src/codexify-client";
import type { CodexifyProxyStatus, CodexifyRuntimeStatus } from "../desktop/src/codexify-runtime-client";

const idle: CodexifyRuntimeStatus = { binaryAvailable: true, bundled: true, version: "1.7.0", configPath: "/config/runtime.json", sourceRoot: "/projects", port: 21228, running: false, managed: false, pid: null, service: { installed: true, running: false, enabled: true }, message: "준비됨" };

test("source input accepts personal parent folders on Mac and Windows without replacing the selected chat project", () => {
  for (const root of ["/Users/example/projects", "~/projects", "C:\\Users\\example\\projects", "D:/projects", "\\\\server\\share\\projects"]) {
    assert.deepEqual(runtimeConfiguration(` ${root} `, " 21228 "), { sourceRoot: root, port: 21228 });
  }
  for (const root of ["", "projects", "./projects", "C:projects", "~someone/projects"]) assert.throws(() => runtimeConfiguration(root, "21228"), /절대 경로/);
  for (const port of ["", "0", "65536", "2.5", "1e3", "21228oops", "-1"]) assert.throws(() => runtimeConfiguration("/projects", port), /정수/);
  assert.equal(runtimeConfiguration("/projects", "65535").port, 65535);
});

test("the UI offers stop for an app-owned process even when its health check fails", () => {
  assert.equal(canStopRuntime(null), false);
  assert.equal(canStopRuntime(idle), false);
  assert.equal(canStopRuntime({ ...idle, managed: true }), true);
  assert.equal(canStopRuntime({ ...idle, running: true }), false);
  assert.equal(canStopRuntime({ ...idle, running: true, managed: true }), true);
  assert.equal(runtimeStateLabel({ ...idle, running: true }), "기존 브리지 사용 중");
  assert.equal(runtimeStateLabel({ ...idle, running: true, managed: true }), "앱에서 실행 중");
  assert.equal(runtimeStateLabel({ ...idle, managed: true, pid: 456 }), "앱 실행 중 · 응답 확인 필요");
});

test("an unresponsive owned process can be stopped without exposing control over external processes", async () => {
  const unhealthy = { ...idle, managed: true, running: false, pid: 456 };
  let stops = 0;
  const call: BridgeInvoke = async command => { assert.equal(command, "codexify_runtime_stop"); stops++; return idle; };
  assert.deepEqual(await applyRuntimeAction("stop", unhealthy, undefined, call), idle);
  assert.equal(stops, 1);
  await assert.rejects(applyRuntimeAction("configure", unhealthy, { sourceRoot: "/another", port: 21228 }, call), /실행 중/);
  assert.equal(stops, 1);
});

test("refused stop and configure never dispatch commands to an external listener", async () => {
  let called = 0;
  const call: BridgeInvoke = async () => { called++; return idle; };
  const external = { ...idle, running: true, pid: 123 };
  await assert.rejects(applyRuntimeAction("stop", external, undefined, call), /앱에서 시작한/);
  await assert.rejects(applyRuntimeAction("configure", external, { sourceRoot: "/another", port: 1234 }, call), /실행 중/);
  assert.equal(called, 0);
});

test("starting with an existing bridge asks native to reuse it so the proxy can still be started", async () => {
  const external = { ...idle, running: true, managed: false, pid: 123 };
  let starts = 0;
  const call: BridgeInvoke = async command => { assert.equal(command, "codexify_runtime_start"); starts++; return external; };
  const result = await applyRuntimeAction("start", external, undefined, call);
  assert.equal(starts, 1);
  assert.equal(result.managed, false);
  assert.equal(result.pid, 123);
  assert.equal(canStopRuntime(result), false);
});

test("runtime commands preserve the native lifecycle result and never mutate chat profiles", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const running = { ...idle, running: true, managed: true, pid: 456 };
  const call: BridgeInvoke = async (command, args) => { calls.push({ command, args }); return command === "codexify_runtime_start" ? running : idle; };
  assert.deepEqual(await getRuntimeStatus(call), idle);
  assert.deepEqual(await applyRuntimeAction("configure", idle, { sourceRoot: "~/projects", port: 21228 }, call), idle);
  assert.deepEqual(await applyRuntimeAction("start", idle, undefined, call), running);
  assert.deepEqual(await applyRuntimeAction("stop", running, undefined, call), idle);
  assert.deepEqual(calls, [{ command: "codexify_runtime_status", args: undefined }, { command: "codexify_runtime_configure", args: { input: { sourceRoot: "~/projects", port: 21228 } } }, { command: "codexify_runtime_start", args: undefined }, { command: "codexify_runtime_stop", args: undefined }]);
});

test("a system service doctor failure stays visible when the app bridge is healthy", async () => {
  const result = { checks: [{ id: "service", status: "failure", label: "시스템 서비스", message: "실행 중 아님" }], failures: 1, bridgeHealthy: true, message: "브리지 정상, 서비스 확인 필요" };
  const call: BridgeInvoke = async command => { assert.equal(command, "codexify_runtime_doctor"); return result; };
  assert.deepEqual(await runRuntimeDoctor(call), result);
  assert.notEqual(runtimeIdentity(idle), runtimeIdentity({ ...idle, running: true, managed: true, pid: 456 }));
  assert.notEqual(runtimeIdentity(idle), runtimeIdentity({ ...idle, sourceRoot: "/another" }));
});

test("public endpoint copying rejects owner-chat credentials and only uses the Quick Tunnel MCP URL", async () => {
  const proxy: CodexifyProxyStatus = { provider: "cloudflare", available: true, running: true, managed: true, mcpUrl: "https://fixture-tunnel.trycloudflare.com/mcp", message: "준비됨" };
  const calls: unknown[] = [];
  const call: BridgeInvoke = async (command, args) => { calls.push({ command, args }); return null; };
  assert.equal(publicMcpUrl(proxy), proxy.mcpUrl);
  await copyPublicMcpUrl(proxy, call);
  assert.deepEqual(calls, [{ command: "copy_text", args: { text: proxy.mcpUrl } }]);
  for (const url of ["http://127.0.0.1:3120/?token=private", "https://fixture.trycloudflare.com/mcp?token=private", "https://user:password@fixture.trycloudflare.com/mcp", "https://trycloudflare.com.evil.test/mcp", "https://fixture.trycloudflare.com/owner", "https://fixture.trycloudflare.com:444/mcp"]) {
    assert.throws(() => publicMcpUrl({ ...proxy, mcpUrl: url }));
  }
  assert.throws(() => publicMcpUrl({ ...proxy, running: false }), /아직 준비/);
  assert.throws(() => publicMcpUrl({ ...proxy, mcpUrl: null }), /아직 준비/);
  await assert.rejects(copyPublicMcpUrl({ ...proxy, mcpUrl: "https://fixture.trycloudflare.com/mcp?token=private" }, call));
  assert.equal(calls.length, 1);
});

test("stopping a proxy also requires app ownership and never dispatches to an external launcher", async () => {
  let calls = 0;
  const call: BridgeInvoke = async (command, args) => { calls++; assert.equal(command, "codexify_proxy_stop"); assert.deepEqual(args, { input: { provider: "cloudflare" } }); return { provider: "cloudflare", available: true, running: false, managed: false, mcpUrl: null, message: "종료됨" }; };
  await assert.rejects(applyProxyAction("stop", { provider: "cloudflare", available: true, running: true, managed: false, mcpUrl: null, message: "외부" }, "cloudflare", call), /앱에서 시작한/);
  assert.equal(calls, 0);
  assert.equal((await applyProxyAction("stop", { provider: "cloudflare", available: true, running: true, managed: true, mcpUrl: null, message: "앱" }, "cloudflare", call)).running, false);
  assert.equal(calls, 1);
});

test("provider-specific proxy calls preserve independent Cloudflare and ngrok ownership", async () => {
  const proxies: Record<string, CodexifyProxyStatus> = { cloudflare: { provider: "cloudflare", available: true, running: true, managed: true, mcpUrl: "https://fixture-tunnel.trycloudflare.com/mcp", message: "실행 중" }, ngrok: { provider: "ngrok", available: true, running: false, managed: false, mcpUrl: null, message: "준비됨" } };
  const call: BridgeInvoke = async (command, args) => {
    const provider = (args?.input as { provider: string }).provider;
    if (command === "codexify_proxy_start") proxies[provider] = { ...proxies[provider], running: true, managed: true, mcpUrl: "https://fixture.ngrok-free.app/mcp" };
    if (command === "codexify_proxy_stop") proxies[provider] = { ...proxies[provider], running: false, managed: false, mcpUrl: null };
    return proxies[provider];
  };
  assert.equal((await getProxyStatus("cloudflare", call)).running, true);
  const ngrok = await applyProxyAction("start", await getProxyStatus("ngrok", call), "ngrok", call);
  assert.equal(publicMcpUrl(ngrok), "https://fixture.ngrok-free.app/mcp");
  assert.equal(proxies.cloudflare.running, true);
  await applyProxyAction("stop", ngrok, "ngrok", call);
  assert.equal(proxies.ngrok.running, false);
  assert.equal(proxies.cloudflare.running, true);
  await assert.rejects(applyProxyAction("stop", proxies.cloudflare, "ngrok", call), /선택한 프록시/);
});

test("ngrok URL validation rejects cross-provider, custom, credentialed and non-MCP URLs", () => {
  const proxy: CodexifyProxyStatus = { provider: "ngrok", available: true, running: true, managed: true, mcpUrl: "https://fixture.ngrok-free.app/mcp", message: "실행 중" };
  for (const domain of ["ngrok-free.app", "ngrok.app", "ngrok.io", "ngrok-free.dev", "ngrok.dev", "ngrok.pizza", "ngrok-free.pizza"]) assert.equal(publicMcpUrl({ ...proxy, mcpUrl: `https://fixture.${domain}/mcp` }), `https://fixture.${domain}/mcp`);
  for (const url of ["https://fixture.trycloudflare.com/mcp", "https://ngrok-free.app.evil.test/mcp", "https://custom.example.com/mcp", "https://nested.fixture.ngrok.app/mcp", "https://name:secret@fixture.ngrok.io/mcp", "https://fixture.ngrok.app/mcp?token=secret", "https://fixture.ngrok.app/owner", "http://fixture.ngrok.app/mcp"]) assert.throws(() => publicMcpUrl({ ...proxy, mcpUrl: url }));
});

test("a proxy response for another provider is rejected without reassigning its state", async () => {
  const wrong: BridgeInvoke = async () => ({ provider: "cloudflare", available: true, running: true, managed: true, mcpUrl: "https://fixture.trycloudflare.com/mcp", message: "다른 제공자" });
  await assert.rejects(getProxyStatus("ngrok", wrong), /요청한 프록시/);
  await assert.rejects(applyProxyAction("start", null, "ngrok", wrong), /요청한 프록시/);
});
