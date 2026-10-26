import { Annotation } from "@langchain/langgraph";
import type { ChatMessage } from "../llm/types.js";
import type { PendingAction } from "../protocol.js";

const replace = <T>(fallback: () => T) => Annotation<T>({ reducer: (_current, next) => next, default: fallback });

export const AgentState = Annotation.Root({
  runId: replace(() => ""),
  project: replace(() => ""),
  task: replace(() => ""),
  route: replace<"frontend" | "backend">(() => "frontend"),
  plan: replace(() => ""),
  testCommand: replace<string[] | null>(() => null),
  /** Worker transcript; the graph owns trimming. */
  messages: replace<ChatMessage[]>(() => []),
  pending: replace<PendingAction | null>(() => null),
  returnTo: replace<"worker" | "qa_review">(() => "worker"),
  changes: Annotation<string[]>({ reducer: (a, b) => [...new Set([...a, ...b])], default: () => [] }),
  diffs: Annotation<Record<string, string>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  workerDone: replace(() => false),
  workerSummary: replace(() => ""),
  steps: replace(() => 0),
  iterations: replace(() => 0),
  testLog: replace(() => ""),
  verdict: replace<"pass" | "fail" | null>(() => null),
  feedback: replace(() => ""),
  summary: replace(() => ""),
  failed: replace(() => ""),
});

export type State = typeof AgentState.State;
export type Update = typeof AgentState.Update;
