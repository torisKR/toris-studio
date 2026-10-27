import type { ApiProviderId } from "../protocol.js";
import { redact, UserError, withTimeout } from "../util.js";
import type { ChatModel, CompleteInput } from "./types.js";

const REQUEST_TIMEOUT_MS = 180_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOKENS = 8_192;

type Endpoint = { url: string; headers: Record<string, string> };

export async function postJson(endpoint: Endpoint, body: unknown, secrets: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
  return requestJson(endpoint, { method: "POST", body: JSON.stringify(body) }, secrets, signal);
}

export async function requestJson(endpoint: Endpoint, init: { method: string; body?: string }, secrets: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
  const { response, raw } = await withTimeout(REQUEST_TIMEOUT_MS, signal, async combined => {
    let response: globalThis.Response;
    try {
      response = await fetch(endpoint.url, {
        ...init,
        headers: { "content-type": "application/json", ...endpoint.headers },
        redirect: "error",
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new UserError(`모델 서버에 연결하지 못했습니다: ${new URL(endpoint.url).host}`);
    }
    return { response, raw: await response.text() };
  });
  if (raw.length > MAX_RESPONSE_BYTES) throw new UserError("모델 응답이 너무 큽니다.");
  let value: Record<string, unknown> = {};
  try { value = JSON.parse(raw); } catch { /* handled below */ }
  if (!response.ok) {
    const message = (value.error as { message?: string } | undefined)?.message ?? raw.slice(0, 300);
    const hint = response.status === 401 || response.status === 403 ? " API 키를 확인하세요." : response.status === 429 ? " 사용 한도를 확인하세요." : "";
    throw new UserError(`모델 요청 실패 (${response.status}).${hint} ${redact(String(message), secrets)}`.trim());
  }
  return value;
}

class AnthropicModel implements ChatModel {
  readonly provider = "anthropic" as const;
  constructor(readonly model: string, private key: string) {}
  async complete(input: CompleteInput): Promise<string> {
    const value = await postJson(
      { url: "https://api.anthropic.com/v1/messages", headers: { "x-api-key": this.key, "anthropic-version": "2023-06-01" } },
      { model: this.model, max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS, system: input.system, messages: input.messages },
      [this.key], input.signal,
    );
    const parts = Array.isArray(value.content) ? value.content as Array<{ type?: string; text?: string }> : [];
    return parts.filter(part => part.type === "text").map(part => part.text ?? "").join("");
  }
}

class OpenAiCompatibleModel implements ChatModel {
  constructor(readonly provider: "openai" | "openrouter" | "ollama", readonly model: string, private base: string, private key: string) {}
  async complete(input: CompleteInput): Promise<string> {
    const headers: Record<string, string> = this.key ? { authorization: `Bearer ${this.key}` } : {};
    if (this.provider === "openrouter") Object.assign(headers, { "x-title": "Toris Studio" });
    const tokenField = this.provider === "openai" ? "max_completion_tokens" : "max_tokens";
    const value = await postJson(
      { url: `${this.base}/chat/completions`, headers },
      { model: this.model, [tokenField]: input.maxTokens ?? DEFAULT_MAX_TOKENS, messages: [{ role: "system", content: input.system }, ...input.messages] },
      [this.key], input.signal,
    );
    const choice = (value.choices as Array<{ message?: { content?: string } }> | undefined)?.[0];
    return choice?.message?.content ?? "";
  }
}

class GoogleModel implements ChatModel {
  readonly provider = "google" as const;
  constructor(readonly model: string, private key: string) {}
  async complete(input: CompleteInput): Promise<string> {
    const value = await postJson(
      { url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, headers: { "x-goog-api-key": this.key } },
      {
        systemInstruction: { parts: [{ text: input.system }] },
        contents: input.messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS },
      },
      [this.key], input.signal,
    );
    const candidate = (value.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined)?.[0];
    return (candidate?.content?.parts ?? []).map(p => p.text ?? "").join("");
  }
}

export function localUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UserError("Ollama 주소를 확인하세요."); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new UserError("Ollama는 이 컴퓨터의 http://127.0.0.1 주소만 사용할 수 있습니다.");
  }
  return url.origin;
}

export function apiModel(provider: ApiProviderId, model: string, keys: Partial<Record<string, string>>, ollamaUrl: string): ChatModel {
  if (!model.trim()) throw new UserError("모델 이름을 선택하세요.");
  const key = keys[provider] ?? "";
  if (provider !== "ollama" && !key) throw new UserError("이 공급자의 API 키를 Agent 설정에 저장하세요.");
  switch (provider) {
    case "anthropic": return new AnthropicModel(model, key);
    case "openai": return new OpenAiCompatibleModel("openai", model, "https://api.openai.com/v1", key);
    case "openrouter": return new OpenAiCompatibleModel("openrouter", model, "https://openrouter.ai/api/v1", key);
    case "ollama": return new OpenAiCompatibleModel("ollama", model, `${localUrl(ollamaUrl)}/v1`, "");
    case "google": return new GoogleModel(model, key);
  }
}

/** Live model list for an API provider; never throws for UI convenience. */
export async function listApiModels(provider: ApiProviderId, keys: Partial<Record<string, string>>, ollamaUrl: string): Promise<string[]> {
  const key = keys[provider] ?? "";
  if (provider !== "ollama" && !key) return [];
  const secrets = [key];
  try {
    switch (provider) {
      case "anthropic": {
        const value = await requestJson({ url: "https://api.anthropic.com/v1/models?limit=100", headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }, { method: "GET" }, secrets);
        return ((value.data as Array<{ id: string }>) ?? []).map(m => m.id);
      }
      case "openai": {
        const value = await requestJson({ url: "https://api.openai.com/v1/models", headers: { authorization: `Bearer ${key}` } }, { method: "GET" }, secrets);
        return ((value.data as Array<{ id: string }>) ?? []).map(m => m.id).filter(id => /^(gpt|o\d|chatgpt|gpt-image)/.test(id)).sort();
      }
      case "openrouter": {
        const value = await requestJson({ url: "https://openrouter.ai/api/v1/models", headers: { authorization: `Bearer ${key}` } }, { method: "GET" }, secrets);
        return ((value.data as Array<{ id: string }>) ?? []).map(m => m.id).slice(0, 400);
      }
      case "google": {
        const value = await requestJson({ url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", headers: { "x-goog-api-key": key } }, { method: "GET" }, secrets);
        return ((value.models as Array<{ name: string; supportedGenerationMethods?: string[] }>) ?? [])
          .filter(m => m.supportedGenerationMethods?.includes("generateContent")).map(m => m.name.replace(/^models\//, ""));
      }
      case "ollama": {
        const value = await requestJson({ url: `${localUrl(ollamaUrl)}/api/tags`, headers: {} }, { method: "GET" }, []);
        return ((value.models as Array<{ name: string }>) ?? []).map(m => m.name);
      }
    }
  } catch {
    return [];
  }
}
