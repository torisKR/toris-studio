import assert from "node:assert/strict";
import test from "node:test";
import { agentWaiting, bootstrapPrompt, connectedChatUrl, openConnectedChat, profileKey, projectChats, receiptState, sendToConnectedChat } from "../desktop/src/codexify-client";
import type { BridgeInvoke, ChatState, CodexifyChat, CodexifyProfile } from "../desktop/src/codexify-client";

const profile: CodexifyProfile = { mcpUrl: "http://127.0.0.1:21228/mcp", pluginUrl: "https://chatgpt.com/plugins/plugin_fixture", conversationUrl: "", projectRoot: "/projects/studio", conversationId: "a".repeat(64) };
const chat: CodexifyChat = { id: profile.conversationId, title: "Studio", workspace: "studio", lastEntryEnd: 100, lastEntryAtMs: 1000, lastAgentCallAtMs: null, agentWaitingUntilMs: null, totalToolCalls: 0 };
const state: ChatState = { messages: [], revision: "1", delivered_through: 0, read_through: 0, last_agent_call_at_ms: null, agent_waiting_until_ms: null, server_time_ms: 1000, has_more: false, before: null, unchanged: false };
const receipt = { id: "message-fixture", end: 300, created_at_ms: 1001, tool_call_count: 0 };

test("owner chat basename is a display filter; opaque IDs never become a ChatGPT URL", () => {
  const chats = [chat, { ...chat, id: "b".repeat(64), workspace: "other" }, { ...chat, id: "c".repeat(64), workspace: "/projects/studio" }];
  assert.deepEqual(projectChats(chats, "/projects/studio/"), [chat]);
  assert.deepEqual(projectChats(chats, "C:\\Projects\\studio\\"), [chat]);
  assert.deepEqual(projectChats(chats, ""), []);
  assert.equal(connectedChatUrl(profile), profile.pluginUrl);
  assert.doesNotMatch(connectedChatUrl(profile), new RegExp(profile.conversationId));
});

test("native project namespace matching includes real Codexify chats and rejects same-name other checkouts", () => {
  const matching = { ...chat, workspace: "toris_studio-ef36692118dc", projectMatches: true };
  const sameNameOtherProject = { ...chat, id: "b".repeat(64), workspace: "studio", projectMatches: false };
  const nonmatchingNamespace = { ...chat, id: "c".repeat(64), workspace: "toris_studio-3b89305533bd", projectMatches: false };
  assert.deepEqual(projectChats([matching, sameNameOtherProject, nonmatchingNamespace], "/projects/studio"), [matching]);
  assert.deepEqual(projectChats([matching], ""), []);
});

