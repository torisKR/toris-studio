import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarClock, Check, CircleAlert, FileVideo, Image, LoaderCircle, Pause, Play, Plus, RefreshCw, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import { ActivityStatus } from "./ActivityStatus";
import { External } from "./External";
import { openConnectedChat, sendToConnectedChat } from "./codexify-client";
import { FIELD_SUPPORT, JOB_LABELS, PLATFORM_LABELS, PUBLISH_PLATFORMS, jobActions, kstSchedule, newPublication, newTarget, publicationApi, publishingError, safePostUrl, scheduleInput, splitTags, submissionInput, targetCaption, targetContent } from "./publication-client";
import type { Publication, PublicationMedia, PublicationPreflight, PublicationTarget, PublicationsSnapshot, PublishAccount, PublishAccounts, PublishPlatform, PublishingJob } from "./publication-client";
import "./PublicationPanel.css";

type MediaSources = { renders: { id: string; title: string }[]; assets: { id: string; title: string }[] };
type AiDraftRequest = { id: string; publicationId?: string; revision?: number; topic: string; context: string; status: "waiting" | "received"; draft?: { title: string; description: string; tags: string[]; hashtags: string[] }; createdAt: string; receivedAt?: string };
type Props = { active: boolean; refreshKey?: number; seed?: { title: string; description: string; key: number } | null; onOpenOAuth: () => void; onOpenChatGPT: () => void; onOpenAssets: () => void };
const emptySnapshot: PublicationsSnapshot = { publications: [], media: [], scheduler: { paused: false, running: false, message: "게시 큐를 확인하고 있습니다." } };
function dateLabel(value?: string | null) {
  if (!value) return "일시 없음";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }) : "일시 확인 필요";
}
function TagInput({ label, value, onChange, hashtags = false }: { label: string; value: string[]; onChange: (value: string[]) => void; hashtags?: boolean }) {
  const formatted = value.map(item => hashtags ? `#${item}` : item).join(hashtags ? " " : ", ");
  const [text, setText] = useState(formatted);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(formatted); }, [formatted]);
  return <input aria-label={label} value={text} maxLength={2500} onFocus={() => { focused.current = true; }} onChange={event => { setText(event.target.value); onChange(splitTags(event.target.value, hashtags)); }} onBlur={() => { focused.current = false; onChange(splitTags(text, hashtags)); setText(splitTags(text, hashtags).map(item => hashtags ? `#${item}` : item).join(hashtags ? " " : ", ")); }}/>
}
function MediaPreview({ media }: { media: PublicationMedia | undefined }) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true; setSrc(""); setError("");
    if (media) void invoke<{ path: string }>("publication_preview_media", { id: media.id }).then(result => {
      // The native command resolves only a registered immutable media ID.
      if (alive) setSrc(convertFileSrc(result.path));
    }).catch(reason => { if (alive) setError(publishingError(reason)); });
    return () => { alive = false; };
  }, [media?.id]);
  return <div className={`publication-media-preview ${media?.kind || "empty"}`}>
    {src && media?.kind === "video" ? <video src={src} controls preload="metadata" aria-label={`${media.name} 영상 미리보기`} /> : src && media ? <img src={src} alt={`${media.name} 썸네일 미리보기`} /> : <><FileVideo size={28}/><span>{error || (media ? "미리보기 준비 중" : "파일을 선택하세요")}</span></>}
    {media && <div className="publication-media-meta"><strong>{media.name}</strong><small>{(media.bytes / 1024 / 1024).toFixed(1)} MiB{media.probe?.width ? ` · ${media.probe.width} × ${media.probe.height}` : ""}{media.probe?.durationSeconds ? ` · ${media.probe.durationSeconds.toFixed(1)}초` : ""}</small></div>}
  </div>;
}

