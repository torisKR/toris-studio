import assert from "node:assert/strict";
import test from "node:test";
import { OFFICE_STEPS, officeScene } from "../desktop/src/agent-office";
import { applyEvent } from "../desktop/src/agent-client";
import type { RunEvent, RunSummary } from "../desktop/src/agent-client";

const base: RunSummary = { runId: "r1", project: "demo", task: "합계 고쳐줘", phase: "queued", agent: "supervisor", createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", approvals: [], changes: [], summary: "", events: [] };
let seq = 0;
const ev = (agent: RunEvent["agent"], phase: RunEvent["phase"], message: string, extra: Partial<RunEvent> = {}): RunEvent => ({ event: "run", runId: "r1", seq: ++seq, at: "2026-10-27T00:00:00Z", agent, phase, message, ...extra });
const runOf = (events: RunEvent[]): RunSummary => events.reduce<RunSummary>((run, event) => applyEvent(run, event)!, base);

test("every agent role gets a desk and the supervisor sits at the PM desk", () => {
  const scene = officeScene(base);
  assert.deepEqual(scene.desks.map(d => d.id), ["supervisor", "frontend", "backend", "qa"]);
  assert.equal(scene.desks.find(d => d.pm)?.id, "supervisor");
  assert.equal(scene.desks.filter(d => d.pm).length, 1);
  assert.ok(scene.desks.every(d => d.activity === "away"), "nobody works before the first event");
  assert.equal(scene.step, "order");
});

test("the active desk shows what that agent is doing; others wait or stay away", () => {
  seq = 0;
  const scene = officeScene(runOf([
    ev("supervisor", "thinking", "작업을 분석"),
    ev("supervisor", "thinking", "Backend Expert에게 배정했습니다."),
    ev("backend", "reading", "파일을 읽고 있습니다.", { detail: "src/cart.ts" }),
  ]));
  const desk = (id: string) => scene.desks.find(d => d.id === id)!;
  assert.equal(desk("backend").activity, "reading");
  assert.equal(desk("backend").note, "파일을 읽고 있습니다.");
  assert.equal(desk("backend").paper, "src/cart.ts");
  assert.equal(desk("supervisor").activity, "waiting");
  assert.equal(desk("frontend").activity, "away");
  assert.equal(scene.step, "work");
});

test("paper moves between desks: order, assignment, report, send-back and final report", () => {
  seq = 0;
  const scene = officeScene({ ...runOf([
    ev("supervisor", "queued", "작업을 시작합니다."),
    ev("supervisor", "thinking", "배정했습니다."),
    ev("backend", "reading", "읽기"),
    ev("backend", "coding", "작업을 마치고 QA에 넘깁니다."),
    ev("qa", "reviewing", "검증 방법"),
    ev("qa", "reviewing", "문제를 찾아 돌려보냅니다"),
    ev("backend", "thinking", "다음 단계"),
    ev("backend", "coding", "작업을 마치고 QA에 넘깁니다."),
    ev("qa", "reviewing", "결과를 검토"),
    ev("supervisor", "done", "작업을 완료했습니다.", { detail: "합계 수정" }),
  ]) });
  assert.deepEqual(scene.handoffs.map(h => `${h.from}>${h.to}:${h.kind}`), [
    "user>supervisor:order",
    "supervisor>backend:assign",
    "backend>qa:report",
    "qa>backend:sendBack",
    "backend>qa:report",
    "qa>supervisor:report",
    "supervisor>user:final",
  ]);
  assert.ok(scene.handoffs.every((h, i, all) => i === 0 || h.seq >= all[i - 1].seq), "in event order");
  assert.equal(scene.step, "final");
  assert.ok(scene.desks.every(d => d.activity === "away" || d.activity === "done"));
});

test("a pending approval sends a paper to the user's tray and marks the approval step", () => {
  seq = 0;
  const approval = { kind: "write_file" as const, id: "a1", agent: "backend" as const, path: "src/cart.ts", diff: "", reason: "" };
  const scene = officeScene(runOf([
    ev("supervisor", "thinking", "배정"),
    ev("backend", "awaiting_approval", "src/cart.ts 변경 승인을 기다립니다.", { approval }),
  ]));
  assert.deepEqual(scene.handoffs.at(-1), { from: "backend", to: "user", kind: "approval", seq: 2, label: "결재 요청 · src/cart.ts" });
  assert.equal(scene.desks.find(d => d.id === "backend")!.activity, "approval");
  assert.equal(scene.step, "approval");
  assert.equal(scene.tray, "src/cart.ts");
});

test("documents on each desk count what that agent read and wrote", () => {
  seq = 0;
  const scene = officeScene(runOf([
    ev("supervisor", "thinking", "배정"),
    ev("frontend", "reading", "읽기", { detail: "a.tsx" }),
    ev("frontend", "reading", "읽기", { detail: "b.tsx" }),
    ev("frontend", "coding", "a.tsx에 변경을 적용했습니다.", { changes: ["a.tsx"] }),
    ev("frontend", "coding", "b.tsx에 변경을 적용했습니다.", { changes: ["a.tsx", "b.tsx"] }),
  ]));
  const frontend = scene.desks.find(d => d.id === "frontend")!;
  assert.equal(frontend.read, 2);
  assert.equal(frontend.written, 2);
});

test("a failed or cancelled run ends with a final report and no one left working", () => {
  seq = 0;
  for (const phase of ["failed", "cancelled"] as const) {
    const scene = officeScene(runOf([ev("supervisor", "thinking", "배정"), ev("backend", "coding", "작성"), ev("backend", phase, "끝")]));
    assert.equal(scene.handoffs.at(-1)?.kind, "final", phase);
    assert.equal(scene.handoffs.at(-1)?.to, "user", phase);
    assert.ok(scene.desks.every(d => d.activity !== "reading" && d.activity !== "coding"), phase);
  }
});

test("the procedure has fixed, ordered steps the screen can show", () => {
  assert.deepEqual(OFFICE_STEPS.map(s => s.id), ["order", "assign", "work", "approval", "review", "final"]);
});

test("two experts work at once: both desks are busy, both report to QA, both requests reach the tray", () => {
  seq = 0;
  const write = { kind: "write_file" as const, id: "w1", agent: "frontend" as const, path: "src/ui.tsx", diff: "", reason: "" };
  const working = runOf([
    ev("supervisor", "thinking", "Frontend Expert·Backend Expert에게 동시에 배정했습니다."),
    ev("frontend", "awaiting_approval", "src/ui.tsx 변경 승인을 기다립니다.", { approval: write }),
    ev("backend", "reading", "파일을 읽고 있습니다.", { detail: "src/api.ts" }),
  ]);
  const scene = officeScene(working);
  const desk = (id: string) => scene.desks.find(d => d.id === id)!;
  assert.equal(desk("frontend").activity, "approval", "frontend still waits for its approval");
  assert.equal(desk("backend").activity, "reading", "backend is not shown as idle");
  assert.equal(desk("supervisor").activity, "waiting");
  assert.equal(scene.step, "approval");
  assert.equal(scene.tray, "src/ui.tsx");
  assert.deepEqual(scene.handoffs.filter(h => h.kind === "assign").map(h => h.to), ["frontend", "backend"], "PM assigns both, not frontend to backend");
  assert.equal(scene.handoffs.some(h => h.from === "frontend" && h.to === "backend"), false);

  const cmd = { kind: "run_command" as const, id: "c1", agent: "backend" as const, command: ["pnpm", "test"], cwd: "demo", reason: "" };
  const two = officeScene(runOf([...working.events, ev("backend", "awaiting_approval", "명령 실행 승인을 기다립니다: pnpm test", { approval: cmd })]));
  assert.equal(two.tray, "src/ui.tsx 외 1건");

  const review = officeScene(runOf([...working.events,
    ev("frontend", "coding", "적용", { resolved: "w1", changes: ["src/ui.tsx"] }),
    ev("frontend", "waiting", "맡은 작업을 마쳤습니다."),
    ev("backend", "waiting", "맡은 작업을 마쳤습니다."),
    ev("qa", "reviewing", "검증 방법을 정하고 있습니다."),
  ]));
  assert.deepEqual(review.handoffs.filter(h => h.to === "qa").map(h => `${h.from}:${h.kind}`), ["frontend:report", "backend:report"], "both experts hand their report to QA");
  assert.equal(review.step, "review");
});

test("experts working at once without approvals are both shown at work", () => {
  seq = 0;
  const scene = officeScene(runOf([
    ev("supervisor", "thinking", "동시에 배정했습니다."),
    ev("frontend", "reading", "파일을 읽고 있습니다.", { detail: "src/ui.tsx" }),
    ev("backend", "thinking", "다음 단계를 정하고 있습니다."),
  ]));
  assert.equal(scene.desks.find(d => d.id === "frontend")!.activity, "reading", "frontend is not idle just because backend spoke last");
  assert.equal(scene.desks.find(d => d.id === "backend")!.activity, "thinking");
});
