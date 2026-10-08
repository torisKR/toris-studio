import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowDownToLine, Check, CircleAlert, Download, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { External } from "./External";
import "./UpdatePanel.css";

type UpdatePhase = "idle" | "checking" | "available" | "upToDate" | "downloading" | "ready" | "installing" | "installed" | "cancelled" | "error";
export type UpdateStatus = {
  configured: boolean;
  currentVersion: string;
  phase: UpdatePhase;
  availableVersion: string | null;
  notes: string | null;
  publishedAt: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  message: string;
  canCancel: boolean;
};
type Props = {
  hasUnsavedChanges?: boolean;
  otherOperationBusy?: boolean;
  onInstallBusyChange?: (busy: boolean) => void;
};

const RELEASES_URL = "https://github.com/torisKR/toris-studio/releases/latest";
const DOWNLOADS_URL = "https://toriskr.github.io/toris-studio/";
const activePhases = new Set<UpdatePhase>(["checking", "downloading", "ready", "installing"]);
const installPhases = new Set<UpdatePhase>(["downloading", "ready", "installing"]);
const phaseLabels: Record<UpdatePhase, string> = {
  idle: "새 버전 확인 가능", checking: "업데이트 확인 중", available: "새 버전이 있습니다",
  upToDate: "최신 버전을 사용 중입니다", downloading: "설치 파일 다운로드 중", ready: "업데이트 검증 완료",
  installing: "업데이트 설치 중", installed: "설치 완료 · 앱 다시 시작 중", cancelled: "업데이트를 취소했습니다", error: "업데이트 확인이 필요합니다"
};

function bytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "크기 확인 중";
  if (value < 1_048_576) return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(value / 1024)} KB`;
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value / 1_048_576)} MB`;
}
function publishedDate(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "short", day: "numeric" }).format(parsed);
}
function trapInstallFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget;
  const controls = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")];
  event.preventDefault();
  if (!controls.length) { dialog.focus(); return; }
  const current = controls.indexOf(document.activeElement as HTMLElement);
  const next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
  controls[next].focus();
}

