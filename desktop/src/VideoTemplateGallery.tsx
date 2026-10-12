import { Check, ChevronLeft, ChevronRight, CircleAlert, Clapperboard, Clock3, Layers3, LoaderCircle, Pause, Play, RefreshCw, Sparkles, Star } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ideaCategories, motionPresets, readMotion } from "./video-idea";
import { formatPreviewTime, sceneAtElapsed, sceneStartSeconds, templateBeatAt, templateFormatLabels, templatesForLibraryView, type VideoTemplateDescriptor, type VideoTemplateLibrary, type VideoTemplateLibraryView, type VideoTemplatePreview } from "./video-templates";
import "./VideoTemplateGallery.css";

export type VideoTemplateGalleryProps = {
  templates: VideoTemplateDescriptor[]; selectedId: string | null;
  onSelect: (template: VideoTemplateDescriptor) => void;
  onUse: (template: VideoTemplateDescriptor, preview: VideoTemplatePreview) => void;
  preview: VideoTemplatePreview | null; loading: boolean; error: string;
  disabled: boolean; active: boolean; onRetry: () => void;
  library: VideoTemplateLibrary | null; libraryLoading: boolean;
  onFavorite: (id: string, enabled: boolean) => void; controls?: ReactNode;
};

function categoryLabel(value: string): string {
  return Object.prototype.hasOwnProperty.call(ideaCategories, value) ? ideaCategories[value as keyof typeof ideaCategories] : value;
}

const TemplateCover = memo(function TemplateCover({ template, index }: { template: VideoTemplateDescriptor; index: number }) {
  const scene = template.sampleProject.scenes[0];
  return <div className={`vt-cover vt-cover-${index % 10}`} style={{ "--vt-accent": template.accent } as CSSProperties} aria-hidden="true">
    <div className="vt-cover-grid" /><div className="vt-cover-orb" />
    <div className="vt-cover-collage"><i /><i /><i /></div>
    <div className="vt-cover-copy"><small>{template.beats[0]?.label || "STORY"}</small><strong>{scene.headline || template.sampleTopic}</strong><span>{scene.body}</span></div>
    <div className="vt-cover-marker">{String(index + 1).padStart(2, "0")} / STUDIO</div>
  </div>;
});

