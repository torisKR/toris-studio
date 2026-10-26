import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RunManager } from "../src/graph/runs.js";
import { ScriptedModel } from "../src/llm/types.js";
import type { RunEvent } from "../src/protocol.js";
import { parseSettings } from "../src/runtime.js";

function project() {
  const root = mkdtempSync(path.join(tmpdir(), "agent-graph-"));
  const dir = path.join(root, "demo");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node -e \"console.log('tests ok')\"" } }));
  return { root, dir };
}

function harness(outputs: ConstructorParameters<typeof ScriptedModel>[0]) {
  const { root, dir } = project();
  const settings = parseSettings({ projectsRoot: root, chromaUrl: "http://127.0.0.1:9" });
  const events: RunEvent[] = [];
  const waiters: Array<() => void> = [];
  const model = new ScriptedModel(outputs);
  const manager = new RunManager(() => settings, event => { events.push(event); waiters.splice(0).forEach(fn => fn()); }, () => model);
  const until = (predicate: (e: RunEvent) => boolean) => new Promise<RunEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout; last=${JSON.stringify(events.at(-1))}`)), 15_000);
    const check = () => { const hit = events.find(predicate); if (hit) { clearTimeout(timer); resolve(hit); } else waiters.push(check); };
    check();
  });
  return { dir, manager, events, until, model };
}

const j = (value: unknown) => JSON.stringify(value);

test("supervisor routes, writes and commands wait for approval, QA passes", async () => {
  const h = harness([
    j({ route: "backend", plan: "a를 10으로", testCommand: ["npm", "test"], reason: "상수" }),
    j({ thought: "파일 확인", action: "read_file", args: { path: "src/a.ts" } }),
    j({ thought: "수정", action: "edit_file", args: { path: "src/a.ts", edits: [{ find: "a = 1", replace: "a = 10" }], reason: "요청" } }),
    j({ thought: "끝", action: "finish", args: { summary: "a를 10으로 바꿈" } }),
    input => { assert.match(input.messages[0].content, /tests ok/); return j({ verdict: "pass", feedback: "", summary: "테스트 통과" }); },
  ]);
  const run = h.manager.start("demo", "a를 10으로 바꿔줘");
  const write = await h.until(e => e.phase === "awaiting_approval" && e.approval?.kind === "write_file");
  assert.equal(readFileSync(path.join(h.dir, "src/a.ts"), "utf8"), "export const a = 1;\n", "nothing written before approval");
  assert.match(write.approval!.kind === "write_file" ? write.approval!.diff : "", /\+export const a = 10;/);
  assert.equal(h.events.find(e => e.agent === "backend")?.agent, "backend");
  await h.manager.resume(run.runId, { actionId: write.approval!.id, decision: "approve" });
  const command = await h.until(e => e.phase === "awaiting_approval" && e.approval?.kind === "run_command");
  assert.equal(readFileSync(path.join(h.dir, "src/a.ts"), "utf8"), "export const a = 10;\n");
  assert.equal(command.agent, "qa");
  await h.manager.resume(run.runId, { actionId: command.approval!.id, decision: "approve" });
  const done = await h.until(e => e.phase === "done");
  assert.equal(done.detail, "테스트 통과");
  assert.deepEqual(h.manager.get(run.runId).changes, ["src/a.ts"]);
});

test("a rejected write is reported back to the expert and QA can send work back", async () => {
  const h = harness([
    j({ route: "frontend", plan: "p", testCommand: null }),
    j({ action: "write_file", args: { path: "src/b.ts", content: "x\n" } }),
    input => { assert.match(input.messages.at(-1)!.content, /거절.*다른 파일명/); return j({ action: "finish", args: { summary: "변경 없음" } }); },
    j({ command: null, reason: "없음" }),
    j({ verdict: "fail", feedback: "src/c.ts를 만드세요", summary: "미완료" }),
    input => { assert.match(input.messages.at(-1)!.content, /QA 피드백/); return j({ action: "finish", args: { summary: "재확인" } }); },
    j({ command: null }),
    j({ verdict: "pass", summary: "확인 완료" }),
  ]);
  const run = h.manager.start("demo", "b 파일 추가");
  const write = await h.until(e => e.phase === "awaiting_approval");
  await h.manager.resume(run.runId, { actionId: write.approval!.id, decision: "reject", feedback: "다른 파일명으로" });
  await h.until(e => e.phase === "done" || e.phase === "failed");
  assert.ok(h.events.some(e => e.agent === "qa" && /돌려보냅니다/.test(e.message)));
  assert.equal(h.model.calls.length, 8);
});

test("stale approval ids and concurrent runs on one project are refused", async () => {
  const h = harness([j({ route: "frontend", plan: "p" }), j({ action: "write_file", args: { path: "src/z.ts", content: "z\n" } })]);
  const run = h.manager.start("demo", "z");
  await h.until(e => e.phase === "awaiting_approval");
  await assert.rejects(h.manager.resume(run.runId, { actionId: "wrong", decision: "approve" }), /바뀌었습니다/);
  assert.throws(() => h.manager.start("demo", "다른 작업"), /진행 중/);
  h.manager.cancel(run.runId);
  assert.equal(h.manager.get(run.runId).phase, "cancelled");
});
