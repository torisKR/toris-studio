import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { canonicalInvocation, missingTool, scriptedRunner, toolInvocation } from "../src/factory/adapters.js";
import { fingerprint, fingerprintMatches } from "../src/factory/artifacts.js";
import { factorySummary } from "../src/factory/graph.js";
import { newJob, reconcileJobs } from "../src/factory/jobs.js";
import { nextBatch, planTasks } from "../src/factory/planner.js";
import { produceFactory, previewFactory } from "../src/factory/pipeline.js";
import { spriteProviderAllowed } from "../src/factory/policies.js";
import { createProjectDir } from "../src/factory/scaffold.js";
import { acceptModelSpec, templateSpec } from "../src/factory/spec.js";
import { pngAlphaProblem, unexpectedPermissions, verdictOf } from "../src/factory/validators.js";
import { RunManager } from "../src/graph/runs.js";
import { defaultWorkflows } from "../src/harness/registry.js";
import { RoleModel } from "../src/harness/testing.js";
import { parseSettings } from "../src/runtime.js";
import { validateCommand } from "../src/tools/terminal.js";
import type { ChatModel } from "../src/llm/types.js";

const BRIEF = "도트풍 무협 로그라이트 게임 만들어줘. 16:9 가로 Android, 한 캐릭터, 세 적, 공격/회피/경험치/게임오버.";

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "factory-"));
}

test("the wuxia brief becomes a bounded 2D Godot spec and drops reference URLs", () => {
  const preview = previewFactory({ brief: BRIEF + " 참고 https://example.com/game", kind: "game" }, "game");
  assert.equal(preview.template, true);
  assert.equal(preview.spec?.slug, "wuxia-roguelite");
  assert.equal(preview.spec?.target.engine, "godot");
  assert.equal(preview.spec?.target.view, "2d");
  assert.equal(preview.spec?.design.orientation, "landscape");
  assert.equal(preview.spec?.assets.characters, 4);
  assert.equal(preview.spec?.assets.vfx, 2);
  assert.equal(preview.spec?.limits.maxApiCostUsd, 5);
  assert.equal(preview.verdict, "incomplete");
  assert.ok(preview.notes.some(note => note.includes("참조 URL")));
  assert.equal(JSON.stringify(preview).includes("https://"), false);
});

test("a model spec with a command field, a shell title, or a raised budget is not a plan", () => {
  const base = templateSpec(BRIEF, {}, "game").spec;
  const command = acceptModelSpec({ ...base, command: "rm -rf /" }, "game");
  assert.equal(command.spec, null);
  assert.match(command.problems.join(" "), /command/);
  const shell = acceptModelSpec({ ...base, title: "게임 $(rm)" }, "game");
  assert.equal(shell.spec, null);
  assert.match(shell.problems.join(" "), /명령/);
  const costly = acceptModelSpec({ ...base, limits: { ...base.limits, maxApiCostUsd: 20 } }, "game");
  assert.equal(costly.spec?.limits.maxApiCostUsd, 5);
  assert.match(costly.notes.join(" "), /5달러/);
  assert.equal(acceptModelSpec({ ...base, target: { ...base.target, engine: "kotlin" } }, "game").spec, null);
});

test("project slugs cannot escape the projects root", () => {
  const root = tempRoot();
  assert.throws(() => createProjectDir(root, "../etc"), /프로젝트 이름/);
  assert.throws(() => createProjectDir(root, "Game"), /프로젝트 이름/);
});

test("sprite providers do not fall back, and the terminal allow-list still rejects Godot", () => {
  assert.equal(spriteProviderAllowed("grok", null), true);
  assert.equal(spriteProviderAllowed("grok", "claude"), false);
  assert.equal(spriteProviderAllowed("openai", null), false);
  assert.throws(() => validateCommand(["godot", "--headless", "--path", "."]));
  assert.equal(canonicalInvocation({ tool: "godot_import", args: ["--quit"] }), null);
  assert.deepEqual(canonicalInvocation(toolInvocation("godot_import")), toolInvocation("godot_import"));
  assert.equal(missingTool("godot_import").status, "blocked");
});

test("independent tasks share a batch and locked tasks do not", () => {
  const plan = planTasks(templateSpec(BRIEF, {}, "game").spec);
  const passed = new Set(["spec-approved", "scaffold-project", "game-design"]);
  const batch = nextBatch(plan, id => passed.has(id) ? "passed" : "queued");
  assert.ok(batch.includes("character-base"));
  assert.ok(batch.includes("vfx-export"));
  assert.equal(batch.includes("gameplay-core"), false);
});

test("a killed paid call waits for approval instead of charging again", () => {
  const job = newJob("wuxia-roguelite", "sprite-atlas", "abc", 3, "explicit");
  job.status = "running";
  job.paid = true;
  const reconciled = reconcileJobs([job], () => false);
  assert.equal(reconciled.jobs[0]?.status, "waiting_approval");
  assert.match(reconciled.warnings.join(" "), /중복 결제/);
  const done = newJob("wuxia-roguelite", "scaffold-project", "abc", 3, "automatic");
  done.status = "running";
  const root = tempRoot();
  const file = path.join(root, "game.spec.json");
  writeFileSync(file, "{}\n");
  done.artifactHashes = [fingerprint("game.spec.json", readFileSync(file))];
  const reused = reconcileJobs([done], value => fingerprintMatches(root, value));
  assert.equal(reused.jobs[0]?.status, "passed");
  assert.match(reused.jobs[0]?.message ?? "", /해시/);
});

