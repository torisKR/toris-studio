import { spawn } from "node:child_process";
import path from "node:path";
import { UserError, clip, redact } from "../util.js";

export const COMMAND_TIMEOUT_MS = 10 * 60_000;
const MAX_LOG = 200_000;
const ARG = /^[A-Za-z0-9_@%+=:,./-]{1,200}$/;

/**
 * Build, test and lint only. Package installs, publishing, arbitrary scripts
 * (`npx`, `exec`, `dlx`, `make`) and shells are never allowed, even with approval.
 */
const RULES: Record<string, (args: string[]) => boolean> = {
  npm: a => a[0] === "test" || (a[0] === "run" && Boolean(a[1])),
  pnpm: a => a[0] === "test" || (a[0] === "run" && Boolean(a[1])) || ["build", "lint", "typecheck"].includes(a[0] ?? ""),
  yarn: a => a[0] === "test" || (a[0] === "run" && Boolean(a[1])) || ["build", "lint", "typecheck"].includes(a[0] ?? ""),
  bun: a => a[0] === "test" || (a[0] === "run" && Boolean(a[1])),
  cargo: a => ["build", "test", "check", "clippy", "fmt"].includes(a[0] ?? "") && (a[0] !== "fmt" || a.includes("--check")),
  go: a => ["build", "test", "vet"].includes(a[0] ?? ""),
  pytest: () => true,
  python3: a => a[0] === "-m" && ["pytest", "unittest", "mypy"].includes(a[1] ?? ""),
  python: a => a[0] === "-m" && ["pytest", "unittest", "mypy"].includes(a[1] ?? ""),
  flutter: a => ["test", "analyze"].includes(a[0] ?? ""),
  dart: a => ["test", "analyze"].includes(a[0] ?? ""),
  deno: a => ["test", "check", "lint"].includes(a[0] ?? ""),
  tsc: a => a.includes("--noEmit") || a.includes("-p") || a.length === 0,
};

export function validateCommand(command: unknown): string[] {
  if (!Array.isArray(command) || !command.length || command.length > 30) throw new UserError("command는 [\"pnpm\", \"test\"] 같은 배열이어야 합니다.");
  const argv = command.map(String);
  const [program, ...args] = argv;
  const rule = RULES[program];
  if (!rule) throw new UserError(`허용하지 않는 실행 파일입니다: ${program}. 빌드·테스트·린트 명령만 실행할 수 있습니다.`);
  for (const arg of args) {
    if (!ARG.test(arg)) throw new UserError(`허용하지 않는 인자입니다: ${arg.slice(0, 40)}`);
    if (arg.includes("..") || path.isAbsolute(arg)) throw new UserError("프로젝트 밖 경로를 가리키는 인자는 사용할 수 없습니다.");
  }
  if (["run", "test"].includes(args[0] ?? "") && args.some(a => ["install", "add", "publish", "exec", "dlx", "link"].includes(a))) throw new UserError("설치·게시 명령은 실행할 수 없습니다.");
  if (!rule(args)) throw new UserError(`허용하지 않는 하위 명령입니다: ${argv.join(" ")}`);
  return argv;
}

/** The child sees no provider key and no inherited secrets; only what a build needs. */
export function commandEnv(searchPath: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const key of ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PATHEXT", "CARGO_HOME", "RUSTUP_HOME", "GOPATH", "JAVA_HOME", "ANDROID_HOME", "FLUTTER_ROOT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = [...searchPath, path.join(process.env.HOME ?? "", ".cargo/bin"), process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  return env;
}

export type CommandResult = { exitCode: number; timedOut: boolean; durationMs: number; log: string };

export function runCommand(argv: string[], cwd: string, searchPath: string[], secrets: string[], signal?: AbortSignal, onChunk?: (text: string) => void): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: commandEnv(searchPath), shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    let log = "", timedOut = false, settled = false;
    const kill = () => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { /* exited */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, COMMAND_TIMEOUT_MS);
    const abort = () => kill();
    signal?.addEventListener("abort", abort, { once: true });
    const take = (chunk: Buffer) => {
      const textChunk = chunk.toString("utf8");
      log = (log + textChunk).slice(-MAX_LOG * 2);
      onChunk?.(redact(textChunk, secrets));
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", error => { if (!settled) { settled = true; clearTimeout(timer); reject(new UserError(`명령을 실행하지 못했습니다: ${argv[0]} (${error.message})`)); } });
    child.on("close", code => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      resolve({ exitCode: code ?? 1, timedOut, durationMs: Date.now() - started, log: redact(clip(log, MAX_LOG), secrets) });
    });
  });
}
