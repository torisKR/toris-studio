import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeInvoke } from "../desktop/src/codexify-client";
import { controlOpenWebUI, copyOpenWebUIBootstrap, getOpenWebUIStatus, openWebUI } from "../desktop/src/open-webui-client";
import type { OpenWebUIStatus } from "../desktop/src/open-webui-client";

const ready: OpenWebUIStatus = { status: "ready", message: "로컬 서버 응답 확인됨", checkedAt: "2026-10-09T00:00:00Z", version: "0.11.4", url: "http://127.0.0.1:43180", dockerAvailable: true, containerRunning: true, setupRequired: true, providerUrl: "http://host.docker.internal:10100/v1", mcpUrl: "http://host.docker.internal:21228/mcp", providerReachable: true, mcpReachable: true, canOpen: true };

test("local Open WebUI start stop and status use the owned native commands without credentials", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const call: BridgeInvoke = async (command, args) => { calls.push({ command, args }); return ready; };
  assert.equal(await getOpenWebUIStatus(call), ready);
  assert.equal(await controlOpenWebUI("start", call), ready);
  assert.equal(await controlOpenWebUI("stop", call), ready);
  assert.deepEqual(calls, [{ command: "open_webui_status", args: undefined }, { command: "open_webui_start", args: undefined }, { command: "open_webui_stop", args: undefined }]);
});

test("the chat opens through the isolated native window only after the local server is ready", async () => {
  const calls: string[] = [];
  const call: BridgeInvoke = async command => { calls.push(command); return null; };
  for (const value of [null, { ...ready, status: "starting" as const }, { ...ready, canOpen: false }]) await assert.rejects(openWebUI(value, call), /준비되면/);
  assert.deepEqual(calls, []);
  await openWebUI(ready, call);
  assert.deepEqual(calls, ["open_webui_open"]);
});

test("bootstrap copies the native selected project guidance without dispatching a chat request", async () => {
  const calls: string[] = [];
  await copyOpenWebUIBootstrap(async (command, args) => {
    calls.push(command);
    if (command === "open_webui_bootstrap") return "저장한 프로젝트의 set_project_root를 선택하세요.";
    assert.equal(command, "copy_text");
    assert.deepEqual(args, { text: "저장한 프로젝트의 set_project_root를 선택하세요." });
  });
  assert.deepEqual(calls, ["open_webui_bootstrap", "copy_text"]);
});
