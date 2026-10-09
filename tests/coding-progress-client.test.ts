import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, ChatState } from "../desktop/src/codexify-client";
import { codingProgress, elapsedLabel, requestProgress } from "../desktop/src/coding-progress-client";

const user: ChatMessage = { id: "request-1", role: "user", markdown: "첫 작업", start: 0, end: 100, created_at_ms: 1000, tool_call_count: 0 };
const reply: ChatMessage = { id: "reply-1", role: "agent", markdown: "첫 작업에 관한 응답", start: 100, end: 200, created_at_ms: 1001, tool_call_count: 1 };
const state: ChatState = { messages: [user], revision: "1", delivered_through: 0, read_through: 0, last_agent_call_at_ms: null, agent_waiting_until_ms: null, server_time_ms: 1000, has_more: false, before: null, unchanged: false };
const input = { state, receipt: null, conversationSelected: true, observedAt: 10_000, now: 10_100 };

test("saved, delivered and read are observed transport stages with no execution or completion claim", () => {
  for (const [value, expected] of [[state, "saved"], [{ ...state, delivered_through: 100 }, "delivered"], [{ ...state, delivered_through: 100, read_through: 100 }, "read"]] as const) {
    const result = codingProgress({ ...input, state: value });
    assert.equal(result.latest?.stage, expected);
    assert.equal(result.latest?.reply, null);
    assert.doesNotMatch(result.title, /실행 중|작업 완료/);
  }
  assert.match(codingProgress({ ...input, state: { ...state, read_through: 100 } }).detail, /실행 중인 작업이나 완료 여부는 아직 확인되지/);
});

test("a subsequent reply is observed without claiming request-specific completion", () => {
  const result = codingProgress({ ...input, state: { ...state, messages: [user, reply] } });
  assert.equal(result.latest?.stage, "reply");
  assert.equal(result.latest?.reply, reply);
  assert.match(result.detail, /작업 완료 여부는 응답 내용과 실제 결과로 확인/);
});

test("the work preview follows the latest actual agent update after a request", () => {
  const update = { ...reply, id: "reply-update", start: 200, end: 300, markdown: "실제 검증 단계 보고", created_at_ms: 1002 };
  const result = codingProgress({ ...input, state: { ...state, messages: [user, reply, update] } });
  assert.equal(result.latest?.reply, update);
});

test("a new saved receipt cannot inherit an older request reply or acknowledgements", () => {
  const result = codingProgress({ ...input, receipt: { id: "request-2", end: 300, created_at_ms: 1002, tool_call_count: 0 }, state: { ...state, messages: [user, reply], delivered_through: 200, read_through: 200 } });
  assert.equal(result.latest?.request.id, "request-2");
  assert.equal(result.latest?.stage, "saved");
  assert.equal(result.latest?.reply, null);
  assert.match(result.title, /전달을 기다리고/);
});

test("a reply after another request is not attributed to the previous request", () => {
  const next = { ...user, id: "request-2", markdown: "두 번째 작업", start: 100, end: 200 };
  const nextReply = { ...reply, start: 200, end: 300 };
  const value = { ...state, messages: [user, next, nextReply] };
  assert.equal(requestProgress(user, value).reply, null);
  assert.equal(requestProgress(next, value).reply, nextReply);
  assert.equal(codingProgress({ ...input, state: value }).latest?.request.id, next.id);
});

test("expired observations and read failures downgrade status even when old chat_await and reply exist", () => {
  const value = { ...state, messages: [user, reply], agent_waiting_until_ms: 99_000 };
  for (const changed of [{ now: 25_001 }, { error: "읽기 실패" }]) {
    const result = codingProgress({ ...input, state: value, ...changed });
    assert.equal(result.stale, true);
    assert.equal(result.agentWaiting, false);
    assert.match(result.title, /최근 작업 상태를 확인할 수 없습니다/);
    assert.equal(result.latest?.reply, reply, "Keep old observations for explicit history only");
  }
});

test("chat_await shows waiting for a request, never executing a job, and expires on the server clock", () => {
  const waiting = { ...state, messages: [], agent_waiting_until_ms: 1200 };
  assert.equal(codingProgress({ ...input, state: waiting }).agentWaiting, true);
  assert.match(codingProgress({ ...input, state: waiting }).title, /새 요청을 기다리고/);
  assert.equal(codingProgress({ ...input, state: waiting, now: 10_200 }).agentWaiting, false);
  assert.equal(codingProgress({ ...input, conversationSelected: false }).latest, null);
  assert.equal(codingProgress({ ...input, state: null }).stale, true);
});

test("elapsed observations use bounded readable durations", () => {
  assert.equal(elapsedLabel(null, 10_000), "시간 기록 없음");
  assert.equal(elapsedLabel(10_100, 10_000), "0초 전");
  assert.equal(elapsedLabel(0, 61_000), "1분 전");
  assert.equal(elapsedLabel(0, 3_600_000), "1시간 전");
});
