import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeInvoke } from "../desktop/src/ai-client";
import {
  acceptVideoRequest, normalizeResult, normalizeSnapshot, readVideoResult, refreshNetwork, sendNetworkMessage, sendVideoResult, STORYBOARD_REQUEST_EXAMPLE, VIDEO_REQUEST_EXAMPLE
} from "../desktop/src/reason/reason-client";
import { launchAgent, normalizeSessions, sessionState, stopAgent } from "../desktop/src/reason/agent-launch-client";

const request = JSON.parse(VIDEO_REQUEST_EXAMPLE);
const incoming = { id: "message-1", from: "toris/muse@phone", fromName: "Muse", text: VIDEO_REQUEST_EXAMPLE, createdAt: null, replyTo: null, video: request, requestError: null, jobId: null };
const snapshot = { state: "connected", version: "0.12.17", selfId: "toris/studio@mac-mini", peers: [{ id: "toris/muse@phone", name: "Muse", kind: "muse", machine: "phone", cwd: null, branch: null, busy: false }], messages: [incoming], error: null };

test("legacy null responses never look connected or crash the Agent tab", () => {
  for (const raw of [null, undefined, false, [], { state: "ready" }]) {
    const parsed = normalizeSnapshot(raw);
    assert.equal(parsed.state, "error");
    assert.ok(parsed.error);
    assert.deepEqual(parsed.peers, []);
    assert.deepEqual(parsed.messages, []);
  }
});

test("the snapshot retains exact Studio address and request identities, without inventing peers", () => {
  const parsed = normalizeSnapshot({ ...snapshot, peers: [...snapshot.peers, snapshot.peers[0], { id: "*" }, null], messages: [incoming, incoming, {}] });
  assert.equal(parsed.selfId, "toris/studio@mac-mini");
  assert.deepEqual(parsed.peers.map(p => p.id), ["toris/muse@phone"]);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].video?.requestId, "video-demo-001");
  assert.equal(parsed.messages[0].from, "toris/muse@phone");
  assert.equal(parsed.messages[0].video?.settings.visual, "stock");
});

test("malformed video previews remain readable but cannot become accepted video requests", () => {
  for (const bad of [
    { ...request, schema: "other" },
    { ...request, settings: { ...request.settings, durationSec: 999 } },
    { ...request, settings: { ...request.settings, visual: "shell" } },
    { ...request, settings: { ...request.settings, narration: "yes" } }
  ]) {
    const message = normalizeSnapshot({ ...snapshot, messages: [{ ...incoming, video: bad }] }).messages[0];
    assert.equal(message.video, null);
    assert.ok(message.requestError);
    assert.equal(message.text, incoming.text);
  }
  const message = normalizeSnapshot({ ...snapshot, messages: [{ ...incoming, video: null, requestError: "허용되지 않은 설정입니다." }] }).messages[0];
  assert.equal(message.requestError, "허용되지 않은 설정입니다.");
});

test("external storyboards retain their script and scene preview instead of becoming a new topic-only plan", () => {
  const external = JSON.parse(STORYBOARD_REQUEST_EXAMPLE);
  const parsed = normalizeSnapshot({ ...snapshot, messages: [{ ...incoming, video: external }] }).messages[0];
  assert.equal(parsed.requestError, null);
  assert.equal(parsed.video?.storyboard?.title, external.storyboard.title);
  assert.equal(parsed.video?.storyboard?.scenes.length, 3);
  assert.deepEqual(parsed.video?.storyboard?.scenes.map(s => s.narration), external.storyboard.scenes.map((s: { narration: string }) => s.narration));
  assert.equal(parsed.video?.storyboard?.story, external.storyboard.story);
  assert.equal(parsed.video?.settings.durationSec, external.storyboard.scenes.reduce((total: number, s: { durationSec: number }) => total + s.durationSec, 0));
});

test("malformed imported storyboards never silently fall back to topic-only planning", () => {
  const external = JSON.parse(STORYBOARD_REQUEST_EXAMPLE);
  const board = external.storyboard;
  for (const storyboard of [
    {}, { ...board, title: "" }, { ...board, scenes: [] },
    { ...board, scenes: [{ ...board.scenes[0], durationSec: Infinity }, board.scenes[1]] },
    { ...board, scenes: [{ ...board.scenes[0], durationSec: 0 }, board.scenes[1]] },
    { ...board, scenes: [board.scenes[0], board.scenes[0]] },
    { ...board, scenes: [{ ...board.scenes[0], durationSec: "10" }, board.scenes[1]] }
  ]) {
    const parsed = normalizeSnapshot({ ...snapshot, messages: [{ ...incoming, video: { ...external, storyboard } }] }).messages[0];
    assert.equal(parsed.video, null);
    assert.ok(parsed.requestError);
  }
});

test("queries never send, accept, approve, render or publish anything", async () => {
  const calls: string[] = [];
  const call: BridgeInvoke = async command => {
    calls.push(command);
    return command === "reason_network_refresh" ? snapshot : { jobId: "job-1", status: "awaiting_approval", stage: "storyboard", title: "검토할 영상", hasVideo: false, requiresApproval: true, summary: "스토리보드 승인 대기" };
  };
  await refreshNetwork(call);
  const result = await readVideoResult("message-1", call);
  assert.deepEqual(calls, ["reason_network_refresh", "reason_network_video_result"]);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.hasVideo, false);
});

