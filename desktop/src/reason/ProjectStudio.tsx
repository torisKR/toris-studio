import { FolderOpen, LoaderCircle, Rocket } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { nativeInvoke, type BridgeInvoke } from "../ai-client";
import { IMPLEMENTATION_MODEL, sessionState, startProject, type AgentSession } from "./agent-launch-client";
import {
  createProjectPipeline, PROJECT_STAGES, projectAgentPeer, stageLabel, suggestPeer, type PipelineView
} from "./pipeline-client";
import type { NetworkSnapshot, ReasonPeer } from "./types";

const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
const STATE_LABELS = { registering: "네트워크 등록 대기 중", connected: "연결됨", exited: "종료됨" } as const;
const MUSE = /muse/i, DOTS = /dots/i;
type Props = {
  snapshot: NetworkSnapshot | null; locked: boolean; call?: BridgeInvoke;
  onCreated: (view: PipelineView) => void; onRefresh: () => void;
};

function Select({ id, label, value, peers, disabled, onChange }: { id: string; label: string; value: string; peers: ReasonPeer[]; disabled: boolean; onChange: (value: string) => void }) {
  return <select id={id} aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
    <option value="">담당 에이전트 선택</option>
    {peers.map(peer => <option key={peer.id} value={peer.id}>{peer.name} · {peer.kind}</option>)}
  </select>;
}

/**
 * Project path → planning (Muse draft, OpenAI Dots spec) → design → development by Claude Code
 * on Opus 5.5 / medium in that folder. Starting the agent needs an OS confirmation; every stage
 * request is approved separately in the pipeline card below.
 */
export function ProjectStudio({ snapshot, locked, call = nativeInvoke, onCreated, onRefresh }: Props) {
  const [path, setPath] = useState("");
  const [session, setSession] = useState<AgentSession | null>(null);
  const [brief, setBrief] = useState("");
  const [planner, setPlanner] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [designer, setDesigner] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const peers = snapshot?.peers ?? [];
  const connected = snapshot?.state === "connected";
  const selfId = snapshot?.selfId ?? null;
  const developer = session ? projectAgentPeer(session.name, peers, selfId) : "";
  const state = session ? sessionState(session, peers, selfId) : null;

  // Suggest Muse for the draft and OpenAI Dots for the spec once they appear; the user can change both.
  const peerKey = peers.map(peer => peer.id).join("|");
  useEffect(() => {
    setPlanner(current => current || suggestPeer(peers, MUSE));
    setReviewer(current => current || suggestPeer(peers, DOTS));
  }, [peerKey]);

  const perform = async (label: string, task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setError("");
    try { await task(); } catch (cause) { setError(errorText(cause)); }
    finally { busyRef.current = false; setBusy(""); }
  };
  const open = (event: FormEvent) => {
    event.preventDefault();
    void perform("open", async () => {
      const started = await startProject(path, call);
      if (started) { setSession(started.session); onRefresh(); }
    });
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    if (!session) return;
    void perform("create", async () => {
      const view = await createProjectPipeline(brief, [planner, reviewer, designer, developer], session.id, peers, call);
      setBrief(""); onCreated(view);
    });
  };
  const disabled = locked || !!busy || !connected;

  return <section className="reason-project" aria-labelledby="reason-project-title">
    <div className="reason-section-heading"><h3 id="reason-project-title"><Rocket size={15} />앱 프로젝트</h3>
      <span>{PROJECT_STAGES.map(stage => stageLabel("project", stage)).join(" → ")}</span></div>
    <p className="reason-note">프로젝트 경로를 넣으면 그 폴더에서 구현 에이전트({IMPLEMENTATION_MODEL})를 실행하고, Muse의 기획 초안과 OpenAI Dots의 기획 확정, 디자인 답장을 차례로 이어 받아 구현을 맡깁니다.</p>
    {error && <p className="reason-alert" role="alert">{error}</p>}
    <form className="reason-message-form reason-project-path" aria-label="프로젝트 열기" onSubmit={open}>
      <label htmlFor="reason-project-path">프로젝트 경로</label>
      <div className="reason-launcher-pick">
        <input id="reason-project-path" type="text" spellCheck={false} autoComplete="off" maxLength={1024} disabled={disabled}
          value={path} onChange={event => setPath(event.target.value)} placeholder="~/projects/my-app" />
        <button type="submit" className="social-button compact" disabled={disabled || !path.trim()}>
          {busy === "open" ? <LoaderCircle size={14} className="social-spin" /> : <FolderOpen size={14} />}프로젝트 열기</button>
      </div>
      <p className="reason-note">{connected ? "확인 창에서 폴더·브랜치·모델을 보여 준 뒤 실행합니다. 이미 이 폴더에서 실행 중이면 그 세션을 이어서 씁니다." : "Reason Network에 연결된 뒤 열 수 있습니다."}</p>
    </form>
    {session && <div className="reason-project-session" role="status">
      <strong>{session.name}</strong>
      <span>{[session.model ?? IMPLEMENTATION_MODEL, session.branch, state ? STATE_LABELS[state] : null].filter(Boolean).join(" · ")}</span>
      <code title={session.folder}>{session.folder}</code>
    </div>}
    {session && <form className="reason-message-form reason-pipeline-form" aria-label="새 프로젝트 파이프라인" onSubmit={create}>
      <label htmlFor="reason-project-brief">만들고 싶은 것</label>
      <textarea id="reason-project-brief" rows={3} maxLength={2500} disabled={disabled} value={brief} onChange={event => setBrief(event.target.value)}
        placeholder="예: 할 일 앱에 반복 일정과 알림을 추가한다. 홈 위젯은 이번 범위에서 뺀다." />
      <div className="reason-stage-assign">
        <label>{stageLabel("project", "planning")} (Muse)<Select id="reason-project-planner" label="프로젝트 기획 초안 담당" value={planner} peers={peers} disabled={disabled} onChange={setPlanner} /></label>
        <label>{stageLabel("project", "spec")} (OpenAI Dots)<Select id="reason-project-reviewer" label="프로젝트 기획 확정 담당" value={reviewer} peers={peers} disabled={disabled} onChange={setReviewer} /></label>
        <label>{stageLabel("project", "design")}<Select id="reason-project-designer" label="프로젝트 디자인 담당" value={designer} peers={peers} disabled={disabled} onChange={setDesigner} /></label>
        <label>{stageLabel("project", "development")}<span className="reason-fixed-assignee">{developer ? session.name : "구현 에이전트 등록 대기 중"}</span></label>
      </div>
      {(!planner || !reviewer) && <p className="reason-note">Muse·OpenAI Dots가 연결된 에이전트 목록에 없으면 각 앱의 Reason 커넥터로 이 네트워크에 연결하세요. 비워 둔 단계는 나중에 정하거나 건너뜁니다.</p>}
      <button type="submit" className="social-button primary" disabled={disabled || !brief.trim()}>
        {busy === "create" ? <LoaderCircle size={14} className="social-spin" /> : <Rocket size={14} />}프로젝트 파이프라인 만들기</button>
    </form>}
  </section>;
}
