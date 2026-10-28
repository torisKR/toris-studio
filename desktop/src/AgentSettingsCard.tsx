import { Check, CircleAlert, Eye, EyeOff, KeyRound, LoaderCircle, RefreshCw, Save, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ModelChoice, ModelOption, ProviderCheck, ProviderInfo } from "./ai-client";
import { KEY_PROVIDERS, agentCall, saveSettings, type AgentSettings, type SettingsView } from "./agent-client";

type Props = { view: SettingsView; providers: ProviderInfo[]; busy: boolean; onSaved: (view: SettingsView) => void; onError: (message: string) => void };
type Slot = "agentModel" | "contentModel";
type CheckState = ProviderCheck | "checking" | undefined;

const IMAGE_PROVIDERS = [{ id: "openai", label: "OpenAI 이미지", models: ["gpt-image-1"] }, { id: "google", label: "Gemini 이미지", models: ["gemini-2.5-flash-image"] }];
const EMBEDDINGS = [
  { id: "local", label: "로컬 (키 불필요 · 이름 기반)", models: [""] },
  { id: "openai", label: "OpenAI 임베딩", models: ["text-embedding-3-small", "text-embedding-3-large"] },
  { id: "google", label: "Gemini 임베딩", models: ["text-embedding-004"] },
  { id: "ollama", label: "Ollama 임베딩", models: ["nomic-embed-text", "mxbai-embed-large"] },
];
/** Order shown in the provider list: subscriptions people already pay for come first. */
const ORDER = ["codex-cli", "claude-cli", "kiro-cli", "cursor-cli", "gemini-cli", "openai", "anthropic", "google", "openrouter", "ollama"];
const STATE_LABEL: Record<ProviderCheck["state"], string> = { connected: "연결됨", "signed-out": "로그인 필요", missing: "미설치", "needs-key": "API 키 필요", offline: "꺼짐", error: "확인 실패" };

