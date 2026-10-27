import assert from "node:assert/strict";
import test from "node:test";
import { EARLY_EVENTS_PER_RUN, EARLY_RUNS, agentCall, applyEvent, bufferEarlyEvent, diffLines, loadPanel, saveSettings } from "../desktop/src/agent-client";
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

test("a locked key store does not hide the runtime status, projects or runs", async () => {
  const vault = "OS 자격 증명 저장소 접근이 보류되었습니다.";
  const call = (async (command: string, args?: { method?: string }) => {
    if (command === "agent_settings_get") throw new Error(vault);
    if (args?.method === "status") return { version: "1.0.0", providers: [], chroma: false, projectsRoot: "/p" };
    if (args?.method === "projects.list") return { projects: [{ name: "demo", path: "/p/demo", stacks: [], scripts: {}, git: true }] };
    if (args?.method === "run.list") return { runs: [base] };
    throw new Error(`unexpected ${command} ${args?.method}`);
  }) as Parameters<typeof loadPanel>[0];
  const data = await loadPanel(call);
  assert.equal(data.status?.version, "1.0.0");
  assert.equal(data.settings, null);
  assert.deepEqual(data.projects.map(p => p.name), ["demo"]);
  assert.deepEqual(data.runs.map(r => r.runId), ["r1"]);
  assert.deepEqual(data.errors, [vault]);
});
