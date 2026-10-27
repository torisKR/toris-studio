import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RunManager } from "../src/graph/runs.js";
import { RoleModel, type ScriptOutput } from "../src/harness/testing.js";
import type { RunEvent } from "../src/protocol.js";
import { parseSettings } from "../src/runtime.js";

type Role = "supervisor" | "frontend" | "backend" | "qaPlan" | "qaReview";
type Script = Partial<Record<Role, ScriptOutput[]>>;

function project(scripts: Record<string, string> = { test: "node -e \"console.log('tests ok')\"" }) {
  const root = mkdtempSync(path.join(tmpdir(), "agent-graph-"));
  const dir = path.join(root, "demo");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", scripts }));
  return { root, dir };
}

function harness(script: Script, scripts?: Record<string, string>) {
  const { root, dir } = project(scripts);
  const settings = parseSettings({ projectsRoot: root, chromaUrl: "http://127.0.0.1:9" });
  const events: RunEvent[] = [];
  const waiters: Array<() => void> = [];
  const model = new RoleModel(script as Record<string, ScriptOutput[]>);
  const manager = new RunManager(() => settings, event => { events.push(event); waiters.splice(0).forEach(fn => fn()); }, () => model);
  const until = (predicate: (e: RunEvent) => boolean, what = "event") => new Promise<RunEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}; last=${JSON.stringify(events.at(-1))}`)), 15_000);
    const check = () => { const hit = events.find(predicate); if (hit) { clearTimeout(timer); resolve(hit); } else waiters.push(check); };
    check();
  });
  const asks = () => events.filter(e => e.approval);
  /** Waits for the n-th approval request (1-based) and returns it. */
  const ask = async (n: number) => { await until(() => asks().length >= n, `approval #${n}`); return asks()[n - 1]; };
  const end = () => until(e => e.phase === "done" || e.phase === "failed", "end");
  return { dir, manager, events, until, ask, asks, end, model };
}

const j = (value: unknown) => JSON.stringify(value);
const finish = (summary = "끝") => j({ action: "finish", args: { summary } });

test("supervisor assigns, writes and commands wait for approval, QA passes", async () => {
  const h = harness({
    supervisor: [j({ lanes: [{ role: "backend", share: "a를 10으로" }], plan: "a를 10으로", testCommands: [["npm", "test"]] })],
    backend: [
      j({ thought: "파일 확인", action: "read_file", args: { path: "src/a.ts" } }),
      j({ thought: "수정", action: "edit_file", args: { path: "src/a.ts", edits: [{ find: "a = 1", replace: "a = 10" }], reason: "요청" } }),
      finish("a를 10으로 바꿈"),
    ],
    qaReview: [input => { assert.match(input.messages[0].content, /tests ok/); return j({ verdict: "pass", summary: "테스트 통과" }); }],
  });
  const run = h.manager.start("demo", "a를 10으로 바꿔줘");
  const write = await h.ask(1);
  assert.equal(write.approval?.kind, "write_file");
  assert.equal(readFileSync(path.join(h.dir, "src/a.ts"), "utf8"), "export const a = 1;\n", "nothing written before approval");
  assert.match(write.approval!.kind === "write_file" ? write.approval!.diff : "", /\+export const a = 10;/);
  assert.equal(write.agent, "backend");
  assert.deepEqual(h.manager.get(run.runId).approvals.map(a => a.id), [write.approval!.id]);
  await h.manager.resume(run.runId, { actionId: write.approval!.id, decision: "approve" });
  const command = await h.ask(2);
  assert.equal(readFileSync(path.join(h.dir, "src/a.ts"), "utf8"), "export const a = 10;\n");
  assert.equal(command.agent, "qa");
  await h.manager.resume(run.runId, { actionId: command.approval!.id, decision: "approve" });
  const done = await h.end();
  assert.equal(done.phase, "done");
  assert.equal(done.detail, "테스트 통과");
  assert.deepEqual(h.manager.get(run.runId).changes, ["src/a.ts"]);
  assert.equal(h.model.count("frontend"), 0, "an unassigned expert never runs");
});