test("accepting uses only the stored message id; host owns validation, settings and deduplication", async () => {
  const calls: Array<[string, unknown]> = [];
  const call: BridgeInvoke = async (command, args) => { calls.push([command, args]); return { jobId: "video-existing-7", reused: true }; };
  assert.deepEqual(await acceptVideoRequest("message-1", call), { jobId: "video-existing-7", reused: true });
  assert.deepEqual(calls, [["reason_network_accept_video", { input: { messageId: "message-1" } }]]);
});

test("send and reply preserve a single explicit target and never broadcast", async () => {
  const calls: Array<[string, unknown]> = [];
  const call: BridgeInvoke = async (command, args) => { calls.push([command, args]); return { messageIds: ["sent-1"] }; };
  await sendNetworkMessage("toris/muse@phone", "  요청 확인했습니다.  ", "message-1", call);
  assert.deepEqual(calls, [["reason_network_send", { input: { target: "toris/muse@phone", text: "요청 확인했습니다.", replyTo: "message-1" } }]]);
  for (const target of ["", "*", "toris/*", "repo:studio", "bad\nrecipient"]) await assert.rejects(sendNetworkMessage(target, "hello", undefined, call));
  await assert.rejects(sendNetworkMessage("toris/muse@phone", " ", undefined, call));
  await assert.rejects(sendNetworkMessage("toris/muse@phone", "a".repeat(16001), undefined, call));
  assert.equal(calls.length, 1, "invalid outbound requests never reach IPC");
});

test("result sending uses the persisted request; an unknown receipt is never reported as success", async () => {
  const calls: Array<[string, unknown]> = [];
  const call: BridgeInvoke = async (command, args) => { calls.push([command, args]); return { messageIds: ["result-1"] }; };
  assert.deepEqual(await sendVideoResult("message-1", call), { messageIds: ["result-1"] });
  assert.deepEqual(calls, [["reason_network_send_result", { input: { messageId: "message-1" } }]]);
  await assert.rejects(sendNetworkMessage("toris/muse@phone", "hello", undefined, async () => null), /전송 결과/);
  await assert.rejects(acceptVideoRequest("message-1", async () => ({})), /영상 작업/);
  assert.throws(() => normalizeResult(null), /영상 작업 결과/);
});

test("the copied example is strict JSON data in the supported video contract", () => {
  assert.equal(request.schema, "toris-studio.video.v1");
  assert.ok(request.requestId);
  assert.equal(request.settings.durationSec, 30);
  assert.equal(request.settings.aspect, "9:16");
  assert.deepEqual(Object.keys(request).sort(), ["requestId", "schema", "settings"]);
  assert.equal(normalizeSnapshot({ ...snapshot, messages: [incoming] }).messages[0].requestError, null);
});

// Development agents: Studio starts `reason network serve` only after an explicit confirmation.
const draft = { kind: "claude", folder: "/Users/qa/projects/demo", branch: "main", name: "mac-mini-claude-demo" };
const session = { id: "s1", kind: "claude", name: draft.name, folder: draft.folder, branch: "main", running: true, exitCode: null };

test("launching names only the agent kind; folder choice and confirmation stay in the host", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  let response: unknown = { cancelled: false, sessions: [session] };
  const call: BridgeInvoke = async (command, args) => { calls.push({ command, args }); return response as never; };
  assert.equal((await launchAgent("claude", call))?.[0].name, draft.name);
  assert.deepEqual(calls, [{ command: "reason_agent_launch", args: { input: { kind: "claude" } } }]);
  assert.equal(JSON.stringify(calls[0].args).includes("folder"), false, "the page cannot choose the folder");
  response = { cancelled: true };
  assert.equal(await launchAgent("codex", call), null);
  response = null;
  assert.equal(await launchAgent("codex", call), null, "an unreadable answer is never shown as started");
  await assert.rejects(launchAgent("grok" as never, call), /Claude/);
  assert.equal(calls.length, 3, "an unsupported agent never reaches the host");
  await stopAgent("s1", call);
  assert.deepEqual(calls[3], { command: "reason_agent_stop", args: { input: { id: "s1" } } });
});

test("session rows show process truth and are matched to the roster by exact name and machine", () => {
  const rows = normalizeSessions([session, { ...session, id: "s2", kind: "grok" }, { ...session, id: "s3", running: false, exitCode: 7 }, null, { id: "s4" }]);
  assert.deepEqual(rows.map(row => row.id), ["s1", "s3"]);
  assert.equal(rows[1].exitCode, 7);
  const roster = [{ id: "toris/mac-mini-claude-demo@mac-mini", name: draft.name, kind: "claude-code", machine: "mac-mini", cwd: draft.folder, branch: "main", busy: false }];
  assert.equal(sessionState(rows[0], roster, "toris/studio@mac-mini"), "connected");
  assert.equal(sessionState(rows[0], roster, "toris/studio@other-mac"), "registering", "a same-named session on another machine is not ours");
  assert.equal(sessionState(rows[0], [], "toris/studio@mac-mini"), "registering");
  assert.equal(sessionState(rows[1], roster, "toris/studio@mac-mini"), "exited");
});
