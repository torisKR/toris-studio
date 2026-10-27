// Workflow registry for the Agent tab. A workflow is a LangGraph graph built
// from shared nodes; the run manager drives any of them the same way.
import type { RunContext } from "../graph/build.js";

/** What a compiled workflow must accept and return. */
export interface CompiledWorkflow {
  invoke(input: { task: string }, options: { recursionLimit: number; signal: AbortSignal }): Promise<{ summary?: unknown }>;
}

export type WorkflowSpec = {
  id: string;
  label: string;
  description: string;
  /** Workflows that edit code need a project folder; others may run on a scratch folder. */
  needsProject: boolean;
  build(ctx: RunContext): CompiledWorkflow;
};

export type WorkflowInfo = Omit<WorkflowSpec, "build">;

const WORKFLOW_ID = /^[a-z][a-z0-9-]{1,40}$/;

export class WorkflowRegistry {
  private specs = new Map<string, WorkflowSpec>();

  define(spec: WorkflowSpec): WorkflowSpec {
    if (!WORKFLOW_ID.test(spec.id)) throw new Error(`잘못된 워크플로 ID: ${spec.id}`);
    if (this.specs.has(spec.id)) throw new Error(`이미 등록된 워크플로: ${spec.id}`);
    this.specs.set(spec.id, spec);
    return spec;
  }

  get(id: string): WorkflowSpec {
    const spec = this.specs.get(id);
    if (!spec) throw new UnknownWorkflow(id);
    return spec;
  }

  list(): WorkflowInfo[] {
    return [...this.specs.values()].map(({ build: _build, ...info }) => info);
  }
}

export class UnknownWorkflow extends Error {
  constructor(id: string) { super(`알 수 없는 워크플로입니다: ${id.slice(0, 60)}`); }
}
