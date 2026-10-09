import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowUpRight, AtSign, Check, ChevronDown, CircleAlert, Clock3, KeyRound,
  LoaderCircle, LogIn, Music2, NotebookPen, RefreshCw, ShieldCheck, Unplug,
  Camera as Instagram, Video as Youtube
} from "lucide-react";
import type { SocialPlatform } from "./types";
import "./OAuthPanel.css";
import { ActivityStatus } from "./ActivityStatus";

type OAuthProviderStatus = {
  platform: SocialPlatform;
  label: string;
  clientConfigured: boolean;
  connected: boolean;
  expiresAt?: string | null;
  refreshable: boolean;
  needsReconnect: boolean;
  detail: string;
  redirectUri?: string | null;
  pending: boolean;
};
type OAuthStatus = { providers: OAuthProviderStatus[] };
type KeychainStatus = { blocked: boolean };
type OAuthAction = "save" | "login" | "complete" | "refresh" | "disconnect";
type OAuthNotice = { platform?: SocialPlatform; tone: "success" | "error" | "info"; text: string };
type ClientForm = { clientId: string; clientSecret: string; redirectUri: string };

const providerInfo = {
  youtube: { label: "YouTube", icon: Youtube, description: "YouTube 계정의 읽기 권한을 연결합니다. 공개 성과·영상은 YouTube 관리에서 API 키로 조회하세요.", setup: "Google Cloud에서 데스크톱 앱용 OAuth 클라이언트를 등록하세요.", https: false },
  threads: { label: "Threads", icon: AtSign, description: "계정 기본 권한으로 연결합니다. 게시·자동 발행 권한은 요청하지 않습니다.", setup: "Meta 개발자 앱에서 Threads 로그인과 승인된 HTTPS 리디렉션 주소를 등록하세요.", https: true },
  naver_blog: { label: "네이버 블로그", icon: NotebookPen, description: "네이버 계정 로그인 연결입니다. 블로그 자동 발행 권한은 포함되지 않습니다.", setup: "네이버 개발자센터에서 네이버 로그인 앱과 콜백 주소를 등록하세요. 검색 API 설정과 별개입니다.", https: false },
  tiktok: { label: "TikTok", icon: Music2, description: "계정 기본 정보 권한으로 연결합니다. 동영상 업로드 권한은 요청하지 않습니다.", setup: "TikTok 개발자 앱에 데스크톱 Login Kit와 리디렉션 주소를 등록하세요.", https: false },
  instagram: { label: "Instagram", icon: Instagram, description: "비즈니스·크리에이터 계정의 기본 권한을 연결합니다. 개인 계정은 지원되지 않습니다.", setup: "Meta 개발자 앱에서 Instagram 로그인과 승인된 HTTPS 리디렉션 주소를 등록하세요.", https: true }
} satisfies Record<SocialPlatform, { label: string; icon: typeof Youtube; description: string; setup: string; https: boolean }>;
const providerOrder: SocialPlatform[] = ["youtube", "threads", "naver_blog", "tiktok", "instagram"];
const setupGuides: Partial<Record<SocialPlatform, string>> = {
  youtube: "https://developers.google.com/identity/protocols/oauth2/native-app",
  naver_blog: "https://developers.naver.com/docs/login/devguide/devguide.md",
  tiktok: "https://developers.tiktok.com/docs/en/login-kit-desktop"
};

function redirectDefault(platform: SocialPlatform) {
  return providerInfo[platform].https ? "" : `http://127.0.0.1:38471/oauth/${platform}/callback`;
}
function blankClient(platform: SocialPlatform, status: OAuthProviderStatus): ClientForm {
  return { clientId: "", clientSecret: "", redirectUri: status.redirectUri ?? redirectDefault(platform) };
}
function failure(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "SNS 연결을 처리하지 못했습니다.";
}
function expiry(value?: string | null) {
  if (!value) return "플랫폼 응답에 만료 일시 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "만료 일시 확인 필요";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date);
}
function connectionLabel(status: OAuthProviderStatus) {
  return status.pending ? "로그인 대기" : status.needsReconnect ? "다시 로그인 필요" : status.connected ? "연결됨" : status.clientConfigured ? "로그인 필요" : "앱 설정 필요";
}

