// Scenario evals: a JSON file of scripted model outputs, approval decisions and
// expected outcomes, replayed against a real workflow on a throwaway project.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunManager } from "../graph/runs.js";
import type { RunEvent } from "../protocol.js";
import { parseSettings } from "../runtime.js";
import { RoleModel, type RoleScript } from "./testing.js";

export type EvalScenario = {
  name: string;
  workflow?: string;
  task: string;
  /** Host data for workflows that run without a project. */
  input?: Record<string, unknown>;
  files: Record<string, string>;
  script: RoleScript;
  /** Decision for each approval, in the order they are requested. */
  decisions: Array<"approve" | "reject">;
  expect: { phase: "done" | "failed"; changes?: string[]; messages?: string[]; maxModelCalls?: number };
};

export type EvalResult = { name: string; ok: boolean; problems: string[]; events: number; modelCalls: number };

export async function runScenario(scenario: EvalScenario, timeoutMs = 20_000): Promise<EvalResult> {
  const root = mkdtempSync(path.join(tmpdir(), "agent-eval-"));
  const dir = path.join(root, "demo");
  for (const [file, body] of Object.entries(scenario.files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), body);
  }
  mkdirSync(dir, { recursive: true });
  const settings = parseSettings({ projectsRoot: root, chromaUrl: "http://127.0.0.1:9" });
  const model = new RoleModel(structuredClone(scenario.script));
  const events: RunEvent[] = [];
  let wake = () => {};
  const manager = new RunManager(() => settings, event => { events.push(event); wake(); }, () => model);
  const problems: string[] = [];
  const run = manager.start("demo", scenario.task, scenario.workflow ?? "coding", scenario.input ?? {});
  const deadline = Date.now() + timeoutMs;
  let decided = 0;
  while (Date.now() < deadline) {
    const view = manager.get(run.runId);
    if (view.phase === "done" || view.phase === "failed" || view.phase === "cancelled") break;
    const next = view.approvals[0];
    if (next) {
      const decision = scenario.decisions[decided++];
      if (!decision) { problems.push(`승인 요청 #${decided}에 대한 결정이 시나리오에 없습니다.`); manager.cancel(run.runId); break; }
      await manager.resume(run.runId, { actionId: next.id, decision });
      continue;
    }
    await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 50); });
  }
  const final = manager.get(run.runId);
  if (final.phase !== scenario.expect.phase) problems.push(`phase: expected ${scenario.expect.phase}, got ${final.phase}`);
  if (scenario.expect.changes && JSON.stringify([...final.changes].sort()) !== JSON.stringify([...scenario.expect.changes].sort())) problems.push(`changes: ${JSON.stringify(final.changes)}`);
  for (const pattern of scenario.expect.messages ?? []) if (!events.some(e => new RegExp(pattern).test(e.message))) problems.push(`no event matching /${pattern}/`);
  if (scenario.expect.maxModelCalls !== undefined && model.calls.length > scenario.expect.maxModelCalls) problems.push(`model calls ${model.calls.length} > ${scenario.expect.maxModelCalls}`);
  if (decided < scenario.decisions.length) problems.push(`unused decisions: ${scenario.decisions.length - decided}`);
  const left = model.leftovers();
  if (left.length) problems.push(`unused model outputs: ${left.join(", ")}`);
  manager.shutdown();
  return { name: scenario.name, ok: problems.length === 0, problems, events: events.length, modelCalls: model.calls.length };
}
