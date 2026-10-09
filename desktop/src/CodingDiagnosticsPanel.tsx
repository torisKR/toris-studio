import { Check, Circle, Link2, ShieldCheck, TriangleAlert } from "lucide-react";
import type { ChatState, CodexifyConnection, CodexifyProfile } from "./codexify-client";
import type { CodexifyProxyStatus, ProxyProvider } from "./codexify-runtime-client";
import { elapsedLabel } from "./coding-progress-client";
import "./CodingDiagnosticsPanel.css";

type CheckLevel = "pass" | "pending" | "warning";
function stamp(value: number | string | null | undefined): string { return value != null ? new Date(value).toLocaleString("ko-KR") : "기록 없음"; }
function Evidence({ title, level, label, detail, timestamp, children }: { title: string; level: CheckLevel; label: string; detail: string; timestamp?: string; children?: React.ReactNode }) {
  return <article className={`coding-diagnostic-check ${level}`}><div className="coding-diagnostic-check-title">{level === "pass" ? <Check size={15}/> : level === "warning" ? <TriangleAlert size={15}/> : <Circle size={15}/>}<h4>{title}</h4></div><strong>{label}</strong><p>{detail}</p>{children}{timestamp && <small>{timestamp}</small>}</article>;
}

export function CodingDiagnosticsPanel({ profile, connection, state, pollError, observedAt, now, proxies, proxyObservedAt, lastFileReceivedAt, lastToolCallAt }: {
  profile: CodexifyProfile | null;
  connection: CodexifyConnection | null;
  state: ChatState | null;
  pollError: string;
  observedAt: number;
  now: number;
  proxies: Partial<Record<ProxyProvider, CodexifyProxyStatus>>;
  proxyObservedAt: number;
  lastFileReceivedAt?: string | null;
  lastToolCallAt?: string | null;
}) {
  const connectionFresh = Boolean(connection && Math.max(0, now - Date.parse(connection.checkedAt)) <= 60_000);
  const bridgeReady = connectionFresh && connection?.reachable;
  const contractReady = bridgeReady && connection?.fileReceiverReady && !connection?.missingStudioTools.length;
  const chatFresh = Boolean(state && !pollError && observedAt && now - observedAt <= 15_000);
  const publicStatuses = Object.values(proxies).filter(value => value?.running && value.mcpUrl);
  const proxyFresh = proxyObservedAt > 0 && now - proxyObservedAt <= 60_000;
  const agentObserved = Boolean(state?.last_agent_call_at_ms);
  return <section className="coding-diagnostics" aria-label="MCP 플러그인 연결 진단">
    <header><div><span className="codexify-eyebrow">CONNECTION EVIDENCE</span><h3><ShieldCheck size={17}/>MCP 플러그인, 어디까지 확인됐나요?</h3><p>로컬 연결과 ChatGPT의 실제 도구 사용 기록을 각각 확인합니다.</p></div><span>{bridgeReady && contractReady && connection?.ownerReady ? "로컬 연결 준비 확인됨" : "연결 확인 필요"}</span></header>
    <div className="coding-diagnostic-grid">
      <Evidence title="로컬 MCP 브리지" level={bridgeReady ? "pass" : connection?.reachable === false ? "warning" : "pending"} label={bridgeReady ? `${connection!.serverName ?? "Codexify"} · ${connection!.toolCount}개 도구` : "로컬 연결 확인 필요"} detail={connectionFresh ? connection!.message : "최근 연결 확인 결과가 없습니다. 연결 확인을 눌러 브리지를 진단하세요."} timestamp={`최근 연결 검사 · ${stamp(connection?.checkedAt)}`}/>
      <Evidence title="Studio 도구 계약" level={contractReady ? "pass" : connectionFresh ? "warning" : "pending"} label={contractReady ? "파일 수신 계약 확인됨" : "도구 목록·파일 계약 확인 필요"} detail={contractReady ? "실제 MCP 도구 목록과 파일 수신 스키마를 확인했습니다. 파일 생성·수신 성공은 별도로 확인합니다." : connection?.missingStudioTools.length ? `누락된 도구 ${connection.missingStudioTools.length}개를 확인하세요.` : "Studio 직접 도구와 파일 수신 스키마를 먼저 확인하세요."} timestamp={`최근 계약 검사 · ${stamp(connection?.checkedAt)}`}>{connection && <details><summary>검사한 Studio 도구 {connection.studioTools.length}개</summary><ul>{connection.studioTools.map(name => <li key={name}>{name}</li>)}</ul>{connection.missingStudioTools.length > 0 && <p>누락: {connection.missingStudioTools.join(", ")}</p>}</details>}</Evidence>
      <Evidence title="앱 대화 전송 권한" level={bridgeReady && connection?.ownerReady ? "pass" : "pending"} label={bridgeReady && connection?.ownerReady ? "비공개 대화 전송 준비됨" : "앱 대화 권한 확인 필요"} detail="앱의 대화 전송 권한을 로컬에서 확인합니다. 인증 값은 화면에 표시하지 않습니다." timestamp={`최근 권한 검사 · ${stamp(connection?.checkedAt)}`}/>
      <Evidence title="공개 MCP 프록시" level={proxyFresh && publicStatuses.length ? "pass" : "pending"} label={proxyFresh && publicStatuses.length ? `${publicStatuses.length}개 프록시 프로세스 실행 확인` : "앱 프록시 실행 확인 필요"} detail="앱이 관리하는 프록시 프로세스와 공개 주소입니다. 현재 ChatGPT에서 이 주소를 연결했는지는 이 검사로 확인되지 않습니다." timestamp={`앱 프로세스 상태 확인 · ${proxyObservedAt ? elapsedLabel(proxyObservedAt, now) : "기록 없음"}`}><ul className="coding-proxy-observations">{publicStatuses.map(value => <li key={value.provider}><Link2 size={12}/><span>{value.provider === "cloudflare" ? "Cloudflare" : "ngrok"}<code>{value.mcpUrl}</code></span></li>)}</ul></Evidence>
      <Evidence title="저장한 ChatGPT 플러그인" level="pending" label={profile?.pluginUrl ? "플러그인 주소 저장됨 · 등록 상태 미확인" : "플러그인 주소를 저장하세요"} detail="저장한 주소만으로 ChatGPT 등록 성공을 확인할 수 없습니다. ChatGPT에서 플러그인을 선택하고 연결 시작 안내를 실행하세요.">{profile?.pluginUrl && <code>{profile.pluginUrl}</code>}</Evidence>
      <Evidence title="선택한 ChatGPT 대화의 도구 사용" level={chatFresh && agentObserved ? "pass" : "pending"} label={!profile?.conversationId ? "대화 선택 필요" : !chatFresh ? "대화 상태 재확인 필요" : agentObserved ? "ChatGPT 도구 접근 기록 확인됨" : "실제 도구 사용 기록 없음"} detail="선택한 대화의 ChatGPT 도구 접근 기록입니다. ChatGPT 로그인 여부나 특정 작업 완료를 뜻하지 않습니다." timestamp={`최근 실제 도구 접근 · ${stamp(state?.last_agent_call_at_ms)}`}/>
    </div>
    <details className="coding-studio-observations"><summary>Studio 전체 활동 기록</summary><p>여러 대화와 클라이언트가 함께 사용하는 Studio 기록입니다. 현재 선택한 대화의 결과로 연결하지 않습니다.</p><dl><div><dt>최근 Studio 도구 활동</dt><dd>{stamp(lastToolCallAt)}</dd></div><div><dt>최근 실제 파일 수신</dt><dd>{stamp(lastFileReceivedAt)}</dd></div></dl></details>
  </section>;
}
