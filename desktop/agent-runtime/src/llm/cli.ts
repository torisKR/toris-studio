import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { CliProviderId } from "../protocol.js";
import { UserError, clip, parseJsonObject } from "../util.js";
import type { ChatModel, CompleteInput, ModelOption, ProviderCheck } from "./types.js";

const CLI_TIMEOUT_MS = 6 * 60_000;
const MAX_OUTPUT = 4 * 1024 * 1024;
const BINARIES: Record<CliProviderId, string> = {
  "claude-cli": "claude",
  "codex-cli": "codex",
  "gemini-cli": "gemini",
  "cursor-cli": "cursor-agent",
  "kiro-cli": "kiro-cli",
};

export function defaultSearchPath(): string[] {
  const home = homedir();
  return [
    path.join(home, ".local/bin"), path.join(home, ".npm-global/bin"), path.join(home, ".bun/bin"),
    path.join(home, ".volta/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm")] : []),
  ];
}

export function findBinary(provider: CliProviderId, searchPath: string[]): string | null {
  // Windows .cmd shims need a shell, which would re-parse prompt text; only native executables are used.
  const names = process.platform === "win32" ? [`${BINARIES[provider]}.exe`] : [BINARIES[provider]];
  const dirs = [...searchPath, ...(process.env.PATH ?? "").split(path.delimiter)].filter(Boolean);
  for (const dir of dirs) for (const name of names) {
    const candidate = path.join(dir, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

/** CLIs keep their own subscription login; no API key or project secret reaches them. */
function cliEnv(searchPath: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PATHEXT", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = [...searchPath, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  env.NO_COLOR = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

/** Single-turn CLIs get the app's instructions first, then the conversation so far. */
export function flatten(input: CompleteInput, includeSystem: boolean): string {
  if (input.messages.length === 1 && !includeSystem) return input.messages[0].content;
  const turns = input.messages.length === 1
    ? input.messages[0].content
    : `지금까지의 대화입니다. 마지막 요청에 답하세요.\n\n${input.messages.map(m => `[${m.role === "user" ? "요청" : "이전 답변"}]\n${m.content}`).join("\n\n")}`;
  return includeSystem ? `${input.system}\n\n---\n\n${turns}` : turns;
}

/** Arguments are fixed per CLI; every CLI runs text-only in an empty scratch directory. */
export function cliInvocation(provider: CliProviderId, model: string, input: CompleteInput, outputFile: string): { args: string[]; stdin: string } {
  const m = model.trim();
  switch (provider) {
    case "claude-cli":
      return {
        args: ["--print", "--safe-mode", "--restricted", "--tools", "", "--disallowedTools", "mcp__*", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
          "--disable-slash-commands", "--setting-sources", "", "--permission-mode", "dontAsk", "--permission-prompts", "none",
          "--no-session-persistence", "--no-chrome", "--output-format", "json", ...(m ? ["--model", m] : []), "--system-prompt", input.system],
        stdin: flatten(input, false),
      };
    case "codex-cli":
      return { args: ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never", "-o", outputFile, ...(m ? ["-m", m] : []), "-"], stdin: flatten(input, true) };
    case "gemini-cli":
      // --skip-trust trusts only the empty scratch directory for this one call.
      return { args: ["--skip-trust", "--approval-mode", "plan", "-o", "json", ...(m ? ["-m", m] : []), "-p", "위 지시에 따라 답변만 작성하세요."], stdin: flatten(input, true) };
    case "cursor-cli":
      // Plan mode is read-only; --trust covers only the empty scratch workspace.
      return { args: ["-p", "--trust", "--mode", "plan", "--output-format", "text", ...(m ? ["--model", m] : []), flatten(input, true)], stdin: "" };
    case "kiro-cli":
      return { args: ["chat", "--no-interactive", "--trust-tools=", ...(m ? ["--model", m] : []), flatten(input, true)], stdin: "" };
  }
}

export function parseCliOutput(provider: CliProviderId, stdout: string, outputFile: string): string {
  if (provider === "claude-cli") {
    const value = parseJsonObject(stdout);
    if (value.is_error) throw new UserError(`Claude Code 오류: ${String(value.result ?? "로그인 상태를 확인하세요.").slice(0, 300)}`);
    return String(value.result ?? "");
  }
  if (provider === "codex-cli") {
    try { return readFileSync(outputFile, "utf8"); } catch { return stdout; }
  }
  if (provider === "gemini-cli") {
    try { const value = parseJsonObject(stdout); if (typeof value.response === "string") return value.response; } catch { /* plain text */ }
    return stdout;
  }
  // eslint-disable-next-line no-control-regex
  return stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/^>\s?/gm, "").trim();
}

/** The most useful single line of a failed CLI run (login, plan or quota problems). */
export function failureReason(provider: CliProviderId, stdout: string, stderr: string): string {
  if (provider === "claude-cli") {
    try { const value = parseJsonObject(stdout); if (typeof value.result === "string" && value.result) return value.result.slice(0, 300); } catch { /* not JSON */ }
  }
  const lines = `${stderr}\n${stdout}`.split("\n").map(line => line.trim()).filter(Boolean);
  const reason = lines.find(line => /not logged|login|log in|auth|unauthori|quota|limit|ineligible|subscription|plan|error/i.test(line) && !/^at\s/.test(line));
  return clip(reason ?? lines[0] ?? "로그인 상태를 확인하세요.", 300);
}

class CliModel implements ChatModel {
  constructor(readonly provider: CliProviderId, readonly model: string, private binary: string, private searchPath: string[]) {}
  async complete(input: CompleteInput): Promise<string> {
    const scratch = mkdtempSync(path.join(tmpdir(), "toris-agent-cli-"));
    const outputFile = path.join(scratch, "last-message.txt");
    try {
      const { args, stdin } = cliInvocation(this.provider, this.model, input, outputFile);
      const { code, stdout, stderr } = await run(this.binary, args, stdin, scratch, cliEnv(this.searchPath), input.signal);
      if (code !== 0) throw new UserError(`${path.basename(this.binary)} 실행 실패 (코드 ${code}): ${failureReason(this.provider, stdout, stderr)}`);
      const text = parseCliOutput(this.provider, stdout, outputFile).trim();
      if (!text) throw new UserError(`${path.basename(this.binary)}가 빈 응답을 반환했습니다.`);
      return text;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

function run(command: string, args: string[], stdin: string, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, limit = MAX_OUTPUT) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", done = false;
    const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); fn(); } };
    const abort = () => { child.kill("SIGTERM"); finish(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); };
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(() => reject(new UserError("CLI 응답 시간이 초과되었습니다."))); }, CLI_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => { if (stdout.length < limit) stdout += chunk; });
    child.stderr.on("data", chunk => { if (stderr.length < 64_000) stderr += chunk; });
    child.on("error", error => finish(() => reject(new UserError(`CLI를 실행하지 못했습니다: ${error.message}`))));
    child.on("close", code => finish(() => resolve({ code: code ?? 1, stdout, stderr })));
    child.stdin.end(stdin);
  });
}

