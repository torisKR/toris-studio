// Brief → spec → scaffold → jobs. The model proposes a spec; files and tool
// arguments come from the template and the typed adapters.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChatModel } from "../llm/types.js";
import { errorText, parseJsonObject } from "../util.js";
import { fingerprint, fingerprintMatches } from "./artifacts.js";
import { missingTool, TOOL_MISSING, toolFor, toolInvocation, VFX_IDS, type TaskOutcome, type ToolId, type ToolResult, type ToolRunner, type VfxId } from "./adapters.js";
import { factoryStoreDir, JobStore, newJob, reconcileJobs, type FactoryJob } from "./jobs.js";
import { blockedReason, declaredDeps, nextBatch, planTasks, type TaskId } from "./planner.js";
import { FACTORY_SYSTEM, factoryPrompt } from "./prompts.js";
import { BLENDER_EXPORT_PY, createProjectDir, existingProjectDir, writeTemplate } from "./scaffold.js";
import { acceptModelSpec, factoryInput, templateSpec, type FactoryKind, type FactorySpec } from "./spec.js";
import { pngAlphaProblem, readProjectText, scriptUnsafe, unexpectedPermissions, verdictOf, type FactoryGate } from "./validators.js";

export type FactoryReport = {
  template: boolean;
  provider: string;
  model: string;
  spec: FactorySpec | null;
  project: string;
  jobs: Array<Pick<FactoryJob, "taskId" | "status" | "message" | "approval"> & { deps: string[] }>;
  gates: FactoryGate[];
  verdict: "pass" | "incomplete" | "fail";
  costUsd: number;
  problems: string[];
  notes: string[];
};

export type ProduceOptions = {
  kind: FactoryKind;
  input: unknown;
  projectsRoot: string;
  model: ChatModel | null;
  runner: ToolRunner;
  signal: AbortSignal;
  approve(job: FactoryJob): Promise<"approve" | "reject">;
  emit?(message: string): void;
};

function report(partial: Partial<FactoryReport> & Pick<FactoryReport, "problems">): FactoryReport {
  const gates = partial.gates ?? [];
  return {
    template: partial.template ?? true,
    provider: partial.provider ?? "",
    model: partial.model ?? "",
    spec: partial.spec ?? null,
    project: partial.project ?? "",
    jobs: partial.jobs ?? [],
    gates,
    verdict: partial.verdict ?? (partial.spec ? verdictOf(gates) : "fail"),
    costUsd: 0,
    problems: partial.problems,
    notes: partial.notes ?? [],
  };
}

async function draftSpec(model: ChatModel, brief: string, kind: FactoryKind, signal: AbortSignal): Promise<Record<string, unknown>> {
  const prompt = factoryPrompt(brief, kind);
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await model.complete({
      system: FACTORY_SYSTEM,
      messages: attempt ? [{ role: "user", content: prompt }, { role: "assistant", content: last }, { role: "user", content: "JSON 객체 하나만 다시 출력하세요." }] : [{ role: "user", content: prompt }],
      signal,
    });
    try { return parseJsonObject(last); } catch { /* one retry */ }
  }
  throw new Error("모델이 형식에 맞는 JSON을 반환하지 않았습니다.");
}

function hashOf(projectDir: string, relative: string): string | null {
  try { return fingerprint(relative, readFileSync(path.join(projectDir, relative))); } catch { return null; }
}

