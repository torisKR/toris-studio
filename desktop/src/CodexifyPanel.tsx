import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, MessageSquare, RefreshCw, Save, Send } from "lucide-react";
import { codexifyOverlay } from "./codexify";
import { agentWaiting, bootstrapPrompt, connectedChatUrl, getProfile, profileKey, projectChats, receiptState, sendToConnectedChat } from "./codexify-client";
import type { ChatReceipt, ChatState, CodexifyChats, CodexifyConnection, CodexifyProfile } from "./codexify-client";
import { CodexifyRuntimePanel } from "./CodexifyRuntimePanel";
import { CodingProgressPanel } from "./CodingProgressPanel";
import { CodingDiagnosticsPanel } from "./CodingDiagnosticsPanel";
import { getProxyStatus } from "./codexify-runtime-client";
import type { CodexifyProxyStatus, ProxyProvider } from "./codexify-runtime-client";
import "./CodexifyPanel.css";

const emptyProfile: CodexifyProfile = { mcpUrl: "http://127.0.0.1:21228/mcp", pluginUrl: "", conversationUrl: "", projectRoot: "", conversationId: "" };
const receiptLabels = { saved: "앱 요청 저장됨", delivered: "ChatGPT 도구에 전달됨", read: "ChatGPT 도구 확인됨" };
function failure(error: unknown): string { return typeof error === "string" ? error : error instanceof Error ? error.message : "연결 요청을 처리하지 못했습니다."; }
function date(value: number | string | null | undefined): string { return value ? new Date(value).toLocaleString("ko-KR") : "기록 없음"; }