test("both experts work at once: one waiting for approval never holds up the other", async () => {
  const h = harness({
    supervisor: [j({ lanes: [{ role: "frontend", share: "화면" }, { role: "backend", share: "API" }], plan: "p", testCommands: [] })],
    frontend: [j({ action: "write_file", args: { path: "src/ui.ts", content: "ui\n" } }), finish("화면 끝")],
    backend: [
      j({ action: "list_dir", args: { path: "." } }),
      j({ action: "read_file", args: { path: "src/a.ts" } }),
      j({ action: "write_file", args: { path: "src/api.ts", content: "api\n" } }),
      finish("API 끝"),
    ],
    qaPlan: [j({ commands: null })],
    qaReview: [input => { assert.match(input.messages[0].content, /화면 끝[\s\S]*API 끝/); return j({ verdict: "pass", summary: "둘 다 확인" }); }],
  });
  const run = h.manager.start("demo", "화면과 API");
  const first = await h.ask(1);
  // The frontend write is still undecided, yet the backend reads and asks for its own write.
  const second = await h.ask(2);
  assert.deepEqual(new Set([first.agent, second.agent]), new Set(["frontend", "backend"]));
  assert.equal(h.model.count("backend"), 3, "backend kept working while frontend waited");
  assert.equal(h.manager.get(run.runId).approvals.length, 2, "two approvals open at the same time");
  assert.equal(h.manager.get(run.runId).phase, "awaiting_approval");
  // Decide in the opposite order they were asked.
  await h.manager.resume(run.runId, { actionId: second.approval!.id, decision: "approve" });
  assert.deepEqual(h.manager.get(run.runId).approvals.map(a => a.id), [first.approval!.id], "only the decided card closes");
  // The approved lane goes on and finishes; the run still waits for the user because the other request is open.
  await h.until(e => e.agent === second.agent && e.phase === "waiting", "approved lane finishes");
  assert.equal(h.manager.get(run.runId).phase, "awaiting_approval", "another lane's progress never hides an open request");
  assert.deepEqual(h.manager.get(run.runId).approvals.map(a => a.id), [first.approval!.id]);
  await h.manager.resume(run.runId, { actionId: first.approval!.id, decision: "approve" });
  const done = await h.end();
  assert.equal(done.phase, "done");
  assert.deepEqual(new Set(h.manager.get(run.runId).changes), new Set(["src/ui.ts", "src/api.ts"]));
  assert.ok(h.events.some(e => e.resolved === first.approval!.id), "the decided approval is announced");
});

test("QA runs independent verification commands at the same time", async () => {
  // Each script waits for the other's flag; run one after the other, the first would time out.
  const wait = "const fs=require('fs');const [me,other]=process.argv.slice(2);fs.writeFileSync(me,'');const t=Date.now();(function p(){if(fs.existsSync(other))process.exit(0);if(Date.now()-t>5000)process.exit(1);setTimeout(p,20)})()";
  const h = harness({
    supervisor: [j({ lanes: [{ role: "backend", share: "b" }], plan: "p", testCommands: [["npm", "run", "check:a"], ["npm", "run", "check:b"], ["npm", "run", "check:a"]] })],
    backend: [j({ action: "write_file", args: { path: "src/b.ts", content: "b\n" } }), finish()],
    qaReview: [j({ verdict: "pass", summary: "둘 다 통과" })],
  }, { "check:a": "node wait.js a.flag b.flag", "check:b": "node wait.js b.flag a.flag" });
  writeFileSync(path.join(h.dir, "wait.js"), wait);
  const run = h.manager.start("demo", "b 추가");
  await h.manager.resume(run.runId, { actionId: (await h.ask(1)).approval!.id, decision: "approve" });
  const a = await h.ask(2);
  const b = await h.ask(3);
  assert.equal(h.manager.get(run.runId).approvals.length, 2, "both checks ask at once; the duplicate is dropped");
  await h.manager.resume(run.runId, { actionId: a.approval!.id, decision: "approve" });
  await h.manager.resume(run.runId, { actionId: b.approval!.id, decision: "approve" });
  const done = await h.end();
  assert.equal(done.phase, "done", "both checks passed, so they ran together");
  assert.equal(h.asks().length, 3);
});

