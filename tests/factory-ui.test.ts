import assert from "node:assert/strict";
import test from "node:test";
import { decide, runTitle } from "../desktop/src/agent-client";
import { factoryRuns, gateLabel, parseFactoryReport, verdictLabel } from "../desktop/src/factory/factory-client";

test("factory approvals go through the host command and titles stay on the factory", async () => {
  const calls: Array<[string, unknown]> = [];
  const call = async (command: string, args?: Record<string, unknown>) => { calls.push([command, args]); return { runId: "r" }; };
  await decide({ runId: "r", workflow: "game-factory" }, "a1", "approve", "", call);
  assert.deepEqual(calls, [["factory_decide", { runId: "r", actionId: "a1", decision: "approve", feedback: "" }]]);
  assert.equal(runTitle({ workflow: "app-factory", project: "" }), "앱 팩토리");
  assert.equal(verdictLabel("incomplete"), "아직 끝나지 않은 검사");
  assert.equal(gateLabel("android"), "Android");
});

test("the desktop factory lists factory runs, including runs started elsewhere", async () => {
  const call = async (command: string, args?: Record<string, unknown>) => {
    assert.equal(command, "agent_call");
    assert.deepEqual(args, { method: "run.list", params: {} });
    return { runs: [{ runId: "mobile", workflow: "game-factory" }, { runId: "other", workflow: "coding" }] };
  };
  assert.deepEqual((await factoryRuns(call)).map(run => run.runId), ["mobile"]);
});

test("a factory summary that did not run Android is not read as a pass", () => {
  const report = parseFactoryReport(JSON.stringify({
    template: true, provider: "", model: "", spec: null, project: "wuxia-roguelite",
    jobs: [{ taskId: "android-debug-build", status: "blocked", message: "도구를 실행하지 않았습니다", approval: "automatic" }],
    gates: [{ name: "android", status: "blocked", detail: "도구를 실행하지 않았습니다", required: true }],
    verdict: "incomplete", costUsd: 0, problems: [], notes: ["미리보기는 규칙으로 만든 명세입니다."],
  }));
  assert.equal(report?.verdict, "incomplete");
  assert.equal(report?.gates[0]?.status, "blocked");
  assert.equal(parseFactoryReport("{"), null);
  assert.equal(parseFactoryReport(JSON.stringify({ verdict: "pass", gates: [{ name: "android", status: "passed", detail: "", required: true }], jobs: [] }))?.template, true);
});
