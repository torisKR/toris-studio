import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RunHistory } from "../src/graph/history.js";
import { RunManager } from "../src/graph/runs.js";
import { ScriptedModel } from "../src/llm/types.js";
import type { RunEvent } from "../src/protocol.js";
import { parseSettings } from "../src/runtime.js";

const j = (value: unknown) => JSON.stringify(value);

function setup(outputs: ConstructorParameters<typeof ScriptedModel>[0]) {
  const root = mkdtempSync(path.join(tmpdir(), "agent-history-"));
  mkdirSync(path.join(root, "demo", "src"), { recursive: true });
  writeFileSync(path.join(root, "demo", "src/a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "demo", "package.json"), j({ name: "demo" }));
  const dir = path.join(root, ".history");
  const settings = parseSettings({ projectsRoot: root, chromaUrl: "http://127.0.0.1:9" });
  const events: RunEvent[] = [];
  const waiters: Array<() => void> = [];
  const model = new ScriptedModel(outputs);
  const manager = new RunManager(() => settings, e => { events.push(e); waiters.splice(0).forEach(fn => fn()); }, () => model);
  manager.attachHistory(new RunHistory(dir));
  const until = (predicate: (e: RunEvent) => boolean) => new Promise<RunEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 15_000);
    const check = () => { const hit = events.find(predicate); if (hit) { clearTimeout(timer); resolve(hit); } else waiters.push(check); };
    check();
  });
  const reopen = () => {
    const next = new RunManager(() => settings, () => {}, () => model);
    next.attachHistory(new RunHistory(dir));
    return next;
  };
  return { dir, manager, until, reopen };
}

test("a finished run is still listed, with its log, after the app restarts", async () => {
  const h = setup([
    j({ route: "backend", plan: "p", testCommand: null }),
    j({ action: "finish", args: { summary: "변경 없음" } }),
    j({ verdict: "pass", summary: "확인 완료" }),
  ]);
  const run = h.manager.start("demo", "확인만 해줘");
  await h.until(e => e.phase === "done");
  const again = h.reopen();
  assert.deepEqual(again.list().map(r => [r.runId, r.phase, r.task]), [[run.runId, "done", "확인만 해줘"]]);
  const full = again.get(run.runId);
  assert.equal(full.summary, "확인 완료");
  assert.equal(full.events.at(-1)?.phase, "done");
  assert.ok(full.events.length >= 3);
});

test("a run cut off by the app closing comes back marked as stopped, with its log", async () => {
  const h = setup([
    j({ route: "backend", plan: "p", testCommand: null }),
    j({ action: "write_file", args: { path: "src/b.ts", content: "x\n" } }),
  ]);
  const run = h.manager.start("demo", "b 파일 만들어줘");
  await h.until(e => e.phase === "awaiting_approval");
  // No shutdown: a crash or force-quit must not lose the run either.
  const again = h.reopen();
  const back = again.get(run.runId);
  assert.equal(back.phase, "failed");
  assert.deepEqual(back.approvals, []);
  assert.ok(back.events.some(e => e.phase === "awaiting_approval"), "earlier log kept");
  assert.match(back.events.at(-1)!.message, /앱이 꺼져/);
  await assert.rejects(again.resume(run.runId, { actionId: "x", decision: "approve" }), /끝난 작업/);
  // A stopped run does not block a new one on the same project.
  assert.doesNotThrow(() => again.start("demo", "다시 해줘"));
  h.manager.shutdown(); again.shutdown();
});

test("history files are private, bad files are skipped, and old runs are pruned", () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "agent-history-")), "h");
  const history = new RunHistory(dir);
  const base = { workflow: "coding", project: "demo", task: "t", phase: "done" as const, agent: "supervisor" as const, approvals: [], changes: [], summary: "", events: [] };
  for (let i = 0; i < 35; i++) {
    const at = new Date(Date.UTC(2026, 9, 27, 0, 0, i)).toISOString();
    history.save({ ...base, runId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, createdAt: at, updatedAt: at });
  }
  writeFileSync(path.join(dir, "broken.json"), "{not json");
  writeFileSync(path.join(dir, "11111111-1111-4111-8111-111111111111.json"), j({ runId: "../escape", phase: "done" }));
  const runs = history.load();
  assert.equal(runs.length, 30, "only the newest 30 kept");
  assert.equal(runs.at(-1)!.runId.endsWith("000000000005"), true, "oldest dropped first");
  assert.equal(readdirSync(dir).filter(f => f.startsWith("00000000")).length, 30, "pruned files removed");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(dir, `${runs[0].runId}.json`)).mode & 0o777, 0o600);
  assert.throws(() => history.save({ ...base, runId: "../x", createdAt: "", updatedAt: "" }));
});

test("settings carry an absolute history directory", () => {
  assert.equal(parseSettings({ projectsRoot: "/p", chromaUrl: "http://127.0.0.1:9", historyDir: "/h/agent-runs" }).historyDir, "/h/agent-runs");
  assert.equal(parseSettings({ projectsRoot: "/p", chromaUrl: "http://127.0.0.1:9" }).historyDir, "");
  assert.throws(() => parseSettings({ projectsRoot: "/p", chromaUrl: "http://127.0.0.1:9", historyDir: "relative" }));
});
