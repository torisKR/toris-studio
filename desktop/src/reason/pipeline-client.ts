import { nativeInvoke, type BridgeInvoke } from "../ai-client";
import { singleTarget } from "./reason-client";
import type { ReasonPeer } from "./types";

/** Fixed orders. The host decides the request text, recipient and progress. */
export const STAGES = ["design", "planning", "development", "audio", "deploy"] as const;
/** A project pipeline: draft plan (Muse), final spec (OpenAI Dots), design, then the project's own implementation agent. */
export const PROJECT_STAGES = ["planning", "spec", "design", "development"] as const;
export type Stage = typeof STAGES[number] | typeof PROJECT_STAGES[number];
export type PipelineKind = "studio" | "project";
const ALL_STAGES: readonly Stage[] = [...STAGES, "spec"];
export const STAGE_LABELS: Record<Stage, string> = { design: "디자인", planning: "기획", spec: "기획 확정", development: "개발", audio: "음향", deploy: "배포" };
export const stagesFor = (kind: PipelineKind): readonly Stage[] => kind === "project" ? PROJECT_STAGES : STAGES;
export const stageLabel = (kind: PipelineKind, stage: Stage) => kind === "project" && stage === "planning" ? "기획 초안" : STAGE_LABELS[stage];
const STATUSES = ["pending", "sending", "waiting", "uncertain", "replied", "skipped"] as const;
export type StageStatus = typeof STATUSES[number];
export const STATUS_LABELS: Record<StageStatus, string> = {
  pending: "보내기 전", sending: "보내는 중", waiting: "답장 대기", uncertain: "전송 확인 필요", replied: "답장 받음", skipped: "건너뜀"
};
export type StageState = { stage: Stage; assignee: string | null; status: StageStatus; sentAt: string | null; reply: string | null };
export type NextSend = { stage: Stage; assignee: string; text: string; digest: string; resend: boolean };
export type ReplyCandidate = { id: string; from: string; fromName: string | null; text: string; createdAt: string | null };
export type ProjectInfo = { folder: string; name: string; branch: string | null; agentName: string; agentModel: string | null };
export type PipelineView = {
  id: string; brief: string; createdAt: string; cancelled: boolean; kind: PipelineKind; project: ProjectInfo | null;
  stages: StageState[]; current: Stage | null; next: NextSend | null; candidates: ReplyCandidate[];
};
export type PipelineAction =
  | { type: "assign"; stage: Stage; assignee: string }
  | { type: "skip" | "reset" | "assumeSent"; stage: Stage }
  | { type: "attach"; stage: Stage; messageId: string }
  | { type: "cancel" };

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => value && typeof value === "object" && !Array.isArray(value) ? value as Rec : {};
const str = (value: unknown) => typeof value === "string" ? value : "";
const nullable = (value: unknown) => typeof value === "string" && value ? value : null;
const isStage = (value: unknown): value is Stage => ALL_STAGES.includes(value as Stage);

function nextSend(value: unknown): NextSend | null {
  const r = rec(value);
  if (!isStage(r.stage) || !str(r.assignee) || !str(r.text) || !str(r.digest)) return null;
  return { stage: r.stage, assignee: str(r.assignee), text: str(r.text), digest: str(r.digest), resend: r.resend === true };
}

/** Display data only; an unknown stage or status drops the pipeline rather than guessing. */
export function normalizePipeline(value: unknown): PipelineView | null {
  const r = rec(value), p = rec(r.pipeline);
  const stages = Array.isArray(p.stages) ? p.stages.map(rec) : [];
  const kind: PipelineKind | null = p.kind === undefined || p.kind === "studio" ? "studio" : p.kind === "project" ? "project" : null;
  if (!kind) return null;
  const order = stagesFor(kind), info = rec(p.project);
  const project = kind === "project" && str(info.folder) && str(info.agentName)
    ? { folder: str(info.folder), name: str(info.name) || str(info.folder), branch: nullable(info.branch), agentName: str(info.agentName), agentModel: nullable(info.agentModel) }
    : null;
  if (!str(p.id) || !str(p.brief) || stages.length !== order.length || (kind === "project" && !project)) return null;
  const states: StageState[] = [];
  for (const [index, s] of stages.entries()) {
    if (s.stage !== order[index] || !STATUSES.includes(s.status as StageStatus)) return null;
    states.push({ stage: order[index], assignee: nullable(s.assignee), status: s.status as StageStatus, sentAt: nullable(s.sentAt), reply: nullable(s.reply) });
  }
  const candidates = (Array.isArray(r.candidates) ? r.candidates.map(rec) : []).filter(c => str(c.id) && str(c.from))
    .map(c => ({ id: str(c.id), from: str(c.from), fromName: nullable(c.fromName), text: str(c.text), createdAt: nullable(c.createdAt) }));
  return {
    id: str(p.id), brief: str(p.brief), createdAt: str(p.createdAt), cancelled: p.cancelled === true, kind, project, stages: states,
    current: isStage(r.current) ? r.current : null, next: nextSend(r.next), candidates
  };
}
function required(value: unknown): PipelineView {
  const view = normalizePipeline(value);
  if (!view) throw new Error("단계 파이프라인 상태를 읽지 못했습니다. 새로고침한 뒤 다시 확인하세요.");
  return view;
}
function onRoster(assignee: string, peers: ReasonPeer[]): string {
  const target = singleTarget(assignee);
  if (!peers.some(peer => peer.id === target)) throw new Error("현재 연결된 에이전트 목록에서 담당자를 고르세요.");
  return target;
}

