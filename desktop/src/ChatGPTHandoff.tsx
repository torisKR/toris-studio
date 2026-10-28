import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Copy, RefreshCw, X } from "lucide-react";
import { creationApi, creationStateLabel, type CreationRequest } from "./creation-client";
import { External } from "./External";

export function ChatGPTHandoff({ prompt, title = "ChatGPT에 전달할 요청" }: { prompt: string; title?: string }) {
  const [notice, setNotice] = useState("");
  useEffect(() => setNotice(""), [prompt]);
  if (!prompt) return null;
  return <section className="creation-handoff" aria-label={title}>
    <div className="workspace-inline-heading"><div><strong>{title}</strong><p>전달문을 ChatGPT에 붙여넣고 Remote Desktop Commander로 계속하세요.</p></div><button className="social-button" onClick={() => void invoke("copy_text", { text: prompt }).then(() => setNotice("전달문을 복사했습니다. ChatGPT에 붙여넣어 요청을 시작하세요.")).catch(e => setNotice(String(e)))}><Copy size={15}/>전달문 복사</button></div>
    <details><summary>전달문 검토</summary><pre>{prompt}</pre></details>
    <div className="workspace-inline-actions"><External url="https://chatgpt.com/">ChatGPT 열기</External><small>복사는 전달·생성 완료가 아닙니다. 수신한 결과는 검토 후 적용합니다.</small></div>
    {notice && <p role="status">{notice}</p>}
  </section>;
}

export function CreationInbox({ active, kind, onReview }: { active: boolean; kind: "text" | "video"; onReview: (request: CreationRequest) => void | Promise<void> }) {
  const [requests, setRequests] = useState<CreationRequest[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (!active) return;
    let alive = true, reading = false;
    const read = async () => { if (reading) return; reading = true; try { const value = await creationApi<{ requests: CreationRequest[] }>("list"); if (alive) { setRequests(value.requests.filter(r => r.kind === kind)); setError(""); } } catch (e) { if (alive) setError(String(e)); } finally { reading = false; } };
    void read(); const timer = setInterval(() => void read(), 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [active, kind, refreshKey]);
  return <section className={`creation-inbox${requests.length || error ? "" : " is-empty"}`} aria-label="제작 요청과 수신 초안"><div className="workspace-inline-heading"><h2>요청과 받은 초안{!requests.length && !error && <small> · 받은 초안 없음</small>}</h2><button className="social-button compact" onClick={() => setRefreshKey(n => n + 1)}><RefreshCw size={14}/>새로고침</button></div>
    {error && <p className="social-form-error" role="alert">{error}</p>}
    
    {requests.slice(0, 12).map(request => <article key={request.id}><div><strong>{request.title}</strong><small>{creationStateLabel(request.status)} · {new Date(request.createdAt).toLocaleString("ko-KR")}</small></div><div className="workspace-inline-actions">{request.status === "draft-received" && request.draft && <button className="social-button primary compact" disabled={busy} onClick={() => { setBusy(true); void Promise.resolve(onReview(request)).catch(e => setError(String(e))).finally(() => setBusy(false)); }}>초안 검토</button>}{request.status !== "cancelled" && <button className="social-button compact" disabled={busy} aria-label={`${request.title} 요청 거절·취소`} onClick={() => { setBusy(true); void creationApi("cancel", { requestId: request.id, revision: request.revision }).then(() => setRefreshKey(n => n + 1)).catch(e => setError(String(e))).finally(() => setBusy(false)); }}><X size={14}/>거절·취소</button>}</div></article>)}
  </section>;
}
