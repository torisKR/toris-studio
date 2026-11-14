import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeInvoke } from "../desktop/src/ai-client";
import { IMPLEMENTATION_MODEL, startProject } from "../desktop/src/reason/agent-launch-client";
import {
  createProjectPipeline, normalizePipeline, PROJECT_STAGES, projectAgentPeer, stageLabel, suggestPeer
} from "../desktop/src/reason/pipeline-client";
import type { ReasonPeer } from "../desktop/src/reason/types";

const peer = (id: string, name: string, kind = "agent"): ReasonPeer => ({ id, name, kind, machine: id.split("@")[1], cwd: null, branch: null, busy: false });
const peers = [
  peer("toris/muse@cloud", "Muse"), peer("toris/openai-dots@cloud", "OpenAI Dots"),
  peer("toris/mac-claude-app-1a2b@mac", "mac-claude-app-1a2b", "claude-code"), peer("toris/mac-claude-app-1a2b@other", "mac-claude-app-1a2b")
];
const session = { id: "s1", kind: "claude", name: "mac-claude-app-1a2b", folder: "/Users/toris/projects/app", branch: "main", model: IMPLEMENTATION_MODEL, running: true, exitCode: null };
const stage = (name: string) => ({ stage: name, assignee: null, status: "pending", sendKey: null, sentId: null, sentAt: null, replyId: null, reply: null });
const project = { folder: "/Users/toris/projects/app", name: "app", branch: "main", agentName: "mac-claude-app-1a2b", agentModel: IMPLEMENTATION_MODEL, snapshot: "- 감지한 구성: Flutter" };
const raw = (overrides: Record<string, unknown> = {}) => ({
  pipeline: { id: "pp1", identity: "x", brief: "반복 일정", createdAt: "", cancelled: false, kind: "project", project, stages: PROJECT_STAGES.map(stage), ...overrides },
  current: "planning", next: null, candidates: []
});
const recorder = (result: unknown) => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const call: BridgeInvoke = async (command, args) => { calls.push({ command, args }); return result as never; };
  return { calls, call };
};

test("a project pipeline keeps its four stages, project and labels", () => {
  const view = normalizePipeline(raw());
  assert.ok(view);
  assert.equal(view.kind, "project");
  assert.deepEqual(view.stages.map(s => s.stage), ["planning", "spec", "design", "development"]);
  assert.equal(view.project?.agentModel, "Claude Opus 5.5 · effort medium");
  assert.equal("snapshot" in view.project!, false, "the folder snapshot stays in the host's request text");
  assert.equal(stageLabel("project", "planning"), "기획 초안");
  assert.equal(stageLabel("studio", "planning"), "기획");
  assert.equal(stageLabel("project", "spec"), "기획 확정");
  // Wrong order, missing project or an unknown kind is dropped rather than guessed.
  assert.equal(normalizePipeline(raw({ stages: [...PROJECT_STAGES].reverse().map(stage) })), null);
  assert.equal(normalizePipeline(raw({ project: null })), null);
  assert.equal(normalizePipeline(raw({ kind: "release" })), null);
  assert.equal(normalizePipeline(raw({ kind: "studio" })), null, "studio pipelines have five stages");
});

test("Muse and OpenAI Dots are suggested as planners; the developer is this machine's session", () => {
  assert.equal(suggestPeer(peers, /muse/i), "toris/muse@cloud");
  assert.equal(suggestPeer(peers, /dots/i), "toris/openai-dots@cloud");
  assert.equal(suggestPeer(peers, /grok/i), "");
  assert.equal(projectAgentPeer("mac-claude-app-1a2b", peers, "toris/studio@mac"), "toris/mac-claude-app-1a2b@mac");
  assert.equal(projectAgentPeer("mac-claude-app-1a2b", peers, null), "");
});

test("opening a project sends only the typed path; the host confirms and starts Opus", async () => {
  const { calls, call } = recorder({ cancelled: false, reused: false, session, sessions: [session] });
  const started = await startProject("  ~/projects/app ", call);
  assert.deepEqual(calls, [{ command: "reason_project_start", args: { input: { path: "~/projects/app" } } }]);
  assert.equal(started?.session.model, IMPLEMENTATION_MODEL);
  assert.equal(started?.reused, false);
  for (const bad of ["", "projects/app", "~"]) await assert.rejects(startProject(bad, call));
  assert.equal(calls.length, 1, "a relative or empty path never reaches the host");
  assert.equal(await startProject("/Users/toris/projects/app", recorder({ cancelled: true }).call), null);
  await assert.rejects(startProject("/x/app", recorder({ cancelled: false, session: { ...session, kind: "codex" } }).call), /구현 에이전트/);
});

test("a project pipeline names only the session; the host reads its folder", async () => {
  const { calls, call } = recorder(raw());
  const assignees = ["toris/muse@cloud", "toris/openai-dots@cloud", "", "toris/mac-claude-app-1a2b@mac"];
  const view = await createProjectPipeline(" 반복 일정 ", assignees, "s1", peers, call);
  assert.equal(view.kind, "project");
  assert.deepEqual(calls[0], { command: "reason_pipeline_create", args: { input: {
    brief: "반복 일정", assignees: ["toris/muse@cloud", "toris/openai-dots@cloud", null, "toris/mac-claude-app-1a2b@mac"], projectSessionId: "s1" } } });
  assert.equal(JSON.stringify(calls[0].args).includes("/Users/toris"), false, "the window never supplies the folder");
  await assert.rejects(createProjectPipeline("x", assignees, "", peers, call), /프로젝트 경로/);
  await assert.rejects(createProjectPipeline("x", assignees.slice(0, 3), "s1", peers, call));
  await assert.rejects(createProjectPipeline("x", ["toris/ghost@cloud", "", "", ""], "s1", peers, call), /목록/);
  assert.equal(calls.length, 1);
});
