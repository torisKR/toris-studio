import type { ProviderId } from "../protocol.js";

export type ChatMessage = { role: "user" | "assistant"; content: string };
export type CompleteInput = {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
};
export interface ChatModel {
  readonly provider: ProviderId;
  readonly model: string;
  complete(input: CompleteInput): Promise<string>;
}

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  kind: "api" | "subscription" | "local";
  /** Subscription the CLI signs in with, shown to the user. */
  plan?: string;
  available: boolean;
  detail: string;
  suggestedModels: string[];
  supportsImages?: boolean;
};

/** One selectable model. id goes to the provider; label/detail are only shown. */
export type ModelOption = { id: string; label: string; detail?: string };
/** Result of models.check: is the provider usable now, and which models does the account offer. */
export type ProviderCheck = {
  provider: ProviderId;
  state: "connected" | "signed-out" | "missing" | "needs-key" | "offline" | "error";
  detail: string;
  account?: string;
  models: ModelOption[];
  /** "account": listed live by the CLI or API for this login/key. "suggested": built-in fallback. */
  source: "account" | "suggested";
  checkedAt: string;
};

export const PROVIDER_LABELS: Record<ProviderId, { label: string; kind: ProviderInfo["kind"]; plan?: string; suggested: string[] }> = {
  anthropic: { label: "Anthropic API", kind: "api", suggested: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"] },
  openai: { label: "OpenAI API", kind: "api", suggested: ["gpt-5", "gpt-5-mini", "gpt-4.1"] },
  google: { label: "Google Gemini API", kind: "api", suggested: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  openrouter: { label: "OpenRouter", kind: "api", suggested: ["anthropic/claude-sonnet-4.5", "openai/gpt-5", "google/gemini-2.5-pro"] },
  ollama: { label: "Ollama (로컬)", kind: "local", suggested: ["qwen2.5-coder:7b", "llama3.1:8b"] },
  "claude-cli": { label: "Claude Code", kind: "subscription", plan: "Claude Pro·Max 구독", suggested: ["sonnet", "opus", "haiku", "fable"] },
  "codex-cli": { label: "Codex CLI", kind: "subscription", plan: "ChatGPT Plus·Pro 구독", suggested: ["gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna"] },
  "gemini-cli": { label: "Gemini CLI", kind: "subscription", plan: "Google 계정·Gemini 구독", suggested: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  "cursor-cli": { label: "Cursor CLI", kind: "subscription", plan: "Cursor 구독", suggested: ["auto"] },
  "kiro-cli": { label: "Kiro CLI", kind: "subscription", plan: "Kiro 구독", suggested: ["auto", "claude-sonnet-4.5"] },
};

/** Deterministic model used by tests; replays queued outputs. */
export class ScriptedModel implements ChatModel {
  readonly provider = "ollama" as const;
  readonly model = "scripted";
  readonly calls: CompleteInput[] = [];
  constructor(private outputs: Array<string | ((input: CompleteInput) => string)>) {}
  async complete(input: CompleteInput): Promise<string> {
    this.calls.push(input);
    const next = this.outputs.shift();
    if (next === undefined) throw new Error("ScriptedModel: no more outputs");
    return typeof next === "function" ? next(input) : next;
  }
}
