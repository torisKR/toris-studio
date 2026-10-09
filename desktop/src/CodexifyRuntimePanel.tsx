import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Check, Copy, ExternalLink, Play, RefreshCw, Save, Square } from "lucide-react";
import { applyProxyAction, applyRuntimeAction, canStopRuntime, copyPublicMcpUrl, getProxyStatus, getRuntimeStatus, openNgrokGuide, proxyLabels, proxyProviders, runRuntimeDoctor, runtimeConfiguration, runtimeIdentity, runtimeStateLabel } from "./codexify-runtime-client";
import type { CodexifyProxyStatus, CodexifyRuntimeDoctor, CodexifyRuntimeStatus, ProxyProvider } from "./codexify-runtime-client";
import "./CodexifyRuntimePanel.css";

const checkLabels = { pass: "통과", failure: "실패", skipped: "건너뜀" };
function failure(error: unknown): string { return typeof error === "string" ? error : error instanceof Error ? error.message : "Codexify 상태를 확인하지 못했습니다."; }

export function CodexifyRuntimePanel({ active, onRuntimeChange, refreshKey = 0 }: { active: boolean; onRuntimeChange: () => void; refreshKey?: number }) {
  const [status, setStatus] = useState<CodexifyRuntimeStatus | null>(null);
  const [sourceRoot, setSourceRoot] = useState("");
  const [port, setPort] = useState("21228");
  const [doctor, setDoctor] = useState<CodexifyRuntimeDoctor | null>(null);
  const [provider, setProvider] = useState<ProxyProvider>("cloudflare");
  const [proxies, setProxies] = useState<Partial<Record<ProxyProvider, CodexifyProxyStatus>>>({});
  const [busy, setBusy] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [proxyErrors, setProxyErrors] = useState<Partial<Record<ProxyProvider, string>>>({});
  const [notice, setNotice] = useState("");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const alive = useRef(false), epoch = useRef(0), pending = useRef(false);
  const current = useRef<CodexifyRuntimeStatus | null>(null);
  const drafts = useRef({ sourceRoot, port });
  const notify = useRef(onRuntimeChange);
  drafts.current = { sourceRoot, port }; notify.current = onRuntimeChange;
  const dirty = status != null && (sourceRoot.trim() !== status.sourceRoot || port.trim() !== String(status.port));
  const locked = Boolean(busy) || checking;
  const proxy = proxies[provider] ?? null;
  const proxyError = proxyErrors[provider] ?? "";

  const acceptProxy = useCallback((value: CodexifyProxyStatus) => { setProxies(previous => ({ ...previous, [value.provider]: value })); setProxyErrors(previous => ({ ...previous, [value.provider]: "" })); }, []);

  const acceptStatus = useCallback((value: CodexifyRuntimeStatus, replaceDraft = false) => {
    const previous = current.current;
    const wasDirty = previous != null && (drafts.current.sourceRoot.trim() !== previous.sourceRoot || drafts.current.port.trim() !== String(previous.port));
    if (replaceDraft || !wasDirty) { setSourceRoot(value.sourceRoot); setPort(String(value.port)); }
    current.current = value; setStatus(value); setCheckedAt(Date.now());
    if (!previous || runtimeIdentity(previous) !== runtimeIdentity(value)) { setDoctor(null); notify.current(); }
  }, []);

  const refresh = useCallback(async () => {
    if (pending.current || !alive.current || document.visibilityState !== "visible") return;
    pending.current = true; setChecking(true);
    const generation = epoch.current;
    try {
      const results = await Promise.allSettled([getRuntimeStatus(), getProxyStatus("cloudflare"), getProxyStatus("ngrok")]);
      if (!alive.current || generation !== epoch.current) return;
      if (results[0].status === "fulfilled") { acceptStatus(results[0].value); setPollError(""); }
      else setPollError(failure(results[0].reason));
      for (const [index, candidate] of proxyProviders.entries()) {
        const result = results[index + 1];
        if (result.status === "fulfilled") acceptProxy(result.value as CodexifyProxyStatus);
        else setProxyErrors(previous => ({ ...previous, [candidate]: failure(result.reason) }));
      }
    } catch (reason) { if (alive.current && generation === epoch.current) setPollError(failure(reason)); }
    finally { pending.current = false; if (alive.current) setChecking(false); }
  }, [acceptStatus, acceptProxy]);

  useEffect(() => {
    if (!active) return;
    alive.current = true; ++epoch.current; void refresh();
    const timer = setInterval(() => void refresh(), 6000);
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { alive.current = false; ++epoch.current; clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [active, refresh, refreshKey]);

  async function run(label: string, operation: () => Promise<CodexifyRuntimeStatus | CodexifyRuntimeDoctor | CodexifyProxyStatus | { runtime: CodexifyRuntimeStatus; proxy: CodexifyProxyStatus | null; proxyFailure: string; provider: ProxyProvider } | { runtime: CodexifyRuntimeStatus; clearProxies: true } | { notice: string }>) {
    if (pending.current || !alive.current) return;
    pending.current = true; const generation = ++epoch.current;
    setBusy(label); setError(""); setNotice("");
    try {
      const result = await operation();
      if (!alive.current || generation !== epoch.current) return;
      if ("notice" in result) {
        setNotice(result.notice);
      } else if ("clearProxies" in result) {
        acceptStatus(result.runtime, true); setPollError(""); setNotice(result.runtime.message);
        setProxies(previous => Object.fromEntries(Object.entries(previous).map(([name, value]) => [name, value?.managed ? { ...value, running: false, managed: false, mcpUrl: null, message: "앱 브리지와 함께 종료됐습니다." } : value])));
      } else if ("runtime" in result) {
        acceptStatus(result.runtime, true); setPollError("");
        if (result.proxy) acceptProxy(result.proxy);
        else setProxies(previous => ({ ...previous, [result.provider]: undefined }));
        setProxyErrors(previous => ({ ...previous, [result.provider]: result.proxyFailure }));
        setNotice(result.proxy ? result.proxy.message : result.runtime.message);
      } else if ("checks" in result) {
        setDoctor(result); setNotice(result.message);
      } else if ("mcpUrl" in result) {
        acceptProxy(result); setNotice(result.message);
      } else {
        acceptStatus(result, true); setPollError(""); setNotice(result.message);
      }
    } catch (reason) { if (alive.current && generation === epoch.current) setError(failure(reason)); }
    finally { pending.current = false; if (alive.current) setBusy(""); }
  }

  async function start() {
    if (!status) throw new Error("Codexify 상태를 먼저 확인하세요.");
    const runtime = await applyRuntimeAction("start", status);
    if (!runtime.running) throw new Error(runtime.managed ? "앱에서 시작한 Codexify가 응답하지 않습니다. 앱에서 실행한 Codexify를 종료한 뒤 다시 시작하세요." : runtime.message || "Codexify가 시작되지 않았습니다. 진단을 실행해 주세요.");
    try { return { runtime, proxy: await applyProxyAction("start", proxy, provider), proxyFailure: "", provider }; }
    catch (reason) { return { runtime, proxy: null, proxyFailure: `Codexify는 실행 중입니다. ${proxyLabels[provider]} 프록시: ${failure(reason)}`, provider }; }
  }

  if (!active) return null;
  return <section className="codexify-runtime" aria-label="앱 내 Codexify 관리" aria-busy={locked}>
    <header className="codexify-runtime-heading"><div><span className="codexify-eyebrow">LOCAL BRIDGE</span><h3>Codexify를 앱에서 실행하세요</h3><p>프로젝트가 모인 Source 폴더를 지정하고, 이 앱에서 로컬 MCP 브리지를 관리합니다.</p></div><button className="social-button compact" disabled={locked} onClick={() => void refresh()} aria-label="Codexify 실행 상태 새로고침"><RefreshCw size={15}/>상태 확인</button></header>
    <div className="codexify-runtime-summary">
      <div><span>실행 상태</span><strong className={status?.running ? "codexify-live" : undefined}>{runtimeStateLabel(status)}</strong></div>
      <div><span>Codexify</span><strong>{status?.version ? `v${status.version}` : "버전 확인 필요"}{status?.binaryAvailable ? <small>{status.bundled ? "앱에 포함됨" : "외부 설치본"}</small> : null}</strong></div>
      <div><span>로컬 MCP</span><strong>{status ? `http://127.0.0.1:${status.port}/mcp` : "상태 확인 중"}</strong></div>
    </div>
    {(error || pollError || proxyError) && <p className="social-notice error" role="alert">{error || pollError || proxyError}</p>}
    {notice && <p className="social-notice success" role="status">{notice}</p>}
    {busy && <p className="codexify-working" role="status">{busy} 중…</p>}
    {status?.message && !notice && <p className="codexify-runtime-note">{status.message}</p>}
    {(status?.managed || status?.running) && <p className="codexify-runtime-note">{status.managed ? status.running ? "앱에서 시작한 Codexify는 Toris Studio를 닫으면 함께 종료됩니다." : "앱에서 시작한 Codexify가 응답하지 않습니다. 앱에서 실행한 Codexify를 종료한 뒤 다시 시작하세요." : "기존 브리지에 연결했습니다. 이 프로세스의 실행과 종료는 기존 실행 프로그램에서 관리합니다."}</p>}
    {status && !status.binaryAvailable && <p className="codexify-runtime-note">Codexify가 포함된 Toris Studio 설치본으로 업데이트하세요. 개발 실행에서는 외부 Codexify 설치 경로도 확인합니다.</p>}
    <form className="codexify-runtime-form" onSubmit={event => { event.preventDefault(); if (status) void run("Codexify 설정 저장", async () => applyRuntimeAction("configure", status, runtimeConfiguration(sourceRoot, port))); }}>
      <fieldset disabled={!status || status.running || status.managed || locked}>
        <label>Source · 프로젝트가 모인 폴더<input aria-label="Codexify Source 폴더" value={sourceRoot} onChange={event => setSourceRoot(event.target.value)} spellCheck={false} required placeholder="~/projects"/></label>
        <label className="codexify-runtime-port">로컬 포트<input aria-label="Codexify 로컬 포트" type="text" value={port} readOnly spellCheck={false}/></label>
        <button className="social-button" type="submit" disabled={!dirty}><Save size={15}/>Source 저장</button>
      </fieldset>
      <p className="codexify-runtime-note">Source는 프로젝트 목록의 기준 폴더입니다. 아래의 작업 프로젝트와 연결 대화는 선택한 프로젝트를 그대로 사용합니다.{status?.running || status?.managed ? " Source를 변경하려면 실행 중인 브리지를 먼저 종료하세요." : ""}</p>
    </form>
    <div className="codexify-runtime-actions"><button className="social-button primary" disabled={(!status?.binaryAvailable && !status?.running) || Boolean(status?.running && proxy?.running) || Boolean(status?.managed && !status.running) || dirty || locked || Boolean(pollError)} onClick={() => void run(`Codexify·${proxyLabels[provider]} 시작`, start)}><Play size={15}/>Codexify · 프록시 시작</button><button className="social-button" disabled={!canStopRuntime(status) || locked || Boolean(pollError)} onClick={() => { if (status) void run("앱 Codexify 종료", async () => ({ runtime: await applyRuntimeAction("stop", status), clearProxies: true })); }}><Square size={15}/>앱에서 실행한 Codexify 종료</button><button className="social-button" disabled={!status?.binaryAvailable || locked} onClick={() => void run("Codexify 진단", runRuntimeDoctor)}><Activity size={15}/>진단 실행</button></div>
    {dirty && <p className="codexify-runtime-note" role="status">Source 변경을 저장한 뒤 시작하세요.</p>}
    <section className="codexify-runtime-proxy" aria-label="ChatGPT 공개 MCP 주소">
      <header><h4>ChatGPT에서 사용할 MCP 주소</h4><label className="codexify-proxy-select">공개 주소 제공자<select aria-label="공개 MCP 제공자" value={provider} disabled={locked} onChange={event => { setProvider(event.target.value as ProxyProvider); setError(""); setNotice(""); }}>{proxyProviders.map(candidate => <option key={candidate} value={candidate}>{proxyLabels[candidate]}</option>)}</select></label></header>
      <div className="codexify-proxy-overview" aria-label="공개 MCP 서버 상태">{proxyProviders.map(candidate => { const value = proxies[candidate]; return <div key={candidate} aria-label={`${proxyLabels[candidate]} 서버 상태`}><strong>{proxyLabels[candidate]}</strong><span className={value?.running && value.mcpUrl ? "codexify-live" : ""}>{proxyErrors[candidate] ? "상태 확인 필요" : !value ? "상태 확인 중" : value.running ? value.mcpUrl ? value.managed ? "앱 프록시 실행 중" : "기존 프록시 사용 중" : "실행 중 · 주소 확인 필요" : value.available ? "시작 준비됨" : "CLI 설치 필요"}</span>{value?.running && value.mcpUrl && <small>{value.mcpUrl}</small>}</div>; })}</div>
      <p className="codexify-runtime-note">두 제공자는 각각 시작·종료할 수 있습니다. 제공자를 바꿔도 이미 실행한 서버는 계속 실행됩니다.</p>
      {proxy?.running && proxy.mcpUrl ? <p className="codexify-public-address" aria-label="공개 MCP 주소">{proxy.mcpUrl}</p> : <p className="codexify-runtime-note">{proxy?.running ? "실행 중인 프록시의 공개 주소를 확인할 수 없습니다. 프록시를 종료한 뒤 다시 시작하세요." : `선택한 ${proxyLabels[provider]}로 로컬 MCP의 공개 주소를 준비합니다.`}</p>}
      <div className="codexify-runtime-actions"><button className="social-button" disabled={!status?.running || !proxy?.available || proxy.running || locked || Boolean(pollError)} onClick={() => void run(`${proxyLabels[provider]} 프록시 시작`, () => applyProxyAction("start", proxy, provider))}><Play size={15}/>공개 MCP 주소 열기</button><button className="social-button" disabled={!proxy?.running || !proxy.mcpUrl || locked || Boolean(proxyError)} onClick={() => { if (proxy) void run(`${proxyLabels[provider]} MCP 주소 복사`, async () => { await copyPublicMcpUrl(proxy); return { notice: `${proxyLabels[provider]} MCP 주소를 복사했습니다. ChatGPT 플러그인의 서버 URL에 입력하세요.` }; }); }}><Copy size={15}/>공개 MCP 주소 복사</button><button className="social-button" disabled={!proxy?.running || !proxy.managed || locked || Boolean(proxyError)} onClick={() => void run(`${proxyLabels[provider]} 프록시 종료`, () => applyProxyAction("stop", proxy, provider))}><Square size={15}/>앱 프록시 종료</button></div>
      {provider === "ngrok" && <div className="codexify-ngrok-help"><p className="codexify-runtime-note">{proxy?.available ? "설치된 ngrok CLI와 기존 계정 설정을 사용합니다. 계정 인증 오류가 표시되면 공식 설정 안내에서 로컬 authtoken 설정을 완료한 뒤 다시 시작하세요." : "ngrok CLI가 필요합니다. 공식 페이지에서 Mac·Windows용 CLI를 설치하고 계정 설정을 완료한 뒤 상태를 다시 확인하세요."}</p><div className="codexify-runtime-actions"><button className="social-button compact" disabled={locked} onClick={() => void run("ngrok 설치 안내 열기", async () => { await openNgrokGuide("download"); return { notice: "ngrok 공식 설치 페이지를 열었습니다." }; })}><ExternalLink size={14}/>ngrok 설치 안내</button><button className="social-button compact" disabled={locked} onClick={() => void run("ngrok 계정 설정 안내 열기", async () => { await openNgrokGuide("setup"); return { notice: "ngrok 공식 계정 설정 안내를 열었습니다." }; })}><ExternalLink size={14}/>ngrok 계정 설정 안내</button></div></div>}
      <p className="codexify-runtime-note">생성된 MCP 주소는 제공자별로 이 기기에 저장됩니다. ChatGPT 플러그인 등록은 ChatGPT 등록 화면에서 완료하세요. 주소가 바뀌면 플러그인의 서버 URL도 갱신하세요.</p>{proxy?.message && proxy.message !== notice && <p className="codexify-runtime-note">{proxy.message}</p>}
    </section>
    {status?.configPath && <details className="codexify-runtime-details"><summary>로컬 설정 경로와 실행 방식</summary><dl><div><dt>설정 파일</dt><dd>{status.configPath}</dd></div><div><dt>시스템 서비스</dt><dd>{status.service ? status.service.running ? "실행 중" : status.service.installed ? status.service.enabled === null ? "설치됨 · 활성화 상태 확인 필요" : status.service.enabled ? "활성화됨 · 실행 중 아님" : "설치됨 · 비활성화" : "설치되지 않음" : "정보 없음"}</dd></div></dl><p className="codexify-runtime-note">시스템 서비스와 앱에서 실행하는 브리지는 별도로 진단합니다. 앱에 포함된 Codexify는 Toris Studio 업데이트로 함께 업데이트됩니다.</p></details>}
    {doctor && <section className="codexify-runtime-doctor" aria-label="Codexify 진단 결과"><header><h4>{doctor.failures ? `진단 · ${doctor.failures}개 항목 확인 필요` : "진단 완료"}</h4><span className={doctor.bridgeHealthy ? "codexify-live" : ""}><Check size={14}/>{doctor.bridgeHealthy ? "앱 브리지 연결 정상" : "앱 브리지 연결 확인 필요"}</span></header><ul>{doctor.checks.map((check, index) => <li key={`${check.id}-${index}`}><span className={`codexify-check-label ${check.status}`}>{checkLabels[check.status]}</span><div><strong>{check.label}</strong><p>{check.message}</p></div></li>)}</ul>{doctor.checks.some(check => check.id === "service" && check.status === "failure") && <p className="codexify-runtime-note">시스템 서비스 진단에 실패했습니다. 위의 앱 브리지 상태와 서비스 진단 결과를 각각 확인하세요.</p>}</section>}
    {checkedAt && <p className="codexify-runtime-timestamp">최근 상태 확인 {new Date(checkedAt).toLocaleTimeString("ko-KR")}</p>}
  </section>;
}
