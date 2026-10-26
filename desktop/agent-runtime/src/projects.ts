import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { UserError } from "./util.js";

export type ProjectInfo = {
  name: string;
  path: string;
  stacks: string[];
  scripts: Record<string, string>;
  git: boolean;
};

const MARKERS: Array<[string, string]> = [
  ["package.json", "node"], ["next.config.ts", "nextjs"], ["next.config.js", "nextjs"], ["next.config.mjs", "nextjs"],
  ["nest-cli.json", "nestjs"], ["Cargo.toml", "rust"], ["supabase/config.toml", "supabase"], ["go.mod", "go"],
  ["pyproject.toml", "python"], ["requirements.txt", "python"], ["pubspec.yaml", "flutter"], ["project.godot", "godot"],
  ["src-tauri/tauri.conf.json", "tauri"], ["desktop/src-tauri/tauri.conf.json", "tauri"], ["vite.config.ts", "vite"],
];

/** A project is exactly one real (non-symlink-escaping) directory directly under the projects root. */
export function projectDir(root: string, name: string): string {
  if (!name || name.length > 200 || /[\\/]/.test(name) || name === "." || name === ".." || name.startsWith(".")) throw new UserError("프로젝트 이름을 확인하세요.");
  const realRoot = realpathSync(root);
  let dir: string;
  try { dir = realpathSync(path.join(realRoot, name)); } catch { throw new UserError(`프로젝트를 찾을 수 없습니다: ${name}`); }
  if (path.dirname(dir) !== realRoot || !statSync(dir).isDirectory()) throw new UserError("프로젝트 폴더는 projects 폴더 바로 아래에 있어야 합니다.");
  return dir;
}

export function describeProject(root: string, name: string): ProjectInfo {
  const dir = projectDir(root, name);
  const stacks = [...new Set(MARKERS.filter(([file]) => existsSync(path.join(dir, file))).map(([, stack]) => stack))];
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    scripts = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([, v]) => typeof v === "string").slice(0, 60).map(([k, v]) => [k, v.slice(0, 200)]));
  } catch { /* not a node project */ }
  return { name, path: dir, stacks, scripts, git: existsSync(path.join(dir, ".git")) };
}

export function listProjects(root: string): ProjectInfo[] {
  let entries: string[];
  try { entries = readdirSync(realpathSync(root)); } catch { throw new UserError(`프로젝트 폴더를 읽을 수 없습니다: ${root}`); }
  const out: ProjectInfo[] = [];
  for (const name of entries.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith(".")) continue;
    try { out.push(describeProject(root, name)); } catch { /* not a directory or escapes root */ }
    if (out.length >= 500) break;
  }
  return out;
}

export function packageManager(dir: string): "pnpm" | "yarn" | "bun" | "npm" {
  if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(dir, "bun.lockb")) || existsSync(path.join(dir, "bun.lock"))) return "bun";
  return "npm";
}
