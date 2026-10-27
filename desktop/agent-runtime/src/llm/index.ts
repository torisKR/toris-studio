import type { ApiProviderId, CliProviderId, ModelChoice, ProviderId, RuntimeSettings } from "../protocol.js";
import { UserError } from "../util.js";
import { cliModel, cliVersion, findBinary } from "./cli.js";
import { apiModel, listApiModels, localUrl } from "./http.js";
import { PROVIDER_LABELS, type ChatModel, type ProviderInfo } from "./types.js";

export const API_PROVIDERS: ApiProviderId[] = ["anthropic", "openai", "google", "openrouter", "ollama"];
export const CLI_PROVIDERS: CliProviderId[] = ["claude-cli", "codex-cli", "gemini-cli", "cursor-cli", "kiro-cli"];
export const ALL_PROVIDERS: ProviderId[] = [...API_PROVIDERS, ...CLI_PROVIDERS];

export function isProvider(value: unknown): value is ProviderId {
  return typeof value === "string" && (ALL_PROVIDERS as string[]).includes(value);
}
const isCli = (p: ProviderId): p is CliProviderId => (CLI_PROVIDERS as string[]).includes(p);

export function createModel(choice: ModelChoice | null, settings: RuntimeSettings): ChatModel {
  if (!choice) throw new UserError("Agent 탭의 모델 설정에서 사용할 모델을 선택하세요.");
  if (!isProvider(choice.provider)) throw new UserError("지원하지 않는 모델 공급자입니다.");
  return isCli(choice.provider)
    ? cliModel(choice.provider, choice.model, settings.searchPath)
    : apiModel(choice.provider, choice.model, settings.keys, settings.ollamaUrl);
}

async function ollamaReachable(raw: string): Promise<boolean> {
  try {
    const response = await fetch(`${localUrl(raw)}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch { return false; }
}

export async function providerStatus(settings: RuntimeSettings): Promise<ProviderInfo[]> {
  return Promise.all(ALL_PROVIDERS.map(async (id): Promise<ProviderInfo> => {
    const meta = PROVIDER_LABELS[id];
    const base = { id, label: meta.label, kind: meta.kind, plan: meta.plan, suggestedModels: meta.suggested, supportsImages: id === "openai" || id === "google" };
    if (isCli(id)) {
      const version = findBinary(id, settings.searchPath) ? await cliVersion(id, settings.searchPath) : null;
      return { ...base, available: Boolean(version), detail: version ? `${version} · 로그인은 첫 요청 때 확인합니다.` : "CLI가 설치되어 있지 않습니다." };
    }
    if (id === "ollama") {
      const up = await ollamaReachable(settings.ollamaUrl);
      return { ...base, available: up, detail: up ? `${settings.ollamaUrl}에서 실행 중` : "Ollama가 실행 중이 아닙니다." };
    }
    const saved = Boolean(settings.keys[id as keyof RuntimeSettings["keys"]]);
    return { ...base, available: saved, detail: saved ? "API 키 저장됨" : "API 키 미등록" };
  }));
}

export async function listModels(provider: ProviderId, settings: RuntimeSettings): Promise<string[]> {
  const suggested = PROVIDER_LABELS[provider].suggested;
  if (isCli(provider)) return suggested;
  const live = await listApiModels(provider, settings.keys, settings.ollamaUrl);
  return live.length ? live : suggested;
}
