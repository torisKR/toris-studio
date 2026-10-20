import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, CircleAlert, Globe, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { BrowserChoice, BrowserRuntimeStatus } from "./browser-types";
import "./BrowserSettingsPanel.css";

const browserNames: Record<BrowserChoice, string> = {
  playwright: "Playwright 전용 브라우저",
  system: "시스템 기본 브라우저"
};
const phaseNames: Record<BrowserRuntimeStatus["phase"], string> = {
  idle: "대기 중", running: "전용 브라우저 실행 중", recovery_required: "복구 확인 필요"
};
type Props = {
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
};

export function BrowserSettingsPanel({ disabled = false, onDirtyChange, onBusyChange }: Props) {
  const [status, setStatus] = useState<BrowserRuntimeStatus | null>(null);
  const [choice, setChoice] = useState<BrowserChoice>("playwright");
  const [pending, setPending] = useState<"read" | "save" | null>("read");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const operation = useRef<"read" | "save" | null>(null);
  const generation = useRef(0);
  const dirty = useRef(false);
  const refreshQueued = useRef(false);

  const refresh = useCallback(async function readStatus() {
    if (operation.current) { refreshQueued.current = true; return; }
    operation.current = "read";
    const request = ++generation.current;
    setPending("read"); setError("");
    try {
      const next = await invoke<BrowserRuntimeStatus>("browser_runtime_status");
      if (!mounted.current || generation.current !== request) return;
      setStatus(next);
      if (!dirty.current) setChoice(next.preference);
    } catch {
      if (mounted.current && generation.current === request) setError("브라우저 상태를 확인하지 못했습니다. 다시 확인하세요.");
    } finally {
      if (generation.current === request) {
        operation.current = null;
        if (mounted.current) {
          setPending(null);
          if (refreshQueued.current) { refreshQueued.current = false; void readStatus(); }
        }
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      generation.current += 1;
      operation.current = null;
      refreshQueued.current = false;
    };
  }, [refresh]);
  useEffect(() => {
    const onFocus = () => { if (!disabled) void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [disabled, refresh]);
  useEffect(() => {
    dirty.current = Boolean(status && choice !== status.preference);
    onDirtyChange?.(dirty.current);
  }, [choice, status, onDirtyChange]);
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    // Event payloads stay native; the public status exposes only the recovery state.
    void listen("browser-runtime-error", () => { if (active) void refresh(); }, { target: { kind: "WebviewWindow", label: "main" } })
      .then(stop => { if (active) unlisten = stop; else stop(); }).catch(() => {});
    return () => { active = false; unlisten?.(); };
  }, [refresh]);
  useEffect(() => { onBusyChange?.(pending === "save"); }, [pending, onBusyChange]);
  useEffect(() => () => { onDirtyChange?.(false); onBusyChange?.(false); }, [onDirtyChange, onBusyChange]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || operation.current || !status || choice === status.preference) return;
    operation.current = "save";
    const request = ++generation.current;
    setPending("save"); setError(""); setNotice("");
    try {
      const next = await invoke<BrowserRuntimeStatus>("save_browser_preferences", { input: { browser: choice } });
      if (!mounted.current || generation.current !== request) return;
      dirty.current = false;
      setStatus(next); setChoice(next.preference);
      setNotice("브라우저 설정을 저장했습니다.");
    } catch {
      if (mounted.current && generation.current === request) setError("브라우저 설정을 저장하지 못했습니다. 선택은 유지됩니다. 다시 시도하세요.");
    } finally {
      if (generation.current === request) {
        operation.current = null;
        if (mounted.current) {
          setPending(null);
          if (refreshQueued.current) { refreshQueued.current = false; void refresh(); }
        }
      }
    }
  }
  const locked = disabled || pending !== null;
  return <section className="desktop-settings-section desktop-browser-settings" aria-labelledby="settings-browser-title" aria-busy={pending !== null}>
    <div className="desktop-browser-heading"><h2 id="settings-browser-title"><Globe size={18} aria-hidden="true" />링크를 여는 브라우저</h2><button type="button" className="social-button compact" disabled={locked} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" />브라우저 상태 확인</button></div>
    <p>일반 링크는 선택한 브라우저로 엽니다. 모든 계정 로그인과 권한 승인은 항상 시스템 기본 브라우저에서 진행합니다.</p>
    <form onSubmit={event => void save(event)}>
      <fieldset disabled={locked || !status} className="desktop-browser-options"><legend>일반 링크 열기</legend>
        {(["playwright", "system"] as const).map(browser => <label key={browser} htmlFor={`settings-browser-${browser}`}><input id={`settings-browser-${browser}`} type="radio" name="link-browser" value={browser} checked={choice === browser} onChange={() => { dirty.current = browser !== status?.preference; setChoice(browser); setNotice(""); }} /><span>{browserNames[browser]}</span></label>)}
      </fieldset>
      {status && <dl className="desktop-browser-status"><div><dt>저장된 선택</dt><dd>{browserNames[status.preference]}</dd></div><div><dt>실제 사용할 브라우저</dt><dd>{browserNames[status.effectiveBrowser]}</dd></div><div><dt>전용 브라우저 상태</dt><dd>{phaseNames[status.phase]}</dd></div></dl>}
      {!status && pending === "read" && <p role="status">브라우저 설정을 확인하고 있습니다.</p>}
      {status?.reason && <p className="social-form-hint" role="status">{status.reason}</p>}
      {status && !status.available && status.phase !== "recovery_required" && <p className="social-form-hint">전용 브라우저를 사용할 수 없어 시스템 기본 브라우저로 엽니다. 저장된 선택은 유지됩니다.</p>}
      {status?.phase === "recovery_required" && <p className="social-form-error" role="status">종료 상태를 확인할 때까지 전용 브라우저의 재실행이 차단됩니다. 시스템 기본 브라우저를 선택해 링크를 열 수 있습니다.</p>}
      <p className="social-form-hint">전용 브라우저는 Studio 전용 프로필을 사용합니다. 기존 브라우저의 쿠키를 가져오지 않습니다.</p>
      {error && <p className="social-form-error" role="alert"><CircleAlert size={15} aria-hidden="true" />{error}</p>}
      {notice && <p className="desktop-browser-notice" role="status">{notice}</p>}
      <div className="desktop-browser-save"><button type="submit" className="social-button" disabled={locked || !status || choice === status.preference}>{pending === "save" ? <LoaderCircle size={15} className="social-spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{pending === "save" ? "브라우저 설정 저장 중" : "브라우저 설정 저장"}</button></div>
    </form>
  </section>;
}
