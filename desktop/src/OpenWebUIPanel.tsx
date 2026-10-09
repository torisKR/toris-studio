import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, LoaderCircle, MessageSquare, Play, RefreshCw, Square } from "lucide-react";
import { controlOpenWebUI, copyOpenWebUIBootstrap, getOpenWebUIStatus, openWebUI, openWebUILabels } from "./open-webui-client";
import type { OpenWebUIStatus } from "./open-webui-client";
import "./OpenWebUIPanel.css";

function failure(error: unknown): string { return typeof error === "string" ? error : error instanceof Error ? error.message : "Open WebUI 상태를 확인하지 못했습니다."; }
function endpointLabel(value: boolean | null | undefined): string { return value === true ? "로컬 응답 확인됨" : value === false ? "로컬 응답 확인 필요" : "검사 기록 없음"; }

export function OpenWebUIPanel({ active, refreshKey = 0 }: { active: boolean; refreshKey?: number }) {
  const [status, setStatus] = useState<OpenWebUIStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [clock, setClock] = useState(Date.now());
  const alive = useRef(false), epoch = useRef(0), pending = useRef(false), acting = useRef(false);
  const refresh = useCallback(async () => {
    if (!alive.current || pending.current || acting.current || document.visibilityState !== "visible") return;
    pending.current = true;
    const generation = epoch.current;
    try { const value = await getOpenWebUIStatus(); if (alive.current && generation === epoch.current) { setStatus(value); setError(""); } }
    catch (reason) { if (alive.current && generation === epoch.current) setError(failure(reason)); }
    finally { pending.current = false; }
  }, []);
  useEffect(() => {
    if (!active) return;
    alive.current = true; ++epoch.current; void refresh();
    const timer = setInterval(() => { setClock(Date.now()); void refresh(); }, 3000);
    const visible = () => { if (document.visibilityState === "visible") { setClock(Date.now()); void refresh(); } };
    document.addEventListener("visibilitychange", visible);
    return () => { alive.current = false; ++epoch.current; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [active, refreshKey, refresh]);
  async function run(label: string, action: "start" | "stop" | "open" | "copy") {
    if (acting.current) return;
    acting.current = true; setBusy(label); setError(""); setNotice("");
    const generation = ++epoch.current;
    try {
      if (action === "open") await openWebUI(status);
      else if (action === "copy") { await copyOpenWebUIBootstrap(); if (alive.current && generation === epoch.current) setNotice("코딩 연결 안내를 복사했습니다. Open WebUI에서 Toris Codexify 도구를 선택한 대화에 붙여넣으세요."); }
      else { const value = await controlOpenWebUI(action); if (alive.current && generation === epoch.current) setStatus(value); }
    } catch (reason) { if (alive.current && generation === epoch.current) setError(failure(reason)); }
    finally { acting.current = false; if (alive.current) setBusy(""); }
  }
  if (!active) return null;
  const preparing = status?.status === "pulling" || status?.status === "starting";
  const stale = Boolean(status && (!Number.isFinite(Date.parse(status.checkedAt)) || clock - Date.parse(status.checkedAt) > 30_000));
  const disabled = Boolean(busy);
  return <section className="open-webui-panel" aria-label="Open WebUI 로컬 채팅" aria-busy={disabled || preparing}>
    <header><div><span className="codexify-eyebrow">LOCAL AI CHAT</span><h3><MessageSquare size={19}/>Open WebUI</h3><p>로컬 채팅 화면에서 AI와 대화하고 Codexify MCP 도구를 연결합니다.</p></div><button className="social-button compact" disabled={disabled} aria-label="Open WebUI 상태 새로고침" onClick={() => void refresh()}><RefreshCw size={14}/>상태 확인</button></header>
    <div className="open-webui-state" role="status" aria-live="polite" aria-atomic="true">{preparing ? <LoaderCircle className="open-webui-loading" size={17}/> : status?.status === "ready" && !error && !stale ? <Check size={17}/> : <MessageSquare size={17}/>}<div><strong>{error || stale ? "최근 서버 상태를 확인할 수 없습니다" : status ? openWebUILabels[status.status] : "로컬 서버 상태 확인 중"}</strong><p>{busy ? `${busy} 중…` : status?.message ?? "Docker 실행 환경과 로컬 서버를 확인합니다."}</p></div></div>
    {error && <p className="social-notice error" role="alert">{error}</p>}
    {notice && <p className="social-notice" role="status">{notice}</p>}
    <div className="open-webui-actions"><button className={`social-button${status?.status === "ready" ? "" : " primary"}`} disabled={disabled || !status?.dockerAvailable || preparing || status?.containerRunning || Boolean(error)} onClick={() => void run("Open WebUI 시작", "start")}><Play size={15}/>로컬 채팅 시작</button><button className={`social-button${status?.canOpen && status.status === "ready" ? " primary" : ""}`} disabled={disabled || !status?.canOpen || status.status !== "ready" || stale || Boolean(error)} onClick={() => void run("Open WebUI 열기", "open")}><ExternalLink size={15}/>Open WebUI 열기</button><button className="social-button" disabled={disabled || (!status?.containerRunning && !preparing)} onClick={() => void run("Open WebUI 종료", "stop")}><Square size={15}/>{preparing ? "시작 취소" : "로컬 채팅 종료"}</button><button className="social-button" disabled={disabled} onClick={() => void run("코딩 연결 안내 복사", "copy")}><Copy size={15}/>코딩 연결 안내 복사</button></div>
    {status && !status.dockerAvailable && <p className="open-webui-note">OrbStack 또는 Docker Desktop을 실행한 뒤 상태를 다시 확인하세요.</p>}
    {status?.setupRequired === true && <div className="open-webui-setup"><strong>첫 관리자 계정을 직접 만들어 주세요</strong><p>Open WebUI를 열고 초기 계정을 생성하세요. 로그인 정보와 채팅 기록은 이 기기의 전용 Docker 볼륨에 저장됩니다.</p></div>}
    {status?.setupRequired === null && status?.status === "ready" && <p className="open-webui-note">초기 계정 설정 여부를 확인하지 못했습니다. Open WebUI를 열어 로그인 상태와 관리자 설정을 확인하세요.</p>}
    <details className="open-webui-connections"><summary>AI 제공자와 MCP 연결 상태</summary><div className="open-webui-connection-grid"><div><span>AI 제공자 로컬 연결</span><strong>{endpointLabel(error || stale ? null : status?.providerReachable)}</strong><code>{status?.providerUrl ?? "연결 주소 확인 필요"}</code></div><div><span>Codexify MCP 로컬 연결</span><strong>{endpointLabel(error || stale ? null : status?.mcpReachable)}</strong><code>{status?.mcpUrl ?? "연결 주소 확인 필요"}</code></div></div><p>로컬 주소의 응답을 검사한 결과입니다. Open WebUI에서 제공자와 도구가 선택됐는지, 모델 응답과 실제 도구 실행이 성공했는지는 채팅 화면에서 확인하세요. 기존 관리자 설정이 있으면 연결 설정도 확인하세요.</p></details>
    {status && <footer><span>Open WebUI v{status.version} · {status.url}</span><time dateTime={status.checkedAt}>최근 확인 {new Date(status.checkedAt).toLocaleTimeString("ko-KR")}</time></footer>}
  </section>;
}
