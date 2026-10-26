// JSONL protocol between the Rust host (stdin/stdout) and this agent runtime.
// Rust is the only peer: it owns process lifetime, secrets and the UI bridge.

export type ApiProviderId = "anthropic" | "openai" | "google" | "openrouter" | "ollama";
export type CliProviderId = "claude-cli" | "codex-cli" | "gemini-cli" | "cursor-cli" | "kiro-cli";
export type ProviderId = ApiProviderId | CliProviderId;
export type EmbeddingProviderId = "local" | "openai" | "google" | "ollama";
export type ImageProviderId = "openai" | "google";

export type ModelChoice = { provider: ProviderId; model: string };

export type RuntimeSettings = {
  projectsRoot: string;
  chromaUrl: string;
  /** Extra directories searched for subscription CLIs (GUI apps do not inherit shell PATH). */
  searchPath: string[];
  keys: Partial<Record<"anthropic" | "openai" | "google" | "openrouter", string>>;
  ollamaUrl: string;
  agentModel: ModelChoice | null;
  contentModel: ModelChoice | null;
  image: { provider: ImageProviderId; model: string } | null;
  embedding: { provider: EmbeddingProviderId; model: string };
};

export type Request = { id: string; method: string; params?: unknown };
export type Response = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

export type AgentRole = "supervisor" | "frontend" | "backend" | "qa";
export type Phase =
  | "queued"
  | "thinking"
  | "reading"
  | "coding"
  | "testing"
  | "reviewing"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "cancelled";

export type PendingAction =
  | { kind: "write_file"; id: string; agent: AgentRole; path: string; diff: string; content: string; baseHash: string | null; reason: string }
  | { kind: "run_command"; id: string; agent: AgentRole; command: string[]; cwd: string; reason: string };

export type ApprovalDecision = { actionId: string; decision: "approve" | "reject"; feedback?: string };

export type RunEvent = {
  event: "run";
  runId: string;
  seq: number;
  at: string;
  agent: AgentRole;
  phase: Phase;
  message: string;
  detail?: string;
  approval?: PendingAction;
  changes?: string[];
};

export type LogEvent = { event: "log"; level: "info" | "warn" | "error"; message: string };
export type IndexEvent = { event: "index"; project: string; phase: "scanning" | "embedding" | "done" | "failed"; done: number; total: number; message: string };
export type ReadyEvent = { event: "ready"; version: string };
export type OutboundEvent = RunEvent | LogEvent | IndexEvent | ReadyEvent;