test("a rejected write is reported back and QA sends the work back with its feedback", async () => {
  const h = harness({
    supervisor: [j({ lanes: [{ role: "frontend", share: "" }], plan: "p", testCommands: [] })],
    frontend: [
      j({ action: "write_file", args: { path: "src/b.ts", content: "x\n" } }),
      input => { assert.match(input.messages.at(-1)!.content, /거절.*다른 파일명/); return finish("변경 없음"); },
      input => { assert.match(input.messages.at(-1)!.content, /QA 피드백[\s\S]*src\/c.ts를 만드세요/); return finish("재확인"); },
    ],
    qaReview: [j({ verdict: "fail", feedback: "src/c.ts를 만드세요", summary: "미완료" }), j({ verdict: "pass", summary: "확인 완료" })],
  });
  const run = h.manager.start("demo", "b 파일 추가");
  const write = await h.ask(1);
  await h.manager.resume(run.runId, { actionId: write.approval!.id, decision: "reject", feedback: "다른 파일명으로" });
  await h.end();
  assert.ok(h.events.some(e => e.agent === "qa" && /돌려보냅니다/.test(e.message)));
  assert.equal(h.model.count("qaPlan"), 0, "no change, no verification plan");
  assert.equal(h.model.calls.length, 6);
});

test("QA sends back only the lane it names; the other expert is not run again", async () => {
  const h = harness({
    supervisor: [j({ lanes: [{ role: "frontend", share: "화면" }, { role: "backend", share: "API" }], plan: "p", testCommands: [] })],
    frontend: [finish("화면"), input => { assert.match(input.messages.at(-1)!.content, /버튼 색/); return finish("화면 고침"); }],
    backend: [finish("API")],
    qaReview: [j({ verdict: "fail", rework: ["frontend"], feedback: "버튼 색", summary: "화면 미흡" }), j({ verdict: "pass", summary: "완료" })],
  });
  h.manager.start("demo", "화면과 API");
  const end = await h.end();
  assert.equal(end.phase, "done");
  assert.equal(h.model.count("frontend"), 2);
  assert.equal(h.model.count("backend"), 1, "backend passed and stays done");
  assert.ok(h.events.some(e => /Frontend Expert에게 돌려보냅니다/.test(e.message)));
});

test("an approved command reruns without asking, until a build manifest changes", async () => {
  const h = harness({
    supervisor: [j({ lanes: [{ role: "backend", share: "" }], plan: "p", testCommands: [["npm", "test"]] })],
    backend: [
      j({ action: "write_file", args: { path: "src/f.ts", content: "f\n" } }), finish(),
      j({ action: "write_file", args: { path: "src/g.ts", content: "g\n" } }), finish(),
      j({ action: "edit_file", args: { path: "package.json", edits: [{ find: "tests ok", replace: "tests ok!" }] } }), finish(),
    ],
    qaReview: [j({ verdict: "fail", feedback: "더" }), j({ verdict: "fail", feedback: "또" }), j({ verdict: "pass", summary: "ok" })],
  });
  const run = h.manager.start("demo", "f");
  const kinds: string[] = [];
  const decide = async (n: number) => { const e = await h.ask(n); kinds.push(`${e.agent}:${e.approval!.kind}`); await h.manager.resume(run.runId, { actionId: e.approval!.id, decision: "approve" }); };
  for (let n = 1; n <= 5; n++) await decide(n);
  const end = await h.end();
  assert.equal(end.phase, "done");
  assert.deepEqual(kinds, ["backend:write_file", "qa:run_command", "backend:write_file", "backend:write_file", "qa:run_command"],
    "round 2 reruns npm test unasked; after package.json changes it asks again");
  assert.ok(h.events.some(e => /승인한 명령을 다시 실행합니다/.test(e.message)));
});

test("a worker that never finishes stops at the step budget and the run is marked failed", async () => {
  const h = harness({ supervisor: [j({ lanes: [{ role: "backend" }], plan: "p" })], backend: Array.from({ length: 80 }, () => j({ action: "list_dir", args: { path: "." } })) });
  h.manager.start("demo", "끝나지 않는 작업");
  const end = await h.end();
  assert.equal(end.phase, "failed");
  assert.match(end.detail ?? "", /단계 한도\(60\)/);
  assert.equal(h.model.calls.length, 61);
});

