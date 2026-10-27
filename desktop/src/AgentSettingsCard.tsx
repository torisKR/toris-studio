import { Eye, EyeOff, KeyRound, Save, X } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { ModelChoice, ProviderInfo } from "./ai-client";
import { KEY_PROVIDERS, agentCall, saveSettings, type AgentSettings, type SettingsView } from "./agent-client";

type Props = { view: SettingsView; providers: ProviderInfo[]; busy: boolean; onSaved: (view: SettingsView) => void; onError: (message: string) => void };
type Slot = "agentModel" | "contentModel";

const IMAGE_PROVIDERS = [{ id: "openai", label: "OpenAI 이미지", model: "gpt-image-1" }, { id: "google", label: "Gemini 이미지", model: "gemini-2.5-flash-image" }];
const EMBEDDINGS = [
  { id: "local", label: "로컬 (키 불필요 · 이름 기반)", model: "" },
  { id: "openai", label: "OpenAI 임베딩", model: "text-embedding-3-small" },
  { id: "google", label: "Gemini 임베딩", model: "text-embedding-004" },
  { id: "ollama", label: "Ollama 임베딩", model: "nomic-embed-text" },
];

/** One settings card. A plain grid box (not <fieldset>) so its rows can join the parent grid. */
function PickerBox({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  const id = useId();
  return <div className="agent-picker" role="group" aria-labelledby={id}>
    <strong className="agent-picker-title" id={id}>{title}</strong><p className="agent-hint">{hint}</p>
    {children}
  </div>;
}

function ModelPicker({ label, hint, value, providers, onChange }: { label: string; hint: string; value: ModelChoice | null; providers: ProviderInfo[]; onChange: (v: ModelChoice | null) => void }) {
  const [models, setModels] = useState<string[]>([]);
  const provider = providers.find(p => p.id === value?.provider);
  useEffect(() => {
    let live = true;
    setModels(provider?.suggestedModels ?? []);
    if (value?.provider && provider?.available && provider.kind !== "subscription") {
      void agentCall<{ models: string[] }>("models.list", { provider: value.provider }).then(r => { if (live) setModels(r.models); }).catch(() => {});
    }
    return () => { live = false; };
  }, [value?.provider, provider?.available, provider?.kind, provider?.suggestedModels]);
  const listId = `agent-models-${label}`;
  return <PickerBox title={label} hint={hint}>
    <select aria-label={`${label} 공급자`} value={value?.provider ?? ""} onChange={e => onChange(e.target.value ? { provider: e.target.value, model: "" } : null)}>
      <option value="">선택 안 함</option>
      <optgroup label="구독 (CLI 로그인)">{providers.filter(p => p.kind === "subscription").map(p => <option key={p.id} value={p.id}>{p.label}{p.plan ? ` · ${p.plan}` : ""}{p.available ? "" : " (미설치)"}</option>)}</optgroup>
      <optgroup label="API 키">{providers.filter(p => p.kind === "api").map(p => <option key={p.id} value={p.id}>{p.label}{p.available ? "" : " (키 필요)"}</option>)}</optgroup>
      <optgroup label="로컬">{providers.filter(p => p.kind === "local").map(p => <option key={p.id} value={p.id}>{p.label}{p.available ? "" : " (꺼짐)"}</option>)}</optgroup>
    </select>
    {value && <>
      <input aria-label={`${label} 모델`} list={listId} value={value.model} placeholder={provider?.kind === "subscription" ? "비우면 CLI 기본 모델" : "모델 이름"} onChange={e => onChange({ ...value, model: e.target.value })} />
      <datalist id={listId}>{models.slice(0, 300).map(m => <option key={m} value={m} />)}</datalist>
      {provider && <small className={provider.available ? "agent-ok" : "agent-warn"}>{provider.detail}</small>}
    </>}
  </PickerBox>;
}

export function AgentSettingsCard({ view, providers, busy, onSaved, onError }: Props) {
  const [draft, setDraft] = useState<AgentSettings>(view.settings);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(view.settings); setKeys({}); }, [view]);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(view.settings) || Object.keys(keys).length > 0, [draft, keys, view.settings]);
  const set = (slot: Slot) => (value: ModelChoice | null) => setDraft(d => ({ ...d, [slot]: value }));

  async function save() {
    setSaving(true);
    try { onSaved(await saveSettings(draft, keys)); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }

  return <section className="agent-card" aria-label="모델 설정">
    <div className="agent-card-head"><h2>모델 설정</h2><button className="social-button primary" disabled={!dirty || saving || busy} onClick={() => void save()}><Save size={15} />{saving ? "저장 중" : "저장"}</button></div>
    <div className="agent-grid">
      <ModelPicker label="에이전트" hint="Supervisor·Expert·QA가 코드 작업에 사용합니다." value={draft.agentModel} providers={providers} onChange={set("agentModel")} />
      <ModelPicker label="콘텐츠 작성" hint="AI 작업실·영상 초안·SNS 문구에 사용합니다. 비우면 에이전트 모델을 씁니다." value={draft.contentModel} providers={providers} onChange={set("contentModel")} />
      <PickerBox title="이미지 생성" hint="이미지 생성기에서 사용합니다. API 키가 필요합니다.">
        <select aria-label="이미지 공급자" value={draft.image?.provider ?? ""} onChange={e => { const p = IMAGE_PROVIDERS.find(x => x.id === e.target.value); setDraft(d => ({ ...d, image: p ? { provider: p.id, model: p.model } : null })); }}>
          <option value="">선택 안 함</option>{IMAGE_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {draft.image && <input aria-label="이미지 모델" value={draft.image.model} onChange={e => setDraft(d => ({ ...d, image: d.image ? { ...d.image, model: e.target.value } : null }))} />}
      </PickerBox>
      <PickerBox title="코드 검색 임베딩" hint="바꾸면 프로젝트를 다시 색인해야 합니다.">
        <select aria-label="임베딩 공급자" value={draft.embedding.provider} onChange={e => { const p = EMBEDDINGS.find(x => x.id === e.target.value)!; setDraft(d => ({ ...d, embedding: { provider: p.id, model: p.model } })); }}>
          {EMBEDDINGS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {draft.embedding.provider !== "local" && <input aria-label="임베딩 모델" value={draft.embedding.model} onChange={e => setDraft(d => ({ ...d, embedding: { ...d.embedding, model: e.target.value } }))} />}
      </PickerBox>
    </div>
    <div className="agent-keys" aria-label="API 키">
      <h3><KeyRound size={15} />API 키 <small>OS 키체인에 저장 · 화면에 다시 표시하지 않음</small></h3>
      {KEY_PROVIDERS.map(p => <div key={p.id} className="agent-key-row">
        <span>{p.label}</span>
        <span className={view.keys[p.id] ? "agent-ok" : "agent-muted"}>{keys[p.id] === "" ? "삭제 예정" : view.keys[p.id] ? "저장됨" : "미등록"}</span>
        <input type={reveal[p.id] ? "text" : "password"} autoComplete="off" spellCheck={false} aria-label={`${p.label} API 키`} placeholder={view.keys[p.id] ? "바꿀 때만 입력" : p.placeholder} value={keys[p.id] ?? ""} onChange={e => setKeys(k => ({ ...k, [p.id]: e.target.value }))} />
        <button type="button" className="social-button subtle icon-only" aria-label={reveal[p.id] ? "숨기기" : "입력값 보기"} onClick={() => setReveal(r => ({ ...r, [p.id]: !r[p.id] }))}>{reveal[p.id] ? <EyeOff size={15} /> : <Eye size={15} />}</button>
        {view.keys[p.id] && <button type="button" className="social-button subtle icon-only" aria-label={`${p.label} 키 삭제`} onClick={() => setKeys(k => ({ ...k, [p.id]: "" }))}><X size={15} /></button>}
      </div>)}
    </div>
    <label className="agent-root">프로젝트 폴더<input value={draft.projectsRoot} onChange={e => setDraft(d => ({ ...d, projectsRoot: e.target.value }))} /></label>
  </section>;
}
