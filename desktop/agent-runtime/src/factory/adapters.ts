// Typed tool invocations. Arguments come from this file, not from model text.
// The general terminal allow-list is not widened.
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { redact } from "../util.js";
import type { TaskId } from "./planner.js";

export const TOOLS = ["godot_import", "godot_build_debug", "sprite_gen_prepare", "sprite_gen_extract", "pixelfx_render", "blender_export", "gradle_build", "adb_devices", "adb_install", "adb_launch"] as const;
export type ToolId = (typeof TOOLS)[number];
export const VFX_IDS = ["fireball", "hit", "slash", "spark"] as const;
export type VfxId = (typeof VFX_IDS)[number];

export type ToolInvocation = { tool: ToolId; args: string[] };
export type ToolResult = { exit: number | null; log: string };

const BINARY: Record<ToolId, { env: string; base: RegExp }> = {
  godot_import: { env: "TORIS_FACTORY_GODOT", base: /^godot(\.exe)?$/i },
  godot_build_debug: { env: "TORIS_FACTORY_GODOT", base: /^godot(\.exe)?$/i },
  sprite_gen_prepare: { env: "TORIS_FACTORY_SPRITE_GEN", base: /^sprite-gen(\.exe|\.cmd)?$/i },
  sprite_gen_extract: { env: "TORIS_FACTORY_SPRITE_GEN", base: /^sprite-gen(\.exe|\.cmd)?$/i },
  pixelfx_render: { env: "TORIS_FACTORY_NODE", base: /^node(\.exe)?$/i },
  blender_export: { env: "TORIS_FACTORY_BLENDER", base: /^blender(\.exe)?$/i },
  gradle_build: { env: "TORIS_FACTORY_GRADLE", base: /^gradle(\.bat)?$/i },
  adb_devices: { env: "TORIS_FACTORY_ADB", base: /^adb(\.exe)?$/i },
  adb_install: { env: "TORIS_FACTORY_ADB", base: /^adb(\.exe)?$/i },
  adb_launch: { env: "TORIS_FACTORY_ADB", base: /^adb(\.exe)?$/i },
};

/** Fixed arguments. `effect` is one of VFX_IDS, chosen by the planner. */
function knownEffect(effect: string | undefined): VfxId {
  return (VFX_IDS as readonly string[]).includes(effect ?? "") ? effect as VfxId : "fireball";
}

/** True when the argument list is one this module would build. */
export function canonicalInvocation(invocation: ToolInvocation): ToolInvocation | null {
  const effect = invocation.tool === "pixelfx_render" ? knownEffect(invocation.args[1]) : undefined;
  if (invocation.tool === "pixelfx_render" && invocation.args[1] !== effect) return null;
  const planned = toolInvocation(invocation.tool, effect);
  return planned.args.join("\0") === invocation.args.join("\0") ? planned : null;
}

export function toolInvocation(tool: ToolId, effect?: VfxId): ToolInvocation {
  const safeEffect = knownEffect(effect);
  switch (tool) {
    case "godot_import": return { tool, args: ["--headless", "--path", ".", "--import", "--quit"] };
    case "godot_build_debug": return { tool, args: ["--headless", "--path", ".", "--export-debug", "Android", "build/factory-debug.apk"] };
    case "sprite_gen_prepare": return { tool, args: ["prepare"] };
    case "sprite_gen_extract": return { tool, args: ["extract"] };
    case "pixelfx_render": return { tool, args: ["tools/render.mjs", safeEffect, "--sheet"] };
    case "blender_export": return { tool, args: ["--background", "--python", "tools/blender_export.py", "--", "data/models.json"] };
    case "gradle_build": return { tool, args: ["assembleDebug"] };
    case "adb_devices": return { tool, args: ["devices"] };
    case "adb_install": return { tool, args: ["install", "-r", "build/factory-debug.apk"] };
    case "adb_launch": return { tool, args: ["shell", "am", "start", "-n", "kr.toris.factory/.MainActivity"] };
    default: {
      const neverTool: never = tool;
      throw new Error(neverTool);
    }
  }
}

export type ToolRunner = {
  which(tool: ToolId): { path: string } | null;
  run(invocation: ToolInvocation, cwd: string, signal: AbortSignal): Promise<ToolResult>;
};

function pinnedBinary(env: NodeJS.ProcessEnv, tool: ToolId): string | null {
  const rule = BINARY[tool];
  const raw = env[rule.env] ?? "";
  if (!path.isAbsolute(raw) || !rule.base.test(path.basename(raw)) || !existsSync(raw)) return null;
  try {
    const real = realpathSync(raw);
    if (!rule.base.test(path.basename(real))) return null;
    return real;
  } catch { return null; }
}

export function envRunner(env: NodeJS.ProcessEnv = process.env): ToolRunner {
  return {
    which(tool) {
      const binary = pinnedBinary(env, tool);
      return binary ? { path: binary } : null;
    },
    run(invocation, cwd, signal) {
      const binary = pinnedBinary(env, invocation.tool);
      const planned = canonicalInvocation(invocation);
      if (!binary || !planned) return Promise.resolve({ exit: null, log: planned ? "실행 파일 없음" : "허용되지 않은 인자입니다." });
      return new Promise(resolve => {
        let log = "";
        const child = spawn(binary, planned.args, { cwd, shell: false, windowsHide: true, signal });
        const take = (chunk: Buffer) => { if (log.length < 4000) log += chunk.toString("utf8"); };
        child.stdout?.on("data", take);
        child.stderr?.on("data", take);
        child.on("error", error => resolve({ exit: null, log: redact(error.message) }));
        child.on("close", code => resolve({ exit: code, log: redact(log).slice(0, 2000) }));
      });
    },
  };
}

/** Runner for tests. `run` may create files; missing tools stay unavailable. */
export function scriptedRunner(results: Partial<Record<ToolId, ToolResult | ((invocation: ToolInvocation) => ToolResult)>>): ToolRunner {
  return {
    which(tool) { return results[tool] ? { path: "/pinned/" + tool } : null; },
    async run(invocation) {
      const scripted = results[invocation.tool];
      if (!scripted) return { exit: null, log: "실행 파일 없음" };
      return typeof scripted === "function" ? scripted(invocation) : scripted;
    },
  };
}

export const TOOL_MISSING = "도구를 실행하지 않았습니다";

export type TaskOutcome = { status: "passed" | "failed" | "blocked" | "cancelled"; message: string; hashes: string[] };

export function missingTool(tool: string): TaskOutcome {
  return { status: "blocked", message: `${TOOL_MISSING}: ${tool}`, hashes: [] };
}

const TASK_TOOL: Partial<Record<TaskId, ToolId>> = {
  "sprite-atlas": "sprite_gen_prepare",
  "vfx-export": "pixelfx_render",
  "model-export": "blender_export",
  "headless-tests": "godot_import",
  "android-debug-build": "godot_build_debug",
  "adb-smoke-test": "adb_devices",
};

export function toolFor(task: TaskId, engine: "godot" | "kotlin"): ToolId | null {
  if (task === "android-debug-build" && engine === "kotlin") return "gradle_build";
  if (task === "headless-tests" && engine === "kotlin") return null;
  return TASK_TOOL[task] ?? null;
}
