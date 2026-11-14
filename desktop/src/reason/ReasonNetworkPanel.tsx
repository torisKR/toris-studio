import { Copy, Link2, LoaderCircle, RefreshCw, Send, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { External } from "../External";
import { DevAgentLauncher } from "./DevAgentLauncher";
import { ReasonInbox } from "./ReasonInbox";
import { ReasonPipeline } from "./ReasonPipeline";
import { STORYBOARD_REQUEST_EXAMPLE, VIDEO_REQUEST_EXAMPLE } from "./reason-client";
import { useReasonNetwork } from "./useReasonNetwork";
import type { ReasonMessage } from "./types";
import "./ReasonNetworkPanel.css";

const STATE_LABELS = { missing: "설치 필요", setup_required: "로그인·네트워크 설정 필요", connected: "연결됨", error: "연결 확인 필요" } as const;
type Props = { active: boolean; onOpenProduction: (jobId: string) => void };

export function ReasonNetworkPanel({ active, onOpenProduction }: Props) {
  const network = useReasonNetwork(active);
  const { snapshot, busy, refreshing } = network;
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const [reply, setReply] = useState<ReasonMessage | null>(null);
  const textField = useRef<HTMLTextAreaElement>(null);
  const connected = snapshot?.state === "connected";
  const locked = !!busy;
  const extraTarget = !!target && !snapshot?.peers.some(peer => peer.id === target);
  const choose = (id: string) => { setTarget(id); setReply(null); };
  const replyTo = (message: ReasonMessage) => { setTarget(message.from); setReply(message); textField.current?.focus(); };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!connected || locked || !target || !text.trim()) return;
    const sent = await network.send(target, text, reply?.id);
    if (sent) { setText(""); setReply(null); }
  };

  return <section className="reason-panel" aria-labelledby="reason-network-title" aria-busy={refreshing}>
    <header className="reason-header">
      <div><h2 id="reason-network-title"><Link2 size={18} />Reason Network</h2><p>Claude·Codex·피클·Muse·Grok Bot·Dots에게 단계별로 작업을 맡기고, 영상 요청을 Studio 제작으로 이어갑니다.</p></div>
      <div className="reason-header-actions">
        <span className={"reason-status " + (snapshot?.state ?? "loading")} role="status">{snapshot ? STATE_LABELS[snapshot.state] : "연결 확인 중"}</span>
        <button type="button" className="social-button compact" disabled={refreshing || locked} onClick={() => void network.refresh()}>{refreshing ? <LoaderCircle size={14} className="social-spin" /> : <RefreshCw size={14} />}연결·받은 요청 확인</button>
      </div>
    </header>
    {!snapshot && <div className="reason-loading" role="status">이 컴퓨터의 Reason 연결을 확인하고 있습니다.</div>}
    {snapshot?.error && <p className="reason-alert" role="alert">{snapshot.error}</p>}
    {network.error && <p className="reason-alert" role="alert">{network.error}</p>}
    {network.notice && <p className="reason-feedback" role="status">{network.notice}</p>}
    {snapshot && !connected && <div className="reason-setup">
      <strong>{snapshot.state === "missing" ? "이 컴퓨터에 Reason Network가 필요합니다." : "Reason에서 로그인과 네트워크 설정을 확인하세요."}</strong>
      <p>공식 안내에 따라 설치·로그인한 뒤, 터미널에서 <code>reason network</code>을 실행하고 연결을 다시 확인하세요.</p>
      <External url="https://reasonmachines.com/network" className="reason-link">Reason 연결 안내 열기</External>
    </div>}
    {snapshot?.selfId && <div className="reason-address"><span>이 Studio 주소</span><code>{snapshot.selfId}</code><button type="button" className="social-button compact" disabled={locked} onClick={() => void network.copy(snapshot.selfId!)}><Copy size={13} />주소 복사</button></div>}
    <ReasonPipeline active={active} snapshot={snapshot} onRefresh={network.refresh} />
    <div className="reason-layout">
      <section className="reason-compose" aria-labelledby="reason-peers-title">
        <DevAgentLauncher active={active} snapshot={snapshot} onCopy={text => void network.copy(text)} onRefresh={network.refresh} />
        <div className="reason-section-heading"><h3 id="reason-peers-title">연결된 에이전트</h3><span>{snapshot?.peers.length ?? 0}개</span></div>
        {snapshot?.peers.length ? <ul className="reason-peers">{snapshot.peers.map(peer => <li key={peer.id}>
          <button type="button" disabled={locked || !connected} aria-pressed={target === peer.id} aria-label={peer.name + " 선택"} onClick={() => choose(peer.id)}>
            <span className="reason-peer-name"><strong>{peer.name}</strong><small>{peer.busy ? "작업 중" : "대기 중"}</small></span>
            <span>{[peer.kind, peer.machine, peer.branch].filter(Boolean).join(" · ")}</span>
            {peer.cwd && <code title={peer.cwd}>{peer.cwd}</code>}
          </button>
        </li>)}</ul> : <p className="reason-empty">{connected ? "아직 연결된 에이전트가 없습니다. 같은 Reason 네트워크에서 작업 세션을 열어 주세요." : "연결하면 함께 작업할 에이전트가 여기에 표시됩니다."}</p>}
        <form onSubmit={event => void send(event)} className="reason-message-form" aria-label="에이전트 메시지 작성">
          <label htmlFor="reason-target">받는 에이전트</label>
          <select id="reason-target" value={target} disabled={locked || !connected} onChange={event => choose(event.target.value)}>
            <option value="">한 에이전트를 선택하세요</option>
            {extraTarget && <option value={target}>{reply?.fromName || target} · 목록 밖 세션</option>}
            {snapshot?.peers.map(peer => <option key={peer.id} value={peer.id}>{peer.name} · {peer.id}</option>)}
          </select>
          {reply && <div className="reason-reply-context"><span>{reply.fromName || reply.from}에게 답장</span><button type="button" aria-label="답장 연결 취소" disabled={locked} onClick={() => setReply(null)}><X size={14} /></button></div>}
          <label htmlFor="reason-message-body">보낼 메시지</label>
          <textarea ref={textField} id="reason-message-body" rows={4} maxLength={16000} disabled={locked || !connected} value={text} onChange={event => setText(event.target.value)} placeholder="예: 쇼츠 주제와 핵심 내용을 정리한 뒤 영상 요청 형식으로 보내 줘." />
          <button type="submit" className="social-button primary" disabled={locked || !connected || !target || !text.trim()}>{busy === "send" ? <LoaderCircle size={14} className="social-spin" /> : <Send size={14} />}메시지 보내기</button>
        </form>
        <details className="reason-guide">
          <summary>AI에게 영상 제작 요청을 보내게 하려면</summary>
          <p>Grok·Muse·dots의 Reason 커넥터에서 위 Studio 주소를 선택하고, 아래 JSON을 메시지 본문으로 보내도록 요청하세요. 새 영상마다 <code>requestId</code>를 바꿉니다.</p>
          <pre>{VIDEO_REQUEST_EXAMPLE}</pre>
          <button type="button" className="social-button compact" disabled={locked} onClick={() => void network.copy(VIDEO_REQUEST_EXAMPLE)}><Copy size={14} />영상 요청 예시 복사</button>
          <p>대본과 장면 구성이 이미 있다면 <code>storyboard</code>가 포함된 예시를 사용하세요. 받은 초안을 그대로 검토한 뒤 제작할 수 있습니다.</p>
          <button type="button" className="social-button compact" disabled={locked} onClick={() => void network.copy(STORYBOARD_REQUEST_EXAMPLE)}><Copy size={14} />스토리보드 요청 예시 복사</button>
          <p>원격 AI의 Reason 커넥터 주소: <code>https://mcp.reasonmachines.com/mcp</code></p>
        </details>
      </section>
      <ReasonInbox messages={snapshot?.messages ?? []} results={network.results} busy={locked} connected={connected}
        onAccept={messageId => void network.accept(messageId)} onReply={replyTo} onInspect={messageId => void network.inspect(messageId)}
        onSendResult={messageId => void network.sendResult(messageId)} onOpenProduction={onOpenProduction} />
    </div>
    <footer className="reason-footer"><span>Studio와 연결된 컴퓨터가 켜져 있어야 요청을 처리합니다.</span><span>영상은 스토리보드 승인 뒤 생성하며, 외부 게시는 발행 화면에서 승인합니다.</span>{snapshot?.version && <small>Reason {snapshot.version}</small>}</footer>
  </section>;
}
