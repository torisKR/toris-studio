import assert from "node:assert/strict";
import test from "node:test";
import { EARLY_EVENTS_PER_RUN, EARLY_RUNS, agentCall, applyEvent, bufferEarlyEvent, diffLines, saveSettings, stageProgress } from "../desktop/src/agent-client";
import type { RunEvent, RunSummary } from "../desktop/src/agent-client";

const base: RunSummary = { runId: "r1", project: "demo", task: "t", phase: "queued", agent: "supervisor", createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", pending: null, changes: [], summary: "", events: [] };
const event = (seq: number, patch: Partial<RunEvent>): RunEvent => ({ event: "run", runId: "r1", seq, at: `2026-10-27T00:00:0${seq}Z`, agent: "supervisor", phase: "thinking", message: `m${seq}`, ...patch });

test("events apply in order; duplicates, stale and foreign events never rewind the run", () => {
  let run = applyEvent(base, event(1, {}))!;
  run = applyEvent(run, event(2, { agent: "frontend", phase: "awaiting_approval", approval: { kind: "run_command", id: "a1", agent: "frontend", command: ["pnpm", "test"], cwd: "demo", reason: "" } }))!;
  assert.equal(run.pending?.id, "a1");
  assert.equal(applyEvent(run, event(2, { phase: "done" })), run, "duplicate seq ignored");
  assert.equal(applyEvent(run, { ...event(9, {}), runId: "other" }), run);
  run = applyEvent(run, event(3, { agent: "frontend", phase: "testing" }))!;
  assert.equal(run.pending, null, "a decided approval clears");
  run = applyEvent(run, event(4, { phase: "done", detail: "완료 요약", changes: ["src/a.ts"] }))!;
  assert.equal(run.summary, "완료 요약");
  assert.deepEqual(run.changes, ["src/a.ts"]);
  assert.equal(run.events.length, 4);
});

test("stage progress reflects plan, implement, verify without inventing time", () => {
  assert.equal(stageProgress({ ...base, phase: "thinking" }).percent, 12);
  assert.equal(stageProgress({ ...base, agent: "backend", phase: "coding", events: [event(1, { agent: "backend" })] }).percent, 50);
  assert.equal(stageProgress({ ...base, agent: "qa", phase: "testing", events: [event(1, { agent: "qa" })] }).percent, 82);
  assert.equal(stageProgress({ ...base, phase: "done" }).percent, 100);
});

test("diff lines are typed for display", () => {
  const lines = diffLines("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same");
  assert.deepEqual(lines.map(l => l.kind), ["meta", "meta", "hunk", "del", "add", "ctx"]);
});

test("agent calls go through one allowlisted native command; keys are sent only on save", async () => {
  const calls: Array<[string, unknown]> = [];
  const call = async (command: string, args?: Record<string, unknown>) => { calls.push([command, args]); return {}; };
  await agentCall("run.start", { project: "demo", task: "t" }, call);
  const settings = { projectsRoot: "/p", ollamaUrl: "http://127.0.0.1:11434", agentModel: { provider: "codex-cli", model: "" }, contentModel: null, image: null, embedding: { provider: "local", model: "" } };
  await saveSettings(settings, { openai: "sk-test" }, call);
  assert.deepEqual(calls[0], ["agent_call", { method: "run.start", params: { project: "demo", task: "t" } }]);
  assert.deepEqual(calls[1], ["agent_settings_save", { input: { settings, keys: { openai: "sk-test" } } }]);
});

test("events for runs the tab does not know yet are buffered within fixed limits", () => {
  const buffer = new Map<string, RunEvent[]>();
  for (let i = 0; i < 300; i++) bufferEarlyEvent(buffer, { ...event(1, {}), seq: i + 1, runId: "same" });
  assert.equal(buffer.get("same")!.length, EARLY_EVENTS_PER_RUN, "per-run cap");
  assert.equal(buffer.get("same")!.at(-1)!.seq, 300, "newest kept");
  for (let i = 0; i < 50; i++) bufferEarlyEvent(buffer, { ...event(1, {}), runId: `run-${i}` });
  assert.equal(buffer.size, EARLY_RUNS, "run cap");
  assert.ok(buffer.has("run-49") && !buffer.has("same"), "oldest run dropped first");
});