export async function produceFactory(options: ProduceOptions): Promise<FactoryReport> {
  const parsed = factoryInput(options.input);
  const notes = [...parsed.notes];
  if (!parsed.input) return report({ problems: parsed.problems, notes });
  const brief = parsed.input.brief ?? "";
  let spec: FactorySpec | null = null;
  let template = true;
  let provider = "";
  let modelName = "";
  const problems: string[] = [];
  if (parsed.input.resumeProject) {
    let projectDir: string;
    try { projectDir = existingProjectDir(options.projectsRoot, parsed.input.resumeProject); }
    catch (error) { return report({ problems: [errorText(error)], notes }); }
    try {
      const accepted = acceptModelSpec(JSON.parse(readFileSync(path.join(projectDir, "game.spec.json"), "utf8")), options.kind);
      if (!accepted.spec) return report({ problems: accepted.problems, notes });
      spec = accepted.spec;
      const provenance = readProjectText(projectDir, "provenance.json");
      if (provenance) {
        const saved = JSON.parse(provenance) as { template?: boolean; provider?: string; model?: string };
        template = saved.template !== false;
        provider = template ? "" : String(saved.provider ?? "");
        modelName = template ? "" : String(saved.model ?? "");
      }
    } catch (error) { return report({ problems: [errorText(error)], notes }); }
    return runProject(options, spec, projectDir, template, provider, modelName, problems, notes, true);
  }
  if (options.model && brief) {
    for (let round = 0; round < 2 && !spec; round++) {
      try {
        const raw = await draftSpec(options.model, brief, options.kind, options.signal);
        const accepted = acceptModelSpec(raw, options.kind);
        if (accepted.spec) {
          spec = accepted.spec;
          template = false;
          provider = options.model.provider;
          modelName = options.model.model;
          notes.push(...accepted.notes);
        } else problems.push(...accepted.problems.map(problem => `${round + 1}차: ${problem}`));
      } catch (error) {
        if (options.signal.aborted) throw error;
        problems.push("모델: " + errorText(error));
        break;
      }
    }
  }
  if (!spec) {
    if (!brief) return report({ problems: ["요청을 입력하세요."], notes });
    const made = templateSpec(brief, { view: parsed.input.view, orientation: parsed.input.orientation, kind: options.kind }, options.kind);
    spec = made.spec;
    template = true;
    notes.push(...made.notes);
  }
  let projectDir: string;
  try { projectDir = createProjectDir(options.projectsRoot, spec.slug); }
  catch (error) { return report({ spec, template, provider, model: modelName, problems: [...problems, errorText(error)], notes }); }
  writeTemplate(projectDir, spec, template, provider, modelName);
  return runProject(options, spec, projectDir, template, provider, modelName, problems, notes, false);
}

async function runProject(options: ProduceOptions, spec: FactorySpec, projectDir: string, template: boolean, provider: string, modelName: string, problems: string[], notes: string[], resumed: boolean): Promise<FactoryReport> {
  const plan = planTasks(spec);
  const inputHash = fingerprint("game.spec.json", JSON.stringify(spec)).split(":").at(-1) ?? "";
  const store = new JobStore(factoryStoreDir(options.projectsRoot));
  const saved = store.load(spec.slug);
  let jobs = plan.map(task => {
    const approval = task.id === "release-review" || task.id === "adb-smoke-test" ? "explicit" as const : "automatic" as const;
    const existing = saved.find(job => job.taskId === task.id && job.inputHash === inputHash);
    return existing ?? newJob(spec.slug, task.id, inputHash, spec.limits.maxAttemptsPerTask, approval);
  });
  if (resumed) {
    const reconciled = reconcileJobs(jobs, value => fingerprintMatches(projectDir, value));
    jobs = reconciled.jobs;
    notes.push(...reconciled.warnings);
  }
  const statusOf = (id: TaskId) => jobs.find(job => job.taskId === id)?.status ?? "absent";
  const emit = (message: string) => options.emit?.(message);

  const perform = async (task: TaskId, job: FactoryJob): Promise<TaskOutcome> => {
    if (task === "spec-approved") return { status: "passed", message: "명세가 검사를 통과했습니다.", hashes: [] };
    if (task === "scaffold-project") {
      const hashes = ["game.spec.json", "provenance.json", "THIRD_PARTY_NOTICES"].map(relative => hashOf(projectDir, relative)).filter((hash): hash is string => Boolean(hash));
      return hashes.length >= 3 ? { status: "passed", message: "템플릿으로 프로젝트를 만들었습니다.", hashes } : { status: "failed", message: "템플릿 파일이 없습니다.", hashes };
    }
    if (task === "game-design" || task === "app-design" || task === "character-base" || task === "level-content") {
      const relative = task === "character-base" ? "data/characters.json" : task === "level-content" ? "data/levels.json" : "data/design.json";
      const hash = hashOf(projectDir, relative);
      return hash ? { status: "passed", message: "기획 데이터를 확인했습니다.", hashes: [hash] } : { status: "failed", message: relative + " 이 없습니다.", hashes: [] };
    }
    if (task === "gameplay-core" || task === "screen-core" || task === "lint-and-import" || task === "asset-integration") return staticCode(projectDir, spec);
    if (task === "release-review") {
      const decision = await options.approve(job);
      if (decision !== "approve") return { status: "cancelled", message: "릴리스 승인이 거절되었습니다.", hashes: [] };
      return { status: "blocked", message: "승인을 기록했습니다. 서명과 스토어 제출은 실행하지 않았습니다.", hashes: [] };
    }
    return runTool(options, spec, projectDir, task, job);
  };

  for (let guard = 0; guard < 40; guard++) {
    if (options.signal.aborted) throw new DOMException("작업이 취소되었습니다.", "AbortError");
    let blocked = false;
    for (const task of plan) {
      const job = jobs.find(item => item.taskId === task.id);
      if (!job || job.status !== "queued") continue;
      const reason = blockedReason(task, statusOf);
      if (!reason) continue;
      job.status = "blocked";
      job.message = reason;
      store.save(job);
      blocked = true;
    }
    if (blocked) continue;
    const batch = nextBatch(plan, statusOf);
    if (!batch.length) break;
    emit(batch.join(", ") + " 작업을 진행합니다.");
    await Promise.all(batch.map(async task => {
      const job = jobs.find(item => item.taskId === task)!;
      job.status = "running";
      job.attempts += 1;
      if (task === "sprite-atlas" && options.runner.which("sprite_gen_prepare")) {
        job.paid = true;
        job.approval = "explicit";
      }
      store.save(job);
      try {
        const outcome = await perform(task, job);
        job.status = outcome.status;
        job.message = outcome.message;
        job.artifactHashes = outcome.hashes;
      } catch (error) {
        if (options.signal.aborted) throw error;
        job.status = "failed";
        job.message = errorText(error).slice(0, 400);
      }
      store.save(job);
    }));
  }

  const gates = buildGates(spec, jobs);
  const planned = new Map(planTasks(spec).map(task => [task.id, task.deps]));
  const finished = report({ template, provider, model: modelName, spec, project: spec.slug, jobs: jobs.map(job => viewJob(job, planned.get(job.taskId) ?? [])), gates, problems, notes });
  writeFileSync(path.join(projectDir, "factory-report.json"), JSON.stringify(finished, null, 2) + "\n");
  return finished;
}

