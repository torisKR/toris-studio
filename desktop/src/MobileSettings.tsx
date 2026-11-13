import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle, RefreshCw, Smartphone } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MobileDeviceItem, PendingApproval } from "./MobileSettingsPermissions";
import { expiryTime, isPrivateAddress, isQrImageUrl, MobileQrQueue } from "./MobileSettingsModel";
import type { MobileQr, MobileStatus } from "./MobileSettingsModel";
import "./MobileSettings.css";

const qrQueue = new MobileQrQueue();
const POLL_INTERVAL = 2000;

export function MobileSettingsPanel({ disabled = false }: { disabled?: boolean }) {
  const [status, setStatus] = useState<MobileStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [qr, setQr] = useState<MobileQr | null>(null);
  const [qrConsumed, setQrConsumed] = useState(false);
  const [qrImageError, setQrImageError] = useState(false);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(false);
  const operation = useRef(false);
  const reading = useRef(false);
  const refreshQueued = useRef(false);
  const generation = useRef(0);
  const qrGeneration = useRef(0);

  const refresh = useCallback(async function readStatus() {
    if (operation.current || reading.current) { refreshQueued.current = true; return; }
    reading.current = true;
    const request = ++generation.current;
    try {
      const next = await invoke<MobileStatus>("mobile_status");
      if (mounted.current && generation.current === request) { setStatus(next); setStatusError(""); }
    } catch {
      if (mounted.current && generation.current === request) setStatusError("모바일 연결 상태를 확인하지 못했습니다. 다시 확인하세요.");
    } finally {
      reading.current = false;
      if (mounted.current && !operation.current && refreshQueued.current) {
        refreshQueued.current = false;
        void readStatus();
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL);
    return () => {
      mounted.current = false;
      generation.current += 1;
      qrGeneration.current += 1;
      refreshQueued.current = false;
      window.clearInterval(timer);
      void qrQueue.run(() => invoke("mobile_close_qr")).catch(() => {});
    };
  }, [refresh]);

  useEffect(() => {
    if (status?.pending && qr) setQrConsumed(true);
  }, [status?.pending, qr]);

  useEffect(() => {
    if (!qr || !status || (status.available && status.enabled)) return;
    qrGeneration.current += 1;
    setQr(null); setQrConsumed(false);
    void qrQueue.run(() => invoke("mobile_close_qr")).catch(() => {
      if (mounted.current) setActionError("등록 화면을 닫지 못했습니다. 모바일 연결 상태를 확인하세요.");
    });
  }, [qr, status?.available, status?.enabled]);

  useEffect(() => {
    if (!qr) return;
    let expired = false;
    const lease = qrGeneration.current;
    const tick = () => {
      if (lease !== qrGeneration.current) return;
      const current = Date.now();
      setNow(current);
      if (!expired && current >= expiryTime(qr.expiresAt)) {
        expired = true;
        qrGeneration.current += 1;
        setQr(null);
        setQrConsumed(false);
        setNotice("등록 QR이 만료되었습니다. 기기를 추가하려면 다시 발급하세요.");
        void qrQueue.run(() => invoke("mobile_close_qr")).then(() => void refresh()).catch(() => {
          if (mounted.current) setActionError("만료된 등록 화면을 닫지 못했습니다. 모바일 연결을 끄고 상태를 확인하세요.");
        });
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [qr, refresh]);

  async function run(label: string, action: () => Promise<void>, success: string, failure: string): Promise<boolean> {
    if (operation.current || disabled || !mounted.current) return false;
    operation.current = true;
    generation.current += 1;
    setBusy(label); setActionError(""); setNotice("");
    try {
      await action();
      if (mounted.current && success) setNotice(success);
      return true;
    } catch {
      if (mounted.current) setActionError(failure);
      return false;
    } finally {
      operation.current = false;
      if (mounted.current) { setBusy(null); void refresh(); }
    }
  }

  async function issueQr() {
    const request = ++qrGeneration.current;
    setQr(null); setQrConsumed(false); setQrImageError(false);
    await run("qr", async () => {
      setStatus(current => current ? { ...current, pending: null } : current);
      const issued = await qrQueue.run(async () => {
        await invoke("mobile_close_qr");
        if (!mounted.current || qrGeneration.current !== request) return null;
        const next = await invoke<MobileQr>("mobile_issue_qr");
        const expires = next ? expiryTime(next.expiresAt) : NaN;
        const current = Date.now();
        if (!next || !isQrImageUrl(next.url) || !Number.isFinite(expires) || expires <= current || expires > current + 121_000) {
          await invoke("mobile_close_qr");
          throw new Error("Invalid QR image or expiry");
        }
        return next;
      });
      if (issued && mounted.current && qrGeneration.current === request) { setNow(Date.now()); setQr(issued); }
    }, "", "등록 QR을 발급하지 못했습니다. 모바일 연결 상태를 확인하고 다시 시도하세요.");
  }

  async function closeQr() {
    qrGeneration.current += 1;
    setQr(null); setQrConsumed(false);
    await run("close", () => qrQueue.run(() => invoke("mobile_close_qr")), "등록 화면을 닫았습니다.", "등록 화면을 닫지 못했습니다. 모바일 연결을 끄고 상태를 확인하세요.");
  }

  async function disableMobile() {
    qrGeneration.current += 1;
    setQr(null); setQrConsumed(false);
    await run("disable", () => qrQueue.run(async () => {
      try { await invoke("mobile_close_qr"); } catch { /* Disabling also stops the host. */ }
      await invoke("mobile_disable");
    }), "모바일 연결을 껐습니다.", "모바일 연결을 끄지 못했습니다. 상태를 확인하고 다시 시도하세요.");
  }

  const privateInterfaces = status?.interfaces?.filter(item => isPrivateAddress(item.address)) ?? [];
  const locked = disabled || !!busy || !!statusError;
  const canEnable = privateInterfaces.some(item => item.address === address);
  const expires = qr ? expiryTime(qr.expiresAt) : 0;
  const remaining = qr ? Math.max(0, Math.ceil((expires - now) / 1000)) : 0;

  return <section className="desktop-settings-section mobile-settings" aria-labelledby="settings-mobile-title" aria-busy={!!busy}>
    <div className="mobile-settings-heading"><h2 id="settings-mobile-title"><Smartphone size={18} aria-hidden="true" />모바일 연결</h2>
      <button type="button" className="social-button compact" disabled={disabled || !!busy} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" />상태 확인</button>
    </div>
    <p>같은 사설 네트워크의 휴대폰에서 이 Mac의 Toris Studio 작업을 시작하고 진행 상황을 확인합니다. Mac과 앱이 켜져 있어야 합니다.</p>
    {statusError && <div className="social-notice error" role="alert"><span>{statusError}</span></div>}
    {actionError && <div className="social-notice error" role="alert"><span>{actionError}</span></div>}
    {notice && <div className="social-notice success" role="status"><span>{notice}</span></div>}
    {!status && !statusError && <p role="status">모바일 연결 상태를 확인하고 있습니다.</p>}
    {status && !status.available && <p className="social-form-hint" role="status">이 환경에서는 모바일 연결을 사용할 수 없습니다. 이 기능은 지원되는 Mac에서 사용할 수 있습니다.</p>}
    {status?.available && <>
      <div className="mobile-settings-service">
        <div><strong>원격 연결</strong> <span className={`social-state-label ${status.enabled ? "ready" : "unconfigured"}`}>{status.enabled ? "켜짐" : "꺼짐"}</span></div>
        {status.enabled ? <button type="button" className="social-button compact" disabled={disabled || !!busy} onClick={() => void disableMobile()}>{busy === "disable" && <LoaderCircle size={14} className="social-spin" aria-hidden="true" />}모바일 연결 끄기</button> :
          <button type="button" className="social-button compact primary" disabled={locked || !canEnable} onClick={() => void run("enable", () => invoke("mobile_enable", { address }), "모바일 연결을 켰습니다.", "모바일 연결을 켜지 못했습니다. 네트워크 주소를 확인하세요.")}>{busy === "enable" && <LoaderCircle size={14} className="social-spin" aria-hidden="true" />}모바일 연결 켜기</button>}
      </div>
      {status.enabled ? <dl className="mobile-settings-details mobile-settings-host">
        <div><dt>선택한 주소</dt><dd>{status.address ?? "확인 중"}{status.port ? `:${status.port}` : ""}</dd></div>
        <div><dt>Mac 호스트 지문</dt><dd><code>{status.fingerprint ?? "확인 중"}</code></dd></div>
      </dl> : <div className="mobile-settings-interface">
        <label htmlFor="mobile-interface">사설 네트워크 인터페이스</label>
        <select id="mobile-interface" value={canEnable ? address : ""} disabled={locked || !privateInterfaces.length} onChange={event => setAddress(event.target.value)}>
          <option value="">인터페이스 선택</option>{privateInterfaces.map(item => <option key={`${item.name}:${item.address}`} value={item.address}>{item.name} · {item.address}</option>)}
        </select>
        {!privateInterfaces.length && <p className="social-form-hint">사용 가능한 사설 네트워크 주소가 없습니다. Wi-Fi 또는 LAN 연결을 확인하세요.</p>}
        <p className="social-form-hint">기본적으로 꺼져 있습니다. 다른 인터페이스를 사용하려면 연결을 끈 뒤 다시 선택하세요.</p>
      </div>}
      {status.enabled && <section className="mobile-settings-pairing" aria-labelledby="mobile-pairing-title">
        <div className="mobile-settings-subheading"><h3 id="mobile-pairing-title">기기 추가</h3>{!qr && !status.pending && <button type="button" className="social-button compact" disabled={locked} onClick={() => void issueQr()}>QR 발급</button>}</div>
        {!qr && !status.pending && <p className="social-form-hint">휴대폰 앱에서 QR을 스캔한 뒤 두 화면의 기기 지문과 확인 코드를 비교하세요.</p>}
        {qr && <div className="mobile-settings-qr">
          {!qrConsumed ? <><img src={qr.url} alt="휴대폰 등록 QR 코드" onError={() => setQrImageError(true)} /><p>휴대폰 앱에서 스캔하세요.</p>{qrImageError && <p className="social-form-error" role="alert">QR 이미지를 표시하지 못했습니다. 모바일 연결 설정을 확인한 뒤 다시 발급하세요.</p>}</> : <p>QR이 사용되었습니다. 휴대폰에서 등록을 계속하세요.</p>}
          <p role="timer">만료까지 {Math.floor(remaining / 60)}분 {String(remaining % 60).padStart(2, "0")}초 · {new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(expires)} 만료</p>
          <p className="social-form-hint">다시 발급하거나 닫으면 현재 등록 요청이 취소됩니다.</p>
          <div className="mobile-settings-actions"><button type="button" className="social-button compact" disabled={locked} onClick={() => void issueQr()}>QR 다시 발급</button><button type="button" className="social-button compact" disabled={!!busy || disabled} onClick={() => void closeQr()}>등록 화면 닫기</button></div>
        </div>}
        {status.pending && qr && <PendingApproval key={`${status.pending.id}:${status.pending.fingerprint}:${status.pending.confirmationCode}`} pending={status.pending} projects={status.projects} disabled={locked || remaining === 0} onApprove={args => run("approve", () => invoke("mobile_approve", args), "기기를 승인했습니다. 휴대폰에서 연결을 완료하세요.", "기기를 승인하지 못했습니다. 등록 요청과 확인 코드를 다시 확인하세요.")} />}
        {status.pending && !qr && <><p className="social-form-hint">이 화면에서 발급한 유효한 QR이 없습니다. 등록 요청을 취소하고 다시 발급하세요.</p><button type="button" className="social-button compact" disabled={!!busy || disabled} onClick={() => void closeQr()}>등록 요청 취소</button></>}
      </section>}
      <section className="mobile-settings-devices" aria-labelledby="mobile-devices-title"><h3 id="mobile-devices-title">등록된 기기 <span>{status.devices.length}</span></h3>
        {!status.devices.length ? <p className="social-form-hint">등록된 기기가 없습니다.</p> : status.devices.map(device => <MobileDeviceItem key={device.id} device={device} projects={status.projects} disabled={locked} permissionsDisabled={!status.enabled} onPermissions={(deviceId, permissions) => run("permissions", () => invoke("mobile_set_permissions", { deviceId, ...permissions }), "기기 권한을 저장했습니다.", "기기 권한을 저장하지 못했습니다. 다시 확인하세요.")} onRevoke={deviceId => run("revoke", () => invoke("mobile_revoke", { deviceId }), "기기 등록을 해제했습니다.", "기기 등록을 해제하지 못했습니다. 다시 확인하세요.")} />)}
      </section>
    </>}
  </section>;
}
