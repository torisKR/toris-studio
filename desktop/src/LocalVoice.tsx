import { invoke } from "@tauri-apps/api/core";
import { BadgeCheck, CircleAlert, Download, LoaderCircle, Mic, Power, PowerOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import "./LocalVoice.css";

export type TtsStatus = {
  supported: boolean;
  state: "running" | "starting" | "stopped";
  owned: boolean;
  narration: boolean;
  installed: boolean;
  python: { source: string; path: string } | null;
  model: { source: string; path: string } | null;
  install: { phase: "idle" | "running" | "done" | "failed"; step: string; log: string[] };
  lastError: string | null;
  license: { commercialUse: boolean; model: { name: string; license: string; url: string }; runtime: { name: string; license: string }[] };
};

const SOURCE: Record<string, string> = { toris: "Toris Studio", "mlx-narration": "MLX-Narration", huggingface: "Hugging Face 캐시", lmstudio: "LM Studio" };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Reads tts_status, polling while an install or startup is in progress. */
export function useTtsStatus(active: boolean) {
  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try { const next = await invoke<TtsStatus>("tts_status"); if (mounted.current) { setStatus(next); setError(""); } return next; }
    catch (reason) { if (mounted.current) setError(message(reason)); return null; }
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (active) void refresh(); }, [active, refresh]);
  const busy = status?.install.phase === "running" || status?.state === "starting";
  useEffect(() => {
    if (!active || !busy) return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [active, busy, refresh]);
  return { status, setStatus, error, setError, refresh };
}

export function CommercialBadge({ status }: { status: TtsStatus | null }) {
  if (!status?.license.commercialUse) return null;
  return <span className="local-voice-license" title={"모델 " + status.license.model.license + " · 런타임 " + status.license.runtime.map(item => item.name + " " + item.license).join(", ")}><BadgeCheck size={13} aria-hidden="true" />상업적 이용 가능 · 모델 {status.license.model.license}</span>;
}

/** Install, start and stop the local Qwen3-TTS engine. compact = one line for the video screen. */
export function LocalVoice({ active, compact = false, onRunningChange }: { active: boolean; compact?: boolean; onRunningChange?: (running: boolean) => void }) {
  const { status, setStatus, error, setError, refresh } = useTtsStatus(active);
  const [action, setAction] = useState<"install" | "start" | "stop" | null>(null);
  const running = status?.state === "running";
  const reported = useRef<boolean | null>(null);
  useEffect(() => { if (status && reported.current !== running) { reported.current = running; onRunningChange?.(running); } }, [status, running, onRunningChange]);

  async function run(kind: "install" | "start" | "stop") {
    setAction(kind); setError("");
    try { setStatus(await invoke<TtsStatus>("tts_" + kind)); }
    catch (reason) { setError(message(reason)); void refresh(); }
    finally { setAction(null); }
  }

  if (!status) return <div className={"local-voice" + (compact ? " compact" : "")} aria-live="polite">{error ? <span className="social-form-error" role="alert">로컬 음성: {error}</span> : <span className="social-state-label"><LoaderCircle size={12} className="social-spin" aria-hidden="true" /> 로컬 음성 확인 중</span>}</div>;

  const installing = status.install.phase === "running";
  const stateLabel = !status.supported ? "이 기기 미지원" : running ? "켜짐" : status.state === "starting" ? "켜는 중 · 모델 불러오는 중" : installing ? "설치 중" : status.installed ? "꺼짐" : "설치 필요";
  const buttons = status.supported && <div className="local-voice-actions">
    {!status.installed && <button type="button" className="social-button compact primary" disabled={!!action || installing} onClick={() => void run("install")}>{installing || action === "install" ? <LoaderCircle size={14} className="social-spin" /> : <Download size={14} />}{installing ? "설치 중" : "음성 엔진 설치"}</button>}
    {status.installed && !running && status.state !== "starting" && <button type="button" className="social-button compact primary" disabled={!!action || installing} onClick={() => void run("start")}>{action === "start" ? <LoaderCircle size={14} className="social-spin" /> : <Power size={14} />}켜기</button>}
    {status.state === "starting" && <button type="button" className="social-button compact" disabled><LoaderCircle size={14} className="social-spin" />켜는 중</button>}
    {running && status.owned && <button type="button" className="social-button compact" disabled={!!action} onClick={() => void run("stop")}>{action === "stop" ? <LoaderCircle size={14} className="social-spin" /> : <PowerOff size={14} />}끄기</button>}
  </div>;
  const problem = error || (status.install.phase === "failed" ? status.install.step : "") || status.lastError;

  if (compact) return <div className="local-voice compact" aria-live="polite">
    <span className={"social-state-label" + (running ? " ready" : "")}><Mic size={11} aria-hidden="true" /> 로컬 음성 {stateLabel}</span>
    <CommercialBadge status={status} />
    {buttons}
    {problem && <span className="social-form-error" role="alert">{problem.split("\n").slice(-1)[0]}</span>}
  </div>;

  return <div className="local-voice" aria-live="polite">
    <div className="local-voice-head"><strong>Qwen3-TTS 1.7B · MLX</strong><span className={"social-state-label" + (running ? " ready" : status.installed ? "" : " unconfigured")}>{stateLabel}</span><CommercialBadge status={status} />{buttons}</div>
    {!status.supported && <p className="social-form-hint">MLX 음성 엔진은 Apple Silicon Mac에서만 돌아갑니다. 다른 기기에서는 장면에 음성 파일을 직접 연결하세요.</p>}
    {(status.python || status.model) && <p className="local-voice-source">{status.python && <>런타임: {SOURCE[status.python.source] ?? status.python.source}</>}{status.python && status.model && " · "}{status.model && <>모델: {SOURCE[status.model.source] ?? status.model.source}</>}</p>}
    {(installing || status.install.log.length > 0) && <div className="local-voice-progress"><span>{installing && <LoaderCircle size={13} className="social-spin" aria-hidden="true" />} {status.install.step}</span>{status.install.log.length > 0 && <pre aria-label="설치 기록">{status.install.log.slice(-12).join("\n")}</pre>}</div>}
    {problem && <p className="social-form-error" role="alert"><CircleAlert size={13} aria-hidden="true" /> {problem}</p>}
    <details><summary>상업적 이용 근거와 주의할 점</summary>
      <ul>
        <li>모델: {status.license.model.name} · {status.license.model.license}. 생성한 음성을 광고·유료 영상·클라이언트 작업에 쓸 수 있습니다.</li>
        <li>런타임: {status.license.runtime.map(item => item.name + " " + item.license).join(", ")}.</li>
        <li>Apache-2.0 고지를 지키고, Qwen 상표로 홍보하지 않습니다.</li>
        <li>내장 화자(Sohee 등)의 원 화자 권리 범위는 Qwen이 따로 밝히지 않았습니다. 특정 실존 인물처럼 소개하지 마세요.</li>
        <li>실제 사람 목소리를 흉내 내거나 복제하려면 그 사람의 동의가 필요합니다.</li>
      </ul>
    </details>
  </div>;
}