test("missing tools stay blocked and are not reported as a successful build", async () => {
  const root = tempRoot();
  let approvals = 0;
  const result = await produceFactory({
    kind: "game",
    input: { brief: BRIEF },
    projectsRoot: root,
    model: null,
    runner: scriptedRunner({}),
    signal: new AbortController().signal,
    approve: async () => { approvals += 1; return "reject"; },
  });
  assert.equal(approvals, 0);
  assert.equal(result.template, true);
  assert.equal(result.verdict, "incomplete");
  assert.equal(result.costUsd, 0);
  assert.equal(result.gates.find(gate => gate.name === "android")?.status, "blocked");
  assert.equal(result.gates.find(gate => gate.name === "asset")?.status, "blocked");
  assert.notEqual(result.gates.find(gate => gate.name === "android")?.status, "passed");
  assert.match(result.jobs.find(job => job.taskId === "sprite-atlas")?.message ?? "", /도구를 실행하지 않았습니다/);
  const project = path.join(root, result.project);
  const notices = readFileSync(path.join(project, "THIRD_PARTY_NOTICES"), "utf8");
  assert.match(notices, /Patch Pixel/);
  assert.match(notices, /Apache-2.0/);
  assert.equal(readFileSync(path.join(project, "scripts/main.gd"), "utf8").includes("OS.execute"), false);
  assert.deepEqual(unexpectedPermissions(readFileSync(path.join(project, "project.godot"), "utf8")), []);
});

test("an app build can pass only the checks that actually ran", async () => {
  const root = tempRoot();
  const result = await produceFactory({
    kind: "app",
    input: { brief: "할 일 메모 앱" },
    projectsRoot: root,
    model: null,
    runner: scriptedRunner({ gradle_build: { exit: 0, log: "" } }),
    signal: new AbortController().signal,
    approve: async () => "reject",
  });
  assert.equal(result.spec?.target.engine, "kotlin");
  assert.equal(result.gates.find(gate => gate.name === "android")?.status, "failed");
  assert.equal(result.verdict, "fail");
  const manifest = readFileSync(path.join(root, result.project, "app/src/main/AndroidManifest.xml"), "utf8");
  assert.deepEqual(unexpectedPermissions(manifest), []);
  assert.deepEqual(unexpectedPermissions(manifest + '\n<uses-permission android:name="android.permission.INTERNET"/>'), ["android.permission.INTERNET"]);
});

test("rejected paid sprite work does not run the tool", async () => {
  const root = tempRoot();
  let ran = false;
  const result = await produceFactory({
    kind: "game",
    input: { brief: BRIEF },
    projectsRoot: root,
    model: null,
    runner: scriptedRunner({ sprite_gen_prepare: () => { ran = true; return { exit: 0, log: "" }; } }),
    signal: new AbortController().signal,
    approve: async () => "reject",
  });
  assert.equal(ran, false);
  assert.equal(result.jobs.find(job => job.taskId === "sprite-atlas")?.status, "cancelled");
});

test("PNG alpha and an empty gate list cannot become a pass", () => {
  const rgb = Buffer.alloc(32);
  rgb.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  rgb.write("IHDR", 12, "ascii");
  rgb.writeUInt32BE(1, 16);
  rgb.writeUInt32BE(1, 20);
  rgb[24] = 8;
  rgb[25] = 2;
  assert.match(pngAlphaProblem(rgb) ?? "", /알파/);
  rgb[25] = 6;
  assert.equal(pngAlphaProblem(rgb), null);
  assert.equal(verdictOf([]), "incomplete");
  assert.equal(factorySummary({ template: true, provider: "", model: "", spec: null, project: "", jobs: [], gates: [], verdict: "fail", costUsd: 0, problems: ["요청을 입력하세요."], notes: [] }).phase, "failed");
});

test("a factory run uses the agent model when its JSON passes and labels a template when it does not", async () => {
  const root = tempRoot();
  const spec = templateSpec(BRIEF, {}, "game").spec;
  const good = new RoleModel({ factory: [JSON.stringify(spec)] });
  const goodRun = await run(root + "-good", good, { brief: BRIEF });
  assert.equal(goodRun.template, false);
  assert.equal(goodRun.provider, "ollama");
  assert.match(goodRun.message, /모델 명세가 검사를 통과/);
  assert.match(goodRun.message, /통과가 아닙니다/);
  assert.equal(good.leftovers().length, 0);

  const bad = new RoleModel({ factory: ['{"command":"rm"}', '{"command":"rm"}'] });
  const badRun = await run(root + "-bad", bad, { brief: BRIEF });
  assert.equal(badRun.template, true);
  assert.match(badRun.message, /AI가 쓴 명세가 아닙니다/);
  assert.equal(bad.calls.length, 2);
});

async function run(root: string, model: ChatModel, input: Record<string, unknown>) {
  mkdirSync(root, { recursive: true });
  const events: string[] = [];
  const manager = new RunManager(() => parseSettings({ projectsRoot: root, chromaUrl: "http://127.0.0.1:9" }), event => events.push(event.message), () => model);
  const started = manager.start("", "팩토리", "game-factory", input);
  await manager.settled(started.runId);
  const view = manager.get(started.runId);
  manager.shutdown();
  return { ...JSON.parse(view.summary), message: events.join("\n"), phase: view.phase };
}

test("coding remains registered beside the factory workflows", () => {
  const ids = defaultWorkflows().list().map(item => item.id);
  assert.ok(ids.includes("coding"));
  assert.ok(ids.includes("game-factory"));
  assert.ok(ids.includes("app-factory"));
});