function TargetEditor({ publication, target, accounts, busy, onChange, onRemove, onLogin }: { publication: Publication; target: PublicationTarget; accounts: PublishAccount[]; busy: boolean; onChange: (target: PublicationTarget) => void; onRemove: () => void; onLogin: () => void }) {
  const content = targetContent(publication, target);
  const available = accounts.filter(account => account.platform === target.platform);
  const account = available.find(item => item.accountId === target.accountId);
  const creator = account?.creatorInfo;
  const [editing, setEditing] = useState(Object.keys(target.overrides).length > 0);
  const opt = (key: string, value: unknown) => onChange({ ...target, options: { ...target.options, [key]: value } });
  function override(key: keyof PublicationTarget["overrides"], value: string | string[]) { onChange({ ...target, overrides: { ...target.overrides, [key]: value } }); }
  function selectAccount(id: string) {
    const selected = available.find(item => item.accountId === id);
    onChange({ ...target, accountId: id, accountTitle: selected?.name || "", options: { ...target.options, confirmPublic: false, ...(target.platform === "tiktok" ? { privacy: "", publishConsent: false, musicConsent: false, allowComments: false, allowDuet: false, allowStitch: false } : {}) } });
  }
  return <section className="publication-target" aria-label={`${PLATFORM_LABELS[target.platform]} 게시 설정`}>
    <header><div><span className={`publication-platform ${target.platform}`}>{target.platform === "facebook" ? "f" : target.platform === "threads" ? "@" : target.platform === "youtube" ? "▶" : target.platform === "instagram" ? "◎" : "♪"}</span><h3>{PLATFORM_LABELS[target.platform]}</h3></div><button type="button" className="social-dismiss" aria-label={`${PLATFORM_LABELS[target.platform]} 대상 제거`} disabled={busy} onClick={onRemove}><X size={17}/></button></header>
    <fieldset disabled={busy}>
      <label>게시 계정<select aria-label={`${PLATFORM_LABELS[target.platform]} 게시 계정`} value={target.accountId} onChange={event => selectAccount(event.target.value)}><option value="">실제 연결된 계정 선택</option>{available.map(item => <option key={item.accountId} value={item.accountId}>{item.name}{item.publishingAuthorized ? "" : " · 게시 권한 필요"}</option>)}</select></label>
      <div className={`publication-permission ${account?.publishingAuthorized ? "ready" : ""}`}><ShieldCheck size={15}/><span>{account?.publishingAuthorized ? "게시 권한 확인됨" : target.accountId ? "로그인과 게시 권한은 별개입니다. 게시 권한을 다시 연결하세요." : "계정을 선택한 뒤 게시 권한을 확인합니다."}</span><button type="button" className="social-button compact" onClick={onLogin}>게시 권한 연결</button></div>
      <div className="publication-two-columns"><label>게시 방식<select aria-label={`${PLATFORM_LABELS[target.platform]} 게시 방식`} value={target.mode} onChange={event => { const mode = event.target.value as PublicationTarget["mode"]; onChange({ ...target, mode, options: { ...target.options, ...(target.platform === "tiktok" ? { mode: mode === "tiktok_inbox" ? "draft" : "direct", publishConsent: false } : {}) } }); }}><option value="manual">수동 · 승인 후 즉시</option><option value="scheduled">자동 · 승인한 예약</option>{target.platform === "tiktok" && <option value="tiktok_inbox">TikTok 초안 전송</option>}</select></label>{target.mode === "scheduled" && <label>예약 일시 · KST<input type="datetime-local" aria-label={`${PLATFORM_LABELS[target.platform]} 예약 일시`} required value={scheduleInput(target.scheduledAt)} onChange={event => onChange({ ...target, scheduledAt: kstSchedule(event.target.value) })}/></label>}</div>
      <p className="publication-field-support">{FIELD_SUPPORT[target.platform]}</p>
      <label className="publication-checkbox"><input type="checkbox" checked={editing} onChange={event => { setEditing(event.target.checked); if (!event.target.checked) onChange({ ...target, overrides: {} }); }}/><span>이 채널의 문구를 따로 편집</span></label>
      {editing && <div className="publication-overrides"><label>채널별 제목<input aria-label={`${PLATFORM_LABELS[target.platform]} 채널별 제목`} value={content.title} maxLength={180} onChange={event => override("title", event.target.value)}/></label><label>채널별 설명<textarea aria-label={`${PLATFORM_LABELS[target.platform]} 채널별 설명`} rows={3} value={content.description} maxLength={20000} onChange={event => override("description", event.target.value)}/></label>{target.platform === "youtube" && <label>채널별 태그<TagInput label="YouTube 채널별 태그" value={content.tags} onChange={value => override("tags", value)}/></label>}<label>채널별 해시태그<TagInput label={`${PLATFORM_LABELS[target.platform]} 채널별 해시태그`} value={content.hashtags} hashtags onChange={value => override("hashtags", value)}/></label></div>}
      {target.platform === "youtube" && <><div className="publication-two-columns"><label>공개 범위<select aria-label="YouTube 공개 범위" value={String(target.options.privacy ?? "private")} onChange={event => onChange({ ...target, options: { ...target.options, privacy: event.target.value, confirmPublic: false } })}><option value="private">비공개</option><option value="unlisted">일부 공개</option><option value="public">공개</option></select></label><label>아동용 콘텐츠<select aria-label="YouTube 아동용 여부" value={String(target.options.madeForKids ?? false)} onChange={event => opt("madeForKids", event.target.value === "true")}><option value="false">아동용 아님</option><option value="true">아동용</option></select></label></div>{target.options.privacy !== "private" && <label className="publication-checkbox"><input type="checkbox" checked={target.options.confirmPublic === true} onChange={event => opt("confirmPublic", event.target.checked)}/><span>영상이 다른 사람에게 노출되는 공개 범위를 확인했습니다.</span></label>}</>}
      {target.platform === "instagram" && <><label className="publication-checkbox"><input type="checkbox" checked={target.options.shareToFeed === true} onChange={event => opt("shareToFeed", event.target.checked)}/><span>Reels를 피드에도 공유</span></label><label>이미지 커버 미선택 시 영상 프레임 (밀리초)<input type="number" min={0} step={100} value={Number(target.options.coverOffsetMs ?? 0)} onChange={event => opt("coverOffsetMs", Number(event.target.value))}/></label></>}
      {(target.platform === "instagram" || target.platform === "facebook" || target.platform === "threads") && <label className="publication-checkbox"><input type="checkbox" checked={target.options.confirmPublic === true} onChange={event => onChange({ ...target, options: { ...target.options, privacy: "public", confirmPublic: event.target.checked } })}/><span>선택한 계정에 콘텐츠를 공개 게시하는 것을 확인했습니다.</span></label>}
      {target.platform === "tiktok" && <div className="publication-tiktok"><p className="publication-field-support">{target.mode === "tiktok_inbox" ? "초안을 TikTok으로 전송합니다. 커버 프레임은 적용하지 않습니다. 알림에서 편집한 뒤 사용자가 최종 게시해야 합니다." : account?.capabilities.directPublicSupported === true ? "사용자가 개발자 콘솔의 공개 Direct Post 심사 승인을 확인했습니다. 이 선언과 실제 API 게시 응답 검증은 구분하며 결과에서 확인하세요." : "공개 Direct Post와 예약은 앱 심사 조건을 충족할 때 사용 가능합니다. 현재 공개 심사 확인 전에는 SELF_ONLY만 지원합니다."}</p>{creator && <p>{creator.nickname || creator.username || account?.name} · 최대 {creator.maxVideoPostDurationSec}초</p>}{target.mode !== "tiktok_inbox" && <label>공개 범위 · 직접 선택<select aria-label="TikTok 공개 범위" value={String(target.options.privacy ?? "")} onChange={event => opt("privacy", event.target.value)}><option value="">공개 범위 선택</option>{creator?.privacyLevelOptions.filter(level => level === "SELF_ONLY" || account?.capabilities.directPublicSupported === true).map(level => <option key={level} value={level}>{level === "SELF_ONLY" ? "나만 보기 (SELF_ONLY)" : level}</option>)}</select></label>}<div className="publication-interactions">{([ ["allowComments", "댓글 허용", creator?.commentDisabled], ["allowDuet", "Duet 허용", creator?.duetDisabled], ["allowStitch", "Stitch 허용", creator?.stitchDisabled] ] as const).map(([key, label, disabled]) => <label className="publication-checkbox" key={key}><input type="checkbox" checked={!disabled && target.options[key] === true} disabled={disabled} onChange={event => opt(key, event.target.checked)}/><span>{label}{disabled ? " · 계정에서 비활성" : ""}</span></label>)}</div>{target.mode !== "tiktok_inbox" && <label>영상 커버 프레임 (밀리초)<input type="number" min={0} step={100} value={Number(target.options.coverOffsetMs ?? 0)} onChange={event => opt("coverOffsetMs", Number(event.target.value))}/></label>}<label className="publication-checkbox"><input type="checkbox" checked={target.options.commercialContent === true} onChange={event => onChange({ ...target, options: { ...target.options, commercialContent: event.target.checked, ...(event.target.checked ? {} : { brandOrganic: false, brandContent: false }) } })}/><span>상업 콘텐츠 포함</span></label>{target.options.commercialContent === true && <><label className="publication-checkbox"><input type="checkbox" checked={target.options.brandOrganic === true} onChange={event => opt("brandOrganic", event.target.checked)}/><span>내 브랜드 홍보</span></label><label className="publication-checkbox"><input type="checkbox" checked={target.options.brandContent === true} onChange={event => opt("brandContent", event.target.checked)}/><span>다른 브랜드의 유료 파트너십</span></label><p className="publication-field-support">유료 파트너십은 비공개 게시와 함께 사용할 수 없습니다.</p></>}<label className="publication-checkbox"><input type="checkbox" checked={target.options.musicConsent === true} onChange={event => opt("musicConsent", event.target.checked)}/><span>TikTok 음악 사용 확인과 필요한 상업 콘텐츠 약관을 읽고 동의했습니다. <External url="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en">음악 사용 확인</External> · <External url="https://www.tiktok.com/legal/page/global/bc-policy/en">브랜드 콘텐츠 정책</External></span></label><label className="publication-checkbox"><input type="checkbox" checked={target.options.publishConsent === true} onChange={event => opt("publishConsent", event.target.checked)}/><span>표시된 계정·캡션·공개 범위와 TikTok 전송에 동의합니다.</span></label></div>}
      <details className="publication-caption" open><summary>채널별 문구 미리보기</summary>{target.platform === "youtube" && <strong>{content.title || "제목 없음"}</strong>}<pre>{targetCaption(publication, target) || "작성한 문구가 없습니다."}</pre></details>
    </fieldset>
  </section>;
}

