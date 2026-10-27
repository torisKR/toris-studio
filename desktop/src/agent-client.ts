import { nativeInvoke, type BridgeInvoke, type ModelChoice, type ProviderInfo } from "./ai-client";

export type AgentRole = "supervisor" | "frontend" | "backend" | "qa";
export type Phase = "queued" | "thinking" | "reading" | "coding" | "testing" | "reviewing" | "awaiting_approval" | "done" | "failed" | "cancelled";
export type PendingAction =
  | { kind: "write_file"; id: string; agent: AgentRole; path: string; diff: string; reason: string }
  | { kind: "run_command"; id: string; agent: AgentRole; command: string[]; cwd: string; reason: string };
export type RunEvent = { event: "run"; runId: string; seq: number; at: string; agent: AgentRole; phase: Phase; message: string; detail?: string; approval?: PendingAction; changes?: string[] };
export type IndexEvent = { event: "index"; project: string; phase: "scanning" | "embedding" | "done" | "failed"; done: number; total: number; message: string };
export type RunSummary = { runId: string; project: string; task: string; phase: Phase; agent: AgentRole; createdAt: string; updatedAt: string; pending: PendingAction | null; changes: string[]; summary: string; events: RunEvent[] };
export type ProjectInfo = { name: string; path: string; stacks: string[]; scripts: Record<string, string>; git: boolean };
export type IndexStatus = { indexed: boolean; chunks: number; stale: boolean; embedder: string; chroma: boolean };
export type AgentSettings = { projectsRoot: string; ollamaUrl: string; agentModel: ModelChoice | null; contentModel: ModelChoice | null; image: ModelChoice | null; embedding: ModelChoice };
export type SettingsView = { settings: AgentSettings; keys: Record<string, boolean>; chromaUrl: string };
export type RuntimeStatus = { version: string; providers: ProviderInfo[]; chroma: boolean; projectsRoot: string };

export const KEY_PROVIDERS = [
  { id: "anthropic", label: "Anthropic", placeholder: "sk-ant-…" },
  { id: "openai", label: "OpenAI", placeholder: "sk-…" },
  { id: "google", label: "Google Gemini", placeholder: "AIza…" },
  { id: "openrouter", label: "OpenRouter", placeholder: "sk-or-…" },
] as const;

export const AGENTS: Array<{ id: AgentRole; name: string; role: string }> = [
  { id: "supervisor", name: "Supervisor", role: "작업 분석·배정" },
  { id: "frontend", name: "Frontend Expert", role: "UI·React 코드" },
  { id: "backend", name: "Backend Expert", role: "서버·DB·Rust 코드" },
  { id: "qa", name: "QA Reviewer", role: "빌드·테스트 검증" },
];

export const PHASE_LABELS: Record<Phase, string> = {
  queued: "대기", thinking: "생각 중", reading: "파일 읽는 중", coding: "코드 작성", testing: "테스트 실행",
  reviewing: "검토 중", awaiting_approval: "승인 대기", done: "완료", failed: "확인 필요", cancelled: "취소됨",
};

export function agentCall<T>(method: string, params: Record<string, unknown> = {}, call: BridgeInvoke = nativeInvoke): Promise<T> {
  return call("agent_call", { method, params }) as Promise<T>;
}
export function getSettings(call: BridgeInvoke = nativeInvoke): Promise<SettingsView> {
  return call("agent_settings_get") as Promise<SettingsView>;
}
/** keys: provider -> new key, "" removes it; providers left out keep their saved key. */
export function saveSettings(settings: AgentSettings, keys: Record<string, string>, call: BridgeInvoke = nativeInvoke): Promise<SettingsView> {
  return call("agent_settings_save", { input: { settings, keys } }) as Promise<SettingsView>;
}

/** Events are applied in seq order; a duplicate or stale event never rewinds the view. */
export function applyEvent(run: RunSummary | undefined, event: RunEvent): RunSummary | undefined {
  if (!run || run.runId !== event.runId) return run;
  const last = run.events.at(-1)?.seq ?? 0;
  if (event.seq <= last) return run;
  const terminal = event.phase === "done" || event.phase === "failed" || event.phase === "cancelled";
  return {
    ...run,
    phase: event.phase,
    agent: event.agent,
    updatedAt: event.at,
    pending: event.approval ?? (event.phase === "awaiting_approval" ? run.pending : null),
    changes: event.changes ?? run.changes,
    summary: terminal ? event.detail ?? run.summary : run.summary,
    events: [...run.events, event].slice(-400),
  };
}

export const EARLY_EVENTS_PER_RUN = 200;
export const EARLY_RUNS = 20;

/**
 * Hold events that arrive before `run.start` returns. Runs the tab never learns
 * about (another window, a pruned run) must not grow the buffer forever.
 */
export function bufferEarlyEvent(buffer: Map<string, RunEvent[]>, event: RunEvent): void {
  const events = [...(buffer.get(event.runId) ?? []), event].slice(-EARLY_EVENTS_PER_RUN);
  buffer.delete(event.runId);
  buffer.set(event.runId, events);
  while (buffer.size > EARLY_RUNS) buffer.delete(buffer.keys().next().value!);
}

/** Split a unified diff into typed lines for display. */
export function diffLines(diff: string): Array<{ kind: "add" | "del" | "hunk" | "meta" | "ctx"; text: string }> {
  return diff.split("\n").filter(line => !line.startsWith("====")).map(text => ({
    kind: text.startsWith("+++") || text.startsWith("---") || text.startsWith("Index:") ? "meta" : text.startsWith("@@") ? "hunk" : text.startsWith("+") ? "add" : text.startsWith("-") ? "del" : "ctx",
    text,
  }));
}