/** Rust owns the update feed, signature verification, installation, and restart. */
export function UpdatePanel({ hasUnsavedChanges = false, otherOperationBusy = false, onInstallBusyChange }: Props) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [pending, setPending] = useState<"check" | "install" | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [savedConfirmation, setSavedConfirmation] = useState(false);
  const mounted = useRef(true);
  const revision = useRef(0);
  const actionPending = useRef(false);
  const cancellationPending = useRef(false);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const checkButtonRef = useRef<HTMLButtonElement>(null);
  const installDialogRef = useRef<HTMLDialogElement>(null);
  const active = status !== null && activePhases.has(status.phase);
  const installing = pending === "install" || (status !== null && installPhases.has(status.phase));

  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const next = await invoke<UpdateStatus>("get_update_status");
      if (mounted.current && request === revision.current) setStatus(next);
    } catch {
      if (mounted.current && request === revision.current) setError("앱의 업데이트 상태를 불러오지 못했습니다. 다시 확인하거나 공식 릴리스에서 설치 파일을 받으세요.");
    } finally {
      if (mounted.current) setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    let stopListening: (() => void) | undefined;
    let disposed = false;
    void listen<UpdateStatus>("desktop-update-status", (event) => {
      if (!mounted.current) return;
      revision.current += 1;
      setStatus(event.payload); setError(""); setInitialLoading(false);
    }).then((unlisten) => {
      if (disposed) unlisten(); else stopListening = unlisten;
    }).catch(() => { /* Active operations are also refreshed below. */ });
    return () => { disposed = true; mounted.current = false; revision.current += 1; stopListening?.(); };
  }, [refresh]);

  useEffect(() => {
    if (!active && pending === null) return;
    const timer = window.setInterval(() => { void refresh(); }, 1200);
    return () => window.clearInterval(timer);
  }, [active, pending, refresh]);

  useEffect(() => {
    onInstallBusyChange?.(installing);
    return () => { onInstallBusyChange?.(false); };
  }, [installing, onInstallBusyChange]);

  useEffect(() => {
    if (!installing) return;
    const dialog = installDialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); checkButtonRef.current?.focus(); };
  }, [installing]);

  useEffect(() => { setConfirmationOpen(false); setSavedConfirmation(false); }, [status?.availableVersion]);
  useEffect(() => { if (hasUnsavedChanges) setSavedConfirmation(false); }, [hasUnsavedChanges]);
  useEffect(() => { if (confirmationOpen) confirmationRef.current?.focus({ preventScroll: true }); }, [confirmationOpen]);

  async function runAction(action: "check" | "install") {
    if (actionPending.current) return;
    if (otherOperationBusy || active) return;
    if (action === "install" && (!status?.availableVersion || !status.configured || hasUnsavedChanges || !savedConfirmation)) return;
    actionPending.current = true;
    setPending(action); setError("");
    if (action === "install") setConfirmationOpen(false);
    const request = ++revision.current;
    try {
      const next = await invoke<UpdateStatus>(action === "check" ? "check_for_updates" : "install_update", action === "install" ? { input: { expectedVersion: status!.availableVersion, confirmed: true } } : undefined);
      if (mounted.current && request === revision.current) setStatus(next);
    } catch {
      if (mounted.current) setError(action === "install" ? "업데이트를 완료하지 못했습니다. 상태를 다시 확인한 뒤 재시도하거나 공식 설치 파일을 받으세요." : "새 버전을 확인하지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도하세요.");
    } finally {
      actionPending.current = false;
      if (mounted.current) { setPending(null); void refresh(); }
    }
  }

  async function cancelDownload() {
    if (cancellationPending.current || !status?.canCancel) return;
    cancellationPending.current = true;
    setCancelling(true); setError("");
    const request = ++revision.current;
    try {
      const next = await invoke<UpdateStatus>("cancel_update");
      if (mounted.current && request === revision.current) setStatus(next);
    } catch {
      if (mounted.current) setError("취소 상태를 확인하지 못했습니다. 아래의 설치 상태를 확인하세요.");
    } finally {
      cancellationPending.current = false;
      if (mounted.current) { setCancelling(false); void refresh(); }
    }
  }

  const canInstall = Boolean(status?.configured && status.availableVersion && ["available", "cancelled", "error"].includes(status.phase));
  const total = status?.totalBytes && status.totalBytes > 0 ? status.totalBytes : null;
  const downloaded = Math.max(0, status?.downloadedBytes ?? 0);
  const percentage = total ? Math.min(100, Math.max(0, Math.floor(downloaded / total * 100))) : null;
  const releaseDate = publishedDate(status?.publishedAt ?? null);
  const label = initialLoading ? "업데이트 상태 확인 중" : status ? phaseLabels[status.phase] : "업데이트 상태를 확인하세요";
  const statusError = status?.phase === "error";
  const updateBusy = active || pending !== null;
  const progress = <div className="desktop-update-progress">
    <div><span>{status?.phase === "downloading" ? `${bytes(downloaded)}${total ? ` / ${bytes(total)}` : " 다운로드"}` : status?.phase === "ready" ? "설치 파일 서명을 확인했습니다." : status?.phase === "installing" ? "설치가 끝나면 앱을 다시 시작합니다." : "설치 파일을 준비하고 있습니다."}</span>{status?.phase === "downloading" && percentage !== null && <strong>{percentage}%</strong>}</div>
    {status?.phase === "downloading" && <progress aria-label="업데이트 설치 파일 다운로드" max={total ?? undefined} value={total ? Math.min(downloaded, total) : undefined} />}
    <p>다운로드와 서명 검증을 마친 뒤 새 버전으로 교체합니다. 설치가 끝나면 앱을 다시 시작합니다.</p>
  </div>;

  return <section className="desktop-update" aria-labelledby="settings-update-title">
    <div className="desktop-update-heading">
      <span className="desktop-update-icon"><ArrowDownToLine size={21} aria-hidden="true" /></span>
      <div><h2 id="settings-update-title">앱 업데이트</h2><p>공식 GitHub 릴리스에서 새 버전을 확인하고 설치하세요.</p></div>
      <span className="desktop-update-version">현재 버전 <strong>{status?.currentVersion ?? "확인 중"}</strong></span>
    </div>
    <div className={`desktop-update-state ${statusError || error ? "error" : status?.phase === "upToDate" || status?.phase === "installed" ? "success" : ""}`}>
      <span className="desktop-update-phase-icon" aria-hidden="true">{initialLoading || active ? <LoaderCircle size={18} className="social-spin" /> : statusError || error ? <CircleAlert size={18} /> : status?.phase === "upToDate" || status?.phase === "installed" ? <Check size={18} /> : <RefreshCw size={18} />}</span>
      <div className="desktop-update-state-copy"><strong role="status" aria-live="polite">{label}</strong>{status?.availableVersion && <span>새 버전 {status.availableVersion}{releaseDate ? ` · ${releaseDate} 공개` : ""}</span>}{status?.message && <p>{status.message}</p>}</div>
      <div className="desktop-update-actions">
        {status?.canCancel && !installing && <button type="button" className="social-button compact" disabled={cancelling} onClick={() => void cancelDownload()}><X size={15} />{cancelling ? "취소 중" : status.phase === "checking" ? "확인 취소" : "다운로드 취소"}</button>}
        {!installing && <button ref={checkButtonRef} type="button" className="social-button" disabled={initialLoading || updateBusy || otherOperationBusy} onClick={() => void runAction("check")}><RefreshCw size={16} className={pending === "check" ? "social-spin" : ""} />{pending === "check" || status?.phase === "checking" ? "확인 중" : "업데이트 확인"}</button>}
        {canInstall && !updateBusy && <button type="button" className="social-button primary" disabled={hasUnsavedChanges || otherOperationBusy} aria-expanded={confirmationOpen} aria-controls="settings-update-confirmation" onClick={() => { setSavedConfirmation(false); setConfirmationOpen(true); }}><Download size={16} />새 버전 설치</button>}
      </div>
    </div>
    {error && <p className="desktop-update-error" role="alert">{error}</p>}
    {installing && <dialog ref={installDialogRef} tabIndex={-1} className="desktop-update-install-dialog" aria-modal="true" aria-labelledby="settings-update-install-title" aria-describedby="settings-update-install-description" onKeyDown={trapInstallFocus} onCancel={(event) => { event.preventDefault(); if (status?.canCancel) void cancelDownload(); }}>
      <div className="desktop-update-dialog-heading"><LoaderCircle size={21} className="social-spin" aria-hidden="true" /><h2 id="settings-update-install-title" role="status" aria-live="polite">{phaseLabels[status?.phase === "downloading" || status?.phase === "ready" || status?.phase === "installing" ? status.phase : "downloading"]}</h2></div>
      <p id="settings-update-install-description">버전 {status?.availableVersion} · 업데이트가 끝날 때까지 작업 화면을 잠시 잠급니다.</p>
      {progress}
      {error && <p className="desktop-update-error" role="alert">{error}</p>}
      <div className="desktop-update-dialog-footer">{status?.canCancel ? <button type="button" className="social-button" autoFocus disabled={cancelling} onClick={() => void cancelDownload()}><X size={16} />{cancelling ? "취소 중" : "다운로드 취소"}</button> : <span>설치 중에는 앱을 종료하지 마세요.</span>}</div>
    </dialog>}
    {hasUnsavedChanges && <p className="desktop-update-hint"><CircleAlert size={15} aria-hidden="true" />연결 설정에 저장하지 않은 변경이 있습니다. 아래에서 설정을 저장한 뒤 업데이트를 설치하세요.</p>}
    {otherOperationBusy && !installing && <p className="desktop-update-hint">진행 중인 설정 작업이 끝나면 업데이트를 확인하고 설치할 수 있습니다.</p>}
    {confirmationOpen && <div id="settings-update-confirmation" ref={confirmationRef} tabIndex={-1} className="desktop-update-confirmation" role="group" aria-labelledby="settings-update-confirmation-title">
      <strong id="settings-update-confirmation-title">버전 {status?.availableVersion}을 설치할까요?</strong>
      <p>설치가 끝나면 Toris Studio가 자동으로 다시 시작됩니다. 콘텐츠, 채널, SNS 연결과 로컬 설정은 같은 저장소에서 불러옵니다.</p>
      <label htmlFor="settings-update-saved"><input id="settings-update-saved" type="checkbox" checked={savedConfirmation} disabled={hasUnsavedChanges || otherOperationBusy} onChange={(event) => setSavedConfirmation(event.target.checked)} /><span>열어 둔 작업의 변경 사항을 모두 저장했습니다.</span></label>
      <div><button type="button" className="social-button" onClick={() => { setConfirmationOpen(false); checkButtonRef.current?.focus(); }}>나중에</button><button type="button" className="social-button primary" disabled={!savedConfirmation || hasUnsavedChanges || otherOperationBusy || updateBusy} onClick={() => void runAction("install")}><Download size={16} />설치 · 앱 다시 시작</button></div>
    </div>}
    {status?.notes && <details className="desktop-update-notes"><summary>새 버전 변경 사항</summary><pre>{status.notes}</pre></details>}
    <div className="desktop-update-footer"><span><ShieldCheck size={15} aria-hidden="true" />서명 검증 후 설치</span><div><External url={DOWNLOADS_URL}><ExternalLink size={14} aria-hidden="true" />macOS · Windows 다운로드</External><External url={RELEASES_URL}><ExternalLink size={14} aria-hidden="true" />공식 릴리스 보기</External></div></div>
  </section>;
}
