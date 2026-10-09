import { invoke } from "@tauri-apps/api/core";
import { ActivityStatus } from "./ActivityStatus";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Check, CircleAlert, Database, Download, ExternalLink, Eye, EyeOff, KeyRound, LoaderCircle, Play, RefreshCw, ShieldCheck, Sparkles, Timer } from "lucide-react";
import { External } from "./External";
import { UpdatePanel } from "./UpdatePanel";

export type PublicSettings = {
  databaseConfigured: boolean;
  opencodexBaseUrl: string;
  opencodexModel: string;
  opencodexAllowedModels: string[];
  teamclaudeBaseUrl?: string | null;
  teamclaudeModel?: string | null;
  teamclaudeAllowedModels?: string[];
  youtubeConfigured: boolean;
  naverConfigured: boolean;
  savedCollectionKeys?: { youtubeApiKey: boolean; naverClientId: boolean; naverClientSecret: boolean };
  configPath: string;
  schedulerEnabled: boolean;
  claudeCliEnabled?: boolean;
  claudeCliPath?: string | null;
};
type SchedulerStatus = {
  enabled: boolean;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  running: boolean;
};
type SettingsForm = {
  databaseUrl: string;
  opencodexBaseUrl: string;
  opencodexModel: string;
  opencodexAllowedModels: string;
  opencodexApiKey: string;
  teamclaudeBaseUrl: string;
  teamclaudeModel: string;
  teamclaudeAllowedModels: string;
  teamclaudeApiKey: string;
  youtubeApiKey: string;
  naverClientId: string;
  naverClientSecret: string;
  claudeCliEnabled: boolean;
};
type CollectionSecretKey = "youtubeApiKey" | "naverClientId" | "naverClientSecret";
type KeychainStatus = { blocked: boolean };

function CollectionSecretField({ secretKey, id, label, value, configured, locked, resetToken, onChange, onStorageChecked }: {
  secretKey: CollectionSecretKey; id: string; label: string; value: string;
  configured: boolean; locked: boolean; resetToken: number; onChange: (value: string) => void;
  onStorageChecked: () => void;
}) {
  const [savedValue, setSavedValue] = useState<string | null>(null);
  const [inputVisible, setInputVisible] = useState(false);
  const [reading, setReading] = useState(false);
  const [readNotice, setReadNotice] = useState("");
  const request = useRef(0);

  useEffect(() => {
    request.current += 1;
    setSavedValue(null); setInputVisible(false); setReading(false); setReadNotice("");
    return () => { request.current += 1; };
  }, [resetToken]);
  useEffect(() => { if (!value) setInputVisible(false); }, [value]);
  useEffect(() => {
    if (!locked) return;
    request.current += 1;
    setSavedValue(null); setInputVisible(false); setReading(false);
  }, [locked]);

  async function toggleSavedValue() {
    if (savedValue !== null) {
      request.current += 1; setSavedValue(null); setReadNotice("");
      return;
    }
    const currentRequest = ++request.current;
    setReading(true); setReadNotice("");
    try {
      const saved = await invoke<string | null>("get_saved_collection_secret", { key: secretKey });
      if (currentRequest !== request.current) return;
      if (saved === null) setReadNotice("이 항목에 저장된 값이 없습니다. 아래에 새 값을 입력한 뒤 설정을 저장하세요.");
      else setSavedValue(saved);
    } catch (reason) {
      if (currentRequest === request.current) setReadNotice(`저장된 값을 불러오지 못했습니다. ${failure(reason)}`);
    } finally {
      if (currentRequest === request.current) setReading(false);
      onStorageChecked();
    }
  }

  return <div>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 17 }}>
      <label htmlFor={`${id}-saved`} style={{ margin: 0 }}>{label} <small>저장된 값</small></label>
      <span className={`social-state-label ${configured ? "ready" : "unconfigured"}`}>{configured ? "저장됨" : "미등록"}</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
      <input id={`${id}-saved`} aria-label={`${label} 저장된 값`} readOnly type={savedValue === null ? "password" : "text"} value={savedValue ?? (configured ? "••••••••" : "")} placeholder="저장된 값 없음" autoComplete="off" spellCheck={false} style={{ flex: 1, minWidth: 0 }} />
      <button type="button" className="social-button compact" disabled={locked || reading} aria-label={`${label} 저장된 값 ${savedValue === null ? "보기" : "숨기기"}`} aria-pressed={savedValue !== null} onClick={() => void toggleSavedValue()}>{reading ? <LoaderCircle size={16} className="social-spin" /> : savedValue === null ? <Eye size={16} /> : <EyeOff size={16} />}{reading ? "확인 중" : savedValue === null ? "보기" : "숨기기"}</button>
    </div>
    {readNotice && <p className="social-form-hint" role="status">{readNotice}</p>}
    <label htmlFor={id}>{label} <small>변경할 때만 입력</small></label>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <input id={id} aria-label={`${label} 변경 입력`} type={inputVisible ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} placeholder={configured ? "비워 두면 저장된 값 유지" : "새 값을 입력하세요"} maxLength={2000} autoComplete="new-password" spellCheck={false} style={{ flex: 1, minWidth: 0 }} />
      <button type="button" className="social-button compact" disabled={locked || !value} aria-label={`${label} 변경 입력 ${inputVisible ? "숨기기" : "보기"}`} aria-pressed={inputVisible} onClick={() => setInputVisible((visible) => !visible)}>{inputVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button>
    </div>
    {value.trim() && <p className="social-form-hint">변경 입력 · 설정 저장을 누르면 이 값으로 변경됩니다.</p>}
  </div>;
}