export function cliModel(provider: CliProviderId, model: string, searchPath: string[]): ChatModel {
  const binary = findBinary(provider, searchPath);
  if (!binary) throw new UserError(`${BINARIES[provider]} CLI를 찾을 수 없습니다. 설치하고 로그인한 뒤 다시 시도하세요.`);
  return new CliModel(provider, model, binary, searchPath);
}

export async function cliVersion(provider: CliProviderId, searchPath: string[]): Promise<string | null> {
  const binary = findBinary(provider, searchPath);
  if (!binary) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const result = await run(binary, ["--version"], "", tmpdir(), cliEnv(searchPath), controller.signal);
    clearTimeout(timer);
    return result.stdout.trim().split("\n")[0]?.slice(0, 80) || "설치됨";
  } catch {
    return "설치됨";
  }
}

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

/** kiro-cli chat --list-models --format json */
export function parseKiroModels(stdout: string): ModelOption[] {
  const list = parseJsonObject(stdout).models;
  if (!Array.isArray(list)) return [];
  return list.flatMap(item => {
    const model = item as { model_id?: unknown; model_name?: unknown; description?: unknown; rate_multiplier?: unknown };
    if (typeof model.model_id !== "string" || !model.model_id) return [];
    const rate = typeof model.rate_multiplier === "number" ? model.rate_multiplier + "x 크레딧" : "";
    const description = typeof model.description === "string" ? model.description : "";
    return [{ id: model.model_id, label: typeof model.model_name === "string" && model.model_name ? model.model_name : model.model_id, detail: [rate, description].filter(Boolean).join(" · ").slice(0, 160) }];
  });
}

/** cursor-agent models: "id - Label" per line. */
export function parseCursorModels(stdout: string): ModelOption[] {
  return plain(stdout).split("\n").flatMap(line => {
    const found = line.trim().match(/^([A-Za-z0-9][\w.:/[\]=,-]*)\s+-\s+(.+)$/);
    if (!found) return [];
    const label = found[2].replace(/[\u200b\u200c\u200d]/g, "").trim();
    const isDefault = /\(default\)\s*$/i.test(label);
    return [{ id: found[1], label: label.replace(/\s*\(default\)\s*$/i, ""), ...(isDefault ? { detail: "기본 모델" } : {}) }];
  });
}

/** codex debug models: JSON catalog; only models the picker lists. */
export function parseCodexModels(stdout: string): ModelOption[] {
  const list = parseJsonObject(stdout).models;
  if (!Array.isArray(list)) return [];
  return list.flatMap(item => {
    const model = item as { slug?: unknown; display_name?: unknown; description?: unknown; visibility?: unknown };
    if (typeof model.slug !== "string" || !model.slug || model.visibility !== "list") return [];
    return [{ id: model.slug, label: typeof model.display_name === "string" && model.display_name ? model.display_name : model.slug, ...(typeof model.description === "string" && model.description ? { detail: model.description.slice(0, 160) } : {}) }];
  });
}

