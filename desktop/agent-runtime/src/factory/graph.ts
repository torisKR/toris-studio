// Game and app factory workflows. Sandbox scaffolding is automatic. Paid calls,
// device install, signing and store submission wait for an explicit approval.
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import type { RunContext } from "../graph/build.js";
import type { CompiledWorkflow } from "../harness/workflow.js";
import { envRunner } from "./adapters.js";
import { produceFactory, type FactoryReport } from "./pipeline.js";
import type { FactoryKind } from "./spec.js";

const replace = <T>(fallback: () => T) => Annotation<T>({ reducer: (_current, next) => next, default: fallback });
const FactoryState = Annotation.Root({
  task: replace(() => ""),
  summary: replace(() => ""),
});

export function factorySummary(report: FactoryReport): { phase: "done" | "failed"; message: string } {
  const lead = report.template ? "규칙으로 만든 명세입니다. AI가 쓴 명세가 아닙니다. " : "모델 명세가 검사를 통과했습니다. ";
  if (!report.spec) return { phase: "failed", message: lead + (report.problems.join(" ") || "명세를 만들지 못했습니다.") };
  if (report.verdict === "pass") return { phase: "done", message: lead + "필수 검증을 통과했습니다." };
  if (report.verdict === "fail") return { phase: "done", message: lead + "실행한 검사 중 실패한 항목이 있습니다. 실행하지 않은 검사는 통과가 아닙니다." };
  return { phase: "done", message: lead + "규칙 검증까지 진행했습니다. 실행하지 않은 검사는 통과가 아닙니다." };
}

export function buildFactory(ctx: RunContext, kind: FactoryKind): CompiledWorkflow {
  const run = async () => {
    const produced = await produceFactory({
      kind,
      input: ctx.input,
      projectsRoot: ctx.projectsRoot,
      model: ctx.model.model === "none" ? null : ctx.model,
      runner: envRunner(),
      signal: ctx.signal,
      emit: message => ctx.emit(kind === "app" ? "frontend" : "backend", "coding", message),
      approve: async job => {
        const gate = job.taskId === "release-review" ? "release" : job.paid ? "paid_api" : "device";
        const decision = await ctx.approve({
          kind: "factory_gate",
          id: randomUUID(),
          agent: "supervisor",
          gate,
          title: job.taskId,
          preview: job.message,
          reason: job.message,
        }, job.message || job.taskId);
        return decision.decision === "approve" ? "approve" : "reject";
      },
    });
    const summary = JSON.stringify(produced);
    const closing = factorySummary(produced);
    ctx.emit("qa", closing.phase, closing.message, { detail: summary });
    return { summary };
  };
  return new StateGraph(FactoryState)
    .addNode("run", run)
    .addEdge(START, "run")
    .addEdge("run", END)
    .compile() as unknown as CompiledWorkflow;
}