test("opening a connection uses only the saved official plugin or conversation URL", async () => {
  const opened: unknown[] = [];
  const call: BridgeInvoke = async (command, args) => {
    if (command === "codexify_connection_get") return { ...profile, conversationUrl: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc" };
    if (command === "open_external") { opened.push(args); return null; }
    throw new Error(`Unexpected ${command}`);
  };
  await openConnectedChat(call);
  assert.deepEqual(opened, [{ url: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc" }]);
  for (const url of ["http://chatgpt.com/plugins/foo", "https://chatgpt.com.evil.test/plugins/foo", "https://name:secret@chatgpt.com/plugins/foo", "https://chatgpt.com:444/plugins/foo", "https://chatgpt.com/c/foo?token=secret", "javascript:alert(1)", "https://chatgpt.com/", "https://chatgpt.com/plugins/"]) {
    assert.throws(() => connectedChatUrl({ ...profile, pluginUrl: url }), undefined, url);
  }
  assert.throws(() => connectedChatUrl({ ...profile, pluginUrl: "" }));
});

test("delivery receipts distinguish persisted messages, returned tool data, and agent acknowledgement", () => {
  assert.equal(receiptState(receipt, null), "saved");
  assert.equal(receiptState(receipt, { delivered_through: 299, read_through: 0 }), "saved");
  assert.equal(receiptState(receipt, { delivered_through: 300, read_through: 299 }), "delivered");
  assert.equal(receiptState(receipt, { delivered_through: 300, read_through: 300 }), "read");
  assert.equal(agentWaiting(state), false);
  assert.equal(agentWaiting({ ...state, agent_waiting_until_ms: 1000 }), false);
  assert.equal(agentWaiting({ ...state, agent_waiting_until_ms: 1001 }), true);
});

test("sending to a dormant chat returns a saved receipt without claiming that a new turn started", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const call: BridgeInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "codexify_connection_get") return profile;
    if (command === "codexify_chats") return { chats: [chat], serverTimeMs: 1000 };
    if (command === "codexify_chat_read") return state;
    if (command === "codexify_chat_send") return { sent: receipt };
    throw new Error(`Unexpected ${command}`);
  };
  const result = await sendToConnectedChat("요청을 처리해줘", "request-fixture", call);
  assert.deepEqual(result, { receipt, waiting: false });
  assert.deepEqual(calls.map(item => item.command), ["codexify_connection_get", "codexify_chats", "codexify_chat_read", "codexify_connection_get", "codexify_chat_send"]);
  assert.deepEqual(calls.at(-1)?.args, { input: { requestId: "request-fixture", message: "요청을 처리해줘", expectedProfile: profile } });
});

test("dispatch accepts a verified real namespace while passing the saved full profile to native validation", async () => {
  const call: BridgeInvoke = async (command, args) => {
    if (command === "codexify_connection_get") return profile;
    if (command === "codexify_chats") return { chats: [{ ...chat, workspace: "toris_studio-ef36692118dc", projectMatches: true }], serverTimeMs: 1000 };
    if (command === "codexify_chat_read") return state;
    if (command === "codexify_chat_send") { assert.deepEqual((args?.input as { expectedProfile: CodexifyProfile }).expectedProfile, profile); return { sent: receipt }; }
    throw new Error(`Unexpected ${command}`);
  };
  assert.deepEqual(await sendToConnectedChat("검증된 프로젝트 요청", "namespace-request", call), { receipt, waiting: false });
});

test("a changed profile or missing project conversation prevents a stale request from being sent", async () => {
  let reads = 0, sends = 0;
  const changed: BridgeInvoke = async command => {
    if (command === "codexify_connection_get") return ++reads === 1 ? profile : { ...profile, conversationId: "b".repeat(64) };
    if (command === "codexify_chats") return { chats: [chat], serverTimeMs: 1000 };
    if (command === "codexify_chat_read") return state;
    if (command === "codexify_chat_send") { sends++; return { sent: receipt }; }
    throw new Error(`Unexpected ${command}`);
  };
  await assert.rejects(sendToConnectedChat("요청", "request-fixture", changed), /설정이 변경/);
  assert.equal(sends, 0);
  const missing: BridgeInvoke = async command => {
    if (command === "codexify_connection_get") return profile;
    if (command === "codexify_chats") return { chats: [{ ...chat, workspace: "other" }], serverTimeMs: 1000 };
    throw new Error(`Unexpected ${command}`);
  };
  await assert.rejects(sendToConnectedChat("요청", "request-fixture", missing), /대화 목록에 없습니다/);
  await assert.rejects(sendToConnectedChat(" ", "request-fixture", missing), /내용을 입력/);
  assert.notEqual(profileKey(profile), profileKey({ ...profile, mcpUrl: "http://localhost:21228/mcp" }));
});

test("bootstrap asks the active registered conversation to wait and return genuine Studio files", () => {
  const prompt = bootstrapPrompt(profile);
  assert.match(prompt, /setup과 get_agent_brief/);
  assert.match(prompt, /다른 프로젝트가 이미 연결돼 있으면 임의로 바꾸지/);
  assert.ok(prompt.includes(`set_project_root(${JSON.stringify({ path: profile.projectRoot, createWorktree: false })})`));
  assert.match(prompt, /chat_write/);
  assert.match(prompt, /chat_await/);
  assert.match(prompt, /download_url\/file_id/);
  assert.match(prompt, /새 ChatGPT 턴이 시작되는 것은 아니야/);
  assert.doesNotMatch(prompt, /쿠키|Bearer|apiKey/);
  assert.throws(() => bootstrapPrompt({ ...profile, projectRoot: "" }));
});