test("QA failing every round ends as failed after two send-backs, never as done", async () => {
  const h = harness({
    supervisor: [j({ lanes: [{ role: "backend" }], plan: "p", testCommands: [] })],
    backend: [j({ action: "write_file", args: { path: "src/q.ts", content: "q\n" } }), finish("1"), finish("2"), finish("3")],
    qaPlan: [j({ commands: null })],
    qaReview: Array.from({ length: 3 }, () => j({ verdict: "fail", feedback: "아직 틀림", summary: "미해결" })),
  });
  const run = h.manager.start("demo", "q 추가");
  await h.manager.resume(run.runId, { actionId: (await h.ask(1)).approval!.id, decision: "approve" });
  const end = await h.end();
  assert.equal(end.phase, "failed");
  assert.equal(end.detail, "미해결");
  assert.equal(h.events.filter(e => /돌려보냅니다/.test(e.message)).length, 2);
  assert.equal(h.model.count("qaPlan"), 1, "QA plans its command once per run");
});

test("stale approval ids and concurrent runs on one project are refused", async () => {
  const h = harness({ supervisor: [j({ lanes: [{ role: "frontend" }], plan: "p" })], frontend: [j({ action: "write_file", args: { path: "src/z.ts", content: "z\n" } })] });
  const run = h.manager.start("demo", "z");
  await h.ask(1);
  await assert.rejects(h.manager.resume(run.runId, { actionId: "wrong", decision: "approve" }), /바뀌었습니다/);
  assert.throws(() => h.manager.start("demo", "다른 작업"), /진행 중/);
  h.manager.cancel(run.runId);
  assert.equal(h.manager.get(run.runId).phase, "cancelled");
});

test("cancelling while both lanes wait stops every lane and closes every approval", async () => {
  const h = harness({
    supervisor: [j({ lanes: [{ role: "frontend" }, { role: "backend" }], plan: "p" })],
    frontend: [j({ action: "write_file", args: { path: "src/x.ts", content: "x\n" } }), finish()],
    backend: [j({ action: "write_file", args: { path: "src/y.ts", content: "y\n" } }), finish()],
  });
  const run = h.manager.start("demo", "둘 다");
  const first = await h.ask(1);
  await h.ask(2);
  h.manager.cancel(run.runId);
  await h.manager.settled(run.runId);
  const view = h.manager.get(run.runId);
  assert.equal(view.phase, "cancelled");
  assert.deepEqual(view.approvals, []);
  await assert.rejects(h.manager.resume(run.runId, { actionId: first.approval!.id, decision: "approve" }), /끝난 작업/);
  assert.equal(h.model.count("frontend") + h.model.count("backend"), 2, "no lane took another step");
});

test("approval events and run views carry the diff but never the full file content", async () => {
  const h = harness({ supervisor: [j({ lanes: [{ role: "frontend" }], plan: "p" })], frontend: [j({ action: "write_file", args: { path: "src/big.ts", content: "BIG-CONTENT\n" } })] });
  const run = h.manager.start("demo", "큰 파일");
  const event = await h.ask(1);
  assert.match(event.approval!.kind === "write_file" ? event.approval!.diff : "", /BIG-CONTENT/);
  assert.equal("content" in event.approval!, false, "event omits content");
  assert.equal(h.manager.get(run.runId).approvals.some(a => "content" in a), false, "view omits content");
  assert.equal(h.manager.get(run.runId).events.some(e => e.approval && "content" in e.approval), false, "stored history omits content");
  h.manager.cancel(run.runId);
});

test("a failing verification command overrides a QA model that says pass", async () => {
  const h = harness({
    supervisor: [j({ lanes: [{ role: "backend" }], plan: "p", testCommands: [["npm", "test"]] })],
    backend: [
      j({ action: "write_file", args: { path: "src/f.ts", content: "f\n" } }), finish("끝"),
      input => { assert.match(input.messages.at(-1)!.content, /검증 명령이 실패/); return finish("다시"); },
      finish("세 번째"),
    ],
    qaReview: [j({ verdict: "pass", summary: "통과라고 주장" }), j({ verdict: "pass", summary: "또 주장" }), j({ verdict: "pass", summary: "계속 주장" })],
  }, { test: "node -e \"process.exit(3)\"" });
  const run = h.manager.start("demo", "f 추가");
  for (let n = 1; n <= 2; n++) await h.manager.resume(run.runId, { actionId: (await h.ask(n)).approval!.id, decision: "approve" });
  const end = await h.end();
  assert.equal(end.phase, "failed", "exit 3 can never end as done");
  assert.match(end.detail ?? "", /exit 3/);
});
