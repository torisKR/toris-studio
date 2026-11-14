import { nativeInvoke, type BridgeInvoke } from "../ai-client";
import { isFactoryRun, type PendingAction, type RunSummary } from "../agent-client";

export type FactoryGateName = "plan" | "code" | "asset" | "model3d" | "gameplay" | "android" | "release";
export type FactoryGateStatus = "passed" | "failed" | "blocked" | "not_run";
export type FactoryGate = { name: FactoryGateName; status: FactoryGateStatus; detail: string; required: boolean };
export type FactoryJobView = { taskId: string; status: string; message: string; approval: "automatic" | "explicit" };
export type FactorySpecView = {
  title: string;
  slug: string;
  kind: "game" | "app";
  target: { engine: string; view: string };
  design: { genre: string; artStyle: string; orientation: string };
  features: string[];
  assets: { characters: number; maps: number; vfx: number; models: number };
  acceptance: string[];
  limits: { maxApiCostUsd: number };
};
export type FactoryReport = {
  template: boolean;
  provider: string;
  model: string;
  spec: FactorySpecView | null;
  project: string;
  jobs: FactoryJobView[];
  gates: FactoryGate[];
  verdict: "pass" | "incomplete" | "fail";
  costUsd: number;
  problems: string[];
  notes: string[];
};

export type FactoryRequest = { brief?: string; kind?: "game" | "app"; view?: "2d" | "3d" | "ui"; orientation?: "landscape" | "portrait"; resumeProject?: string };

const GATE_NAMES: FactoryGateName[] = ["plan", "code", "asset", "model3d", "gameplay", "android", "release"];
const GATE_STATUS: FactoryGateStatus[] = ["passed", "failed", "blocked", "not_run"];

export function verdictLabel(verdict: FactoryReport["verdict"]): string {
  switch (verdict) {
    case "pass": return "필수 검사 통과";
    case "fail": return "실행한 검사 실패";
    case "incomplete": return "아직 끝나지 않은 검사";
    default: {
      const neverVerdict: never = verdict;
      return neverVerdict;
    }
  }
}

export function gateLabel(name: FactoryGateName): string {
  switch (name) {
    case "plan": return "계획";
    case "code": return "코드";
    case "asset": return "에셋";
    case "model3d": return "3D";
    case "gameplay": return "플레이";
    case "android": return "Android";
    case "release": return "배포";
    default: {
      const neverName: never = name;
      return neverName;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Reads a factory summary. A malformed payload stays unparsed instead of looking successful. */
export function parseFactoryReport(summary: string): FactoryReport | null {
  try {
    const raw = JSON.parse(summary) as unknown;
    if (!isRecord(raw) || (raw.verdict !== "pass" && raw.verdict !== "incomplete" && raw.verdict !== "fail")) return null;
    if (!Array.isArray(raw.gates) || !Array.isArray(raw.jobs)) return null;
    const gates: FactoryGate[] = [];
    for (const gate of raw.gates) {
      if (!isRecord(gate) || typeof gate.name !== "string" || typeof gate.status !== "string" || typeof gate.detail !== "string") return null;
      if (!GATE_NAMES.includes(gate.name as FactoryGateName) || !GATE_STATUS.includes(gate.status as FactoryGateStatus)) return null;
      gates.push({ name: gate.name as FactoryGateName, status: gate.status as FactoryGateStatus, detail: gate.detail, required: gate.required === true });
    }
    return {
      template: raw.template !== false,
      provider: typeof raw.provider === "string" ? raw.provider : "",
      model: typeof raw.model === "string" ? raw.model : "",
      spec: isRecord(raw.spec) ? raw.spec as FactorySpecView : null,
      project: typeof raw.project === "string" ? raw.project : "",
      jobs: raw.jobs.filter(isRecord).map(job => ({ taskId: String(job.taskId ?? ""), status: String(job.status ?? ""), message: String(job.message ?? ""), approval: job.approval === "explicit" ? "explicit" : "automatic" })),
      gates,
      verdict: raw.verdict,
      costUsd: typeof raw.costUsd === "number" ? raw.costUsd : 0,
      problems: Array.isArray(raw.problems) ? raw.problems.filter((item): item is string => typeof item === "string") : [],
      notes: Array.isArray(raw.notes) ? raw.notes.filter((item): item is string => typeof item === "string") : [],
    };
  } catch { return null; }
}

export function factoryPreview(input: FactoryRequest, call: BridgeInvoke = nativeInvoke): Promise<FactoryReport> {
  return call("factory_preview", { input }) as Promise<FactoryReport>;
}
export function factoryStart(input: FactoryRequest, call: BridgeInvoke = nativeInvoke): Promise<RunSummary> {
  return call("factory_start", { input }) as Promise<RunSummary>;
}
export function factoryStatus(runId: string, call: BridgeInvoke = nativeInvoke): Promise<RunSummary> {
  return call("factory_status", { runId }) as Promise<RunSummary>;
}
export function factoryDecide(runId: string, action: PendingAction, decision: "approve" | "reject", feedback: string, call: BridgeInvoke = nativeInvoke): Promise<RunSummary> {
  return call("factory_decide", { runId, actionId: action.id, decision, feedback }) as Promise<RunSummary>;
}
export function factoryCancel(runId: string, call: BridgeInvoke = nativeInvoke): Promise<RunSummary> {
  return call("factory_cancel", { runId }) as Promise<RunSummary>;
}
export function factoryJobs(call: BridgeInvoke = nativeInvoke): Promise<{ jobs: FactoryJobView[] }> {
  return call("factory_jobs") as Promise<{ jobs: FactoryJobView[] }>;
}
/** Desktop-only list: the mobile protocol does not expose the runtime's run list. */
export async function factoryRuns(call: BridgeInvoke = nativeInvoke): Promise<RunSummary[]> {
  const result = await call("agent_call", { method: "run.list", params: {} }) as { runs: RunSummary[] };
  return result.runs.filter(isFactoryRun);
}
