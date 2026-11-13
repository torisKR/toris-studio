import { nativeInvoke, type BridgeInvoke } from "../ai-client";
import type { ReasonPeer } from "./types";

/** Only these two can be started by Studio; every other agent joins Reason Network by itself. */
export const AGENT_KINDS = ["claude", "codex"] as const;
export type AgentKind = typeof AGENT_KINDS[number];
export const AGENT_LABELS: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };
export type AgentSession = { kind: AgentKind; folder: string; branch: string | null; name: string; id: string; running: boolean; exitCode: number | null; model: string | null };
/** The implementation model Studio pins for Claude Code sessions it starts. */
export const IMPLEMENTATION_MODEL = "Claude Opus 5.5 · effort medium";
export type SessionState = "registering" | "connected" | "exited";

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => value && typeof value === "object" && !Array.isArray(value) ? value as Rec : {};
const str = (value: unknown) => typeof value === "string" ? value : "";
function agentKind(value: unknown): AgentKind {
  if (!AGENT_KINDS.includes(value as AgentKind)) throw new Error("Studio에서 실행할 수 있는 에이전트는 Claude Code와 Codex입니다.");
  return value as AgentKind;
}
/** Rows the host could not describe exactly are dropped, never shown as running. */
export function normalizeSessions(value: unknown): AgentSession[] {
  return (Array.isArray(value) ? value : []).flatMap(item => {
    const r = rec(item);
    if (!str(r.id) || !str(r.folder) || !str(r.name) || typeof r.running !== "boolean") return [];
    try {
      return [{ kind: agentKind(r.kind), folder: str(r.folder), branch: str(r.branch) || null, name: str(r.name),
        id: str(r.id), running: r.running, exitCode: typeof r.exitCode === "number" ? r.exitCode : null, model: str(r.model) || null }];
    } catch { return []; }
  });
}
/** "connected" only when the roster lists this exact session name on this Studio's machine. */
export function sessionState(session: AgentSession, peers: ReasonPeer[], selfId: string | null): SessionState {
  if (!session.running) return "exited";
  const machine = selfId?.split("@")[1];
  return machine && peers.some(peer => peer.name === session.name && peer.machine === machine) ? "connected" : "registering";
}

/**
 * The host opens the OS folder dialog and then an OS confirmation; the page supplies only the
 * agent kind. Returns the sessions after a confirmed start, or null when the user cancelled.
 */
export async function launchAgent(kind: AgentKind, call: BridgeInvoke = nativeInvoke): Promise<AgentSession[] | null> {
  const result = rec(await call("reason_agent_launch", { input: { kind: agentKind(kind) } }));
  if (result.cancelled !== false) return null;
  return normalizeSessions(result.sessions);
}
export async function stopAgent(id: string, call: BridgeInvoke = nativeInvoke): Promise<AgentSession[]> {
  return normalizeSessions(await call("reason_agent_stop", { input: { id } }));
}
export async function listAgents(call: BridgeInvoke = nativeInvoke): Promise<AgentSession[]> {
  return normalizeSessions(await call("reason_agent_list"));
}

export type ProjectStart = { session: AgentSession; sessions: AgentSession[]; reused: boolean };
/**
 * Opens a project by its typed path. The host resolves and checks the folder and asks in an OS
 * confirmation before starting Claude Code (Opus 5.5, medium effort) there. Returns null when cancelled.
 */
export async function startProject(path: string, call: BridgeInvoke = nativeInvoke): Promise<ProjectStart | null> {
  const typed = path.trim();
  if (!typed) throw new Error("프로젝트 폴더 경로를 입력하세요.");
  if (!typed.startsWith("/") && !typed.startsWith("~/")) throw new Error("/ 또는 ~/ 로 시작하는 전체 경로를 입력하세요.");
  const result = rec(await call("reason_project_start", { input: { path: typed } }));
  if (result.cancelled !== false) return null;
  const [session] = normalizeSessions([result.session]);
  if (!session || session.kind !== "claude" || !session.running) throw new Error("구현 에이전트 상태를 확인하지 못했습니다. 목록을 새로고침하세요.");
  return { session, sessions: normalizeSessions(result.sessions), reused: result.reused === true };
}
