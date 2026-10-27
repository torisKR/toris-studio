import { Annotation } from "@langchain/langgraph";
import type { ChatMessage } from "../llm/types.js";

export type Worker = "frontend" | "backend";
/** One expert's share of the task. Lanes run at the same time. */
export type LanePlan = { role: Worker; share: string };

const replace = <T>(fallback: () => T) => Annotation<T>({ reducer: (_current, next) => next, default: fallback });
/** Each lane writes only its own key, so merging keeps every lane's value. */
const byRole = <T>() => Annotation<Partial<Record<Worker, T>>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) });

export const AgentState = Annotation.Root({
  task: replace(() => ""),
  plan: replace(() => ""),
  /** Task, plan, project brief and vector-search context every lane starts from. */
  brief: replace(() => ""),
  lanes: replace<LanePlan[]>(() => []),
  /** Lanes that work in the next experts round: all of them first, then only those QA sends back. */
  rework: replace<Worker[]>(() => []),
  /** Independent verification commands; QA runs them at the same time. */
  testCommands: replace<string[][]>(() => []),
  /** QA asked the model for commands once; later rounds reuse the answer. */
  testPlanned: replace(() => false),
  /** Each lane's transcript; the lane owns trimming. */
  transcripts: byRole<ChatMessage[]>(),
  steps: byRole<number>(),
  summaries: byRole<string>(),
  changes: Annotation<string[]>({ reducer: (a, b) => [...new Set([...a, ...b])], default: () => [] }),
  diffs: Annotation<Record<string, string>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  iterations: replace(() => 0),
  verdict: replace<"pass" | "fail" | null>(() => null),
  /** QA's note (with the verification log) for the lanes it sends back. */
  feedback: replace(() => ""),
  summary: replace(() => ""),
  failed: replace(() => ""),
});

export type State = typeof AgentState.State;
export type Update = typeof AgentState.Update;