export function previewFactory(raw: unknown, kind: FactoryKind): FactoryReport {
  const parsed = factoryInput(raw);
  if (!parsed.input?.brief) return report({ problems: parsed.problems.length ? parsed.problems : ["요청을 입력하세요."], notes: parsed.notes });
  const made = templateSpec(parsed.input.brief, { kind, view: parsed.input.view, orientation: parsed.input.orientation }, kind);
  const jobs = planTasks(made.spec).map(task => ({ taskId: task.id, status: "queued" as const, message: task.deps.join(", "), approval: task.id === "release-review" || task.id === "adb-smoke-test" ? "explicit" as const : "automatic" as const, deps: [...task.deps] }));
  return report({ template: true, spec: made.spec, project: made.spec.slug, jobs, problems: [], notes: [...parsed.notes, ...made.notes, "미리보기는 규칙으로 만든 명세입니다."] });
}

export function listFactoryJobs(projectsRoot: string): FactoryReport["jobs"] {
  try {
    const jobs = new JobStore(factoryStoreDir(projectsRoot)).load();
    const present = new Set(jobs.map(job => job.taskId));
    return jobs.map(job => viewJob(job, declaredDeps(job.taskId).filter(dep => present.has(dep))));
  } catch { return []; }
}

function viewJob(job: FactoryJob, deps: readonly string[]): FactoryReport["jobs"][number] {
  return { taskId: job.taskId, status: job.status, message: job.message, approval: job.approval, deps: [...deps] };
}

