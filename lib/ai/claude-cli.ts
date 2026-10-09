import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { draftMessages } from "./prompts";
import { AiError, type DraftInput } from "./types";

export type CliRunner = (command: string, args: string[], input: string, timeoutMs: number) => Promise<string>;

export function subscriptionCliEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NODE_ENV: env.NODE_ENV || "production" };
  // API keys, gateway routing, project env and agent-session state cannot silently change billing.
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    if (env[key]) result[key] = env[key];
  }
  result.CLAUDE_CODE_SAFE_MODE = "1";
  result.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return result;
}

export const runClaudeCli: CliRunner = async (command, args, input, timeoutMs) => {
  const directory = await mkdtemp(path.join(tmpdir(), "toris-ai-"));
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: directory, env: subscriptionCliEnvironment(), shell: false,
        stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32",
      });
      let output = "";
      let byteLength = 0;
      let settled = false;
      const kill = () => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { /* Already exited. */ }
      };
      const fail = (error: AiError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        kill();
        reject(error);
      };
      const timer = setTimeout(() => fail(new AiError("PROVIDER_TIMEOUT", "Claude CLI 응답 시간이 초과되었습니다.", 504)), timeoutMs);
      child.on("error", () => fail(new AiError("CLI_UNAVAILABLE", "Claude CLI 실행 파일 또는 인증 상태를 확인해 주세요.")));
      child.stdout.on("data", (data: Buffer) => {
        byteLength += data.length;
        if (byteLength > 131072) return fail(new AiError("PROVIDER_RESPONSE_INVALID", "Claude CLI 응답 크기가 제한을 초과했습니다.", 502));
        output += data.toString("utf8");
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) reject(new AiError("CLI_UNAVAILABLE", "Claude CLI가 요청을 처리하지 못했습니다. 구독 로그인 또는 한도를 확인해 주세요."));
        else resolve(output);
      });
      child.stdin.on("error", () => { /* The process may exit before it reads stdin. */ });
      child.stdin.end(input);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
};

export function isSubscriptionLogin(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const status = value as Record<string, unknown>;
  return status.loggedIn === true && status.apiProvider === "firstParty"
    && typeof status.authMethod === "string"
    && ["oauth", "claude.ai", "claudeai", "oauth_token"].includes(status.authMethod.toLowerCase());
}

export async function claudeSubscriptionStatus(command: string, runner: CliRunner = runClaudeCli): Promise<boolean> {
  try {
    const raw = await runner(command, ["--safe-mode", "auth", "status", "--json"], "", 5000);
    return isSubscriptionLogin(JSON.parse(raw));
  } catch { return false; }
}

export async function generateWithClaudeCli(
  command: string, model: string, input: DraftInput, timeoutMs: number, runner: CliRunner = runClaudeCli,
): Promise<string> {
  const [system, user] = draftMessages(input);
  const args = [
    "--print", "--safe-mode", "--restricted", "--tools", "", "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--setting-sources", "",
    "--permission-mode", "dontAsk", "--no-session-persistence", "--output-format", "json",
    "--model", model, "--system-prompt", system.content,
  ];
  const raw = await runner(command, args, user.content, timeoutMs);
  let result: Record<string, unknown>;
  try { result = JSON.parse(raw); } catch {
    throw new AiError("PROVIDER_RESPONSE_INVALID", "Claude CLI가 올바른 응답을 반환하지 않았습니다.", 502);
  }
  if (result.is_error === true || typeof result.result !== "string" || !result.result.trim() || result.result.length > 40000) {
    throw new AiError("PROVIDER_RESPONSE_INVALID", "Claude CLI 초안 생성에 실패했습니다. 인증 또는 사용량 한도를 확인해 주세요.", 502);
  }
  return result.result.trim();
}
