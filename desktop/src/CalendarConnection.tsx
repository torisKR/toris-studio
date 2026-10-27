import { invoke } from "@tauri-apps/api/core";
import { CalendarDays, Check, LoaderCircle, LogIn, Unplug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";

type Provider = { platform: string; clientConfigured: boolean; connected: boolean; needsReconnect?: boolean; redirectUri?: string | null; accountLabel?: string | null };
const PLATFORM = "google_calendar";
const REDIRECT = "http://127.0.0.1:38471/oauth/google_calendar/callback";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Google Calendar login for the planner. Rust owns the client secret, the browser login and the tokens. */
export function CalendarConnection({ onChanged }: { onChanged: () => void }) {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "login" | "disconnect">("");
  const [text, setText] = useState("");
  const load = useCallback(async () => {
    try {
      const status = await invoke<{ providers: Provider[] }>("oauth_status");
      setProvider(status.providers.find(p => p.platform === PLATFORM) ?? null);
    } catch (error) { setText(message(error)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function run(kind: "save" | "login" | "disconnect", task: () => Promise<unknown>, done: string) {
    setBusy(kind); setText("");
    try { await task(); setText(done); await load(); onChanged(); }
    catch (error) { setText(message(error)); }
    finally { setBusy(""); }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!clientId.trim()) return;
    const input = { clientId: clientId.trim(), redirectUri: provider?.redirectUri || REDIRECT, ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) };
    void run("save", () => invoke("oauth_save_client", { platform: PLATFORM, input }), "OAuth 클라이언트를 키체인에 저장했습니다. 이제 로그인하세요.").then(() => { setClientId(""); setClientSecret(""); });
  }
  if (!provider) return null;
  const connected = provider.connected && !provider.needsReconnect;
  return <details className="planner-calendar-connect" open={!connected}>
    <summary><CalendarDays size={14} aria-hidden="true" />Google Calendar 연결 {connected ? <span className="planner-ok"><Check size={12} />연결됨</span> : provider.needsReconnect ? <span className="planner-warn">다시 연결 필요</span> : <span>미연결</span>}</summary>
    <p>Studio가 만든 'Toris Studio' 캘린더 하나만 읽고 씁니다(calendar.app.created). 기존 캘린더는 보지 않습니다. 로그인은 시스템 브라우저에서 진행합니다.</p>
    {!provider.clientConfigured && <form onSubmit={save} className="planner-connect-form">
      <label>OAuth 클라이언트 ID<input value={clientId} autoComplete="off" spellCheck={false} onChange={event => setClientId(event.target.value)} placeholder="Google Cloud 데스크톱 앱 클라이언트" /></label>
      <label>클라이언트 보안 비밀 <small>선택</small><input type="password" value={clientSecret} autoComplete="new-password" spellCheck={false} onChange={event => setClientSecret(event.target.value)} /></label>
      <small>리디렉션 주소: <code>{REDIRECT}</code></small>
      <button className="social-button compact" disabled={!clientId.trim() || !!busy}>{busy === "save" ? <LoaderCircle size={14} className="social-spin" /> : <Check size={14} />}저장</button>
    </form>}
    <div className="planner-actions">
      {provider.clientConfigured && !connected && <button className="social-button compact primary" disabled={!!busy} onClick={() => void run("login", () => invoke("oauth_begin_login", { platform: PLATFORM }), "브라우저에서 로그인을 마친 뒤 '지금 동기화'를 누르세요.")}>{busy === "login" ? <LoaderCircle size={14} className="social-spin" /> : <LogIn size={14} />}Google 로그인</button>}
      {connected && <button className="social-button compact subtle" disabled={!!busy} onClick={() => void run("disconnect", () => invoke("oauth_disconnect", { platform: PLATFORM }), "Studio에 저장된 Google Calendar 연결을 해제했습니다.")}><Unplug size={14} />연결 해제</button>}
    </div>
    {text && <p role="status" className="planner-connect-status">{text}</p>}
  </details>;
}
