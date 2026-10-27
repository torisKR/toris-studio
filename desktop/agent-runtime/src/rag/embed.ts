import type { RuntimeSettings } from "../protocol.js";
import { UserError } from "../util.js";
import { localUrl, postJson } from "../llm/http.js";

export interface Embedder {
  /** Stable id stored on the collection; a different id forces a rebuild. */
  readonly id: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

const LOCAL_DIMS = 768;

/** Split identifiers so `getUserById` and `get_user_by_id` share tokens. */
export function codeTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/)
    .filter(token => token.length > 1 && token.length < 40);
}

function hash(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) { h ^= token.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Key-free fallback: signed feature hashing over identifier tokens and bigrams.
 * It finds code by shared names, not by meaning; a provider embedder is better.
 */
export class LocalHashEmbedder implements Embedder {
  readonly id = `local-hash-v1-${LOCAL_DIMS}`;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => {
      const vector = new Array<number>(LOCAL_DIMS).fill(0);
      const tokens = codeTokens(text);
      const add = (feature: string, weight: number) => {
        const h = hash(feature);
        vector[h % LOCAL_DIMS] += (h & 0x80000000 ? -1 : 1) * weight;
      };
      tokens.forEach((token, i) => { add(token, 1); if (i > 0) add(`${tokens[i - 1]}_${token}`, 0.5); });
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
      return vector.map(v => v / norm);
    });
  }
}

class OpenAiEmbedder implements Embedder {
  readonly id: string;
  constructor(private model: string, private key: string) { this.id = `openai:${model}`; }
  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const value = await postJson({ url: "https://api.openai.com/v1/embeddings", headers: { authorization: `Bearer ${this.key}` } }, { model: this.model, input: texts }, [this.key], signal);
    return ((value.data as Array<{ embedding: number[]; index: number }>) ?? []).sort((a, b) => a.index - b.index).map(d => d.embedding);
  }
}

class GoogleEmbedder implements Embedder {
  readonly id: string;
  constructor(private model: string, private key: string) { this.id = `google:${model}`; }
  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const name = `models/${this.model}`;
    const value = await postJson(
      { url: `https://generativelanguage.googleapis.com/v1beta/${name}:batchEmbedContents`, headers: { "x-goog-api-key": this.key } },
      { requests: texts.map(text => ({ model: name, content: { parts: [{ text }] } })) },
      [this.key], signal,
    );
    return ((value.embeddings as Array<{ values: number[] }>) ?? []).map(e => e.values);
  }
}

class OllamaEmbedder implements Embedder {
  readonly id: string;
  constructor(private model: string, private base: string) { this.id = `ollama:${model}`; }
  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const value = await postJson({ url: `${this.base}/api/embed`, headers: {} }, { model: this.model, input: texts }, [], signal);
    return (value.embeddings as number[][]) ?? [];
  }
}

export function createEmbedder(settings: RuntimeSettings): Embedder {
  const { provider, model } = settings.embedding;
  switch (provider) {
    case "local": return new LocalHashEmbedder();
    case "openai":
      if (!settings.keys.openai) throw new UserError("OpenAI 임베딩에는 OpenAI API 키가 필요합니다.");
      return new OpenAiEmbedder(model || "text-embedding-3-small", settings.keys.openai);
    case "google":
      if (!settings.keys.google) throw new UserError("Gemini 임베딩에는 Google API 키가 필요합니다.");
      return new GoogleEmbedder(model || "text-embedding-004", settings.keys.google);
    case "ollama": return new OllamaEmbedder(model || "nomic-embed-text", localUrl(settings.ollamaUrl));
  }
}