function staticCode(projectDir: string, spec: FactorySpec): TaskOutcome {
  if (spec.kind === "app") {
    const manifest = readProjectText(projectDir, "app/src/main/AndroidManifest.xml") ?? "";
    const activity = readProjectText(projectDir, "app/src/main/java/kr/toris/factory/MainActivity.kt") ?? "";
    const permissions = unexpectedPermissions(manifest);
    if (!manifest || !activity.includes("setContent")) return { status: "failed", message: "앱 화면 파일이 없습니다.", hashes: [] };
    if (permissions.length) return { status: "failed", message: "허용하지 않은 권한이 있습니다: " + permissions.join(", "), hashes: [] };
    return { status: "passed", message: "화면 코드와 권한을 확인했습니다. 기기 실행과는 별개입니다.", hashes: [] };
  }
  const script = readProjectText(projectDir, "scripts/main.gd") ?? "";
  const unsafe = scriptUnsafe(script);
  if (!script.includes("func _ready")) return { status: "failed", message: "게임 스크립트가 없습니다.", hashes: [] };
  if (unsafe) return { status: "failed", message: unsafe, hashes: [] };
  return { status: "passed", message: "스크립트를 확인했습니다. Godot 실행 결과와는 별개입니다.", hashes: [] };
}

async function runTool(options: ProduceOptions, spec: FactorySpec, projectDir: string, task: TaskId, job: FactoryJob): Promise<TaskOutcome> {
  const tool = toolFor(task, spec.target.engine);
  if (!tool) return { status: "blocked", message: "이 엔진에서는 실행할 검사가 없습니다.", hashes: [] };
  if (task === "android-debug-build" && spec.target.engine === "godot" && !readProjectText(projectDir, "export_presets.cfg")) {
    return { status: "blocked", message: "Android 내보내기 프리셋이 없어 디버그 APK를 만들지 않았습니다.", hashes: [] };
  }
  if (!options.runner.which(tool)) return missingTool(tool);
  if (task === "sprite-atlas" || task === "adb-smoke-test") {
    job.approval = "explicit";
    storeApproval(job);
    const decision = await options.approve(job);
    if (decision !== "approve") return { status: "cancelled", message: "승인이 거절되어 실행하지 않았습니다.", hashes: [] };
  }
  if (task === "model-export") {
    const script = readProjectText(projectDir, "tools/blender_export.py");
    if (script !== BLENDER_EXPORT_PY) return { status: "blocked", message: "승인되지 않은 Blender 스크립트라 실행하지 않았습니다.", hashes: [] };
  }
  if (task === "vfx-export") {
    const effects = VFX_IDS.slice(0, spec.assets.vfx);
    for (const effect of effects) {
      const result = await options.runner.run(toolInvocation("pixelfx_render", effect as VfxId), projectDir, options.signal);
      if (result.exit === null) return { status: "blocked", message: blockedLog(tool, result), hashes: [] };
      if (result.exit !== 0) return { status: "failed", message: "PixelFX 종료 코드 " + result.exit, hashes: [] };
    }
    return checkPng(projectDir, "assets/vfx/fireball.png", "VFX 시트를 확인했습니다.");
  }
  const cwd = projectDir;
  const result = await options.runner.run(toolInvocation(tool), cwd, options.signal);
  if (result.exit === null) return { status: "blocked", message: blockedLog(tool, result), hashes: [] };
  if (result.exit !== 0) return { status: "failed", message: `${tool} 종료 코드 ${result.exit}`, hashes: [] };
  if (task === "sprite-atlas") return checkPng(projectDir, "assets/sprites/atlas.png", "스프라이트 시트를 확인했습니다.");
  if (task === "headless-tests") return { status: "passed", message: "Godot headless 검사를 실행했습니다.", hashes: [] };
  if (task === "android-debug-build") return checkApk(projectDir, spec.target.engine === "kotlin" ? "app/build/outputs/apk/debug/app-debug.apk" : "build/factory-debug.apk");
  if (task === "adb-smoke-test") {
    if (!/\tdevice\b/.test(result.log)) return { status: "blocked", message: "연결된 기기가 없어 설치하지 않았습니다.", hashes: [] };
    const install = await options.runner.run(toolInvocation("adb_install"), projectDir, options.signal);
    const launch = install.exit === 0 ? await options.runner.run(toolInvocation("adb_launch"), projectDir, options.signal) : install;
    if (launch.exit !== 0) return { status: "failed", message: "기기 설치나 실행이 실패했습니다.", hashes: [] };
    return { status: "passed", message: "연결된 기기에서 설치와 실행을 확인했습니다.", hashes: [] };
  }
  if (task === "model-export") return { status: "blocked", message: "고정 스크립트는 실행됐지만 GLB가 없습니다.", hashes: [] };
  return { status: "blocked", message: "결과를 확인하지 못했습니다.", hashes: [] };
}

