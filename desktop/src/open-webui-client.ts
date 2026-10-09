import { invoke } from "@tauri-apps/api/core";
import type { BridgeInvoke } from "./codexify-client";

export type OpenWebUIStatus = {
  status: "stopped" | "pulling" | "starting" | "ready" | "error";
  message: string;
  checkedAt: string;
  version: string;
  url: string;
  dockerAvailable: boolean;
  containerRunning: boolean;
  setupRequired: boolean | null;
  providerUrl: string | null;
  mcpUrl: string | null;
  providerReachable: boolean | null;
  mcpReachable: boolean | null;
  canOpen: boolean;
};
const nativeInvoke: BridgeInvoke = (command, args) => invoke(command, args);
export const openWebUILabels: Record<OpenWebUIStatus["status"], string> = {
  stopped: "로컬 채팅 서버가 꺼져 있습니다",
  pulling: "Open WebUI 이미지를 다운로드하고 있습니다",
  starting: "로컬 채팅 서버를 시작하고 있습니다",
  ready: "Open WebUI를 열 수 있습니다",
  error: "로컬 채팅 서버 확인이 필요합니다",
};

export async function getOpenWebUIStatus(call: BridgeInvoke = nativeInvoke): Promise<OpenWebUIStatus> {
  return await call("open_webui_status") as OpenWebUIStatus;
}
export async function controlOpenWebUI(action: "start" | "stop", call: BridgeInvoke = nativeInvoke): Promise<OpenWebUIStatus> {
  return await call(`open_webui_${action}`) as OpenWebUIStatus;
}
export async function openWebUI(status: OpenWebUIStatus | null, call: BridgeInvoke = nativeInvoke): Promise<void> {
  if (!status?.canOpen || status.status !== "ready") throw new Error("Open WebUI 서버가 준비되면 열 수 있습니다. 상태를 다시 확인하세요.");
  await call("open_webui_open");
}

export async function copyOpenWebUIBootstrap(call: BridgeInvoke = nativeInvoke): Promise<void> {
  const text = await call("open_webui_bootstrap");
  if (typeof text !== "string" || !text.trim()) throw new Error("코딩 연결 안내를 확인하지 못했습니다.");
  await call("copy_text", { text });
}
