import { invoke } from "@tauri-apps/api/core";
import type { BridgeInvoke } from "./codexify-client";

export type CodexifyRuntimeStatus = {
  binaryAvailable: boolean;
  bundled: boolean;
  version: string | null;
  configPath: string;
  sourceRoot: string;
  port: number;
  running: boolean;
  managed: boolean;
  pid: number | null;
  service: { installed: boolean; running: boolean; enabled: boolean | null } | null;
  message: string;
};
export type CodexifyRuntimeDoctor = {
  checks: Array<{ id: string; status: "pass" | "failure" | "skipped"; label: string; message: string }>;
  failures: number;
  bridgeHealthy: boolean;
  message: string;
};
export type CodexifyRuntimeInput = { sourceRoot: string; port: number };
export type RuntimeAction = "configure" | "start" | "stop";
export type CodexifyProxyStatus = { available: boolean; running: boolean; managed: boolean; mcpUrl: string | null; message: string };
const nativeInvoke: BridgeInvoke = (command, args) => invoke(command, args);

/** Existing listeners belong to their original launcher. The app can only stop its own process. */
export function canStopRuntime(status: CodexifyRuntimeStatus | null): boolean {
  return Boolean(status?.managed);
}

export function runtimeConfiguration(sourceRoot: string, port: string): CodexifyRuntimeInput {
  const root = sourceRoot.trim();
  if (!root || !(root.startsWith("/") || root.startsWith("~/") || /^[a-zA-Z]:[\\/]/.test(root) || /^\\\\[^\\]+\\[^\\]+/.test(root))) {
    throw new Error("Source에 프로젝트 폴더의 절대 경로를 입력하세요. ~/projects도 사용할 수 있습니다.");
  }
  const value = port.trim();
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error("포트는 1부터 65535 사이의 정수로 입력하세요.");
  }
  return { sourceRoot: root, port: Number(value) };
}

export function runtimeStateLabel(status: CodexifyRuntimeStatus | null): string {
  if (!status) return "상태 확인 중";
  if (status.managed) return status.running ? "앱에서 실행 중" : "앱 실행 중 · 응답 확인 필요";
  if (status.running) return "기존 브리지 사용 중";
  return status.binaryAvailable ? "시작할 준비가 됐습니다" : "Codexify 실행 파일 확인 필요";
}

export function runtimeIdentity(status: CodexifyRuntimeStatus): string {
  return JSON.stringify([status.running, status.managed, status.sourceRoot, status.port, status.version, status.pid]);
}

export async function getRuntimeStatus(call: BridgeInvoke = nativeInvoke): Promise<CodexifyRuntimeStatus> {
  return await call("codexify_runtime_status") as CodexifyRuntimeStatus;
}

export async function applyRuntimeAction(
  action: RuntimeAction,
  status: CodexifyRuntimeStatus,
  input?: CodexifyRuntimeInput,
  call: BridgeInvoke = nativeInvoke,
): Promise<CodexifyRuntimeStatus> {
  if (action === "stop" && !canStopRuntime(status)) throw new Error("앱에서 시작한 Codexify만 종료할 수 있습니다.");
  if (action === "configure") {
    if (status.running || status.managed) throw new Error("실행 중에는 Source와 포트를 변경할 수 없습니다. 앱에서 시작한 브리지를 먼저 종료하세요.");
    if (!input) throw new Error("저장할 Source와 포트가 필요합니다.");
    return await call("codexify_runtime_configure", { input }) as CodexifyRuntimeStatus;
  }
  return await call(`codexify_runtime_${action}`) as CodexifyRuntimeStatus;
}

export async function runRuntimeDoctor(call: BridgeInvoke = nativeInvoke): Promise<CodexifyRuntimeDoctor> {
  return await call("codexify_runtime_doctor") as CodexifyRuntimeDoctor;
}

export async function getProxyStatus(call: BridgeInvoke = nativeInvoke): Promise<CodexifyProxyStatus> {
  return await call("codexify_proxy_status") as CodexifyProxyStatus;
}

export async function applyProxyAction(action: "start" | "stop", status: CodexifyProxyStatus | null, call: BridgeInvoke = nativeInvoke): Promise<CodexifyProxyStatus> {
  if (action === "stop" && !(status?.running && status.managed)) throw new Error("앱에서 시작한 프록시만 종료할 수 있습니다.");
  return await call(`codexify_proxy_${action}`) as CodexifyProxyStatus;
}

/** Copy only the public Quick Tunnel endpoint, never an owner-chat URL or credentials. */
export function publicMcpUrl(status: CodexifyProxyStatus): string {
  if (!status.running || !status.mcpUrl) throw new Error("공개 MCP 주소가 아직 준비되지 않았습니다.");
  const url = new URL(status.mcpUrl);
  if (url.protocol !== "https:" || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname) || url.port || url.username || url.password || url.pathname !== "/mcp" || url.search || url.hash) {
    throw new Error("공개 MCP 주소의 형식이 올바르지 않습니다. 프록시 상태를 다시 확인하세요.");
  }
  return url.href;
}

export async function copyPublicMcpUrl(status: CodexifyProxyStatus, call: BridgeInvoke = nativeInvoke): Promise<void> {
  await call("copy_text", { text: publicMcpUrl(status) });
}
