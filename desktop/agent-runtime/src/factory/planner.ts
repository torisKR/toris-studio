// Task DAG. Independent tasks may share a batch. Tasks that edit the project,
// render, or animate take a lock and run one at a time.
import { createHash } from "node:crypto";
import type { FactorySpec } from "./spec.js";

export const TASKS = [
  "spec-approved",
  "scaffold-project",
  "game-design",
  "app-design",
  "character-base",
  "sprite-atlas",
  "vfx-export",
  "model-export",
  "gameplay-core",
  "screen-core",
  "level-content",
  "asset-integration",
  "lint-and-import",
  "headless-tests",
  "android-debug-build",
  "adb-smoke-test",
  "release-review",
] as const;
export type TaskId = (typeof TASKS)[number];

const DEPS: Record<TaskId, readonly TaskId[]> = {
  "spec-approved": [],
  "scaffold-project": ["spec-approved"],
  "game-design": ["scaffold-project"],
  "app-design": ["scaffold-project"],
  "character-base": ["game-design"],
  "sprite-atlas": ["character-base"],
  "vfx-export": ["game-design"],
  "model-export": ["game-design"],
  "gameplay-core": ["game-design"],
  "screen-core": ["app-design"],
  "level-content": ["gameplay-core", "sprite-atlas"],
  "asset-integration": ["sprite-atlas", "vfx-export", "gameplay-core"],
  "lint-and-import": ["asset-integration"],
  "headless-tests": ["lint-and-import"],
  "android-debug-build": ["headless-tests"],
  "adb-smoke-test": ["android-debug-build"],
  "release-review": ["android-debug-build"],
};

const LOCK: Record<TaskId, string> = {
  "spec-approved": "",
  "scaffold-project": "project-edit",
  "game-design": "project-edit",
  "app-design": "project-edit",
  "character-base": "project-edit",
  "sprite-atlas": "animation",
  "vfx-export": "animation",
  "model-export": "blender",
  "gameplay-core": "project-edit",
  "screen-core": "project-edit",
  "level-content": "project-edit",
  "asset-integration": "project-edit",
  "lint-and-import": "project-edit",
  "headless-tests": "project-edit",
  "android-debug-build": "project-edit",
  "adb-smoke-test": "device",
  "release-review": "",
};

const HEAVY = new Set<TaskId>(["sprite-atlas", "vfx-export", "model-export", "headless-tests", "android-debug-build", "adb-smoke-test"]);

export type PlannedTask = { id: TaskId; deps: TaskId[]; lock: string; heavy: boolean; optional: boolean };

function isTask(value: string): value is TaskId {
  return (TASKS as readonly string[]).includes(value);
}

/** Tasks that apply to this spec. 2D, 3D and apps do not share asset work. */
export function planTasks(spec: FactorySpec): PlannedTask[] {
  const view = spec.target.view;
  const ids = TASKS.filter(id => {
    if (spec.kind === "app") return ["spec-approved", "scaffold-project", "app-design", "screen-core", "android-debug-build", "adb-smoke-test", "release-review"].includes(id);
    if (id === "app-design" || id === "screen-core") return false;
    if (id === "sprite-atlas" || id === "character-base" || id === "level-content") return view === "2d";
    if (id === "vfx-export") return view === "2d" && spec.assets.vfx > 0;
    if (id === "model-export") return view === "3d";
    if (id === "asset-integration" || id === "lint-and-import" || id === "headless-tests") return view !== "ui";
    return true;
  });
  return ids.map(id => ({
    id,
    deps: dependencies(id, ids),
    lock: LOCK[id],
    heavy: HEAVY.has(id),
    optional: id === "adb-smoke-test",
  }));
}

function dependencies(id: TaskId, ids: TaskId[]): TaskId[] {
  const deps = DEPS[id].filter(dep => ids.includes(dep));
  if (id === "android-debug-build" && deps.length === 0) {
    if (ids.includes("screen-core")) deps.push("screen-core");
    else if (ids.includes("lint-and-import")) deps.push("lint-and-import");
  }
  if (id === "asset-integration" && ids.includes("model-export") && !deps.includes("model-export")) deps.push("model-export");
  return deps;
}

export function jobKey(project: string, specRevision: number, taskId: TaskId, inputHash: string, adapterVersion: string): string {
  return createHash("sha256").update([project, String(specRevision), taskId, inputHash, adapterVersion].join("\0")).digest("hex");
}

export type TaskStatus = "queued" | "running" | "waiting_approval" | "passed" | "failed" | "cancelled" | "blocked" | "interrupted";

/** Next tasks whose dependencies passed and whose locks do not clash. At most one heavy task. */
export function nextBatch(plan: PlannedTask[], status: (id: TaskId) => TaskStatus | "absent"): TaskId[] {
  const ready = plan.filter(task => {
    const state = status(task.id);
    if (state !== "queued") return false;
    return task.deps.every(dep => status(dep) === "passed");
  });
  const explicitFirst = ready.find(task => task.id === "release-review" || task.id === "adb-smoke-test");
  const pool = explicitFirst ? [explicitFirst] : ready;
  const batch: TaskId[] = [];
  const locks = new Set<string>();
  let heavy = false;
  for (const task of pool) {
    if (task.lock && locks.has(task.lock)) continue;
    if (task.heavy && heavy) continue;
    if (task.lock) locks.add(task.lock);
    if (task.heavy) heavy = true;
    batch.push(task.id);
  }
  return batch;
}

/** A task whose dependency failed, was blocked, or was cancelled cannot run. */
export function blockedReason(task: PlannedTask, status: (id: TaskId) => TaskStatus | "absent"): string | null {
  if (status(task.id) !== "queued") return null;
  for (const dep of task.deps) {
    const state = status(dep);
    if (state === "failed" || state === "blocked" || state === "cancelled") return `${dep} 단계가 ${state} 이라 진행하지 않습니다.`;
  }
  return null;
}

export function assertTask(value: string): TaskId {
  if (!isTask(value)) throw new Error("알 수 없는 작업입니다.");
  return value;
}