export function CodexifyPanel({ active, nativeMcpConfig, lastFileReceivedAt, lastToolCallAt, onIntegrationRefresh, refreshKey = 0 }: { active: boolean; nativeMcpConfig?: object; lastFileReceivedAt?: string | null; lastToolCallAt?: string | null; onIntegrationRefresh?: () => Promise<void>; refreshKey?: number }) {
  const [profile, setProfile] = useState<CodexifyProfile | null>(null);
  const [draft, setDraft] = useState(emptyProfile);
  const [connection, setConnection] = useState<CodexifyConnection | null>(null);
  const [chats, setChats] = useState<CodexifyChats | null>(null);
  const [state, setState] = useState<ChatState | null>(null);
  const [composer, setComposer] = useState("");
  const [receipt, setReceipt] = useState<ChatReceipt | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [notice, setNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newMessages, setNewMessages] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [observedAt, setObservedAt] = useState(0);
  const [diagnosticProxies, setDiagnosticProxies] = useState<Partial<Record<ProxyProvider, CodexifyProxyStatus>>>({});
  const [proxyObservedAt, setProxyObservedAt] = useState(0);
  const stateReceivedAt = useRef(0);
  const epoch = useRef(0), mounted = useRef(false), reading = useRef(false), acting = useRef(false);
  const needsCheck = useRef(true);
  const lastChecked = useRef(0);
  const saved = useRef<CodexifyProfile | null>(null);
  const sendId = useRef<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const dirty = profile != null && profileKey(draft) !== profileKey(profile);
  const visibleChats = projectChats(chats?.chats ?? [], draft.projectRoot);
  const projectName = draft.projectRoot.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "프로젝트";
  const waiting = state != null && !pollError && clock - observedAt <= 15_000 && agentWaiting({ ...state, server_time_ms: state.server_time_ms + Math.max(0, clock - stateReceivedAt.current) });

  const refresh = useCallback(async (includeConnection = false) => {
    if (reading.current || !saved.current || !mounted.current || document.visibilityState !== "visible") return;
    reading.current = true;
    const current = saved.current, generation = epoch.current;
    const check = includeConnection || needsCheck.current || Date.now() - lastChecked.current > 30000;
    try {
      const before = await getProfile();
      if (!mounted.current || generation !== epoch.current) return;
      if (profileKey(before) !== profileKey(current)) {
        ++epoch.current; saved.current = before; setProfile(before); setDraft(previous => profileKey(previous) === profileKey(current) ? before : previous);
        setState(null); setReceipt(null); setConnection(null); setChats(null); setObservedAt(0); setDiagnosticProxies({}); setProxyObservedAt(0); needsCheck.current = true;
        setPollError("다른 화면에서 연결 설정이 변경되었습니다. 새 연결을 다시 확인하세요.");
        return;
      }
      const results = await Promise.allSettled([
        invoke<CodexifyChats>("codexify_chats"),
        current.conversationId ? invoke<ChatState>("codexify_chat_read") : Promise.resolve(null),
        check ? invoke<CodexifyConnection>("codexify_connection_check") : Promise.resolve(null),
        check ? getProxyStatus("cloudflare") : Promise.resolve(null),
        check ? getProxyStatus("ngrok") : Promise.resolve(null),
      ]);
      if (!mounted.current || generation !== epoch.current) return;
      const after = await getProfile();
      if (!mounted.current || generation !== epoch.current) return;
      if (profileKey(after) !== profileKey(current)) {
        ++epoch.current; saved.current = after; setProfile(after); setDraft(previous => profileKey(previous) === profileKey(current) ? after : previous);
        setState(null); setReceipt(null); setConnection(null); setChats(null); setObservedAt(0); setDiagnosticProxies({}); setProxyObservedAt(0); needsCheck.current = true;
        setPollError("확인 중 연결 설정이 변경되었습니다. 새 연결을 다시 확인하세요.");
        return;
      }
      if (results[0].status === "fulfilled") setChats(results[0].value as CodexifyChats);
      if (results[1].status === "fulfilled") { stateReceivedAt.current = Date.now(); setObservedAt(stateReceivedAt.current); setClock(stateReceivedAt.current); setState(results[1].value as ChatState | null); }
      if (check && results[2].status === "fulfilled") { setConnection(results[2].value); needsCheck.current = false; lastChecked.current = Date.now(); }
      if (check && results[2].status === "rejected") { setConnection(null); needsCheck.current = true; }
      if (check) {
        const values: Partial<Record<ProxyProvider, CodexifyProxyStatus>> = {};
        for (const result of results.slice(3)) if (result.status === "fulfilled" && result.value) { const value = result.value as CodexifyProxyStatus; values[value.provider] = value; }
        setDiagnosticProxies(values); setProxyObservedAt(Date.now());
      }
      const failed = results.slice(0, 3).find(result => result.status === "rejected");
      setPollError(failed?.status === "rejected" ? failure(failed.reason) : "");
    } catch (reason) { if (mounted.current && generation === epoch.current) setPollError(failure(reason)); }
    finally { reading.current = false; }
  }, []);

  const runtimeChanged = useCallback(() => {
    needsCheck.current = true; setConnection(null); void refresh(true);
  }, [refresh]);

  useEffect(() => {
    if (!active) return;
    mounted.current = true;
    const generation = ++epoch.current;
    void getProfile().then(value => {
      if (!mounted.current || generation !== epoch.current) return;
      saved.current = value; setProfile(value); setDraft(value); setSettingsOpen(!value.projectRoot || !value.pluginUrl);
      void refresh(true);
    }).catch(reason => { if (mounted.current && generation === epoch.current) setError(failure(reason)); });
    const timer = setInterval(() => { setClock(Date.now()); if (!acting.current) void refresh(); }, 4000);
    const onVisibility = () => { if (document.visibilityState === "visible" && !acting.current) void refresh(true); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { mounted.current = false; ++epoch.current; clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [active, refresh, refreshKey]);

  useEffect(() => {
    if (!log.current) return;
    if (followTail.current) { log.current.scrollTop = log.current.scrollHeight; setNewMessages(false); }
    else setNewMessages(true);
  }, [state?.messages.at(-1)?.id]);

  async function run(label: string, work: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true; setBusy(label); setError(""); setNotice("");
    try { await work(); } catch (reason) { if (mounted.current) setError(failure(reason)); }
    finally { acting.current = false; if (mounted.current) setBusy(""); }
  }

  async function save(input: CodexifyProfile) {
    const result = await invoke<CodexifyProfile>("codexify_connection_save", { input });
    if (!mounted.current) return;
    ++epoch.current; needsCheck.current = true; saved.current = result; setProfile(result); setDraft(result); setState(null); setConnection(null); setChats(null); setReceipt(null); setObservedAt(0); setDiagnosticProxies({}); setProxyObservedAt(0); sendId.current = null;
    followTail.current = true; setNewMessages(false);
    setNotice("Codexify 연결 설정을 이 기기에 저장했습니다.");
    await refresh(true);
  }

  async function send() {
    if (dirty) throw new Error("변경한 연결 설정을 먼저 저장하세요.");
    const generation = epoch.current;
    sendId.current ??= crypto.randomUUID();
    const result = await sendToConnectedChat(composer, sendId.current, undefined, saved.current ?? undefined);
    if (!mounted.current || generation !== epoch.current) return;
    setReceipt(result.receipt); setComposer(""); sendId.current = null; followTail.current = true;
    setNotice(result.waiting ? "요청을 저장했습니다. ChatGPT 도구 전달과 응답을 아래 대화에서 확인하세요." : "요청을 저장했습니다. ChatGPT 대화에서 연결 시작 안내를 실행하면 대기 중인 요청을 읽을 수 있습니다.");
    await refresh();
  }

  if (!active) return null;
  return <section className="codexify-panel" aria-label="Codexify 앱 연결" aria-busy={Boolean(busy)}>
    <header className="codexify-heading"><div><span className="codexify-eyebrow">CHATGPT MCP</span><h2>앱에서 요청하고, 결과를 확인하세요</h2><p>등록한 Codexify 대화에 요청을 보내고 ChatGPT의 도구 응답을 이 화면에서 받습니다.</p></div><button className="social-button" disabled={!profile || Boolean(busy)} onClick={() => void run("연결 확인", async () => { await Promise.all([refresh(true), onIntegrationRefresh?.()]); })}><RefreshCw size={16}/>연결 확인</button></header>
    {(error || pollError) && <p className="social-notice error" role="alert">{error || pollError}</p>}
    {notice && <p className="social-notice success" role="status">{notice}</p>}
    {busy && <p className="codexify-working" role="status">{busy} 중…</p>}
    <CodingProgressPanel state={state} receipt={receipt} conversationSelected={Boolean(profile?.conversationId)} observedAt={observedAt} now={clock} error={pollError} selectedChat={chats?.chats.find(chat => chat.id === profile?.conversationId)} canStartChat={Boolean(profile?.projectRoot && (profile.pluginUrl || profile.conversationUrl) && !dirty)} actionBusy={Boolean(busy)} onOpenChat={() => void run("등록한 ChatGPT 열기", async () => { await invoke("open_external", { url: connectedChatUrl(profile!) }); })} onCopyStart={() => void run("연결 시작 안내 복사", async () => { await invoke("copy_text", { text: bootstrapPrompt(profile!) }); setNotice("연결 시작 안내를 복사했습니다. 등록한 플러그인을 선택한 ChatGPT 대화에 붙여넣으세요."); })} onShowChat={() => { document.getElementById("codexify-coding-chat")?.scrollIntoView({ block: "start", behavior: "auto" }); log.current?.focus(); }}/>
    <CodingDiagnosticsPanel profile={profile} connection={connection} state={state} pollError={pollError} observedAt={observedAt} now={clock} proxies={diagnosticProxies} proxyObservedAt={proxyObservedAt} lastFileReceivedAt={lastFileReceivedAt} lastToolCallAt={lastToolCallAt}/>
    <CodexifyRuntimePanel active={active} refreshKey={refreshKey} onRuntimeChange={runtimeChanged}/>
    <div className="codexify-body">
      <div className="codexify-setup">
        <details open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}><summary>연결 설정{dirty ? " · 저장하지 않은 변경" : ""}</summary>
          <form onSubmit={event => { event.preventDefault(); void run("연결 설정 저장", () => save(draft)); }}>
            <fieldset disabled={!profile || Boolean(busy)}>
              <label>로컬 MCP 주소<input aria-label="Codexify 로컬 MCP 주소" value={draft.mcpUrl} onChange={event => setDraft({ ...draft, mcpUrl: event.target.value })} spellCheck={false} required placeholder="http://127.0.0.1:21228/mcp"/></label>
              <label>등록한 ChatGPT 플러그인 주소<input aria-label="등록한 ChatGPT 플러그인 주소" value={draft.pluginUrl} onChange={event => setDraft({ ...draft, pluginUrl: event.target.value })} spellCheck={false} placeholder="https://chatgpt.com/plugins/…"/></label>
              <label>ChatGPT 대화 주소 · 선택<input aria-label="ChatGPT 대화 주소" value={draft.conversationUrl} onChange={event => setDraft({ ...draft, conversationUrl: event.target.value })} spellCheck={false} placeholder="https://chatgpt.com/c/…"/></label>
              <label>작업 프로젝트의 절대 경로<input aria-label="Codexify 작업 프로젝트" value={draft.projectRoot} onChange={event => setDraft({ ...draft, projectRoot: event.target.value, conversationId: "" })} spellCheck={false} required placeholder="프로젝트 폴더 경로"/></label>
              <button className="social-button primary" type="submit"><Save size={16}/>연결 설정 저장</button>
            </fieldset>
          </form>
        </details>
        <div className="codexify-start"><h3>ChatGPT 연결 시작</h3><p>등록된 플러그인을 선택한 ChatGPT 대화에서 연결 시작 안내를 실행하세요. 대화가 종료되면 다시 시작해야 합니다.</p><div className="codexify-actions"><button className="social-button" disabled={!profile || dirty || Boolean(busy)} onClick={() => void run("등록한 ChatGPT 열기", async () => { await invoke("open_external", { url: connectedChatUrl(profile!) }); })}><ExternalLink size={16}/>등록한 ChatGPT 열기</button><button className="social-button" disabled={!profile?.projectRoot || dirty || Boolean(busy)} onClick={() => void run("연결 시작 안내 복사", async () => { await invoke("copy_text", { text: bootstrapPrompt(profile!) }); setNotice("연결 시작 안내를 복사했습니다. 등록한 플러그인을 선택한 ChatGPT 대화에 붙여넣으세요."); })}><Copy size={16}/>연결 시작 안내 복사</button></div></div>
        <details className="codexify-advanced"><summary>설치 앱 MCP 설정 · 고급</summary><p>Codexify 도구 목록에 Studio 수신 도구가 없다면 기존 설정에 설치 앱 MCP를 연결해야 합니다.</p><div className="codexify-actions"><button className="social-button compact" disabled={!nativeMcpConfig || Boolean(busy)} onClick={() => void run("MCP 설정 복사", async () => { await invoke("copy_text", { text: JSON.stringify(nativeMcpConfig, null, 2) }); setNotice("설치된 앱의 MCP 실행 설정을 복사했습니다. Node.js나 개발 프로젝트 경로가 필요하지 않습니다."); })}>설치 앱 MCP 설정 복사</button><button className="social-button compact" disabled={!nativeMcpConfig || !profile?.projectRoot || dirty || Boolean(busy)} onClick={() => void run("Codexify 설정 복사", async () => { await invoke("copy_text", { text: JSON.stringify(codexifyOverlay(nativeMcpConfig, profile!.projectRoot), null, 2) }); setNotice("Codexify direct 설정 조각을 복사했습니다. 기존 인증과 다른 설정은 유지하며 병합하세요."); })}>Codexify direct 설정 복사</button></div><p>최근 실제 파일 수신: {date(lastFileReceivedAt)}</p></details>
      </div>
      <div className="codexify-chat" id="codexify-coding-chat">
        <div className="codexify-chat-top"><label>앱에 연결할 Codexify 대화<select aria-label="Codexify 연결 대화" value={draft.conversationId} disabled={!profile || dirty || Boolean(busy) || !draft.projectRoot} onChange={event => void run("대화 선택 저장", () => save({ ...draft, conversationId: event.target.value }))}><option value="">대화를 직접 선택하세요</option>{draft.conversationId && !visibleChats.some(chat => chat.id === draft.conversationId) && <option value={draft.conversationId}>저장된 대화 · 목록 확인 필요</option>}{visibleChats.map(chat => <option key={chat.id} value={chat.id}>{chat.title || "제목 없는 대화"} · {projectName}</option>)}</select></label><button className="social-button compact" disabled={!profile || Boolean(busy)} aria-label="Codexify 대화 목록 새로고침" onClick={() => void run("대화 목록 확인", () => refresh())}><RefreshCw size={16}/></button></div>
        <p className="codexify-note">저장한 프로젝트 경로와 일치하는 대화를 표시합니다. 사용할 ChatGPT 대화를 직접 선택하세요.</p>
        <div className="codexify-transcript" ref={log} role="log" aria-label="Codexify ChatGPT 대화 기록" aria-live="polite" aria-relevant="additions text" tabIndex={0} onScroll={event => { const box = event.currentTarget; followTail.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80; if (followTail.current) setNewMessages(false); }}>
          {!state?.messages.length && <div className="codexify-chat-empty"><MessageSquare size={24}/><strong>{profile?.conversationId ? "아직 대화 내용이 없습니다" : "ChatGPT 연결을 시작하고 대화를 선택하세요"}</strong><p>ChatGPT에서 chat_write로 전한 응답이 여기에 표시됩니다. 파일은 실제 Studio 수신이 완료되면 에셋 화면에 나타납니다.</p></div>}
          {state?.has_more && <p className="codexify-note">최근 메시지부터 표시합니다. 이전 내용은 ChatGPT 대화에서 확인하세요.</p>}
          {state?.messages.map(message => <article className={`codexify-message ${message.role}`} key={message.id}><div><strong>{message.role === "user" ? "내 요청" : message.role === "agent" ? "ChatGPT" : "연결 안내"}</strong>{message.created_at_ms != null && <time dateTime={new Date(message.created_at_ms).toISOString()}>{date(message.created_at_ms)}</time>}</div><p>{message.markdown}</p>{message.role === "user" && <small>{receiptLabels[receiptState(message, state)]}</small>}</article>)}
        </div>
        {newMessages && <button className="social-button compact codexify-new-messages" onClick={() => { followTail.current = true; if (log.current) log.current.scrollTop = log.current.scrollHeight; setNewMessages(false); }}>새 메시지로 이동</button>}
        {receipt && <p className="codexify-receipt" role="status"><Check size={14}/>{receiptLabels[receiptState(receipt, state)]} · 저장은 생성 완료를 뜻하지 않습니다.</p>}
        <form className="codexify-composer" onSubmit={event => { event.preventDefault(); void run("ChatGPT 요청 전송", send); }}>
          <label>ChatGPT에 요청<textarea aria-label="Codexify ChatGPT 요청" rows={3} value={composer} maxLength={24000} disabled={Boolean(busy)} onChange={event => { setComposer(event.target.value); sendId.current = null; }} placeholder="예: 이번 주 트렌드를 정리하고, 선택한 주제의 영상 장면과 썸네일을 만들어줘."/></label>
          <div><p>{waiting ? "ChatGPT가 앱 요청을 기다리고 있습니다." : "ChatGPT 대화가 종료된 상태에서는 요청을 저장하고, 대화에서 연결을 다시 시작해야 합니다."}</p><button className="social-button primary" type="submit" disabled={!profile?.conversationId || !connection?.ownerReady || Boolean(pollError) || dirty || !composer.trim() || Boolean(busy)}><Send size={16}/>앱 요청 보내기</button></div>
        </form>
      </div>
    </div>
  </section>;
}