export function VideoTemplateGallery({ templates, selectedId, onSelect, onUse, preview, loading, error, disabled, active, onRetry, library, libraryLoading, onFavorite, controls }: VideoTemplateGalleryProps) {
  const [category, setCategory] = useState("all");
  const [view, setView] = useState<VideoTemplateLibraryView>("all");
  const [query, setQuery] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const elapsedRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const categories = useMemo(() => [...new Set(templates.flatMap((template) => template.categories))], [templates]);
  const favoriteIds = useMemo(() => new Set(library?.favorites ?? []), [library]);
  const favoriteTemplates = useMemo(() => templatesForLibraryView(templates, library, "favorites"), [templates, library]);
  const recentTemplates = useMemo(() => templatesForLibraryView(templates, library, "recent"), [templates, library]);
  const viewedTemplates = useMemo(() => templatesForLibraryView(templates, library, view), [templates, library, view]);
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase("ko-KR");
    return viewedTemplates.filter((template) => (category === "all" || template.categories.includes(category))
      && (!search || [template.name, template.tagline, template.description, ...template.categories.map(categoryLabel)].join(" ").toLocaleLowerCase("ko-KR").includes(search)));
  }, [viewedTemplates, category, query]);
  const selected = templates.find((template) => template.id === selectedId) ?? null;
  const selectedPreview = selected && preview?.project.templateRecipe?.id === selected.id ? preview : null;
  const project = selectedPreview?.project ?? selected?.sampleProject ?? null;
  const scenes = project?.scenes ?? [];
  const position = sceneAtElapsed(scenes, elapsed);
  const scene = position ? scenes[position.index] : null;
  const sceneBeat = selected && position ? templateBeatAt(selected.beats, position.index, scenes.length) : undefined;
  const motion = readMotion(scene?.motion);
  const totalSec = position?.totalSec ?? 0;
  const playingRef = useRef(false);
  const eligibleToPlay = active && visible && !loading && !disabled && !!project;
  const actuallyPlaying = playing && eligibleToPlay;
  const accent = scene?.accent ?? selected?.accent ?? "#8AE3BB";
  const emptyMessage = view !== "all" && !library ? "즐겨찾기·최근 사용 정보를 불러오지 못했습니다."
    : query.trim() || category !== "all" ? "검색 조건에 맞는 템플릿이 없습니다."
      : view === "favorites" ? "즐겨찾는 템플릿이 없습니다. 카드의 별을 눌러 저장하세요."
        : view === "recent" ? "최근 사용한 템플릿이 없습니다. 템플릿으로 편집을 시작하면 여기에 표시됩니다."
          : "표시할 템플릿이 없습니다.";
  const style = { "--vt-accent": accent, "--vt-intensity": motion?.intensity ?? 0, "--vt-scene-progress": `${Math.round((position?.progress ?? 0) * 100)}%` } as CSSProperties;

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(query.matches);
    const visibility = () => {
      const isVisible = document.visibilityState !== "hidden";
      setVisible(isVisible);
      if (!isVisible) {
        playingRef.current = false;
        setPlaying(false);
        if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
    query.addEventListener("change", change);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      playingRef.current = false;
      query.removeEventListener("change", change);
      document.removeEventListener("visibilitychange", visibility);
      if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, []);

  useEffect(() => {
    setPlaying(false);
    playingRef.current = false;
    elapsedRef.current = 0;
    setElapsed(0);
  }, [project]);

  useEffect(() => {
    if (!eligibleToPlay) {
      playingRef.current = false;
      setPlaying(false);
    }
  }, [eligibleToPlay]);

  useEffect(() => {
    if (!actuallyPlaying || totalSec <= 0) return;
    let disposed = false;
    let previousTimestamp: number | null = null;
    let lastPaint = 0;
    playingRef.current = true;
    const tick = (timestamp: number) => {
      if (disposed || !playingRef.current) return;
      const delta = previousTimestamp == null ? 0 : Math.max(0, timestamp - previousTimestamp) / 1000;
      previousTimestamp = timestamp;
      elapsedRef.current = Math.min(totalSec, elapsedRef.current + delta);
      // Paint at most ten times a second. One RAF owns the entire storyboard.
      if (timestamp - lastPaint >= 100 || elapsedRef.current >= totalSec) {
        setElapsed(elapsedRef.current);
        lastPaint = timestamp;
      }
      if (elapsedRef.current >= totalSec) {
        playingRef.current = false;
        setPlaying(false);
        frameRef.current = null;
      } else frameRef.current = window.requestAnimationFrame(tick);
    };
    frameRef.current = window.requestAnimationFrame(tick);
    return () => {
      disposed = true;
      playingRef.current = false;
      if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [actuallyPlaying, totalSec, project]);

  function seek(seconds: number) {
    playingRef.current = false;
    setPlaying(false);
    elapsedRef.current = seconds;
    setElapsed(seconds);
  }
  function togglePlay() {
    if (actuallyPlaying) {
      playingRef.current = false;
      setPlaying(false);
      setElapsed(elapsedRef.current);
    } else {
      if (elapsedRef.current >= totalSec) { elapsedRef.current = 0; setElapsed(0); }
      setPlaying(true);
    }
  }

  return <section className="vt-gallery" aria-label="영상 템플릿 선택">
    <div className="vt-section-heading"><div><span className="vt-kicker"><Clapperboard size={14} />TEMPLATE STUDIO</span><h3>어떤 영상으로 만들까요?</h3><p>구성과 화면을 먼저 골라 보고, 내 주제로 편집을 시작하세요.</p></div><span className="vt-count">{templates.length}개 템플릿</span></div>
    <div className="vt-workspace">
      <div className="vt-library">
        <div className="vt-library-views" role="group" aria-label="템플릿 라이브러리 보기">
          <button type="button" aria-pressed={view === "all"} onClick={() => setView("all")}>전체 <span>{templates.length}</span></button>
          <button type="button" aria-pressed={view === "favorites"} onClick={() => setView("favorites")}><Star size={12} />즐겨찾기 <span>{favoriteTemplates.length}</span></button>
          <button type="button" aria-pressed={view === "recent"} onClick={() => setView("recent")}><Clock3 size={12} />최근 사용 <span>{recentTemplates.length}</span></button>
        </div>
        {libraryLoading && <p className="vt-library-status" role="status"><LoaderCircle size={12} className="spin" />라이브러리를 동기화하는 중입니다.</p>}
        <label className="vt-search"><span>템플릿 찾기</span><input type="search" aria-label="템플릿 검색" placeholder="이름 또는 영상 스타일 검색" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="vt-filters" role="group" aria-label="템플릿 카테고리"><button type="button" aria-pressed={category === "all"} onClick={() => setCategory("all")}>전체 <span>{templates.length}</span></button>{categories.map((value) => <button type="button" key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>{categoryLabel(value)}</button>)}</div>
        <div className="vt-results-count" aria-live="polite">{filtered.length}개 표시{selected && <span>선택: {selected.name}</span>}</div>
        {templates.length === 0 ? <div className="vt-empty">{loading ? <><LoaderCircle size={18} className="spin" />템플릿을 불러오는 중입니다.</> : <>사용 가능한 템플릿이 없습니다.<button type="button" className="social-button compact" disabled={disabled} onClick={onRetry}><RefreshCw size={13} />다시 불러오기</button></>}</div> : filtered.length === 0 ? <div className="vt-empty">{view !== "all" && libraryLoading ? <><LoaderCircle size={18} className="spin" />라이브러리를 불러오는 중입니다.</> : <>{emptyMessage}<div className="vt-empty-actions"><button type="button" className="social-button compact" onClick={() => { setCategory("all"); setQuery(""); setView("all"); }}>검색 조건 초기화</button><button type="button" className="social-button compact" disabled={disabled || libraryLoading} onClick={onRetry}><RefreshCw size={13} />다시 불러오기</button></div></>}</div> : <div className="vt-cards">{filtered.map((template) => <article key={template.id} className={`vt-card ${selectedId === template.id ? "selected" : ""}`}><button type="button" className="vt-card-select" aria-pressed={selectedId === template.id} aria-label={`${template.name}, ${template.tagline}, ${template.durationSec}초, ${templateFormatLabels[template.format]}`} disabled={disabled} onClick={() => onSelect(template)}>
          <TemplateCover template={template} index={templates.findIndex((item) => item.id === template.id)} />
          <span className="vt-card-selected">{selectedId === template.id ? <><Check size={12} />선택됨</> : "미리보기"}</span>
          <span className="vt-card-copy"><strong>{template.name}</strong><span>{template.tagline}</span><span className="vt-card-meta"><span><Clock3 size={11} />{formatPreviewTime(template.durationSec)}</span><span>{templateFormatLabels[template.format]}</span></span><span className="vt-card-beats">{template.beats.slice(0, 3).map((beat) => beat.label).join(" → ")}</span></span>
        </button><button type="button" className="vt-favorite" aria-label={`${template.name} 즐겨찾기 ${favoriteIds.has(template.id) ? "해제" : "추가"}`} aria-pressed={favoriteIds.has(template.id)} disabled={disabled || libraryLoading || !library} onClick={() => onFavorite(template.id, !favoriteIds.has(template.id))}><Star size={13} /></button></article>)}</div>}
      </div>
      <div className="vt-preview-panel" aria-busy={loading}>
        {!selected || !project || !scene || !position ? <div className="vt-preview-placeholder"><Layers3 size={32} /><strong>템플릿을 선택하세요</strong><span>장면, 문구, 내레이션과 영상의 흐름을 확인할 수 있습니다.</span></div> : <>
          <div className="vt-preview-heading"><div><span>선택한 구성 · {scenes.length}개 장면</span><h4>{selected.name}</h4></div><span className="vt-preview-tag">{templateFormatLabels[project.format]}</span></div>
          {controls && <div className="vt-preview-controls">{controls}</div>}
          <p className="vt-preview-description">{selected.description}</p>
          <div className="vt-stage-shell"><div key={`${project.id}-${position.index}`} className={`vt-stage ${project.format === "youtube-landscape" ? "landscape" : "portrait"} ${motion?.preset ?? "still"} ${actuallyPlaying && !reduced && (motion?.intensity ?? 0) > 0 ? "playing" : ""}`} style={style} aria-label={`장면 ${position.index + 1}: ${scene.headline}`}>
            <div className="vt-stage-background" /><div className="vt-stage-glow" />
            {motion?.preset === "orbit-cards" && <div className="vt-stage-orbit" aria-hidden="true"><i>01</i><i>02</i><i>03</i></div>}
            <div className="vt-stage-copy"><small>{scene.eyebrow || sceneBeat?.label || `SCENE ${position.index + 1}`}</small><h5>{scene.headline || "제목을 입력하세요"}</h5><p>{scene.body}</p></div>
            <div className="vt-stage-footer"><span>TORIS STUDIO</span><span>{String(position.index + 1).padStart(2, "0")} / {String(scenes.length).padStart(2, "0")}</span></div>
          </div></div>
          <div className="vt-player-controls"><button type="button" aria-label="이전 장면" disabled={position.index === 0 || !active} onClick={() => seek(sceneStartSeconds(scenes, position.index - 1))}><ChevronLeft size={17} /></button><button type="button" className="vt-play-button" disabled={!eligibleToPlay} onClick={togglePlay}>{actuallyPlaying ? <Pause size={15} /> : <Play size={15} />}{actuallyPlaying ? "일시정지" : "구성 재생"}</button><button type="button" aria-label="다음 장면" disabled={position.index >= scenes.length - 1 || !active} onClick={() => seek(sceneStartSeconds(scenes, position.index + 1))}><ChevronRight size={17} /></button><span>{formatPreviewTime(elapsed)} / {formatPreviewTime(totalSec)}</span></div>
          <label className="vt-seek"><span className="sr-only">영상 구성 재생 위치</span><input type="range" aria-label="영상 구성 재생 위치" min={0} max={totalSec} step={.1} value={elapsed} disabled={!active} onChange={(event) => seek(Number(event.target.value))} aria-valuetext={`${formatPreviewTime(elapsed)}, 장면 ${position.index + 1}`} /></label>
          <div className="vt-timeline" role="group" aria-label="영상 장면 선택">{scenes.map((item, index) => <button type="button" key={item.id} aria-pressed={position.index === index} disabled={!active} onClick={() => seek(sceneStartSeconds(scenes, index))}><span>{String(index + 1).padStart(2, "0")}</span><strong>{templateBeatAt(selected.beats, index, scenes.length)?.label || "장면"}</strong><small>{item.durationSec.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}초</small>{position.index === index && <i style={{ width: `${position.progress * 100}%` }} />}</button>)}</div>
          <div className="vt-scene-detail"><div><strong><Sparkles size={13} />{motion ? motionPresets[motion.preset].label : "정지 장면"}</strong><span>{scene.durationSec.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}초 · 장면 {position.index + 1}</span></div><p>{sceneBeat?.intent}</p><span className="vt-narration-label">내레이션 초안</span><p className="vt-narration">{scene.narration || "이 장면에는 내레이션이 없습니다."}</p></div>
          <p className="vt-preview-note">{selectedPreview ? "입력한 주제를 반영한 구성 초안입니다." : `예시 주제: ${selected.sampleTopic}.`} 이 화면은 제목·본문·모션의 구성 미리보기이며 완성된 영상이 아닙니다. 최종 MP4의 배치는 달라질 수 있습니다. {reduced && "모션 감소 설정에 따라 움직임 없이 장면을 전환합니다."}</p>
          {selectedPreview?.warnings.length ? <div className="vt-warnings">{selectedPreview.warnings.map((warning, index) => <p key={index}><CircleAlert size={13} />{warning}</p>)}</div> : null}
          <button type="button" className="social-button primary vt-use-button" disabled={disabled || !active || loading || !!error || !selectedPreview} onClick={() => { if (selectedPreview) onUse(selected, selectedPreview); }}>{loading ? <LoaderCircle size={15} className="spin" /> : <Clapperboard size={15} />}{loading ? "내 주제로 구성하는 중…" : "이 템플릿으로 시작"}</button>
        </>}
        {error && <div className="vt-error" role="alert"><p><CircleAlert size={15} />{error}</p><button type="button" className="social-button compact" disabled={disabled || loading} onClick={onRetry}><RefreshCw size={13} />다시 시도</button></div>}
      </div>
    </div>
  </section>;
}
