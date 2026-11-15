import { Copy, Megaphone } from "lucide-react";
import { useState } from "react";
import { HOSTED_ASSISTANTS, SNS_PLATFORMS, SNS_REQUEST_EXAMPLE } from "./sns-client";
import type { HostedAssistant, SnsHandoff, SnsPlatform } from "./types";

type Props = {
  connected: boolean; busy: boolean; handoff: SnsHandoff | null;
  onCreate: (assistant: HostedAssistant, brief: string, platforms: SnsPlatform[]) => void; onCopy: (text: string) => void;
};

/** Asks Muse, OpenAI Dots or Grok Bot to plan posts. Nothing is sent: the user pastes the handoff. */
export function SnsHandoffPanel({ connected, busy, handoff, onCreate, onCopy }: Props) {
  const [assistant, setAssistant] = useState<HostedAssistant>("muse");
  const [brief, setBrief] = useState("");
  const [platforms, setPlatforms] = useState<SnsPlatform[]>(["threads", "instagram", "x"]);
  const toggle = (id: SnsPlatform, on: boolean) => setPlatforms(current => on ? [...new Set([...current, id])] : current.filter(p => p !== id));
  return <details className="reason-guide reason-sns-handoff">
    <summary>SNS 게시 기획 맡기기 (Muse·OpenAI Dots·Grok Bot)</summary>
    <p>호스팅 어시스턴트는 Reason MCP의 <code>send_message</code>로만 Studio에 보낼 수 있습니다. 전달문을 만들어 그 앱에 붙여넣으면, 첫 줄에 이 전달문의 코드가 있는 기획만 받은 요청에 표시됩니다.</p>
    <form className="reason-message-form" aria-label="SNS 기획 전달문 만들기" onSubmit={event => { event.preventDefault(); onCreate(assistant, brief, platforms); }}>
      <label htmlFor="reason-sns-assistant">맡길 어시스턴트</label>
      <select id="reason-sns-assistant" value={assistant} disabled={busy} onChange={event => setAssistant(event.target.value as HostedAssistant)}>
        {HOSTED_ASSISTANTS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
      </select>
      <fieldset className="reason-sns-platforms" disabled={busy}><legend>대상 플랫폼</legend>
        {SNS_PLATFORMS.map(p => <label key={p.id}><input type="checkbox" checked={platforms.includes(p.id)} onChange={event => toggle(p.id, event.target.checked)} />{p.label}</label>)}
      </fieldset>
      <label htmlFor="reason-sns-brief">기획 요청</label>
      <textarea id="reason-sns-brief" rows={3} maxLength={4000} value={brief} disabled={busy} onChange={event => setBrief(event.target.value)} placeholder="예: 이번 주 단월 업데이트를 알리는 게시글. 친근한 말투, 저녁 7시 게시 희망." />
      <button type="submit" className="social-button compact primary" disabled={busy || !connected || !brief.trim() || !platforms.length}><Megaphone size={14} />전달문 만들기</button>
      {!connected && <small>Reason Network에 연결되면 Studio 주소가 들어간 전달문을 만들 수 있습니다.</small>}
    </form>
    {handoff && <section aria-label="SNS 기획 전달문">
      <p>{handoff.assistant}에게 붙여넣을 전달문 · 코드 <code>{handoff.code}</code></p>
      <pre>{handoff.prompt}</pre>
      <button type="button" className="social-button compact" disabled={busy} onClick={() => onCopy(handoff.prompt)}><Copy size={14} />전달문 복사</button>
    </section>}
    <p>연결된 에이전트(피어)는 코드 없이 아래 JSON 객체 하나를 메시지 본문으로 보내면 됩니다. 새 기획마다 <code>requestId</code>를 바꿉니다.</p>
    <pre>{SNS_REQUEST_EXAMPLE}</pre>
    <button type="button" className="social-button compact" disabled={busy} onClick={() => onCopy(SNS_REQUEST_EXAMPLE)}><Copy size={14} />SNS 기획 요청 예시 복사</button>
  </details>;
}