/** One settings card. A plain grid box (not <fieldset>) so its rows can join the parent grid. */
function PickerBox({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  const id = useId();
  return <div className="agent-picker" role="group" aria-labelledby={id}>
    <strong className="agent-picker-title" id={id}>{title}</strong><p className="agent-hint">{hint}</p>
    {children}
  </div>;
}

function optionsWith(models: ModelOption[], current: string): ModelOption[] {
  return current && !models.some(m => m.id === current) ? [{ id: current, label: current, detail: "저장된 모델" }, ...models] : models;
}

/** Live connection state for one provider; animates once when a check finishes. */
function ConnectionStatus({ check, provider, onRetry }: { check: CheckState; provider?: ProviderInfo; onRetry: () => void }) {
  if (!provider) return <small className="agent-muted">공급자를 고르면 연결을 확인합니다.</small>;
  if (check === "checking" || check === undefined) return <small className="agent-connection checking" role="status"><LoaderCircle size={13} className="social-spin" aria-hidden="true" />{provider.label} 연결 확인 중</small>;
  const ok = check.state === "connected";
  return <small key={check.checkedAt} className={"agent-connection " + (ok ? "ok" : "warn")} role="status">
    {ok ? <Check size={13} aria-hidden="true" /> : <CircleAlert size={13} aria-hidden="true" />}
    <span><b>{STATE_LABEL[check.state]}</b>{check.account ? " · " + check.account : ""}{ok ? " · 모델 " + check.models.length + "개" + (check.source === "account" ? "" : " (추천 목록)") : ""}<br />{check.detail}</span>
    <button type="button" className="agent-recheck" aria-label={provider.label + " 다시 확인"} title="다시 확인" onClick={onRetry}><RefreshCw size={12} /></button>
  </small>;
}

function ModelPicker({ label, hint, value, providers, check, onCheck, onChange }: { label: string; hint: string; value: ModelChoice | null; providers: ProviderInfo[]; check: CheckState; onCheck: (provider: string) => void; onChange: (v: ModelChoice | null) => void }) {
  const provider = providers.find(p => p.id === value?.provider);
  const ordered = [...providers].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const ready = check && check !== "checking" ? check : null;
  const models = optionsWith(ready?.models ?? (provider?.suggestedModels ?? []).map(id => ({ id, label: id })), value?.model ?? "");
  const groups: Array<[string, ProviderInfo["kind"]]> = [["구독 (CLI 로그인)", "subscription"], ["API 키", "api"], ["로컬", "local"]];
  return <PickerBox title={label} hint={hint}>
    <select aria-label={label + " 공급자"} value={value?.provider ?? ""} onChange={e => onChange(e.target.value ? { provider: e.target.value, model: "" } : null)}>
      <option value="">선택 안 함</option>
      {groups.map(([title, kind]) => <optgroup key={kind} label={title}>{ordered.filter(p => p.kind === kind).map(p => <option key={p.id} value={p.id}>{p.available ? "● " : "○ "}{p.label}{p.plan ? " · " + p.plan : ""}</option>)}</optgroup>)}
    </select>
    <select aria-label={label + " 모델"} value={value?.model ?? ""} disabled={!value} onChange={e => value && onChange({ ...value, model: e.target.value })}>
      {!value && <option value="">공급자를 먼저 고르세요</option>}
      {value && <option value="">{provider?.kind === "subscription" ? "CLI 기본 모델" : "공급자 기본 모델"}</option>}
      {value && models.slice(0, 400).map(m => <option key={m.id} value={m.id} title={m.detail}>{m.label === m.id ? m.id : m.label + " · " + m.id}{m.detail ? " — " + m.detail : ""}</option>)}
    </select>
    <ConnectionStatus check={check} provider={provider} onRetry={() => provider && onCheck(provider.id)} />
  </PickerBox>;
}

export function AgentSettingsCard({ view, providers, busy, onSaved, onError }: Props) {
  const [draft, setDraft] = useState<AgentSettings>(view.settings);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const generation = useRef<Record<string, number>>({});
  useEffect(() => { setDraft(view.settings); setKeys({}); }, [view]);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(view.settings) || Object.keys(keys).length > 0, [draft, keys, view.settings]);
  const set = (slot: Slot) => (value: ModelChoice | null) => setDraft(d => ({ ...d, [slot]: value }));

  const check = useCallback((provider: string) => {
    const run = (generation.current[provider] ?? 0) + 1;
    generation.current[provider] = run;
    setChecks(c => ({ ...c, [provider]: "checking" }));
    void agentCall<ProviderCheck>("models.check", { provider })
      .then(result => { if (generation.current[provider] === run) setChecks(c => ({ ...c, [provider]: result })); })
      .catch((error: unknown) => { if (generation.current[provider] === run) setChecks(c => ({ ...c, [provider]: { provider, state: "error", detail: error instanceof Error ? error.message : String(error), models: [], source: "suggested", checkedAt: new Date().toISOString() } })); });
  }, []);
  // Check what is selected; a saved key (view changes) re-checks API providers.
  const selected = [draft.agentModel?.provider, draft.contentModel?.provider].filter((p): p is string => Boolean(p));
  const selectedKey = [...new Set(selected)].join(",");
  useEffect(() => { for (const provider of selectedKey.split(",").filter(Boolean)) check(provider); }, [selectedKey, view.keys, check]);

  async function save() {
    setSaving(true);
    try { onSaved(await saveSettings(draft, keys)); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }

  const picker = (slot: Slot, label: string, hint: string) => <ModelPicker label={label} hint={hint} value={draft[slot]} providers={providers} check={draft[slot] ? checks[draft[slot]!.provider] : undefined} onCheck={check} onChange={set(slot)} />;
  const image = IMAGE_PROVIDERS.find(p => p.id === draft.image?.provider);
  const embedding = EMBEDDINGS.find(p => p.id === draft.embedding.provider) ?? EMBEDDINGS[0];

  return <section className="agent-card" aria-label="모델 설정">
    <div className="agent-card-head"><h2>모델 설정</h2><button className="social-button primary" disabled={!dirty || saving || busy} onClick={() => void save()}><Save size={15} />{saving ? "저장 중" : "저장"}</button></div>
    <div className="agent-grid">
      {picker("agentModel", "에이전트", "Supervisor·Expert·QA가 코드 작업에 사용합니다.")}
      {picker("contentModel", "콘텐츠 작성", "AI 작업실·영상 초안·SNS 문구에 사용합니다. 비우면 에이전트 모델을 씁니다.")}
      <PickerBox title="이미지 생성" hint="이미지 생성기에서 사용합니다. API 키가 필요합니다.">
        <select aria-label="이미지 공급자" value={draft.image?.provider ?? ""} onChange={e => { const p = IMAGE_PROVIDERS.find(x => x.id === e.target.value); setDraft(d => ({ ...d, image: p ? { provider: p.id, model: p.models[0] } : null })); }}>
          <option value="">선택 안 함</option>{IMAGE_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <select aria-label="이미지 모델" value={draft.image?.model ?? ""} disabled={!draft.image} onChange={e => setDraft(d => ({ ...d, image: d.image ? { ...d.image, model: e.target.value } : null }))}>
          {!draft.image && <option value="">공급자를 먼저 고르세요</option>}
          {image && optionsWith(image.models.map(id => ({ id, label: id })), draft.image?.model ?? "").map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
        </select>
        {draft.image ? <small className={view.keys[draft.image.provider] ? "agent-connection ok" : "agent-connection warn"}>{view.keys[draft.image.provider] ? <Check size={13} aria-hidden="true" /> : <CircleAlert size={13} aria-hidden="true" />}<span>{view.keys[draft.image.provider] ? "API 키 저장됨" : "아래에 API 키를 등록하세요."}</span></small> : <small className="agent-muted">선택하지 않으면 이미지를 만들지 않습니다.</small>}
      </PickerBox>
      <PickerBox title="코드 검색 임베딩" hint="바꾸면 프로젝트를 다시 색인해야 합니다.">
        <select aria-label="임베딩 공급자" value={draft.embedding.provider} onChange={e => { const p = EMBEDDINGS.find(x => x.id === e.target.value)!; setDraft(d => ({ ...d, embedding: { provider: p.id, model: p.models[0] } })); }}>
          {EMBEDDINGS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <select aria-label="임베딩 모델" value={draft.embedding.model} disabled={draft.embedding.provider === "local"} onChange={e => setDraft(d => ({ ...d, embedding: { ...d.embedding, model: e.target.value } }))}>
          {draft.embedding.provider === "local" ? <option value="">로컬 해시 임베딩</option> : optionsWith(embedding.models.map(id => ({ id, label: id })), draft.embedding.model).map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
        </select>
        <small className="agent-muted">{draft.embedding.provider === "local" ? "키 없이 이 기기에서 계산합니다." : draft.embedding.provider === "ollama" ? "Ollama에서 모델을 받아 두세요." : view.keys[draft.embedding.provider] ? "API 키 저장됨" : "아래에 API 키를 등록하세요."}</small>
      </PickerBox>
    </div>
    <div className="agent-keys" aria-label="API 키">
      <h3><KeyRound size={15} />API 키 <small>OS 키체인에 저장 · 화면에 다시 표시하지 않음</small></h3>
      {KEY_PROVIDERS.map(p => <div key={p.id} className="agent-key-row">
        <span>{p.label}</span>
        <span className={view.keys[p.id] ? "agent-ok" : "agent-muted"}>{keys[p.id] === "" ? "삭제 예정" : view.keys[p.id] ? "저장됨" : "미등록"}</span>
        <input type={reveal[p.id] ? "text" : "password"} autoComplete="off" spellCheck={false} aria-label={p.label + " API 키"} placeholder={view.keys[p.id] ? "바꿀 때만 입력" : p.placeholder} value={keys[p.id] ?? ""} onChange={e => setKeys(k => ({ ...k, [p.id]: e.target.value }))} />
        <button type="button" className="social-button subtle icon-only" aria-label={reveal[p.id] ? "숨기기" : "입력값 보기"} onClick={() => setReveal(r => ({ ...r, [p.id]: !r[p.id] }))}>{reveal[p.id] ? <EyeOff size={15} /> : <Eye size={15} />}</button>
        {view.keys[p.id] && <button type="button" className="social-button subtle icon-only" aria-label={p.label + " 키 삭제"} onClick={() => setKeys(k => ({ ...k, [p.id]: "" }))}><X size={15} /></button>}
      </div>)}
    </div>
    <label className="agent-root">프로젝트 폴더<input value={draft.projectsRoot} onChange={e => setDraft(d => ({ ...d, projectsRoot: e.target.value }))} /></label>
  </section>;
}

