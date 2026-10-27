import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MemorySaver } from "@langchain/langgraph";
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
  const checkpointer = new MemorySaver();
  const manager = new RunManager(() => settings, event => { events.push(event); waiters.splice(0).forEach(fn => fn()); }, () => model, checkpointer);
  const until = (predicate: (e: RunEvent) => boolean) => new Promise<RunEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout; last=${JSON.stringify(events.at(-1))}`)), 15_000);
    const check = () => { const hit = events.find(predicate); if (hit) { clearTimeout(timer); resolve(hit); } else waiters.push(check); };
    check();
  });
  const threads = () => Object.keys(checkpointer.storage).length;
  return { dir, manager, events, until, model, threads };
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

test("a worker that never finishes stops at the step budget and the run is marked failed", async () => {
  const h = harness([j({ route: "backend", plan: "p" }), ...Array.from({ length: 80 }, () => j({ action: "list_dir", args: { path: "." } }))]);
  h.manager.start("demo", "끝나지 않는 작업");
  const end = await h.until(e => e.phase === "done" || e.phase === "failed");
  assert.equal(end.phase, "failed");
  assert.match(end.detail ?? "", /단계 한도\(60\)/);
  assert.equal(h.model.calls.length, 61);
});

test("QA failing every round ends as failed after two send-backs, never as done", async () => {
  const round = [j({ action: "finish", args: { summary: "다시 확인" } }), j({ command: null }), j({ verdict: "fail", feedback: "아직 틀림", summary: "미해결" })];
  const h = harness([
    j({ route: "backend", plan: "p", testCommand: null }),
    j({ action: "write_file", args: { path: "src/q.ts", content: "q\n" } }),
    ...round, ...round, ...round,
  ]);
  const run = h.manager.start("demo", "q 추가");
  const write = await h.until(e => e.phase === "awaiting_approval");
  await h.manager.resume(run.runId, { actionId: write.approval!.id, decision: "approve" });
  const end = await h.until(e => e.phase === "done" || e.phase === "failed");
  assert.equal(end.phase, "failed");
  assert.equal(end.detail, "미해결");
  assert.equal(h.events.filter(e => /돌려보냅니다/.test(e.message)).length, 2);
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

test("finished and cancelled runs free their saved graph state; a paused run keeps it", async () => {
  const done = harness([j({ route: "backend", plan: "p", testCommand: null }), j({ action: "finish", args: { summary: "s" } }), j({ verdict: "pass", summary: "ok" })]);
  done.manager.start("demo", "끝까지");
  await done.until(e => e.phase === "done" || e.phase === "failed");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done.threads(), 0, "a finished run keeps no checkpoint");

  const paused = harness([j({ route: "frontend", plan: "p" }), j({ action: "write_file", args: { path: "src/p.ts", content: "p\n" } })]);
  const run = paused.manager.start("demo", "멈춤");
  await paused.until(e => e.phase === "awaiting_approval");
  // A stale id waits for the graph to finish pausing, then is refused.
  await assert.rejects(paused.manager.resume(run.runId, { actionId: "stale", decision: "approve" }), /바뀌었습니다/);
  assert.equal(paused.threads(), 1, "a run waiting for approval needs its checkpoint to resume");
  paused.manager.cancel(run.runId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(paused.threads(), 0, "a cancelled run keeps no checkpoint");
});

test("approval events and run views carry the diff but never the full file content", async () => {
  const h = harness([j({ route: "frontend", plan: "p" }), j({ action: "write_file", args: { path: "src/big.ts", content: "BIG-CONTENT\n" } })]);
  const run = h.manager.start("demo", "큰 파일");
  const event = await h.until(e => e.phase === "awaiting_approval");
  assert.match(event.approval!.kind === "write_file" ? event.approval!.diff : "", /BIG-CONTENT/);
  assert.equal("content" in event.approval!, false, "event omits content");
  assert.equal("content" in (h.manager.get(run.runId).pending ?? {}), false, "view omits content");
  assert.equal(h.manager.get(run.runId).events.some(e => e.approval && "content" in e.approval), false, "stored history omits content");
});

test("a failing verification command overrides a QA model that says pass", async () => {
  const h = harness([
    j({ route: "backend", plan: "p", testCommand: ["npm", "test"] }),
    j({ action: "write_file", args: { path: "src/f.ts", content: "f\n" } }),
    j({ action: "finish", args: { summary: "끝" } }),
    j({ verdict: "pass", summary: "통과라고 주장" }),
    input => { assert.match(input.messages.at(-1)!.content, /검증 명령이 실패/); return j({ action: "finish", args: { summary: "다시" } }); },
    j({ verdict: "pass", summary: "또 주장" }),
    j({ action: "finish", args: { summary: "세 번째" } }),
    j({ verdict: "pass", summary: "계속 주장" }),
  ]);
  writeFileSync(path.join(h.dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node -e \"process.exit(3)\"" } }));
  const run = h.manager.start("demo", "f 추가");
  const approve = async (count: number) => {
    const pending = h.events.filter(e => e.phase === "awaiting_approval");
    await h.until(() => h.events.filter(e => e.phase === "awaiting_approval").length >= count);
    const next = h.events.filter(e => e.phase === "awaiting_approval")[count - 1] ?? pending.at(-1)!;
    await h.manager.resume(run.runId, { actionId: next.approval!.id, decision: "approve" });
  };
  for (let i = 1; i <= 4; i++) await approve(i);
  const end = await h.until(e => e.phase === "done" || e.phase === "failed");
  assert.equal(end.phase, "failed", "exit 3 can never end as done");
  assert.match(end.detail ?? "", /exit 3/);
});
