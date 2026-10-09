import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
const OPERATIONS = new Set(["snapshot", "create_jobs", "set_job", "import", "create_mesh", "update_asset", "get_asset", "resize_asset"]);
let inFlight = 0;
export async function resolveAssetBinary(): Promise<string> {
  const configured = process.env.TORIS_STUDIO_ASSET_BIN;
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("TORIS_STUDIO_ASSET_BIN은 절대 경로여야 합니다.");
    await access(configured, constants.X_OK); return configured;
  }
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const profile of ["debug", "release"]) {
    const path = fileURLToPath(new URL(`../desktop/src-tauri/target/${profile}/toris-studio-desktop${suffix}`, import.meta.url));
    try { await access(path, constants.X_OK); return path; } catch { /* Try next explicit candidate. */ }
  }
  throw new Error("에셋 워커가 없습니다. pnpm assets:worker:build 실행 후 다시 연결하세요.");
}
export async function assetWorker<T = Record<string, unknown>>(action: string, input: object): Promise<T> {
  if (!OPERATIONS.has(action)) throw new Error("허용되지 않는 MCP 에셋 작업입니다.");
  if (inFlight >= 2) throw new Error("에셋 처리 중입니다. 진행 중인 요청이 끝난 뒤 재시도하세요.");
  inFlight++;
  try {
    const binary = await resolveAssetBinary();
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    for (const key of ["HOME", "USERPROFILE", "PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "TORIS_STUDIO_ASSET_HOME"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    // No shell, API credentials, private ChatGPT endpoints, or coding CLI are involved.
    return await new Promise<T>((resolve, reject) => {
      const child = spawn(binary, ["--asset-command"], { shell: false, env, stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = []; let size = 0;
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("에셋 처리 시간이 초과되었습니다. 작업 상태를 확인하세요.")); }, 120_000);
      child.stdout.on("data", (data: Buffer) => {
        size += data.length;
        if (size > 16 * 1024 * 1024) { child.kill("SIGTERM"); reject(new Error("응답이 너무 큽니다. 조회 범위를 줄이세요.")); }
        else chunks.push(data);
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("error", () => { clearTimeout(timer); reject(new Error("로컬 에셋 워커를 실행하지 못했습니다. 실행 파일 경로를 확인하세요.")); });
      child.on("close", () => {
        clearTimeout(timer);
        try {
          const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok: boolean; result?: T; error?: string };
          if (!envelope.ok) reject(new Error(envelope.error ?? "에셋 작업이 실패했습니다."));
          else resolve(envelope.result as T);
        } catch { reject(new Error("에셋 워커 응답을 읽지 못했습니다. 현재 소스로 워커를 다시 빌드하세요.")); }
      });
      child.stdin.end(JSON.stringify({ action, input }));
    });
  } finally { inFlight--; }
}