function ProviderCard({ status, active, busy, storageLocked, notice, onAction }: {
  status: OAuthProviderStatus;
  active: boolean;
  busy: { platform: SocialPlatform; action: OAuthAction } | null;
  storageLocked: boolean;
  notice: OAuthNotice | null;
  onAction: (platform: SocialPlatform, action: OAuthAction, input?: Record<string, string>) => Promise<boolean>;
}) {
  const info = providerInfo[status.platform];
  const Icon = info.icon;
  const [setupOpen, setSetupOpen] = useState(false);
  const [form, setForm] = useState(() => blankClient(status.platform, status));
  const [callbackUrl, setCallbackUrl] = useState("");
  const [inputError, setInputError] = useState("");
  const noticeRegion = useRef<HTMLDivElement>(null);
  const currentBusy = busy?.platform === status.platform ? busy.action : null;
  const disabled = !!busy || storageLocked;
  const providerNotice: OAuthNotice | null = inputError ? { platform: status.platform, tone: "error", text: inputError } : notice?.platform === status.platform ? notice : null;

  useEffect(() => {
    if (!active) {
      setSetupOpen(false);
      setForm(blankClient(status.platform, status));
      setCallbackUrl("");
      setInputError("");
    }
  }, [active, status.platform, status.redirectUri]);
  useEffect(() => {
    if (active && providerNotice) {
      noticeRegion.current?.focus({ preventScroll: true });
      noticeRegion.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }, [active, providerNotice?.text]);

  function toggleSetup() {
    setInputError("");
    setForm(blankClient(status.platform, status));
    setSetupOpen((current) => !current);
  }
  async function startLogin(browser: "system" | "aside" = "system") {
    setInputError("");
    if (!status.clientConfigured) {
      setSetupOpen(true);
      setInputError(`${info.label} 로그인을 시작하려면 아래 OAuth 앱 설정을 먼저 저장하세요.${status.platform === "youtube" ? " 수집용 API 키는 계정 로그인에 사용할 수 없습니다." : status.platform === "naver_blog" ? " 네이버 검색 API 설정과 계정 로그인 앱 설정은 별개입니다." : ""}`);
      return;
    }
    if (await onAction(status.platform, "login", { browser })) setCallbackUrl("");
  }
  async function openSetupGuide() {
    const url = setupGuides[status.platform];
    if (!url) return;
    setInputError("");
    try { await invoke("open_external", { url }); }
    catch (reason) { setInputError(failure(reason)); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInputError("");
    if (!status.clientConfigured && !form.clientId.trim()) {
      setInputError(`${info.label} 개발자 앱에서 발급받은 클라이언트 ID를 입력하세요.`);
      return;
    }
    if (!status.clientConfigured && status.platform !== "youtube" && !form.clientSecret.trim()) {
      setInputError(`${info.label} 개발자 앱의 클라이언트 시크릿을 입력하세요.`);
      return;
    }
    if (!event.currentTarget.checkValidity() || !form.redirectUri.trim()) {
      setInputError("등록한 리디렉션 주소를 http:// 또는 https://부터 전체 입력하세요.");
      return;
    }
    const input: Record<string, string> = {};
    for (const key of ["clientId", "clientSecret", "redirectUri"] as const) {
      if (form[key].trim()) input[key] = form[key].trim();
    }
    const success = await onAction(status.platform, "save", input);
    if (success) {
      setForm((current) => ({ ...current, clientId: "", clientSecret: "" }));
      setSetupOpen(false);
    }
  }
  async function complete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInputError("");
    if (!callbackUrl.trim()) {
      setInputError("브라우저에서 로그인 후 이동한 전체 주소를 입력하세요.");
      return;
    }
    if (await onAction(status.platform, "complete", { callbackUrl: callbackUrl.trim() })) setCallbackUrl("");
  }

  return <article className="desktop-oauth-card" aria-labelledby={`oauth-title-${status.platform}`}>
    <div className="desktop-oauth-card-heading">
      <span className={`social-platform-mark ${status.platform}`}><Icon size={22} aria-hidden="true" /></span>
      <div><h2 id={`oauth-title-${status.platform}`}>{info.label}</h2><span className={`desktop-oauth-state ${status.needsReconnect ? "reconnect" : status.pending ? "pending" : status.connected ? "connected" : ""}`}><i aria-hidden="true" />{connectionLabel(status)}</span></div>
      <button type="button" className="social-button compact subtle desktop-oauth-setup-toggle" disabled={disabled} onClick={toggleSetup} aria-expanded={setupOpen} aria-controls={`oauth-setup-${status.platform}`}><KeyRound size={14} /><span>앱 설정</span><ChevronDown size={13} className={setupOpen ? "open" : ""} /></button>
    </div>
    <p className="desktop-oauth-description">{info.description}</p>
    <p className="desktop-oauth-detail">{status.detail}</p>
    {(status.connected || status.needsReconnect || status.expiresAt) && <dl className="desktop-oauth-session"><div><dt><Clock3 size={13} aria-hidden="true" />토큰 만료 (KST)</dt><dd>{expiry(status.expiresAt)}</dd></div><div><dt>연결 갱신</dt><dd>{status.refreshable ? "플랫폼 갱신 토큰 사용" : "필요할 때 다시 로그인"}</dd></div></dl>}

    {providerNotice && <div ref={noticeRegion} tabIndex={-1} className={`social-notice ${providerNotice.tone}`} role={providerNotice.tone === "error" ? "alert" : "status"}>{providerNotice.tone === "error" ? <CircleAlert size={16} /> : providerNotice.tone === "success" ? <Check size={16} /> : <ShieldCheck size={16} />}<span>{providerNotice.text}</span></div>}

    {setupOpen && <form id={`oauth-setup-${status.platform}`} className="desktop-oauth-setup" onSubmit={(event) => void save(event)} noValidate autoComplete="off">
      <p>{info.setup}</p>
      {setupGuides[status.platform] && <button type="button" className="social-button compact subtle" disabled={disabled} onClick={() => void openSetupGuide()}><ArrowUpRight size={13} aria-hidden="true" />공식 OAuth 설정 안내</button>}
      <fieldset disabled={disabled}>
        <label htmlFor={`oauth-client-${status.platform}`}>클라이언트 ID {status.clientConfigured && <small>변경할 때만 입력</small>}</label>
        <input id={`oauth-client-${status.platform}`} type="password" autoComplete="new-password" spellCheck={false} value={form.clientId} onChange={(event) => setForm((current) => ({ ...current, clientId: event.target.value }))} placeholder={status.clientConfigured ? "빈 입력은 저장된 ID 유지" : "등록한 앱의 클라이언트 ID"} required={!status.clientConfigured} maxLength={2000} />
        <label htmlFor={`oauth-secret-${status.platform}`}>클라이언트 시크릿 {status.platform === "youtube" && <small>발급된 경우만</small>}</label>
        <input id={`oauth-secret-${status.platform}`} type="password" autoComplete="new-password" spellCheck={false} value={form.clientSecret} onChange={(event) => setForm((current) => ({ ...current, clientSecret: event.target.value }))} placeholder={status.clientConfigured ? "빈 입력은 저장된 시크릿 유지" : "등록한 앱의 클라이언트 시크릿"} required={status.platform !== "youtube" && !status.clientConfigured} maxLength={4000} />
        <label htmlFor={`oauth-redirect-${status.platform}`}>등록한 리디렉션 주소</label>
        <input id={`oauth-redirect-${status.platform}`} type="url" autoComplete="off" spellCheck={false} value={form.redirectUri} onChange={(event) => setForm((current) => ({ ...current, redirectUri: event.target.value }))} placeholder={info.https ? "등록한 https:// 주소" : redirectDefault(status.platform)} required maxLength={2000} aria-describedby={`oauth-redirect-help-${status.platform}`} />
        <p id={`oauth-redirect-help-${status.platform}`} className="social-form-hint">{info.https ? "Meta 앱에 등록한 HTTPS 주소와 정확히 같아야 합니다. 로그인 후 이동한 전체 주소를 아래에 붙여넣어 연결을 완료합니다." : "플랫폼 앱에 등록한 주소와 정확히 같아야 합니다. 기본 로컬 주소를 사용하면 로그인 완료를 자동으로 받습니다."}</p>
        <div className="desktop-oauth-save"><span>입력한 비밀 정보는 저장 후 다시 표시하지 않습니다.</span><button type="submit" className="social-button compact">{currentBusy === "save" ? <LoaderCircle size={14} className="social-spin" /> : <Check size={14} />}{currentBusy === "save" ? "저장 중" : "앱 설정 저장"}</button></div>
      </fieldset>
    </form>}

    {status.pending && <div className="desktop-oauth-pending">
      <ActivityStatus title={`${info.label} 브라우저 로그인 대기`} state="waiting" clock={false} detail={info.https ? "브라우저에서 로그인 후 이동한 전체 주소를 아래에 붙여넣으세요." : "기본 로컬 콜백 주소를 사용하면 인증 응답 수신 후 연결이 반영됩니다. 로그인 요청은 5분 뒤 만료됩니다."}/>
      <form onSubmit={(event) => void complete(event)} autoComplete="off"><label htmlFor={`oauth-callback-${status.platform}`}>로그인 후 이동한 전체 주소 <small>{info.https ? "필수" : "자동 연결이 안 될 때"}</small></label><div><input id={`oauth-callback-${status.platform}`} type="password" autoComplete="new-password" spellCheck={false} value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder="등록한 리디렉션 주소로 이동한 URL 전체" required disabled={disabled} maxLength={8192} /><button type="submit" className="social-button compact" disabled={disabled || !callbackUrl.trim()}>{currentBusy === "complete" ? <LoaderCircle size={14} className="social-spin" /> : <Check size={14} />}연결 완료</button></div></form>
    </div>}

    <div className="desktop-oauth-actions">
      <button type="button" className="social-button primary compact" disabled={disabled} onClick={() => void startLogin()}>{currentBusy === "login" ? <LoaderCircle size={15} className="social-spin" /> : <LogIn size={15} />}{!status.clientConfigured ? "로그인 설정 시작" : status.pending ? "로그인 다시 시작" : status.connected || status.needsReconnect ? "다시 로그인" : "브라우저에서 로그인"}<ArrowUpRight size={13} aria-hidden="true" /></button>
      <button type="button" className="social-button compact" disabled={disabled} onClick={() => void startLogin("aside")}><ArrowUpRight size={14} aria-hidden="true" />Aside로 로그인</button>
      <button type="button" className="social-button compact" disabled={disabled || !status.refreshable || status.needsReconnect} onClick={() => void onAction(status.platform, "refresh")}>{currentBusy === "refresh" ? <LoaderCircle size={14} className="social-spin" /> : <RefreshCw size={14} />}연결 갱신</button>
      {(status.connected || status.needsReconnect || status.pending || status.expiresAt) && <button type="button" className="social-button subtle compact desktop-oauth-disconnect" disabled={disabled} onClick={() => void onAction(status.platform, "disconnect")}>{currentBusy === "disconnect" ? <LoaderCircle size={14} className="social-spin" /> : <Unplug size={14} />}저장된 연결 해제</button>}
    </div>
    {!status.clientConfigured && !setupOpen && <p className="desktop-oauth-setup-hint">앱 설정에 직접 등록한 OAuth 클라이언트를 입력한 뒤 로그인하세요.</p>}
  </article>;
}

export function OAuthPanel({ active }: { active: boolean }) {
  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<{ platform: SocialPlatform; action: OAuthAction } | null>(null);
  const [notice, setNotice] = useState<OAuthNotice | null>(null);
  const [error, setError] = useState("");
  const [keychainBlocked, setKeychainBlocked] = useState(false);
  const [keychainRetryBusy, setKeychainRetryBusy] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const generation = useRef(0);
  const statusRequest = useRef(false);
  const actionRequest = useRef(false);
  const keychainRetryRequest = useRef(false);
  const checkKeychainStatus = useCallback(async (requestGeneration = generation.current) => {
    // The status command reads a flag; it never retries OS authorization during polling.
    const next = await invoke<KeychainStatus>("get_keychain_status");
    if (generation.current === requestGeneration) setKeychainBlocked(next.blocked);
    return next.blocked;
  }, []);
  const reload = useCallback(async (showLoading = false) => {
    if (statusRequest.current || actionRequest.current || keychainRetryRequest.current) return;
    statusRequest.current = true;
    setCheckingStatus(true);
    const requestGeneration = generation.current;
    if (showLoading) setLoading(true);
    try {
      if (await checkKeychainStatus(requestGeneration) || generation.current !== requestGeneration) return;
      const next = await invoke<OAuthStatus>("oauth_status");
      await checkKeychainStatus(requestGeneration);
      if (generation.current === requestGeneration) { setStatus(next); setError(""); }
    } catch (reason) {
      try { await checkKeychainStatus(requestGeneration); } catch { /* Keep the last known permission state. */ }
      if (generation.current === requestGeneration) setError(failure(reason));
    } finally { statusRequest.current = false; setCheckingStatus(false); setLoading(false); }
  }, [checkKeychainStatus]);
  useEffect(() => {
    if (!active) return;
    void reload(true);
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, reload]);
  const pending = status?.providers.some((provider) => provider.pending) ?? false;
  useEffect(() => {
    if (!active || !pending || keychainBlocked || keychainRetryBusy) return;
    const interval = window.setInterval(() => void reload(), 10000);
    return () => window.clearInterval(interval);
  }, [active, pending, keychainBlocked, keychainRetryBusy, reload]);

  async function action(platform: SocialPlatform, kind: OAuthAction, input?: Record<string, string>): Promise<boolean> {
    if (actionRequest.current || statusRequest.current || keychainRetryRequest.current || keychainBlocked) return false;
    actionRequest.current = true;
    generation.current += 1;
    setBusy({ platform, action: kind }); setNotice(null); setError("");
    try {
      if (kind === "login") {
        // Rust opens the validated official login URL. Authorization URLs and tokens are not kept in UI state.
        const browser = input?.browser === "aside" ? "aside" : "system";
        await invoke("oauth_begin_login", { platform, browser });
        setNotice({ platform, tone: "info", text: `${browser === "aside" ? "Aside" : "기본 브라우저"}에서 로그인을 완료하세요. 연결 상태는 자동으로 확인합니다.` });
      } else {
        const command = { save: "oauth_save_client", complete: "oauth_complete_login", refresh: "oauth_refresh_session", disconnect: "oauth_disconnect" }[kind];
        setStatus(await invoke<OAuthStatus>(command, { platform, ...(input ? { input } : {}) }));
        setNotice({ platform, tone: "success", text: {
          save: "OAuth 앱 설정을 내 기기에 저장했습니다. 브라우저에서 로그인하세요.",
          complete: "계정 연결을 저장했습니다. 다음 실행에도 연결을 불러옵니다.",
          refresh: "플랫폼에서 연결 토큰을 갱신했습니다.",
          disconnect: "Toris Studio에 저장된 계정 연결을 해제했습니다. 브라우저 로그인은 유지됩니다."
        }[kind] });
      }
      return true;
    } catch (reason) { setNotice({ platform, tone: "error", text: failure(reason) }); return false; }
    finally {
      try { await checkKeychainStatus(); } catch { /* The action's feedback remains visible. */ }
      actionRequest.current = false; setBusy(null);
      void reload();
    }
  }
  async function retryKeychainAccess() {
    if (keychainRetryRequest.current || actionRequest.current || statusRequest.current) return;
    keychainRetryRequest.current = true;
    generation.current += 1;
    setKeychainRetryBusy(true); setNotice(null); setError("");
    try {
      await invoke("retry_keychain_access");
      if (await checkKeychainStatus()) throw new Error("저장소 접근이 아직 차단되어 있습니다. 운영체제의 권한 창에서 Toris Studio의 접근을 허용한 뒤 다시 확인하세요.");
      const next = await invoke<OAuthStatus>("oauth_status");
      if (await checkKeychainStatus()) throw new Error("저장된 SNS 연결을 불러오는 중 저장소 접근이 차단되었습니다. 권한을 허용한 뒤 다시 확인하세요.");
      // Keep provider cards mounted so their unfinished client/callback inputs survive a retry.
      setStatus(next);
      setNotice({ tone: "success", text: "저장소 권한을 확인하고 SNS 연결 상태를 다시 불러왔습니다. 입력 중인 앱 설정은 유지했습니다." });
    } catch (reason) {
      setError(failure(reason));
      try { await checkKeychainStatus(); } catch { /* Keep the last known permission state. */ }
    } finally {
      keychainRetryRequest.current = false;
      setKeychainRetryBusy(false);
    }
  }

  const connected = status?.providers.filter((provider) => provider.connected && !provider.needsReconnect).length ?? 0;
  const controlsBusy = loading || checkingStatus || !!busy || keychainRetryBusy;
  return <div className="desktop-oauth">
    <div className="desktop-oauth-intro"><ShieldCheck size={22} aria-hidden="true" /><div><strong>내 기기에 안전하게 저장하는 SNS 연결</strong><p>토큰과 앱 비밀키는 macOS 키체인·Windows 자격 증명에 보관합니다. 저장소 권한은 Toris Studio가 보관한 앱 설정과 계정 연결을 읽고 저장할 때 사용합니다. 브라우저 로그인 쿠키는 브라우저가 관리하며, Toris Studio는 OAuth 연결을 저장합니다.</p></div></div>
    {(keychainBlocked || keychainRetryBusy) && <div className="social-notice error" role="alert" style={{ flexWrap: "wrap" }}><KeyRound size={17} aria-hidden="true" /><span>{keychainRetryBusy ? "운영체제에서 Toris Studio의 저장소 권한을 확인하고 있습니다." : "저장소 접근이 차단되어 저장된 SNS 연결을 읽거나 저장할 수 없습니다. 입력 중인 앱 설정은 유지됩니다."}</span><button type="button" className="social-button compact" disabled={controlsBusy} onClick={() => void retryKeychainAccess()}>{keychainRetryBusy ? <LoaderCircle size={15} className="social-spin" /> : <RefreshCw size={15} />}{keychainRetryBusy ? "권한 확인 중" : "저장소 권한 다시 확인"}</button></div>}
    <div className="desktop-oauth-summary"><span>계정 연결 <strong>{connected}</strong><small>/ 5</small></span><button type="button" className="social-button compact" disabled={controlsBusy} onClick={() => void reload(true)}><RefreshCw size={14} className={loading ? "social-spin" : ""} />{loading ? "확인 중" : "연결 상태 확인"}</button></div>
    {error && <div className="social-notice error" role="alert"><CircleAlert size={17} /><span>{error}{status ? " 이전 연결 상태가 표시됩니다." : ""}</span><button type="button" className="social-button compact" disabled={controlsBusy} onClick={() => void reload(true)}>다시 확인</button></div>}
    {notice && !notice.platform && <div className={`social-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.tone === "error" ? <CircleAlert size={17} /> : <Check size={17} />}<span>{notice.text}</span></div>}
    {!status && loading ? <ActivityStatus title="저장된 SNS 연결을 확인하는 중" detail="OS 저장소의 연결 상태를 읽습니다. 계정 정보와 인증 토큰은 이 상태 표시에 노출되지 않습니다."/> : status ? <div className="desktop-oauth-providers">{providerOrder.map((platform) => {
      const provider = status.providers.find((item) => item.platform === platform);
      return provider ? <ProviderCard key={platform} status={provider} active={active} busy={busy} storageLocked={keychainBlocked || keychainRetryBusy || checkingStatus} notice={notice} onAction={action} /> : null;
    })}</div> : null}
    <div className="desktop-oauth-footnote"><Clock3 size={17} aria-hidden="true" /><div><p>갱신은 플랫폼이 허용하는 유효 기간과 권한을 따릅니다. 권한 철회·갱신 토큰 만료 시 다시 로그인해야 합니다. 브라우저 쿠키의 만료를 연장하지는 않습니다.</p><p>저장된 연결 해제는 Toris Studio의 연결만 삭제합니다. 브라우저 계정 로그아웃이나 플랫폼 앱 권한 철회는 각 SNS에서 진행하세요.</p></div></div>
  </div>;
}
