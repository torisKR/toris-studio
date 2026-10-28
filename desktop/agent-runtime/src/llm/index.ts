import type { ApiProviderId, CliProviderId, ModelChoice, ProviderId, RuntimeSettings } from "../protocol.js";
import { UserError } from "../util.js";
import { checkCli, cliModel, cliVersion, findBinary } from "./cli.js";
import { apiModel, listApiModels, localUrl } from "./http.js";
import { PROVIDER_LABELS, type ChatModel, type ModelOption, type ProviderCheck, type ProviderInfo } from "./types.js";

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

const options = (ids: string[]): ModelOption[] => ids.map(id => ({ id, label: id }));

/** Connection check for the settings picker: CLIs report their login, APIs list models with the saved key. */
export async function checkProvider(provider: ProviderId, settings: RuntimeSettings): Promise<ProviderCheck> {
  const suggested = options(PROVIDER_LABELS[provider].suggested);
  const checkedAt = new Date().toISOString();
  if (isCli(provider)) return { provider, checkedAt, ...(await checkCli(provider, settings.searchPath, suggested)) };
  if (provider !== "ollama" && !settings.keys[provider as keyof RuntimeSettings["keys"]]) {
    return { provider, checkedAt, state: "needs-key", detail: "아래 API 키 칸에 키를 넣고 저장하면 연결을 확인합니다.", models: suggested, source: "suggested" };
  }
  if (provider === "ollama" && !(await ollamaReachable(settings.ollamaUrl))) {
    return { provider, checkedAt, state: "offline", detail: settings.ollamaUrl + "에서 Ollama가 응답하지 않습니다. ollama serve로 켜세요.", models: suggested, source: "suggested" };
  }
  try {
    const live = await listApiModels(provider, settings.keys, settings.ollamaUrl, { strict: true });
    return live.length
      ? { provider, checkedAt, state: "connected", detail: provider === "ollama" ? "Ollama 실행 중 · 설치한 모델 " + live.length + "개" : "API 키 확인됨 · 모델 " + live.length + "개", models: options(live), source: "account" }
      : { provider, checkedAt, state: provider === "ollama" ? "offline" : "error", detail: provider === "ollama" ? "설치한 모델이 없습니다. ollama pull로 모델을 받으세요." : "모델 목록이 비어 있습니다.", models: suggested, source: "suggested" };
  } catch (error) {
    return { provider, checkedAt, state: "error", detail: error instanceof Error ? error.message : String(error), models: suggested, source: "suggested" };
  }
}
