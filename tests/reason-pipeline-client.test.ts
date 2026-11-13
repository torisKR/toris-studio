import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeInvoke } from "../desktop/src/ai-client";
import { createPipeline, listPipelines, normalizePipeline, sendStage, STAGES, updatePipeline } from "../desktop/src/reason/pipeline-client";
import type { ReasonPeer } from "../desktop/src/reason/types";

const peer = (id: string, name: string): ReasonPeer => ({ id, name, kind: "agent", machine: id.split("@")[1], cwd: null, branch: null, busy: false });
const peers = [peer("toris/muse@phone", "Muse"), peer("toris/codex@mac", "Codex"), peer("toris/claude@mac", "Claude")];
const stage = (name: string, status = "pending", assignee: string | null = "toris/muse@phone") =>
  ({ stage: name, assignee, status, sendKey: null, sentId: null, sentAt: null, replyId: null, reply: null });
const raw = (overrides: Record<string, unknown> = {}) => ({
  pipeline: { id: "p1", identity: "reason-network:team:agent:session", brief: "게임 출시", createdAt: "2026-11-13T01:00:00.000Z", cancelled: false, stages: STAGES.map(name => stage(name)) },
  current: "design",
  next: { stage: "design", assignee: "toris/muse@phone", text: "[Toris Studio 단계 요청] 디자인", digest: "abc123", resend: false },
  candidates: [],
  ...overrides
});
const recorder = (result: unknown) => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const call: BridgeInvoke = async (command, args) => { calls.push({ command, args }); return result as never; };
  return { calls, call };
};

test("a pipeline view keeps the host's stage order, statuses and approval text", () => {
  const view = normalizePipeline(raw());
  assert.ok(view);
  assert.deepEqual(view.stages.map(s => s.stage), [...STAGES]);
  assert.equal(view.current, "design");
  assert.equal(view.next?.digest, "abc123");
  assert.equal(view.next?.text, "[Toris Studio 단계 요청] 디자인");
  assert.equal("identity" in view, false, "internal identifiers stay out of the view");
});

test("an unreadable pipeline is dropped instead of being shown with a guessed status", () => {
  const stages = STAGES.map(name => stage(name));
  const bad = [
    null, {}, raw({ pipeline: null }),
    raw({ pipeline: { ...raw().pipeline, stages: stages.slice(0, 4) } }),
    raw({ pipeline: { ...raw().pipeline, stages: [...stages].reverse() } }),
    raw({ pipeline: { ...raw().pipeline, stages: stages.map((s, i) => i === 0 ? { ...s, status: "done" } : s) } }),
    raw({ pipeline: { ...raw().pipeline, stages: stages.map((s, i) => i === 0 ? { ...s, status: undefined } : s) } })
  ];
  for (const value of bad) assert.equal(normalizePipeline(value), null);
  // A next-send the UI cannot fully show is not offered for approval.
  assert.equal(normalizePipeline(raw({ next: { stage: "design", assignee: "toris/muse@phone", text: "", digest: "abc" } }))?.next, null);
  assert.equal(normalizePipeline(raw({ next: { stage: "marketing", assignee: "x/y@z", text: "t", digest: "d" } }))?.next, null);
});

test("listing only reads; nothing is sent by opening the tab", async () => {
  const { calls, call } = recorder([raw(), { broken: true }]);
  const views = await listPipelines(call);
  assert.equal(views.length, 1);
  assert.deepEqual(calls, [{ command: "reason_pipeline_list", args: undefined }]);
});

test("stages can only be assigned to agents on the current roster", async () => {
  const { calls, call } = recorder(raw());
  const assignees = ["toris/muse@phone", "", "toris/codex@mac", "", "toris/claude@mac"];
  await createPipeline(" 게임 출시 ", assignees, peers, call);
  assert.deepEqual(calls[0], { command: "reason_pipeline_create", args: { input: { brief: "게임 출시", assignees: ["toris/muse@phone", null, "toris/codex@mac", null, "toris/claude@mac"] } } });

  await assert.rejects(createPipeline("게임 출시", ["toris/ghost@cloud", "", "", "", ""], peers, call), /목록/);
  await assert.rejects(createPipeline("게임 출시", ["*", "", "", "", ""], peers, call));
  await assert.rejects(createPipeline("  ", assignees, peers, call), /브리프/);
  await assert.rejects(createPipeline("게임 출시", assignees.slice(0, 4), peers, call));
  await assert.rejects(updatePipeline("p1", { type: "assign", stage: "planning", assignee: "toris/ghost@cloud" }, peers, call), /목록/);
  assert.equal(calls.length, 1, "rejected input never reaches the host");

  await updatePipeline("p1", { type: "assign", stage: "planning", assignee: "toris/codex@mac" }, peers, call);
  await updatePipeline("p1", { type: "attach", stage: "design", messageId: "m1" }, peers, call);
  assert.deepEqual(calls[1].args, { input: { pipelineId: "p1", action: { type: "assign", stage: "planning", assignee: "toris/codex@mac" } } });
  assert.deepEqual(calls[2].args, { input: { pipelineId: "p1", action: { type: "attach", stage: "design", messageId: "m1" } } });
});

test("a stage is sent only with the digest of the text that was shown", async () => {
  const { calls, call } = recorder(raw({ next: null }));
  const view = normalizePipeline(raw())!;
  await sendStage(view, false, call);
  assert.deepEqual(calls[0], { command: "reason_pipeline_send", args: { input: { pipelineId: "p1", stage: "design", digest: "abc123", deployApproved: false } } });
  assert.equal(JSON.stringify(calls[0].args).includes("단계 요청"), false, "the window never supplies message text");

  await assert.rejects(sendStage({ ...view, next: null }, false, call), /보낼/);
  assert.equal(calls.length, 1);
});

test("the deploy stage needs its own explicit approval", async () => {
  const { calls, call } = recorder(raw({ next: null }));
  const deploy = normalizePipeline(raw({ current: "deploy", next: { stage: "deploy", assignee: "toris/claude@mac", text: "배포 요청", digest: "d1", resend: false } }))!;
  await assert.rejects(sendStage(deploy, false, call), /배포/);
  assert.equal(calls.length, 0);
  await sendStage(deploy, true, call);
  assert.deepEqual(calls[0].args, { input: { pipelineId: "p1", stage: "deploy", digest: "d1", deployApproved: true } });
});