function blockedLog(tool: string, result: ToolResult): string {
  return result.log.includes(TOOL_MISSING) ? result.log : missingTool(tool).message;
}

function storeApproval(job: FactoryJob): void {
  job.message = job.paid ? "유료 API를 호출하기 전에 승인이 필요합니다. 다른 제공자로 자동 전환하지 않습니다." : "연결된 기기에 설치하기 전에 승인이 필요합니다.";
}

function checkPng(projectDir: string, relative: string, ok: string): TaskOutcome {
  let bytes: Buffer;
  try { bytes = readFileSync(path.join(projectDir, relative)); } catch { return { status: "failed", message: relative + " 파일이 없습니다.", hashes: [] }; }
  const problem = pngAlphaProblem(bytes);
  if (problem) return { status: "failed", message: problem, hashes: [] };
  return { status: "passed", message: ok, hashes: [fingerprint(relative, bytes)] };
}

function checkApk(projectDir: string, relative: string): TaskOutcome {
  let bytes: Buffer;
  try { bytes = readFileSync(path.join(projectDir, relative)); } catch { return { status: "failed", message: "디버그 APK 파일이 없습니다.", hashes: [] }; }
  if (bytes.length < 4 || bytes.subarray(0, 2).toString("ascii") !== "PK") return { status: "failed", message: "APK 서명이 아닙니다.", hashes: [] };
  return { status: "passed", message: "디버그 APK를 만들었습니다. 서명 배포본은 아닙니다.", hashes: [fingerprint(relative, bytes)] };
}

function buildGates(spec: FactorySpec, jobs: FactoryJob[]): FactoryGate[] {
  const job = (id: TaskId) => jobs.find(item => item.taskId === id);
  const fromJob = (name: FactoryGate["name"], id: TaskId, required: boolean, passed: string): FactoryGate => {
    const found = job(id);
    if (!found) return { name, status: "not_run", detail: "이 명세에는 없는 검사입니다.", required: false };
    if (found.status === "passed") return { name, status: "passed", detail: passed, required };
    if (found.status === "failed") return { name, status: "failed", detail: found.message, required };
    return { name, status: found.status === "queued" || found.status === "running" ? "not_run" : "blocked", detail: found.message || found.status, required };
  };
  const assetIds = ["sprite-atlas", "vfx-export"].filter(id => job(id as TaskId));
  const assetRequired = spec.assets.characters > 0 || spec.assets.vfx > 0;
  const assetJobs = assetIds.map(id => job(id as TaskId)!);
  const asset: FactoryGate = !assetJobs.length
    ? { name: "asset", status: "not_run", detail: "2D 에셋 작업이 없는 명세입니다.", required: false }
    : assetJobs.some(item => item.status === "failed")
      ? { name: "asset", status: "failed", detail: assetJobs.find(item => item.status === "failed")?.message ?? "에셋 실패", required: assetRequired }
      : assetJobs.every(item => item.status === "passed")
        ? { name: "asset", status: "passed", detail: "스프라이트·효과 파일을 검사했습니다.", required: assetRequired }
        : { name: "asset", status: "blocked", detail: assetJobs.map(item => item.message).filter(Boolean).join(" ") || "에셋 도구를 실행하지 않았습니다.", required: assetRequired };
  return [
    { name: "plan", status: "passed", detail: "스키마와 엔진 정책을 통과했습니다.", required: true },
    fromJob("code", spec.kind === "app" ? "screen-core" : "gameplay-core", true, spec.kind === "app" ? "화면 코드를 확인했습니다. 기기 실행은 아닙니다." : "스크립트를 확인했습니다. Godot 실행 결과와는 별개입니다."),
    asset,
    fromJob("model3d", "model-export", spec.target.view === "3d", "GLB를 검사했습니다."),
    spec.kind === "game"
      ? fromJob("gameplay", "headless-tests", true, "Godot headless 검사를 실행했습니다.")
      : fromJob("gameplay", "adb-smoke-test", spec.acceptance.includes("screen-opens"), "기기에서 화면을 열었습니다."),
    fromJob("android", "android-debug-build", true, "디버그 패키지를 만들었습니다."),
    fromJob("release", "release-review", false, "배포를 실행했습니다."),
  ];
}