function makeForm(settings: PublicSettings): SettingsForm {
  return {
    databaseUrl: "", opencodexBaseUrl: settings.opencodexBaseUrl,
    opencodexModel: settings.opencodexModel,
    opencodexAllowedModels: settings.opencodexAllowedModels.join(", "),
    opencodexApiKey: "", teamclaudeBaseUrl: settings.teamclaudeBaseUrl ?? "",
    teamclaudeModel: settings.teamclaudeModel ?? "", teamclaudeAllowedModels: (settings.teamclaudeAllowedModels ?? []).join(", "), teamclaudeApiKey: "",
    youtubeApiKey: "", naverClientId: "", naverClientSecret: "",
    claudeCliEnabled: settings.claudeCliEnabled ?? false
  };
}
function failure(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "설정을 처리하지 못했습니다.";
}
function displayDate(value: string | null) {
  if (!value) return "기록 없음";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "확인 필요" : new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date);
}

export function SettingsPanel({ onSaved, databaseConnected }: { onSaved: () => void; databaseConnected: boolean }) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [schedulerBusy, setSchedulerBusy] = useState(false);
  const [databaseBusy, setDatabaseBusy] = useState<"start" | "backup" | null>(null);
  const [backup, setBackup] = useState<{ path: string; bytes: number } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [followupNotice, setFollowupNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [secretResetToken, setSecretResetToken] = useState(0);
  const [keychainBlocked, setKeychainBlocked] = useState(false);
  const [keychainRetryBusy, setKeychainRetryBusy] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const keychainRetryRequest = useRef(false);
  const dirtyFields = useRef(new Set<keyof SettingsForm>());
  const feedback = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error || notice) {
      feedback.current?.focus({ preventScroll: true });
      feedback.current?.scrollIntoView({ block: "nearest" });
    }
  }, [error, notice]);

  const applySavedSettings = useCallback((next: PublicSettings, preserveInputs = true) => {
    const touched = preserveInputs ? [...dirtyFields.current] : [];
    setSettings(next);
    setForm((current) => ({
      ...makeForm(next),
      ...(current ? Object.fromEntries(touched.map((key) => [key, current[key]])) : {})
    }));
  }, []);
  const checkKeychainStatus = useCallback(async () => {
    const next = await invoke<KeychainStatus>("get_keychain_status");
    setKeychainBlocked(next.blocked);
    return next.blocked;
  }, []);
  const refreshKeychainStatus = useCallback(() => {
    // This reads the Rust permission flag. Only the explicit retry button asks the OS for access.
    void checkKeychainStatus().catch(() => {});
  }, [checkKeychainStatus]);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    const result = await Promise.allSettled([
      invoke<PublicSettings>("get_settings"), invoke<SchedulerStatus>("get_scheduler_status"), checkKeychainStatus()
    ]);
    if (result[0].status === "fulfilled") {
      applySavedSettings(result[0].value);
    } else setError(failure(result[0].reason));
    if (result[1].status === "fulfilled") setScheduler(result[1].value);
    else { const reason = result[1].reason; setError((current) => [current, failure(reason)].filter(Boolean).join(" ")); }
    if (result[2].status === "rejected") setFollowupNotice("저장소 권한 상태를 확인하지 못했습니다. 화면을 다시 열어 확인하세요.");
    setLoading(false);
  }, [applySavedSettings, checkKeychainStatus]);
  useEffect(() => { void load(); }, [load]);

  function update(key: keyof SettingsForm, value: string | boolean) {
    dirtyFields.current.add(key);
    setForm((current) => current ? { ...current, [key]: value } : current);
    setNotice("");
    setFollowupNotice("");
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || busy || schedulerBusy || databaseBusy || keychainRetryRequest.current || keychainBlocked || updateInstalling) return;
    setError(""); setNotice(""); setFollowupNotice("");
    if (!event.currentTarget.checkValidity()) {
      setError("필수 입력란과 연결 주소 형식을 확인하세요. 저장하지 않았습니다.");
      event.currentTarget.reportValidity();
      return;
    }
    setBusy(true);
    setSecretResetToken((current) => current + 1);
    try {
      const input: Record<string, unknown> = {
        opencodexBaseUrl: form.opencodexBaseUrl.trim(),
        opencodexModel: form.opencodexModel.trim(),
        opencodexAllowedModels: form.opencodexAllowedModels.split(",").map((model) => model.trim()).filter(Boolean),
        teamclaudeBaseUrl: form.teamclaudeBaseUrl.trim(),
        teamclaudeModel: form.teamclaudeModel.trim(),
        teamclaudeAllowedModels: form.teamclaudeAllowedModels.split(",").map((model) => model.trim()).filter(Boolean),
        claudeCliEnabled: form.claudeCliEnabled
      };
      // Unfilled secret fields are omitted; Rust preserves the saved values.
      for (const key of ["databaseUrl", "opencodexApiKey", "teamclaudeApiKey", "youtubeApiKey", "naverClientId", "naverClientSecret"] as const) {
        const value = form[key].trim();
        if (value) input[key] = value;
      }
      const next = await invoke<PublicSettings>("save_settings", { input });
      dirtyFields.current.clear();
      applySavedSettings(next, false);
      setSecretResetToken((current) => current + 1);
      setNotice("내 기기의 설정을 저장했습니다. DB 연결과 ChatGPT 수신 상태는 각 화면에서 확인할 수 있습니다.");
      onSaved();
      try { setScheduler(await invoke<SchedulerStatus>("get_scheduler_status")); }
      catch { setFollowupNotice("설정은 저장되었습니다. 자동 수집 상태를 불러오지 못했으므로 아래의 상태 확인 버튼을 눌러 주세요."); }
    } catch (reason) { setError(failure(reason)); }
    finally { refreshKeychainStatus(); setBusy(false); }
  }
  async function setCollection(enabled: boolean) {
    if (busy || schedulerBusy || databaseBusy || keychainRetryRequest.current || keychainBlocked || updateInstalling) return;
    setSchedulerBusy(true); setError("");
    try {
      setScheduler(await invoke<SchedulerStatus>("set_scheduler", { enabled }));
      setSettings((current) => current ? { ...current, schedulerEnabled: enabled } : current);
    } catch (reason) { setError(failure(reason)); }
    finally { refreshKeychainStatus(); setSchedulerBusy(false); }
  }
  async function databaseAction(action: "start" | "backup") {
    if (busy || schedulerBusy || databaseBusy || keychainRetryRequest.current || keychainBlocked || updateInstalling) return;
    setDatabaseBusy(action); setError(""); setNotice(""); setFollowupNotice("");
    try {
      if (action === "start") {
        const result = await invoke<{ ok: boolean; message: string }>("start_database");
        const next = await invoke<PublicSettings>("get_settings");
        applySavedSettings(next);
        setSecretResetToken((current) => current + 1);
        setNotice(result.message || "로컬 PostgreSQL을 실행하고 스키마를 초기화했습니다.");
      } else {
        const result = await invoke<{ ok: boolean; path: string; bytes: number }>("backup_database");
        setBackup({ path: result.path, bytes: result.bytes });
        setNotice("로컬 DB 백업을 저장했습니다. 아래에서 파일 위치를 확인하세요.");
      }
      onSaved();
    } catch (reason) { setError(failure(reason)); }
    finally { refreshKeychainStatus(); setDatabaseBusy(null); }
  }
  async function retryKeychainAccess() {
    if (keychainRetryRequest.current || busy || schedulerBusy || databaseBusy || updateInstalling) return;
    keychainRetryRequest.current = true;
    setKeychainRetryBusy(true); setError(""); setNotice(""); setFollowupNotice("");
    setSecretResetToken((current) => current + 1);
    try {
      const next = await invoke<PublicSettings>("retry_keychain_access");
      if (await checkKeychainStatus()) throw new Error("저장소 접근이 아직 차단되어 있습니다. 운영체제의 권한 창에서 Toris Studio의 접근을 허용한 뒤 다시 확인하세요.");
      applySavedSettings(next);
      setNotice("저장소 권한을 확인하고 저장된 연결 정보를 다시 불러왔습니다. 입력 중인 변경 사항은 유지했습니다.");
      onSaved();
      try { setScheduler(await invoke<SchedulerStatus>("get_scheduler_status")); }
      catch { setFollowupNotice("저장된 연결 정보는 불러왔습니다. 자동 수집 상태는 아래의 상태 확인 버튼으로 다시 확인하세요."); }
    } catch (reason) {
      setError(failure(reason));
      refreshKeychainStatus();
    } finally {
      keychainRetryRequest.current = false;
      setKeychainRetryBusy(false);
    }
  }
  const settingsOperationBusy = busy || schedulerBusy || databaseBusy !== null || keychainRetryBusy;
  const operationBusy = settingsOperationBusy || updateInstalling;
  const locked = operationBusy || keychainBlocked;
  const storageNotice = (keychainBlocked || keychainRetryBusy) && <div className="social-notice error" role="alert" style={{ flexWrap: "wrap" }}>
    <KeyRound size={18} aria-hidden="true" /><span>{keychainRetryBusy ? "운영체제에서 Toris Studio의 저장소 권한을 확인하고 있습니다." : "저장소 접근이 차단되어 저장된 연결 정보를 읽거나 저장할 수 없습니다. 입력 중인 값은 유지됩니다."}</span>
    <button type="button" className="social-button compact" disabled={operationBusy} onClick={() => void retryKeychainAccess()}>{keychainRetryBusy ? <LoaderCircle size={15} className="social-spin" /> : <RefreshCw size={15} />}{keychainRetryBusy ? "권한 확인 중" : "저장소 권한 다시 확인"}</button>
  </div>;

  if (loading) return <ActivityStatus title="로컬 설정을 확인하는 중" detail="저장된 설정을 읽고 있습니다. OS 저장소의 접근 승인이 필요한 경우 시스템 확인창을 완료하세요."/>;
  if (!form || !settings) return <div>{storageNotice}<div className="social-notice error" role="alert"><CircleAlert size={18} /><span>{error || "설정을 불러오지 못했습니다."}</span><button type="button" className="social-button compact" disabled={operationBusy} onClick={() => void load()}>다시 시도</button></div></div>;

  return <div className="desktop-settings">
    <UpdatePanel hasUnsavedChanges={dirtyFields.current.size > 0} otherOperationBusy={settingsOperationBusy} onInstallBusyChange={setUpdateInstalling} />
    <div className="desktop-settings-intro"><ShieldCheck size={21} /><div><strong>연결 정보는 내 기기에 보관됩니다</strong><p>API 키와 DB 비밀번호는 macOS 키체인·Windows 자격 증명에 보관합니다. 저장소 권한은 Toris Studio가 보관한 연결 정보를 읽고 저장할 때 사용합니다. 빈 비밀키 입력란은 기존 값을 유지합니다.</p><p>일반 설정 파일</p><code>{settings.configPath}</code></div></div>
    {storageNotice}
    {(error || notice || followupNotice) && <div ref={feedback} tabIndex={-1}>
      {error && <div className="social-notice error" role="alert"><CircleAlert size={18} /><span>{error}</span></div>}
      {notice && <div className="social-notice success" role="status"><Check size={18} /><span>{notice}</span></div>}
      {followupNotice && <div className="social-notice info" role="status"><CircleAlert size={18} /><span>{followupNotice}</span></div>}
    </div>}
    <form onSubmit={save} autoComplete="off" noValidate>
      <fieldset disabled={locked} className="desktop-settings-section"><legend><Database size={18} />로컬 데이터베이스<span className={`social-state-label ${databaseConnected ? "ready" : "unconfigured"}`}>{databaseConnected ? "연결됨" : settings.databaseConfigured ? "연결 확인 필요" : "설정 필요"}</span></legend>
        <p>OrbStack의 PostgreSQL 컨테이너에 채널, 콘텐츠, 수집 기록을 저장합니다.</p>
        <div className="desktop-settings-save"><button type="button" className="social-button" disabled={locked} onClick={() => void databaseAction("start")}>{databaseBusy === "start" ? <LoaderCircle size={16} className="social-spin" /> : <Play size={16} />}{databaseBusy === "start" ? "DB 준비 중" : "DB 컨테이너 실행 · 초기화"}</button><button type="button" className="social-button" disabled={locked || !databaseConnected} onClick={() => void databaseAction("backup")}>{databaseBusy === "backup" ? <LoaderCircle size={16} className="social-spin" /> : <Download size={16} />}{databaseBusy === "backup" ? "백업 중" : "DB 백업 저장"}</button></div>
        <p className="social-form-hint">macOS는 OrbStack, Windows는 Docker Desktop을 먼저 실행하세요. 실행 시 기존 데이터를 유지하고 필요한 스키마를 준비합니다.</p>
        {backup && <div className="desktop-settings-link" role="status"><p>최근 백업 · {new Intl.NumberFormat("ko-KR").format(backup.bytes)}바이트</p><code style={{ display: "block", overflowWrap: "anywhere", marginTop: 6 }}>{backup.path}</code></div>}
        <label htmlFor="settings-database">데이터베이스 연결 주소</label><input id="settings-database" type="password" value={form.databaseUrl} onChange={(event) => update("databaseUrl", event.target.value)} placeholder={settings.databaseConfigured ? "저장된 주소 사용 중 · 변경할 때만 입력" : "postgresql://사용자:비밀번호@127.0.0.1:포트/DB"} maxLength={2000} autoComplete="new-password" spellCheck={false} />
        <p className="social-form-hint">컨테이너가 실행 중이어야 연결됩니다. 주소를 저장하면 실제 DB 연결 상태를 다시 확인합니다.</p>
      </fieldset>
      <section className="desktop-settings-section"><h2><Sparkles size={18} />ChatGPT 연결</h2><p>AI 작성과 이미지 생성은 실제 ChatGPT 대화에 요청합니다. 코딩 메뉴에서 Codexify와 대화를 연결한 뒤 ChatGPT에서 시작·재개하세요.</p><p className="social-form-hint">이전 로컬 AI 설정은 보존하지만 데스크톱 AI 요청에는 사용하지 않습니다. ChatGPT 사용 한도가 적용됩니다.</p></section>
      <fieldset disabled={locked} className="desktop-settings-section"><legend><KeyRound size={18} />수집 API</legend>
        <p>Google 트렌드는 키 없이 수집합니다. YouTube와 네이버 블로그 수집에 필요한 API 정보를 추가하세요.</p>
        <p className="social-form-hint">저장됨 표시로 등록 여부를 확인하고, 보기 버튼으로 저장된 값을 확인하세요. 저장된 값은 읽기 전용이며 변경 입력과 구분됩니다.</p>
        <div className="desktop-settings-columns"><section><h3>YouTube <span className={`social-state-label ${settings.youtubeConfigured ? "ready" : "unconfigured"}`}>{settings.youtubeConfigured ? "설정됨" : "설정 필요"}</span></h3>
          <CollectionSecretField secretKey="youtubeApiKey" id="settings-youtube-key" label="YouTube Data API 키" value={form.youtubeApiKey} configured={settings.savedCollectionKeys?.youtubeApiKey ?? settings.youtubeConfigured} locked={locked} resetToken={secretResetToken} onChange={(value) => update("youtubeApiKey", value)} onStorageChecked={refreshKeychainStatus} />
        </section><section><h3>네이버 검색 <span className={`social-state-label ${settings.naverConfigured ? "ready" : "unconfigured"}`}>{settings.naverConfigured ? "설정됨" : "설정 필요"}</span></h3>
          <CollectionSecretField secretKey="naverClientId" id="settings-naver-id" label="클라이언트 ID" value={form.naverClientId} configured={settings.savedCollectionKeys?.naverClientId ?? settings.naverConfigured} locked={locked} resetToken={secretResetToken} onChange={(value) => update("naverClientId", value)} onStorageChecked={refreshKeychainStatus} />
          <CollectionSecretField secretKey="naverClientSecret" id="settings-naver-secret" label="클라이언트 시크릿" value={form.naverClientSecret} configured={settings.savedCollectionKeys?.naverClientSecret ?? settings.naverConfigured} locked={locked} resetToken={secretResetToken} onChange={(value) => update("naverClientSecret", value)} onStorageChecked={refreshKeychainStatus} />
        </section></div>
      </fieldset>
      <div className="desktop-settings-save" style={{ position: "sticky", bottom: 0, zIndex: 1, background: "var(--social-panel)", border: "1px solid var(--social-line)", borderRadius: 8, padding: "12px 16px" }}><span style={{ color: error ? "#ffc0c6" : notice ? "#b0dfc6" : undefined }} aria-live="polite">{busy ? "설정을 저장하고 있습니다." : error || notice || "빈 비밀키 입력란은 기존 값을 유지합니다."}</span><button type="submit" className="social-button primary" disabled={locked}>{busy ? <LoaderCircle size={17} className="social-spin" /> : <Check size={17} />}{busy ? "저장 중" : "설정 저장 · 연결 확인"}</button></div>
    </form>
    <section className="desktop-settings-section desktop-scheduler" aria-labelledby="settings-scheduler-title"><div className="desktop-scheduler-header"><h2 id="settings-scheduler-title"><Timer size={18} />자동 트렌드 수집</h2><button className="social-button compact" disabled={locked} onClick={() => { setSchedulerBusy(true); void invoke<SchedulerStatus>("get_scheduler_status").then(setScheduler).catch((reason: unknown) => setError(failure(reason))).finally(() => setSchedulerBusy(false)); }}><RefreshCw size={14} />상태 확인</button></div>
      <p>매일 한국 시간 오전 7시에 수집합니다. 앱이 닫혀 있거나 기기가 잠들어 놓친 수집은 다음 실행 때 처리하며, 실패하면 5분 뒤 다시 시도합니다.</p>
      <label className="desktop-scheduler-toggle" htmlFor="settings-scheduler"><input id="settings-scheduler" type="checkbox" checked={scheduler?.enabled ?? settings.schedulerEnabled} disabled={locked || !databaseConnected} onChange={(event) => void setCollection(event.target.checked)} /><span>자동 수집 켜기</span>{scheduler?.running && <small><LoaderCircle size={13} className="social-spin" />수집 중</small>}</label>
      <dl><div><dt>최근 수집 성공</dt><dd>{displayDate(scheduler?.lastSuccessAt ?? null)}</dd></div><div><dt>다음 실행</dt><dd>{scheduler?.enabled ? displayDate(scheduler.nextRunAt) : "자동 수집 꺼짐"}</dd></div></dl>
      {scheduler?.lastError && <div className="social-form-error" role="status">{scheduler.lastError}</div>}
      {!databaseConnected && <p className="social-form-hint">DB를 연결한 뒤 자동 수집을 켤 수 있습니다.</p>}
    </section>
  </div>;
}
