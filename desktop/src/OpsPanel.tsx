import { Activity, Check, CircleAlert, KeyRound, ListPlus, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { KIND_LABELS, SECRET_LABELS, SOURCE_LABELS, STATE_LABELS, deleteProduct, draftError, draftOf, emptyDraft, isStale, loadOverview, needsAttention, openTask, orderedStatuses, refreshOps, saveProduct, saveSecret, type OpsOverview, type OpsStatus, type Product, type ProductDraft, type SecretKind } from "./ops-client";
import "./OpsPanel.css";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const when = (iso: string) => new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const FIELDS: Array<{ key: "githubRepo" | "cloudflareWorker" | "cloudflarePages" | "healthUrl" | "playPackage"; label: string; placeholder: string }> = [
  { key: "githubRepo", label: "GitHub 저장소", placeholder: "owner/repo" },
  { key: "cloudflareWorker", label: "Cloudflare Worker", placeholder: "my-worker" },
  { key: "cloudflarePages", label: "Cloudflare Pages 프로젝트", placeholder: "my-site" },
  { key: "healthUrl", label: "헬스체크 주소", placeholder: "https://example.com/health" },
  { key: "playPackage", label: "Google Play 패키지", placeholder: "com.example.app" },
];

function StatusRow({ product, status, now, busy, onTask }: { product: Product; status: OpsStatus; now: Date; busy: boolean; onTask: () => void }) {
  const state = STATE_LABELS[status.state];
  const url = typeof status.detail.url === "string" && status.detail.url.startsWith("https://") ? status.detail.url : null;
  return <li className="ops-status" data-tone={state.tone}>
    <span className="ops-source">{SOURCE_LABELS[status.source]}</span>
    <span className="ops-state">{state.label}</span>
    <span className="ops-summary">{url ? <a href={url} target="_blank" rel="noreferrer">{status.summary}</a> : status.summary}</span>
    <time dateTime={status.observedAt} title="마지막 확인">{when(status.observedAt)}{isStale(status, now) && <small className="ops-stale"> · 오래됨</small>}</time>
    {needsAttention(status) && <button className="social-button compact subtle" disabled={busy} onClick={onTask} aria-label={product.name + " " + SOURCE_LABELS[status.source] + " 작업 만들기"}><ListPlus size={13} />작업 만들기</button>}
  </li>;
}

function SecretRow({ kind, saved, onSaved }: { kind: SecretKind; saved: boolean; onSaved: (secrets: OpsOverview["secrets"], text: string) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const meta = SECRET_LABELS[kind];
  const id = "ops-secret-" + kind;
  async function submit(next: string | null) {
    setBusy(true); setError("");
    try { onSaved(await saveSecret(kind, next), next ? meta.label + " 저장됨" : meta.label + " 삭제됨"); setValue(""); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  return <form className="ops-secret" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (value.trim()) void submit(value); }}>
    <label htmlFor={id}>{meta.label} <span className={saved ? "ops-saved" : "ops-missing"}>{saved ? "저장됨" : "없음"}</span></label>
    {meta.multiline
      ? <textarea id={id} rows={3} value={value} autoComplete="off" spellCheck={false} placeholder={saved ? "새 값으로 바꾸려면 붙여넣기" : "JSON 키 붙여넣기"} onChange={event => setValue(event.target.value)} />
      : <input id={id} type="password" value={value} autoComplete="off" spellCheck={false} placeholder={saved ? "새 값으로 바꾸려면 입력" : ""} onChange={event => setValue(event.target.value)} />}
    <small>{meta.hint}</small>
    {error && <p className="social-form-error" role="alert">{error}</p>}
    <div className="ops-secret-actions"><button className="social-button compact" disabled={busy || !value.trim()}>{busy ? <LoaderCircle size={13} className="social-spin" /> : <Check size={13} />}저장</button>{saved && <button type="button" className="social-button compact subtle" disabled={busy} onClick={() => void submit(null)}>삭제</button>}</div>
  </form>;
}

/** Read-only status of every product the business runs, with failures turned into planner work. */
export function OpsPanel({ active, databaseConnected, onOpenPlanner }: { active: boolean; databaseConnected: boolean; onOpenPlanner: () => void }) {
  const [data, setData] = useState<OpsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"refresh" | "save" | "task" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ text: string; planner?: boolean } | null>(null);
  const [draft, setDraft] = useState<ProductDraft | null>(null);
  const [formError, setFormError] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  const load = useCallback(async () => {
    if (!databaseConnected) return;
    setLoading(true); setError("");
    try { setData(await loadOverview()); }
    catch (e) { setError(message(e)); }
    finally { setLoading(false); }
  }, [databaseConnected]);

  useEffect(() => { if (active) void load(); }, [active, load]);
  useEffect(() => { const node = dialog.current; if (!node) return; if (draft && !node.open) node.showModal(); if (!draft && node.open) node.close(); }, [draft]);

  async function refresh() {
    setBusy("refresh"); setError(""); setNotice(null);
    try { const result = await refreshOps(); setNotice({ text: "상태 " + result.snapshots + "건을 새로 확인했습니다." }); await load(); }
    catch (e) { setError(message(e)); }
    finally { setBusy(null); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const problem = draftError(draft);
    if (problem) { setFormError(problem); return; }
    setBusy("save"); setFormError("");
    try { await saveProduct(draft); setDraft(null); setNotice({ text: "제품을 저장했습니다. 지금 확인을 누르면 상태를 가져옵니다." }); await load(); }
    catch (e) { setFormError(message(e)); }
    finally { setBusy(null); }
  }

  async function remove(product: Product) {
    if (!window.confirm(product.name + "을(를) 목록과 상태 기록에서 지울까요? 원격 서비스에는 영향이 없습니다.")) return;
    setError("");
    try { await deleteProduct(product.id); await load(); }
    catch (e) { setError(message(e)); }
  }

  async function task(product: Product, status: OpsStatus) {
    setBusy("task"); setError("");
    try { await openTask(product.id, status.source); setNotice({ text: product.name + " · " + SOURCE_LABELS[status.source] + " 작업을 일정·작업에 열었습니다.", planner: true }); }
    catch (e) { setError(message(e)); }
    finally { setBusy(null); }
  }

  if (!active) return null;
  if (!databaseConnected) return <div className="social-notice info"><CircleAlert size={18} /><span>운영 상태는 로컬 DB에 저장됩니다. 연결 설정에서 DB를 먼저 연결하세요.</span></div>;
  const now = new Date();
  const products = data?.products ?? [];
  const attention = products.reduce((sum, product) => sum + product.statuses.filter(needsAttention).length, 0);
  const missing = (Object.keys(SECRET_LABELS) as SecretKind[]).filter(kind => !data?.secrets[kind]).length;
  return <section className="ops" aria-label="운영 상태">
    <div className="ops-bar">
      <span className="ops-count">{products.length}개 제품{attention > 0 && <span className="ops-alert">확인 필요 {attention}</span>}</span>
      <span className="ops-note">읽기 전용 · 원격 서비스는 바꾸지 않습니다</span>
      <div className="ops-actions">
        <button className="social-button compact" aria-expanded={showSecrets} aria-controls="ops-secrets" onClick={() => setShowSecrets(open => !open)}><KeyRound size={14} />연결 설정{missing > 0 && <small>{" · 미설정 " + missing}</small>}</button>
        <button className="social-button compact" disabled={!!busy || products.length === 0} onClick={() => void refresh()}>{busy === "refresh" ? <LoaderCircle size={14} className="social-spin" /> : <RefreshCw size={14} />}지금 확인</button>
        <button className="social-button primary compact" disabled={!!busy} onClick={() => { setFormError(""); setDraft(emptyDraft()); }}><Plus size={14} />제품 추가</button>
      </div>
    </div>
    {error && <div className="social-notice error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
    {notice && <div className="social-notice success" role="status"><Check size={17} /><span>{notice.text}</span>{notice.planner && <button className="social-button compact" onClick={onOpenPlanner}>일정·작업 열기</button>}<button className="social-dismiss" aria-label="알림 닫기" onClick={() => setNotice(null)}><X size={15} /></button></div>}
    {showSecrets && <section id="ops-secrets" className="ops-card ops-secrets" aria-label="운영 연결 설정">
      <h2>연결 설정</h2>
      <p className="ops-note">값은 OS 키체인에만 저장되고 화면으로 다시 돌아오지 않습니다. 읽기 권한만 준 토큰을 쓰세요.</p>
      <div className="ops-secret-grid">{(Object.keys(SECRET_LABELS) as SecretKind[]).map(kind => <SecretRow key={kind} kind={kind} saved={!!data?.secrets[kind]} onSaved={(secrets, text) => { setData(current => current ? { ...current, secrets } : current); setNotice({ text }); }} />)}</div>
    </section>}
    {loading && !data ? <p className="ops-empty"><LoaderCircle size={15} className="social-spin" />불러오는 중</p>
      : products.length === 0 ? <div className="ops-card ops-empty-card"><Activity size={22} aria-hidden="true" /><p>앱·웹·서비스를 추가하면 CI, 배포, 헬스체크, Play 심사 상태를 한 화면에서 봅니다.</p><button className="social-button primary compact" onClick={() => setDraft(emptyDraft())}><Plus size={14} />첫 제품 추가</button></div>
      : <ul className="ops-products">{products.map(product => <li key={product.id} className="ops-card" data-attention={product.statuses.some(needsAttention) || undefined}>
        <div className="ops-product-head"><h2>{product.name}</h2><span className="ops-kind">{KIND_LABELS[product.kind]}</span>
          <button className="social-button compact subtle icon-only" aria-label={product.name + " 편집"} onClick={() => { setFormError(""); setDraft(draftOf(product)); }}><Pencil size={13} /></button>
          <button className="social-button compact subtle icon-only" aria-label={product.name + " 삭제"} onClick={() => void remove(product)}><Trash2 size={13} /></button></div>
        {product.statuses.length
          ? <ul className="ops-statuses">{orderedStatuses(product.statuses).map(status => <StatusRow key={status.source} product={product} status={status} now={now} busy={busy === "task"} onTask={() => void task(product, status)} />)}</ul>
          : <p className="ops-empty">{[product.githubRepo, product.cloudflareWorker, product.cloudflarePages, product.healthUrl, product.playPackage].some(Boolean) ? "아직 확인하지 않았습니다. 지금 확인을 누르세요." : "연결된 소스가 없습니다. 편집에서 저장소나 주소를 추가하세요."}</p>}
      </li>)}</ul>}
    <dialog ref={dialog} className="social-dialog" aria-labelledby="ops-product-title" onClose={() => setDraft(null)}>
      {draft && <form onSubmit={event => void submit(event)} noValidate>
        <div className="social-dialog-header"><div><h2 id="ops-product-title">{draft.id ? "제품 편집" : "제품 추가"}</h2><p>필요한 소스만 채우세요. 비어 있는 소스는 확인하지 않습니다.</p></div><button type="button" className="social-dismiss" aria-label="닫기" onClick={() => setDraft(null)}><X size={20} /></button></div>
        <div className="ops-form-row"><label>이름<input required maxLength={120} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>종류<select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as ProductDraft["kind"] })}>{Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
        {FIELDS.map(field => <label key={field.key}>{field.label} <small>선택</small><input value={draft[field.key]} placeholder={field.placeholder} maxLength={field.key === "healthUrl" ? 2048 : 200} spellCheck={false} onChange={event => setDraft({ ...draft, [field.key]: event.target.value })} /></label>)}
        {formError && <p className="social-form-error" role="alert">{formError}</p>}
        <div className="social-dialog-actions"><button type="button" className="social-button" onClick={() => setDraft(null)}>취소</button><button className="social-button primary" disabled={busy === "save"}>{busy === "save" ? <LoaderCircle size={15} className="social-spin" /> : <Check size={15} />}저장</button></div>
      </form>}
    </dialog>
  </section>;
}