const LOGIN_HINT: Record<CliProviderId, string> = {
  "claude-cli": "터미널에서 claude를 실행하고 /login으로 로그인하세요.",
  "codex-cli": "터미널에서 codex login으로 ChatGPT 계정에 로그인하세요.",
  "gemini-cli": "터미널에서 gemini를 실행하고 Google 계정으로 로그인하세요.",
  "cursor-cli": "터미널에서 cursor-agent login으로 로그인하세요.",
  "kiro-cli": "터미널에서 kiro-cli login으로 로그인하세요.",
};

/** Login state from each CLI's own status command. Output text decides; nothing is sent to a model. */
export function parseCliLogin(provider: CliProviderId, code: number, stdout: string, stderr: string): { signedIn: boolean; account?: string; detail: string } {
  const text = plain(stdout + "\n" + stderr);
  const email = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0];
  switch (provider) {
    case "claude-cli": {
      let value: Record<string, unknown> = {};
      try { value = parseJsonObject(stdout); } catch { /* not JSON */ }
      const signedIn = value.loggedIn === true;
      const method = typeof value.authMethod === "string" && value.authMethod !== "none" ? value.authMethod : "";
      return { signedIn, account: typeof value.email === "string" ? value.email : email, detail: signedIn ? "Claude 계정 로그인됨" + (method ? " · " + method : "") : LOGIN_HINT[provider] };
    }
    case "codex-cli": {
      const signedIn = code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text);
      return { signedIn, account: email, detail: signedIn ? (/chatgpt/i.test(text) ? "ChatGPT 계정 로그인됨" : "로그인됨") : LOGIN_HINT[provider] };
    }
    case "cursor-cli": {
      const signedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
      return { signedIn, account: email, detail: signedIn ? "Cursor 계정 로그인됨" : LOGIN_HINT[provider] };
    }
    case "kiro-cli": {
      const signedIn = code === 0 && !/not logged in|not authenticated|login required/i.test(text);
      const via = text.match(/logged in with ([\w ]+)/i)?.[1]?.trim();
      return { signedIn, account: email, detail: signedIn ? "Kiro 계정 로그인됨" + (via ? " · " + via : "") : LOGIN_HINT[provider] };
    }
    case "gemini-cli":
      return { signedIn: code === 0, detail: code === 0 ? "Google 계정 로그인 정보 있음 · 첫 요청 때 확인합니다." : LOGIN_HINT[provider] };
  }
}

const STATUS_ARGS: Partial<Record<CliProviderId, string[]>> = {
  "claude-cli": ["auth", "status"],
  "codex-cli": ["login", "status"],
  "cursor-cli": ["status"],
  "kiro-cli": ["whoami"],
};
const MODEL_ARGS: Partial<Record<CliProviderId, { args: string[]; parse: (stdout: string) => ModelOption[]; limit?: number }>> = {
  "kiro-cli": { args: ["chat", "--list-models", "--format", "json"], parse: parseKiroModels },
  "cursor-cli": { args: ["models"], parse: parseCursorModels },
  "codex-cli": { args: ["debug", "models"], parse: parseCodexModels, limit: 24 * 1024 * 1024 },
};

async function quick(binary: string, args: string[], searchPath: string[], limit?: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const scratch = mkdtempSync(path.join(tmpdir(), "toris-agent-check-"));
  try { return await run(binary, args, "", scratch, cliEnv(searchPath), controller.signal, limit); }
  finally { clearTimeout(timer); rmSync(scratch, { recursive: true, force: true }); }
}

/** Installed? Signed in? Which models does this account offer? Never sends a prompt. */
export async function checkCli(provider: CliProviderId, searchPath: string[], suggested: ModelOption[]): Promise<Omit<ProviderCheck, "provider" | "checkedAt">> {
  const binary = findBinary(provider, searchPath);
  if (!binary) return { state: "missing", detail: BINARIES[provider] + " CLI가 설치되어 있지 않습니다.", models: suggested, source: "suggested" };
  let login: ReturnType<typeof parseCliLogin>;
  try {
    const statusArgs = STATUS_ARGS[provider];
    if (statusArgs) {
      const result = await quick(binary, statusArgs, searchPath);
      login = parseCliLogin(provider, result.code, result.stdout, result.stderr);
    } else {
      login = parseCliLogin(provider, existsSync(path.join(homedir(), ".gemini/oauth_creds.json")) ? 0 : 1, "", "");
    }
  } catch {
    return { state: "error", detail: "로그인 상태를 확인하지 못했습니다. 잠시 뒤 다시 확인하세요.", models: suggested, source: "suggested" };
  }
  if (!login.signedIn) return { state: "signed-out", detail: login.detail, models: suggested, source: "suggested" };
  const lister = MODEL_ARGS[provider];
  let models: ModelOption[] = [];
  if (lister) {
    try {
      const result = await quick(binary, lister.args, searchPath, lister.limit);
      if (result.code === 0) models = lister.parse(result.stdout);
    } catch { /* fall back to suggestions */ }
  }
  return { state: "connected", detail: login.detail, ...(login.account ? { account: login.account } : {}), models: models.length ? models : suggested, source: models.length ? "account" : "suggested" };
}

