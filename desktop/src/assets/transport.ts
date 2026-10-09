import { invoke } from "@tauri-apps/api/core";
export function assetApi<T>(action: string, input: object = {}): Promise<T> {
  return invoke<T>("asset_command", { action, input });
}
export function assetError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "요청을 처리하지 못했습니다. 데스크톱 앱에서 다시 시도하세요.";
}
