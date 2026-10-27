import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runScenario, type EvalScenario } from "../src/harness/eval.js";
import { defaultWorkflows } from "../src/harness/registry.js";
import { decide } from "../src/harness/verify.js";
import { WorkflowRegistry } from "../src/harness/workflow.js";

const EVALS = path.join(path.dirname(fileURLToPath(import.meta.url)), "evals");

test("the registry lists the coding workflow and refuses unknown or duplicate ids", () => {
  const registry = defaultWorkflows();
  assert.deepEqual(registry.list().map(w => w.id), ["coding", "weekly-content", "ops-triage"]);
  assert.equal("build" in registry.list()[0], false, "list exposes no builder");
  assert.throws(() => registry.get("rm -rf"), /알 수 없는 워크플로/);
  const fresh = new WorkflowRegistry();
  const spec = { id: "demo", label: "d", description: "", needsProject: false, build: () => { throw new Error("unused"); } };
  fresh.define(spec);
  assert.throws(() => fresh.define(spec), /이미 등록/);
  assert.throws(() => fresh.define({ ...spec, id: "../x" }), /잘못된 워크플로 ID/);
});

test("facts outrank the reviewer: a failed command or check always fails", () => {
  assert.equal(decide("pass", [{ log: "", exit: 0 }]).verdict, "pass");
  assert.equal(decide("pass", [{ log: "", exit: null }]).verdict, "pass", "a rejected command proves nothing either way");
  const failed = decide("pass", [{ log: "", exit: 0 }, { log: "", exit: 2 }]);
  assert.equal(failed.verdict, "fail");
  assert.match(failed.factNote, /exit 2/);
  const check = decide("pass", [], [{ name: "프레임", ok: false, detail: "빈 화면" }]);
  assert.equal(check.verdict, "fail");
  assert.match(check.factNote, /프레임 — 빈 화면/);
  assert.equal(decide("fail", []).verdict, "fail", "the reviewer can still fail on its own");
});

for (const file of readdirSync(EVALS).filter(name => name.endsWith(".json")).sort()) {
  const scenario = JSON.parse(readFileSync(path.join(EVALS, file), "utf8")) as EvalScenario;
  test(`eval: ${scenario.name}`, async () => {
    const result = await runScenario(scenario);
    assert.deepEqual(result.problems, [], `${file}: ${result.problems.join("; ")}`);
  });
}
