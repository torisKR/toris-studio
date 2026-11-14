import { Copy, FolderOpen, LoaderCircle, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { nativeInvoke, type BridgeInvoke } from "../ai-client";
import { External } from "../External";
import {
  AGENT_KINDS, AGENT_LABELS, launchAgent, listAgents, sessionState, stopAgent, type AgentKind, type AgentSession
} from "./agent-launch-client";
import type { NetworkSnapshot } from "./types";

const SESSION_POLL_MS = 5_000;
const REMOTE_MCP = "https://mcp.reasonmachines.com/mcp";
const STATE_LABELS = { registering: "네트워크 등록 대기 중", connected: "연결됨", exited: "종료됨" } as const;
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
type Props = { active: boolean; snapshot: NetworkSnapshot | null; onCopy: (text: string) => void; onRefresh: () => void; call?: BridgeInvoke };

/** Starts Claude Code or Codex as a Reason Network peer. The folder and the confirmation are OS dialogs. */
export function DevAgentLauncher({ active, snapshot, onCopy, onRefresh, call = nativeInvoke }: Props) {
  const [kind, setKind] = useState<AgentKind>("claude");
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const connected = snapshot?.state === "connected";
  const peers = snapshot?.peers ?? [];

  const load = useCallback(async () => {
    try { setSessions(await listAgents(call)); } catch (cause) { setError(errorText(cause)); }
  }, [call]);
  useEffect(() => { if (active) void load(); }, [active, load]);
  const running = sessions.some(session => session.running);
  useEffect(() => {
    if (!active || !running) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, SESSION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, running, load]);

  const perform = async (label: string, task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setError("");
    try { await task(); } catch (cause) { setError(errorText(cause)); }
    finally { busyRef.current = false; setBusy(""); }
  };
  const launch = () => perform("launch", async () => {
    const started = await launchAgent(kind, call);
    if (started) { setSessions(started); onRefresh(); }
  });
  const stop = (id: string) => perform("stop:" + id, async () => { setSessions(await stopAgent(id, call)); onRefresh(); });
  const locked = !!busy;

  return <section className="reason-launcher" aria-labelledby="reason-launcher-title">
    <div className="reason-section-heading"><h3 id="reason-launcher-title">개발 에이전트 실행</h3><span>{sessions.filter(session => session.running).length}개 실행 중</span></div>
    {error && <p className="reason-alert" role="alert">{error}</p>}
    <div className="reason-launcher-pick">
      <select aria-label="실행할 에이전트" value={kind} disabled={locked} onChange={event => setKind(event.target.value as AgentKind)}>
        {AGENT_KINDS.map(item => <option key={item} value={item}>{AGENT_LABELS[item]}</option>)}
      </select>
      <button type="button" className="social-button compact" disabled={locked || !connected} onClick={() => void launch()}>
        {busy === "launch" ? <LoaderCircle size={14} className="social-spin" /> : <FolderOpen size={14} />}폴더 선택 후 실행</button>
    </div>
    <p className="reason-note">{connected
      ? "폴더를 고르면 실행 내용을 확인하는 창이 한 번 더 뜹니다. 실행된 에이전트는 받은 요청에 따라 그 폴더의 파일을 묻지 않고 수정합니다."
      : "Reason Network에 연결된 뒤 실행할 수 있습니다."}</p>
    {sessions.length > 0 && <ul className="reason-sessions">{sessions.map(session => {
      const state = sessionState(session, peers, snapshot?.selfId ?? null);
      return <li key={session.id}>
        <div className="reason-peer-name"><strong>{session.name}</strong>
          <small>{STATE_LABELS[state]}{state === "exited" && session.exitCode !== null ? " (코드 " + session.exitCode + ")" : ""}</small></div>
        <span>{[AGENT_LABELS[session.kind], session.branch].filter(Boolean).join(" · ")}</span>
        <code title={session.folder}>{session.folder}</code>
        {state === "exited" && <p className="reason-note">로그인 상태를 확인하려면 터미널에서 <code>reason network serve {session.kind}</code>를 실행해 보세요.</p>}
        <button type="button" className="social-button compact" disabled={locked} aria-label={session.name + (session.running ? " 중지" : " 기록 닫기")} onClick={() => void stop(session.id)}>
          {busy === "stop:" + session.id ? <LoaderCircle size={14} className="social-spin" /> : <Square size={13} />}{session.running ? "중지" : "닫기"}</button>
      </li>;
    })}</ul>}
    <details className="reason-guide">
      <summary>다른 AI 연결하기 (피클·Muse·Grok Bot·OpenAI Dots)</summary>
      <p>이 에이전트들은 각자의 앱에서 Reason 커넥터로 같은 네트워크에 접속합니다. 접속하면 아래 "연결된 에이전트"에 나타나고, 단계별 작업을 맡길 수 있습니다.</p>
      <p>원격 MCP 주소: <code>{REMOTE_MCP}</code></p>
      <button type="button" className="social-button compact" disabled={locked} onClick={() => onCopy(REMOTE_MCP)}><Copy size={14} />커넥터 주소 복사</button>
      <p><External url="https://docs.reasonmachines.com/docs/network" className="reason-link">Reason 연결 문서 열기</External></p>
    </details>
  </section>;
}
