// Test harness for workflows: scripted models per agent role and a run driver.
// Lives in src so evals and tests share one implementation; nothing here talks to a real model.
import type { ChatModel, CompleteInput } from "../llm/types.js";

export type ScriptOutput = string | ((input: CompleteInput) => string);
export type RoleScript = Record<string, ScriptOutput[]>;
/** Maps a system prompt to a role name. Order matters: the first match wins. */
export type RoleMatcher = Array<[role: string, includes: string]>;

export const CODING_ROLES: RoleMatcher = [
  ["supervisor", "Supervisor 에이전트"],
  ["frontend", "Frontend Expert 에이전트"],
  ["backend", "Backend Expert 에이전트"],
  ["qaPlan", "검증할 명령을 고른다"],
  ["qaReview", "QA/Reviewer"],
  ["content", "주간 콘텐츠 기획자"],
  ["triage", "운영 점검 담당자"],
];

/** Replays outputs per role, because parallel lanes call the model in no fixed order. */
export class RoleModel implements ChatModel {
  readonly provider = "ollama" as const;
  readonly model = "scripted";
  readonly calls: Array<{ role: string; input: CompleteInput }> = [];
  constructor(private script: RoleScript, private roles: RoleMatcher = CODING_ROLES) {}
  async complete(input: CompleteInput): Promise<string> {
    const role = this.roles.find(([, needle]) => input.system.includes(needle))?.[0] ?? "unknown";
    this.calls.push({ role, input });
    const next = this.script[role]?.shift();
    if (next === undefined) throw new Error(`RoleModel: no more ${role} outputs`);
    return typeof next === "function" ? next(input) : next;
  }
  count(role: string): number { return this.calls.filter(call => call.role === role).length; }
  /** Outputs scripted but never used; a non-empty list means the scenario drifted. */
  leftovers(): string[] { return Object.entries(this.script).filter(([, list]) => list.length).map(([role, list]) => `${role}×${list.length}`); }
}