export async function listPipelines(call: BridgeInvoke = nativeInvoke): Promise<PipelineView[]> {
  const value = await call("reason_pipeline_list");
  return (Array.isArray(value) ? value : []).map(normalizePipeline).filter((view): view is PipelineView => !!view);
}
/** `assignees` has one entry per stage; an empty string leaves that stage unassigned for now. */
export async function createPipeline(brief: string, assignees: string[], peers: ReasonPeer[], call: BridgeInvoke = nativeInvoke): Promise<PipelineView> {
  const text = brief.trim();
  if (!text) throw new Error("브리프를 입력하세요.");
  if (assignees.length !== STAGES.length) throw new Error("다섯 단계의 담당자 정보를 확인하세요.");
  const input = { brief: text, assignees: assignees.map(assignee => assignee ? onRoster(assignee, peers) : null) };
  return required(await call("reason_pipeline_create", { input }));
}
/**
 * A project pipeline bound to a running Studio-started implementation session. The host reads
 * that session's folder itself; the page names only the session ID.
 */
export async function createProjectPipeline(brief: string, assignees: string[], projectSessionId: string, peers: ReasonPeer[], call: BridgeInvoke = nativeInvoke): Promise<PipelineView> {
  const text = brief.trim();
  if (!text) throw new Error("브리프를 입력하세요.");
  if (!projectSessionId) throw new Error("먼저 프로젝트 경로를 열어 구현 에이전트를 실행하세요.");
  if (assignees.length !== PROJECT_STAGES.length) throw new Error("네 단계의 담당자 정보를 확인하세요.");
  const input = { brief: text, assignees: assignees.map(assignee => assignee ? onRoster(assignee, peers) : null), projectSessionId };
  const view = required(await call("reason_pipeline_create", { input }));
  if (view.kind !== "project") throw new Error("프로젝트 파이프라인을 만들지 못했습니다.");
  return view;
}
/** The roster entry whose name, address or kind mentions `word` (e.g. Muse, OpenAI Dots). Only a suggestion: the user confirms. */
export function suggestPeer(peers: ReasonPeer[], word: RegExp): string {
  return peers.find(peer => word.test(peer.name) || word.test(peer.id) || word.test(peer.kind))?.id ?? "";
}
/** The roster address of the Studio-started session `name` on this Studio's machine. */
export function projectAgentPeer(name: string, peers: ReasonPeer[], selfId: string | null): string {
  const machine = selfId?.split("@")[1];
  return machine ? peers.find(peer => peer.name === name && peer.machine === machine)?.id ?? "" : "";
}
export async function updatePipeline(pipelineId: string, action: PipelineAction, peers: ReasonPeer[], call: BridgeInvoke = nativeInvoke): Promise<PipelineView> {
  if (action.type === "assign") onRoster(action.assignee, peers);
  return required(await call("reason_pipeline_update", { input: { pipelineId, action } }));
}
/** Approves exactly the text in `view.next`; the host re-derives it and compares the digest. */
export async function sendStage(view: PipelineView, deployApproved: boolean, call: BridgeInvoke = nativeInvoke): Promise<PipelineView> {
  if (!view.next) throw new Error("지금 보낼 단계가 없습니다.");
  if (view.next.stage === "deploy" && !deployApproved) throw new Error("배포 단계는 배포 승인을 체크한 뒤 보낼 수 있습니다.");
  const input = { pipelineId: view.id, stage: view.next.stage, digest: view.next.digest, deployApproved };
  return required(await call("reason_pipeline_send", { input }));
}
