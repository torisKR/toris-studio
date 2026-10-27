import { invoke } from "@tauri-apps/api/core";

/** Injected in tests; production calls the Tauri bridge. */
export type BridgeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export const nativeInvoke: BridgeInvoke = (command, args) => invoke(command, args);

export type ModelChoice = { provider: string; model: string };
export type ProviderInfo = { id: string; label: string; kind: "api" | "subscription" | "local"; plan?: string; available: boolean; detail: string; suggestedModels: string[]; supportsImages?: boolean };
export type AiStatus = { providers: ProviderInfo[]; contentModel: ModelChoice | null; agentModel: ModelChoice | null; image: ModelChoice | null };
export type AiText = { text: string; provider: string; model: string };

export async function aiStatus(call: BridgeInvoke = nativeInvoke): Promise<AiStatus> {
  return await call("ai_status") as AiStatus;
}

/** The model chosen under Agent → 모델 설정 → 콘텐츠 작성 answers; nothing is published. */
export async function generateText(prompt: string, system?: string, call: BridgeInvoke = nativeInvoke): Promise<AiText> {
  if (!prompt.trim()) throw new Error("AI에 요청할 내용을 입력하세요.");
  return await call("ai_generate", { input: { prompt, ...(system ? { system } : {}) } }) as AiText;
}

export async function generateImage(jobId: string, prompt: string, size = "1024x1024", call: BridgeInvoke = nativeInvoke): Promise<{ saved: unknown; provider: string; model: string }> {
  return await call("ai_generate_image", { input: { jobId, prompt, size } }) as { saved: unknown; provider: string; model: string };
}

/** First balanced JSON object in model text (models often wrap JSON in prose or fences). */
export function extractJson<T = Record<string, unknown>>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  for (const candidate of [fenced, text].filter((v): v is string => typeof v === "string")) {
    const start = candidate.indexOf("{");
    if (start < 0) continue;
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inString) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === "\"") inString = false; continue; }
      if (ch === "\"") inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { return JSON.parse(candidate.slice(start, i + 1)) as T; } catch { break; }
      }
    }
  }
  throw new Error("AI 응답에서 JSON을 찾지 못했습니다. 다시 요청하거나 응답을 직접 확인하세요.");
}

export function modelLabel(status: AiStatus | null, choice: ModelChoice | null | undefined): string {
  if (!choice) return "모델 미선택";
  const provider = status?.providers.find(p => p.id === choice.provider);
  return `${provider?.label ?? choice.provider}${choice.model ? ` · ${choice.model}` : ""}`;
}

export function contentReady(status: AiStatus | null): boolean {
  const choice = status?.contentModel ?? status?.agentModel;
  return Boolean(choice && status?.providers.find(p => p.id === choice.provider)?.available);
}