export function PublicationPanel({ active, refreshKey = 0, seed, onOpenOAuth, onOpenChatGPT, onOpenAssets }: Props) {
  const [snapshot, setSnapshot] = useState<PublicationsSnapshot>(emptySnapshot);
  const [accounts, setAccounts] = useState<PublishAccounts>({ accounts: [], warnings: [], checkedAt: "" });
  const [sources, setSources] = useState<MediaSources>({ renders: [], assets: [] });
  const [publication, setPublication] = useState<Publication>(newPublication);
  const [dirty, setDirty] = useState(false);
  const [check, setCheck] = useState<PublicationPreflight | null>(null);
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[] | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<"compose" | "history">("compose");
  const [renderId, setRenderId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [aiDrafts, setAiDrafts] = useState<AiDraftRequest[]>([]);
  const [actionJob, setActionJob] = useState<{ job: PublishingJob; publication: Publication; action: string } | null>(null);
  const [actionConfirmed, setActionConfirmed] = useState(false);
  const [actionResolution, setActionResolution] = useState("remote");
  const [actionUrl, setActionUrl] = useState("");
  const gate = useRef(false), alive = useRef(false), generation = useRef(0), seenSeed = useRef<number | undefined>(undefined);
  const reading = useRef(false);
  const feedback = useRef<HTMLDivElement>(null);
  const chatRetry = useRef<{ key: string; message: string; requestId: string } | null>(null);
  const load = useCallback(async (silent = false) => {
    if (reading.current) return;
    reading.current = true;
    const epoch = ++generation.current;
    if (!silent) setLoading(true);
    try {
      const value = await invoke<PublicationsSnapshot>("publication_list");
      if (alive.current && generation.current === epoch) setSnapshot(value);
      const drafts = await invoke<{ requests: AiDraftRequest[] }>("publication_ai_drafts");
      if (alive.current && generation.current === epoch) setAiDrafts(drafts.requests);
    } catch (reason) { if (alive.current && generation.current === epoch && !silent) setError(publishingError(reason)); }
    finally { reading.current = false; if (alive.current && generation.current === epoch) setLoading(false); }
  }, []);
  useEffect(() => {
    if (!active) return;
    alive.current = true; void load();
    void invoke<MediaSources>("publication_media_sources").then(value => { if (alive.current) setSources(value); }).catch(reason => { if (alive.current) setNotice(`로컬 에셋·렌더 목록 확인: ${publishingError(reason)}`); });
    const id = setInterval(() => { if (!gate.current && document.visibilityState === "visible") void load(true); }, 5000);
    return () => { alive.current = false; ++generation.current; clearInterval(id); };
  }, [active, refreshKey, load]);
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    const stops: (() => void)[] = [];
    void listen<PublicationsSnapshot["scheduler"]>("publication-scheduler-status", event => { if (mounted) setSnapshot(current => ({ ...current, scheduler: event.payload })); }).then(stop => { if (mounted) stops.push(stop); else stop(); }).catch(() => { /* Periodic native status read remains available. */ });
    void listen<string>("publication-runtime-error", event => { if (mounted) setError(publishingError(event.payload)); }).then(stop => { if (mounted) stops.push(stop); else stop(); }).catch(() => { /* Native command errors remain visible. */ });
    return () => { mounted = false; stops.forEach(stop => stop()); };
  }, [active]);
  useEffect(() => {
    if (!active || !seed || seed.key === seenSeed.current) return;
    seenSeed.current = seed.key;
    if (dirty && !window.confirm("현재 저장하지 않은 초안 대신 AI 작업실의 새 문구를 가져올까요?")) { setNotice("기존 초안을 유지했습니다. AI 작업실 문구는 적용하지 않았습니다."); return; }
    setPublication({ ...newPublication(), title: seed.title, description: seed.description }); setDirty(true); setCheck(null); setSelectedTargetIds(null); setConfirmed(false); setView("compose"); setNotice("ChatGPT 문구를 새 SNS 초안으로 가져왔습니다. 파일과 채널을 선택한 뒤 저장하세요.");
  }, [active, seed]);
  useEffect(() => { if (error || notice) feedback.current?.focus({ preventScroll: true }); }, [error, notice]);
  function patch(value: Partial<Publication>) { setPublication(current => ({ ...current, ...value })); setDirty(true); setCheck(null); setConfirmed(false); }
  function patchTarget(target: PublicationTarget) { patch({ targets: publication.targets.map(item => item.id === target.id ? target : item) }); }
  function remember(value: Publication) { setPublication(value); setDirty(false); setCheck(null); setSelectedTargetIds(null); setConfirmed(false); setSnapshot(current => ({ ...current, publications: [value, ...current.publications.filter(item => item.id !== value.id)] })); }
  async function run(label: string, work: () => Promise<void>) {
    if (gate.current) return;
    gate.current = true; setBusy(label); setError(""); setNotice("");
    try { await work(); } catch (reason) { setError(publishingError(reason)); }
    finally { gate.current = false; setBusy(""); }
  }
  async function save() {
    if (!publication.title.trim()) throw new Error("게시 제목을 입력하세요.");
    const result = await publicationApi<Publication>("save", { ...publication, title: publication.title.trim(), jobs: undefined, createdAt: undefined, updatedAt: undefined });
    remember(result); setNotice("초안을 저장했습니다. 실제 게시를 시작하려면 사전 검사를 실행하세요.");
    return result;
  }
  async function preflight() {
    const targetIds = approvalTargets.map(target => target.id);
    if (!targetIds.length) throw new Error("검사·승인할 게시 대상을 선택하세요. 이미 전송한 채널은 다시 승인하지 않습니다.");
    const saved = dirty || !publication.id ? await save() : publication;
    const result = await publicationApi<PublicationPreflight>("preflight", { publicationId: saved.id, revision: saved.revision, targetIds });
    setSelectedTargetIds(targetIds);
    setCheck(result); setConfirmed(false); setNotice(result.ready ? "사전 검사를 통과했습니다. 대상과 파일·문구를 확인하고 최종 승인하세요." : "게시할 수 없는 대상이 있습니다. 검사 결과를 확인하고 수정하세요.");
  }
  async function submit() { if (!check || dirty) throw new Error("저장한 초안의 사전 검사를 먼저 실행하세요."); remember(await publicationApi<Publication>("submit", submissionInput(publication, check, confirmed))); setView("history"); setNotice("승인한 대상의 게시 큐를 저장했습니다. 채널별 실제 처리 결과를 확인하세요."); await load(true); }
  async function importMedia(kind: "video" | "thumbnail", source: "picker" | "asset" | "render" = "picker", id?: string) {
    const result = await invoke<PublicationMedia | { cancelled: true }>("publication_import_media", { input: { kind, source, ...(id ? { id } : {}) } });
    if ("cancelled" in result) { setNotice("파일 선택을 취소했습니다. 기존 초안을 유지합니다."); return; }
    setSnapshot(current => ({ ...current, media: [result, ...current.media.filter(item => item.id !== result.id)] }));
    patch(kind === "video" ? { videoMediaId: result.id } : { thumbnailMediaId: result.id }); setNotice(`${result.name} 파일을 게시용 복사본으로 가져왔습니다.`);
  }
  async function refreshAccounts() { const value = await invoke<PublishAccounts>("publication_accounts"); setAccounts(value); setNotice("최신 계정과 실제 게시 권한을 조회했습니다. 대상 계정을 직접 선택하세요."); setCheck(null); setConfirmed(false); }
  async function requestCopy() {
    if (!publication.title.trim()) throw new Error("ChatGPT에 전달할 주제를 제목에 입력하세요.");
    const connection = await invoke<{ reachable: boolean; studioTools: string[] }>("codexify_connection_check");
    if (!connection.reachable || !connection.studioTools?.some(name => name === "studio_publication_draft_receive" || name.endsWith("__studio_publication_draft_receive"))) {
      throw new Error("SNS 초안 수신 도구가 연결되지 않았습니다. 코딩에서 0.1.21 MCP 설정을 확인하고 Codexify·ChatGPT 연결을 새로고침한 뒤 요청하세요.");
    }
    const context = JSON.stringify({ description: publication.description, tags: publication.tags, hashtags: publication.hashtags, targets: publication.targets.map(target => target.platform) }, null, 2);
    const key = JSON.stringify([publication.id, publication.revision, publication.title, context]);
    if (chatRetry.current?.key !== key) {
      const request = await invoke<AiDraftRequest>("publication_ai_request", { input: { ...(publication.id && !dirty ? { publicationId: publication.id, revision: publication.revision } : {}), topic: publication.title, context } });
      setAiDrafts(current => [request, ...current.filter(item => item.id !== request.id)]);
      const message = ["Toris Studio SNS 게시 초안을 작성해줘. 실제 ChatGPT 대화의 응답으로만 작성하고 게시 도구를 실행하거나 예약을 승인하지 마.", "제목, 설명, tags, hashtags를 분리하고 YouTube·Instagram·Facebook Page·Threads·TikTok의 채널별 문구를 제안해줘. 확인하지 않은 사실이나 이미지 생성 성공을 주장하지 마.", `실제 도구 목록에서 studio_publication_draft_receive 또는 studio__studio_publication_draft_receive를 확인하고 requestId=${JSON.stringify(request.id)} 와 title,description,tags,hashtags를 전달해줘. 이 도구는 수신만 기록하고 앱 사용자가 직접 초안 적용·저장·게시를 승인해야 해. 도구가 없으면 편집 가능한 응답으로 반환해줘.`, JSON.stringify({ topic: publication.title, context }, null, 2)].join("\n\n");
      chatRetry.current = { key, message, requestId: crypto.randomUUID() };
    }
    const result = await sendToConnectedChat(chatRetry.current.message, chatRetry.current.requestId); chatRetry.current = null;
    setNotice(result.waiting ? "ChatGPT 요청을 저장했습니다. 응답·새 미승인 초안은 코딩 대화와 게시 이력에서 확인하세요." : "요청을 저장했습니다. 종료된 ChatGPT 대화에서 시작·재개한 뒤 응답을 확인하세요.");
  }
  async function jobAction() {
    if (!actionJob || !actionConfirmed) throw new Error("해당 작업의 결과와 대상 계정을 확인하세요.");
    if (actionResolution === "published" && !safePostUrl(actionUrl)) throw new Error("직접 확인한 SNS의 HTTPS 게시 URL을 입력하세요.");
    const result = await publicationApi<Publication>(actionJob.action, { jobId: actionJob.job.id, confirmed: true, ...(actionJob.action === "reconcile" && actionJob.job.status === "uncertain" && actionResolution !== "remote" ? { resolution: actionResolution, ...(actionResolution === "published" ? { url: actionUrl.trim() } : {}) } : {}) });
    setSnapshot(current => ({ ...current, publications: current.publications.map(item => item.id === result.id ? result : item) }));
    setActionJob(null); setActionConfirmed(false); setNotice(actionJob.action === "retry" ? "실패·지연 대상만 다시 승인했습니다. 성공한 채널은 재전송하지 않습니다." : actionJob.action === "cancel" ? "대기 중인 작업을 취소했습니다." : "플랫폼의 현재 결과를 다시 확인했습니다.");
  }
  const video = snapshot.media.find(item => item.id === publication.videoMediaId);
  const thumbnail = snapshot.media.find(item => item.id === publication.thumbnailMediaId);
  const selectedPlatforms = new Set(publication.targets.map(item => item.platform));
  const approvalTargets = publication.targets.filter(target => selectedTargetIds ? selectedTargetIds.includes(target.id) : !(publication.jobs || []).some(job => job.targetId === target.id && (job.revision == null || job.revision === publication.revision) && !["cancelled", "needs_confirmation"].includes(job.status)));
  if (!active) return null;
  return <div className="publication-studio">
    <div className="publication-top"><div className="publication-tabs" role="group" aria-label="SNS 게시 화면"><button aria-pressed={view === "compose"} className={view === "compose" ? "active" : ""} onClick={() => setView("compose")}><FileVideo size={16}/>콘텐츠 작성</button><button aria-pressed={view === "history"} className={view === "history" ? "active" : ""} onClick={() => setView("history")}><CalendarClock size={16}/>예약·게시 이력 <small>{snapshot.publications.length}</small></button></div><div className="publication-scheduler"><span className={snapshot.scheduler.paused ? "paused" : ""}><i/>{snapshot.scheduler.paused ? "예약 일시정지" : snapshot.scheduler.running ? "게시 큐 처리 중" : "예약 대기"}</span><button className="social-button compact" disabled={!!busy} onClick={() => void run("예약 실행 설정", async () => { await invoke("publication_set_paused", { paused: !snapshot.scheduler.paused }); await load(); })}>{snapshot.scheduler.paused ? <Play size={14}/> : <Pause size={14}/>} {snapshot.scheduler.paused ? "예약 재개" : "예약 일시정지"}</button></div></div>
    <p className="publication-scheduler-note">창을 닫아도 트레이·메뉴 막대에서 승인한 예약을 실행합니다. PC 전원·로컬 DB·인터넷 연결이 필요합니다. 종료·절전으로 놓친 예약은 재승인해야 합니다.</p>
    <div ref={feedback} tabIndex={-1}>{error && <div className="social-notice error" role="alert"><CircleAlert size={17}/><span>{error}</span></div>}{notice && <div className="social-notice info" role="status"><Check size={17}/><span>{notice}</span></div>}</div>
    {busy && <ActivityStatus title={busy} detail="실제 저장·플랫폼 응답을 기다립니다. 이 표시가 게시 완료를 의미하지 않습니다."/>}
    {view === "compose" ? <div className="publication-layout"><section className="publication-common" aria-label="공통 게시 콘텐츠"><header><div><span className="publication-kicker">01 · 콘텐츠</span><h2>한 번 작성하고 채널별로 확인</h2></div><button className="social-button compact" disabled={!!busy} onClick={() => { if (dirty && !window.confirm("저장하지 않은 초안 대신 새 콘텐츠를 만들까요?")) return; setPublication(newPublication()); setDirty(false); setCheck(null); setSelectedTargetIds(null); setConfirmed(false); }}><Plus size={15}/>새 초안</button></header><fieldset disabled={!!busy}>
      <div className="publication-file-buttons"><button className="social-button" type="button" onClick={() => void run("MP4 가져오기", () => importMedia("video"))}><FileVideo size={16}/>MP4 가져오기</button><button className="social-button" type="button" onClick={() => void run("썸네일 가져오기", () => importMedia("thumbnail"))}><Image size={16}/>썸네일 가져오기</button></div>
      <div className="publication-two-columns"><label>등록한 영상<select aria-label="등록한 게시 영상" value={publication.videoMediaId || ""} onChange={event => patch({ videoMediaId: event.target.value || null })}><option value="">MP4 선택</option>{snapshot.media.filter(item => item.kind === "video").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>등록한 썸네일<select aria-label="등록한 게시 썸네일" value={publication.thumbnailMediaId || ""} onChange={event => patch({ thumbnailMediaId: event.target.value || null })}><option value="">이미지 미사용</option>{snapshot.media.filter(item => item.kind === "thumbnail").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
      <div className="publication-previews"><MediaPreview media={video}/><MediaPreview media={thumbnail}/></div>
      <details className="publication-local-sources"><summary>기존 렌더·ChatGPT 이미지 에셋 사용</summary><div><label>기존 렌더<select aria-label="기존 영상 렌더 선택" value={renderId} onChange={event => setRenderId(event.target.value)}><option value="">렌더 완료한 영상 선택</option>{sources.renders.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label><button className="social-button compact" disabled={!renderId} onClick={() => void run("기존 렌더 가져오기", () => importMedia("video", "render", renderId))}>영상 가져오기</button></div><div><label>ChatGPT·로컬 이미지 에셋<select aria-label="이미지 에셋 썸네일 선택" value={assetId} onChange={event => setAssetId(event.target.value)}><option value="">이미지 에셋 선택</option>{sources.assets.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label><button className="social-button compact" disabled={!assetId} onClick={() => void run("이미지 에셋 가져오기", () => importMedia("thumbnail", "asset", assetId))}>썸네일 가져오기</button></div><button className="social-button compact" onClick={onOpenAssets}><Sparkles size={14}/>ChatGPT 썸네일 요청</button></details>
      <label>공통 제목·주제<input aria-label="게시 공통 제목" value={publication.title} maxLength={180} required onChange={event => patch({ title: event.target.value })} placeholder="어떤 영상을 게시할까요?"/></label><label>공통 설명·본문<textarea aria-label="게시 공통 설명" rows={6} maxLength={20000} value={publication.description} onChange={event => patch({ description: event.target.value })} placeholder="내용과 출처를 입력하거나 ChatGPT 응답을 붙여넣으세요."/></label><div className="publication-two-columns"><label>태그 · 쉼표로 구분<TagInput label="게시 공통 태그" value={publication.tags} onChange={value => patch({ tags: value })}/></label><label>해시태그<TagInput label="게시 공통 해시태그" value={publication.hashtags} hashtags onChange={value => patch({ hashtags: value })}/></label></div><div className="publication-chat-actions"><button className="social-button" onClick={() => void run("ChatGPT 문구 요청", requestCopy)}><Sparkles size={15}/>ChatGPT로 문구 작성</button><button className="social-button compact" onClick={() => void run("ChatGPT 대화 열기", () => openConnectedChat())}>대화 시작·재개</button><button className="social-button compact" onClick={onOpenChatGPT}>수신·응답 확인</button></div><div className="publication-ai-drafts" aria-label="ChatGPT SNS 초안 수신"><strong>ChatGPT 초안 수신</strong>{!aiDrafts.length ? <p>문구 작성 요청 후 실제 응답이 도착하면 표시됩니다.</p> : aiDrafts.slice(0, 6).map(request => <div key={request.id}><span>{request.topic}<small>{request.status === "received" ? `수신됨 · ${dateLabel(request.receivedAt)}` : "요청 저장 · 실제 수신 대기"}</small></span>{request.draft && <button className="social-button compact" onClick={() => { if (dirty && !window.confirm("현재 입력 문구를 수신한 ChatGPT 초안으로 바꿀까요? 영상·채널 선택은 유지합니다.")) return; patch({ title: request.draft!.title, description: request.draft!.description, tags: request.draft!.tags, hashtags: request.draft!.hashtags }); setNotice("ChatGPT 응답을 편집 가능한 초안에 적용했습니다. 게시 승인은 다시 확인해야 합니다."); }}>초안 적용</button>}</div>)}</div><p className="publication-field-support">ChatGPT 응답은 미승인 초안입니다. 내용과 대상 계정을 확인한 뒤 게시를 승인하세요. 수집용 API 키는 게시 권한으로 사용할 수 없습니다.</p>
    </fieldset></section><section className="publication-destinations" aria-label="채널별 게시 대상"><header><div><span className="publication-kicker">02 · 대상과 문구</span><h2>선택한 채널에 함께 게시</h2></div><button className="social-button compact" disabled={!!busy} onClick={() => void run("게시 계정 조회", refreshAccounts)}><RefreshCw size={15}/>계정 조회</button></header><div className="publication-platform-picker" role="group" aria-label="게시 플랫폼 선택">{PUBLISH_PLATFORMS.map(platform => <button key={platform} aria-pressed={selectedPlatforms.has(platform)} disabled={!!busy} className={selectedPlatforms.has(platform) ? "selected" : ""} onClick={() => patch({ targets: selectedPlatforms.has(platform) ? publication.targets.filter(target => target.platform !== platform) : [...publication.targets, newTarget(platform)] })}>{selectedPlatforms.has(platform) && <Check size={13}/>} {PLATFORM_LABELS[platform]}</button>)}</div>{accounts.warnings.map((warning, index) => <p role="status" className="publication-warning" key={index}>{PLATFORM_LABELS[warning.platform] || warning.platform} · {warning.message}</p>)}{accounts.checkedAt && <small className="publication-account-time">계정·권한 조회: {dateLabel(accounts.checkedAt)}</small>}{publication.targets.length ? publication.targets.map(target => <TargetEditor key={target.id} publication={publication} target={target} accounts={accounts.accounts} busy={!!busy} onChange={patchTarget} onRemove={() => patch({ targets: publication.targets.filter(item => item.id !== target.id) })} onLogin={() => void run("게시 권한 로그인", async () => { await invoke("publication_begin_login", { platform: target.platform }); setNotice("브라우저에서 게시 권한 로그인을 완료한 뒤 계정 조회를 다시 누르세요."); })}/>) : <div className="publication-empty"><Send size={26}/><p>게시할 플랫폼을 선택하고 실제 계정을 조회하세요.</p><button className="social-button compact" onClick={onOpenOAuth}>SNS 로그인 설정</button></div>}</section></div> : <section className="publication-history" aria-label="게시 이력">{loading && !snapshot.publications.length ? <ActivityStatus title="저장한 게시 이력 확인 중"/> : !snapshot.publications.length ? <div className="publication-empty"><CalendarClock size={28}/><h2>저장한 게시 콘텐츠가 없습니다</h2><button className="social-button primary" onClick={() => setView("compose")}>첫 게시 콘텐츠 작성</button></div> : snapshot.publications.map(item => <article key={item.id} className="publication-history-item"><header><div><h3>{item.title}</h3><span>수정 {item.revision} · {dateLabel(item.updatedAt)}</span></div><button className="social-button compact" disabled={!!busy} onClick={() => { if (dirty && !window.confirm("저장하지 않은 초안을 유지하지 않고 이 콘텐츠를 열까요?")) return; remember(item); setView("compose"); }}>초안 열기·수정</button></header>{!item.jobs?.length ? <p className="publication-field-support">미승인 초안 · 자동 게시를 시작하지 않습니다.</p> : item.jobs.map(job => { const target = item.targets.find(value => value.id === job.targetId); return <section className={`publication-job ${job.status}`} key={job.id}><div><strong>{job.platform ? PLATFORM_LABELS[job.platform] : target ? PLATFORM_LABELS[target.platform] : "게시 대상"} · {job.accountTitle || job.accountId || target?.accountTitle || "계정 확인"}</strong><span className="publication-job-state">{JOB_LABELS[job.status] || job.status}</span><small>{job.scheduledAt ? `예약 ${dateLabel(job.scheduledAt)}` : dateLabel(job.updatedAt)}</small>{job.status === "draft_sent" && <p>TikTok에 초안을 전송했습니다. TikTok 알림에서 편집 후 최종 게시하세요.</p>}{job.status === "uncertain" && <p>결과가 불명확하므로 재전송하지 않습니다. 플랫폼 결과를 먼저 확인하세요.</p>}{job.status === "needs_confirmation" && <p>놓친 예약은 자동 재게시하지 않습니다. 대상과 콘텐츠를 확인하고 다시 승인하세요.</p>}{job.thumbnailStatus && <small>커버 결과: {job.thumbnailStatus}</small>}{job.error && <p role="status" className="publication-warning">{job.error}</p>}{job.warnings?.map((warning, index) => <p className="publication-warning" key={index}>{warning}</p>)}</div><div className="publication-job-actions">{safePostUrl(job.url) && <External url={safePostUrl(job.url)} className="social-button compact">게시 결과 열기</External>}{jobActions(job).map(action => <button key={action} className="social-button compact" disabled={!!busy} onClick={() => { if (action === "review") { remember(item); setSelectedTargetIds([job.targetId]); setView("compose"); setNotice("이 지연 대상만 사전 검사·재승인합니다. 예약이 지난 경우 새 일시 또는 즉시 게시로 변경하세요."); } else { setActionJob({ job, publication: item, action }); setActionConfirmed(false); setActionResolution("remote"); setActionUrl(""); } }}>{action === "retry" ? "실패 대상 재시도" : action === "review" ? "지연 대상 검토·재승인" : action === "cancel" ? "예약 취소" : "결과 재확인"}</button>)}</div></section>; })}</article>)}</section>}
    {view === "compose" && <section className="publication-approval" aria-label="저장·사전 검사·게시 승인"><div><span className="publication-kicker">03 · 검토와 승인</span><strong>{dirty ? "수정한 내용은 저장과 재승인이 필요합니다." : publication.id ? `저장한 수정 ${publication.revision}` : "새 미승인 초안"}</strong></div><div className="publication-approval-targets" role="group" aria-label="이번에 검사·승인할 대상">{publication.targets.map(target => <label className="publication-checkbox" key={target.id}><input type="checkbox" checked={approvalTargets.some(item => item.id === target.id)} disabled={!!busy || (publication.jobs || []).some(job => job.targetId === target.id && (job.revision == null || job.revision === publication.revision) && !["cancelled", "needs_confirmation"].includes(job.status))} onChange={event => { setSelectedTargetIds(event.target.checked ? [...approvalTargets.map(item => item.id), target.id] : approvalTargets.filter(item => item.id !== target.id).map(item => item.id)); setCheck(null); setConfirmed(false); }}/><span>{PLATFORM_LABELS[target.platform]} · {target.accountTitle || "계정 미선택"}</span></label>)}</div><div className="publication-approval-actions"><button className="social-button" disabled={!!busy} onClick={() => void run("SNS 초안 저장", async () => { await save(); })}><Check size={15}/>초안 저장</button><button className="social-button primary" disabled={!!busy || !approvalTargets.length} onClick={() => void run("게시 사전 검사", preflight)}><ShieldCheck size={16}/>사전 검사·대상 확인</button></div>{check && <div className="publication-checks">{check.checks.map(item => { const target = publication.targets.find(value => value.id === item.targetId); return <p key={item.targetId} className={item.ready ? "ready" : "blocked"} role={item.ready ? "status" : "alert"}>{item.ready ? <Check size={15}/> : <CircleAlert size={15}/>}<strong>{target ? PLATFORM_LABELS[target.platform] : "대상"}</strong><span>{item.message}{item.details?.warnings?.map((warning, index) => <small className="publication-check-warning" key={index}>{warning}</small>)}</span></p>; })}{check.ready && <><div className="publication-final-review"><strong>승인할 파일과 게시 대상</strong><p>{video?.name || "영상 확인 필요"}{thumbnail ? ` · 썸네일 ${thumbnail.name}` : " · 별도 썸네일 없음"}</p>{publication.targets.filter(target => check.checks.some(item => item.targetId === target.id)).map(target => <p key={target.id}>{PLATFORM_LABELS[target.platform]} · {target.accountTitle} · {target.mode === "scheduled" ? `예약 ${dateLabel(target.scheduledAt)}` : target.mode === "tiktok_inbox" ? "TikTok 초안 전송" : "즉시 게시"} · 제목: {targetContent(publication, target).title}</p>)}</div><label className="publication-checkbox"><input type="checkbox" disabled={!!busy || dirty} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/><span>영상·문구·권한·대상 계정과 일정을 확인했으며 실제 전송·예약에 동의합니다.</span></label><button className="social-button primary" disabled={!confirmed || dirty || !!busy} onClick={() => void run("승인한 SNS 게시 큐 저장", submit)}><Send size={16}/>선택한 대상 일괄 승인</button></>}</div>}</section>}
    {actionJob && <section className="publication-action-confirm" aria-label="게시 작업 결과 확인"><header><h3>{actionJob.action === "retry" ? "실패 대상 재시도" : actionJob.action === "cancel" ? "게시 예약 취소" : "플랫폼 결과 재확인"}</h3><button className="social-dismiss" disabled={!!busy} onClick={() => setActionJob(null)} aria-label="작업 확인 닫기"><X size={18}/></button></header><p>{actionJob.publication.title} · {actionJob.job.accountTitle || actionJob.job.accountId || actionJob.publication.targets.find(target => target.id === actionJob.job.targetId)?.accountTitle}</p><p>{actionJob.action === "retry" ? "실패가 확정된 이 대상만 재시도합니다. 성공한 다른 채널을 재전송하지 않습니다." : actionJob.action === "cancel" ? "이미 전송을 시작한 작업은 취소되지 않을 수 있습니다." : "재전송 없이 플랫폼이 반환한 결과를 조회합니다."}</p>{actionJob.action === "reconcile" && actionJob.job.status === "uncertain" && <div className="publication-uncertain-resolution"><label>불명확한 결과 확인 방식<select aria-label="불명확한 게시 결과 확인 방식" value={actionResolution} disabled={!!busy} onChange={event => { setActionResolution(event.target.value); setActionConfirmed(false); }}><option value="remote">API로 전송 결과 조회 · 재전송 없음</option><option value="not_published">외부 채널에서 게시되지 않았음을 직접 확인</option><option value="published">외부 채널에서 실제 게시를 직접 확인</option></select></label>{actionResolution === "published" && <label>직접 확인한 게시 URL<input type="url" aria-label="직접 확인한 SNS 게시 URL" value={actionUrl} placeholder="https://" disabled={!!busy} onChange={event => { setActionUrl(event.target.value); setActionConfirmed(false); }}/></label>}{actionResolution !== "remote" && <p>사용자의 외부 확인으로 기록하며 API 검증과 구분합니다. 미게시 확인은 재승인 대기로 변경하고 자동 전송하지 않습니다.</p>}</div>}<label className="publication-checkbox"><input type="checkbox" checked={actionConfirmed} disabled={!!busy} onChange={event => setActionConfirmed(event.target.checked)}/><span>표시된 콘텐츠와 대상의 현재 결과를 확인했습니다.</span></label><button className="social-button primary" disabled={!actionConfirmed || !!busy} onClick={() => void run("게시 작업 확인", jobAction)}>확인하고 실행</button></section>}
  </div>;
}
