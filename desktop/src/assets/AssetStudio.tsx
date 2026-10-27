import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Box, Check, ChevronLeft, ChevronRight, CircleAlert, ClipboardList, Copy, ExternalLink, FolderOpen, Image as ImageIcon, Layers, LoaderCircle, Plus, RefreshCw, Search, Send, SlidersHorizontal, Star, Upload, X } from "lucide-react";
import { aiStatus as readAiStatus, generateImage, modelLabel } from "../ai-client";
import { AssetInspector, AssetThumbnail } from "./AssetInspector";
import { ImageOutputControls } from "./ImageOutputControls";
import { AssetResizePanel } from "./AssetResizePanel";
import { applyAssetRefresh, defaultSpec, handoffText, imageGenerationRequest, JOB_LABELS, validationError } from "./contracts";
import type { Asset, AssetJob, AssetSnapshot, AssetSpec } from "./contracts";
import { assetApi, assetError } from "./transport";
import "./AssetStudio.css";
import { ActivityStatus, ActivitySkeleton } from "../ActivityStatus";
import "./AssetResize.css";

type View = "create" | "library" | "queue" | "resize";
const PAGE_SIZE = 48;
function initialSpec(): AssetSpec {
  try {
    const saved = JSON.parse(localStorage.getItem("toris.asset.draft") ?? "null") as Partial<AssetSpec> | null;
    const next = {...defaultSpec,...saved};
    return validationError(next,false) ? defaultSpec : next;
  } catch {return defaultSpec;}
}
export function AssetStudio({ active, refreshKey = 0 }: { active: boolean; refreshKey?: number }) {
  const [view,setView]=useState<View>("create");
  const [mode,setMode]=useState<"image"|"model3d">("image");
  const [spec,setSpec]=useState<AssetSpec>(initialSpec);
  const [snapshot,setSnapshot]=useState<AssetSnapshot|null>(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [loadError,setLoadError]=useState("");
  const [notice,setNotice]=useState("");
  const [query,setQuery]=useState("");
  const [search,setSearch]=useState("");
  const [purpose,setPurpose]=useState("all");
  const [kind,setKind]=useState("all");
  const [favorites,setFavorites]=useState(false);
  const [offset,setOffset]=useState(0);
  const [selected,setSelected]=useState<Asset|null>(null);
  const [resizeSource,setResizeSource]=useState<Asset|null>(null);
  const [shape,setShape]=useState("box");
  const [size,setSize]=useState([1,1,1]);
  const [modelFormat,setModelFormat]=useState("glb");
  const [segments,setSegments]=useState(32);
  const [color,setColor]=useState("#92b8ff");
  const serial=useRef(0);
  const pendingReads=useRef(0);
  const mounted=useRef(false);
  const noticeFrame=useRef<number|null>(null);
  const activeRef=useRef(active);
  activeRef.current=active;
  const noticeRef=useRef<HTMLDivElement>(null);
  const refresh=useCallback(async(background=false)=>{
    // A slow native read must not be invalidated by the next automatic tick.
    // Explicit filter/refresh changes can supersede it; only the latest result applies.
    if(!mounted.current || !activeRef.current || (background && pendingReads.current>0)) return;
    const request=++serial.current;
    pendingReads.current++;
    try {
      const data=await assetApi<AssetSnapshot>("snapshot",{query:search,purpose,kind,favorite:favorites,offset,limit:PAGE_SIZE});
      if(request!==serial.current || !activeRef.current) return;
      setSnapshot(data);
      setLoadError("");
      setSelected(current=>current ? data.assets.find(a=>a.id===current.id) ?? current : null);
    } catch(error) {if(request===serial.current && activeRef.current) setLoadError(assetError(error));}
    finally {
      pendingReads.current--;
      if(request===serial.current && activeRef.current)setLoading(false);
    }
  },[search,purpose,kind,favorites,offset]);
  useEffect(()=>{
    mounted.current=true;
    return()=>{mounted.current=false;serial.current++;if(noticeFrame.current!==null)cancelAnimationFrame(noticeFrame.current);noticeFrame.current=null;};
  },[]);
  useEffect(()=>{
    if(!active) return;
    void refresh();
    const timer=window.setInterval(()=>{if(document.visibilityState==="visible")void refresh(true);},5000);
    return()=>{window.clearInterval(timer);serial.current++;if(noticeFrame.current!==null)cancelAnimationFrame(noticeFrame.current);noticeFrame.current=null;};
  },[active,refresh,refreshKey]);
  useEffect(()=>{if(!active)return;const timer=setTimeout(()=>{setSearch(query);setOffset(0);},250);return()=>clearTimeout(timer);},[active,query]);
  useEffect(()=>{try{localStorage.setItem("toris.asset.draft",JSON.stringify(spec));}catch{/* The native job remains the durable record. */}},[spec]);
  const pending=snapshot?.jobs.filter(j=>j.status==="queued"||j.status==="waiting") ?? [];
  const setField=<K extends keyof AssetSpec>(key:K,value:AssetSpec[K])=>setSpec(current=>({...current,[key]:value}));
  const inform=(text:string)=>{if(!mounted.current)return;setNotice(text);if(!activeRef.current)return;if(noticeFrame.current!==null)cancelAnimationFrame(noticeFrame.current);noticeFrame.current=requestAnimationFrame(()=>{noticeFrame.current=null;if(mounted.current&&activeRef.current)noticeRef.current?.scrollIntoView({block:"nearest"});});};
  async function execute(task:()=>Promise<void>) {
    if(busy||!mounted.current)return;
    setBusy(true);setError("");setNotice("");
    try{await task();}catch(error){if(mounted.current)setError(assetError(error));}finally{if(mounted.current)setBusy(false);}
  }
  async function copyJobs(jobs:AssetJob[]) {
    const text=handoffText(jobs);
    if(text.length>39000) throw new Error("복사할 프롬프트가 큽니다. 작업별 복사 버튼으로 나누어 전달하세요.");
    await invoke("copy_text",{text});
    inform(`${jobs.length}개 요청을 복사했습니다. Studio MCP가 연결된 AI 도구에 붙여넣으세요.`);
  }
  /** Generate each queued job with the selected image API; files are saved against the job. */
  async function sendJobs(jobs:AssetJob[]) {
    const status=await readAiStatus();
    if(!status.image) throw new Error("Agent 탭의 모델 설정에서 이미지 생성 모델을 선택하세요.");
    let done=0;
    for(const job of jobs.filter(j=>j.status==="queued"||j.status==="waiting")){
      if(!mounted.current)return;
      inform(`이미지 생성 중 ${done+1}/${jobs.length} · ${job.spec.title}`);
      const request=imageGenerationRequest(job);
      await generateImage(request.jobId,request.prompt,request.size);
      done++;
      await refresh();
    }
    inform(`${done}개 이미지를 ${modelLabel(status,status.image)}로 생성해 보관함에 저장했습니다.`);
  }
  async function create() {
    const invalid=validationError(spec,mode==="image");
    if(invalid)throw new Error(invalid);
    if(mode==="image") {
      await assetApi<{jobs:AssetJob[]}>("create_jobs",spec);
      await refresh();if(!mounted.current)return;setView("queue");
      inform(`${spec.quantity}개 요청을 저장했습니다. 작업 큐에서 이미지 생성을 누르세요.`);
    } else {
      const result=await assetApi<{asset:Asset}>("create_mesh",{spec,shape,size,color,segments,format:modelFormat});
      await refresh();if(!mounted.current)return;setSelected(result.asset);setView("library");
      inform(`${modelFormat.toUpperCase()} 파일을 로컬에서 생성하고 저장했습니다.`);
    }
  }
  async function resizeAsset(outputSpec:AssetSpec) {
    if(!resizeSource) throw new Error("변환할 이미지 에셋을 선택하세요.");
    const invalid=validationError(outputSpec,false);
    if(invalid) throw new Error(invalid);
    const result=await assetApi<{asset:Asset}>("resize_asset",{id:resizeSource.id,spec:outputSpec});
    if(!mounted.current)return;resetFilters();await refresh();if(!mounted.current)return;setSelected(result.asset);setResizeSource(null);setView("library");
    inform(`${outputSpec.width} × ${outputSpec.height} ${outputSpec.format.toUpperCase()} 파일을 새 에셋으로 저장했습니다. 원본과 이전 출력은 유지됩니다.`);
  }
  async function importFiles(job?:AssetJob) {
    const useSpec=job?.spec ?? spec;
    const invalid=validationError(useSpec,false);if(invalid)throw new Error(invalid);
    const paths=await invoke<string[]>("asset_choose_files");
    if(!paths.length||!mounted.current)return;
    if(job && paths.length!==1)throw new Error("한 작업에는 결과 파일 하나를 선택하세요. 묶음 가져오기는 상단 버튼을 이용하세요.");
    const result=await assetApi<{results:Array<{asset?:Asset;error?:string}>}>("import_paths",{paths,spec:useSpec,...(job ? {jobId:job.id} : {})});
    const added=result.results.filter(r=>r.asset);
    const failures=result.results.filter(r=>r.error);
    await refresh();
    if(!mounted.current)return;
    if(added.length){setView("library");setSelected(added[0].asset!);inform(`${added.length}개 에셋을 가져왔습니다. 원본 파일은 삭제하거나 덮어쓰지 않았습니다.`);}
    if(failures.length)setError(`${failures.length}개 파일을 가져오지 못했습니다. ${failures.map(r=>r.error).join(" · ")}`);
  }
  async function chooseFolder(purpose:"video"|"project") {
    const result=await invoke<{cancelled?:boolean}>("asset_choose_folder",{purpose});
    if(!result.cancelled){await refresh();inform("저장 폴더를 변경했습니다. 새로 만드는 요청부터 적용됩니다. 기존 요청과 파일의 위치는 유지됩니다.");}
  }
  async function updateJob(job:AssetJob,status:string){await assetApi("set_job",{id:job.id,status});await refresh();}
  function resetFilters(){setQuery("");setSearch("");setPurpose("all");setKind("all");setFavorites(false);setOffset(0);}
  const visibleError=error || loadError;
  const failedLibrary=<div className="asset-empty"><CircleAlert size={36}/><h2>보관함을 불러오지 못했습니다</h2><p>저장된 에셋이 없는 상태와는 다릅니다. 기존 파일은 유지됩니다. 연결 상태를 확인하고 다시 불러오세요.</p><button className="asset-button" disabled={busy} onClick={()=>void refresh()}>보관함 다시 불러오기</button></div>;
  if (!active) return null;
  return <section className="asset-studio" aria-label="이미지 및 3D 에셋 작업실">
    <div className="asset-workspace-bar">
      <div className="asset-views" role="group" aria-label="에셋 작업 화면">
        <button disabled={busy} aria-pressed={view==="create"} className={view==="create"?"active":""} onClick={()=>setView("create")}><Plus size={17}/>새로 만들기</button>
        <button disabled={busy} aria-pressed={view==="library"} className={view==="library"?"active":""} onClick={()=>setView("library")}><Layers size={17}/>에셋 보관함{snapshot && <small>{snapshot.libraryTotal}</small>}</button>
        <button disabled={busy} aria-pressed={view==="queue"} className={view==="queue"?"active":""} onClick={()=>setView("queue")}><ClipboardList size={17}/>작업 큐{pending.length>0 && <small>{pending.length}</small>}</button>
      </div>
      <div className="asset-row"><button className="asset-icon-button" disabled={busy} aria-label="에셋 새로고침" onClick={()=>void execute(refresh)}><RefreshCw size={17}/></button><button className="asset-button" disabled={busy} onClick={()=>void execute(()=>importFiles())}><Upload size={16}/>기존 에셋 가져오기</button></div>
    </div>
    <div className="asset-provider-strip"><span><Check size={15}/>로컬 파일 처리 · 원본 보존</span><span>이미지 생성: Agent 탭에서 고른 이미지 API</span></div>
    {(visibleError||notice) && <div ref={noticeRef} className={`asset-message ${visibleError?"error":"success"}`} role={visibleError?"alert":"status"}><CircleAlert size={18}/><p>{visibleError||notice}</p>{!error && loadError ? <button className="asset-button small" disabled={busy} onClick={()=>void refresh()}>다시 불러오기</button> : <button className="asset-icon-button" aria-label="에셋 알림 닫기" onClick={()=>{setError("");setNotice("");}}><X size={16}/></button>}</div>}
    {busy && <ActivityStatus title="로컬 작업 처리 중" detail="Studio가 요청한 파일 처리 또는 저장을 수행하고 있습니다. 실제 응답이 도착하면 결과를 반영하며 완료 비율을 추정해서 표시하지 않습니다."/>}

    {view==="resize" && resizeSource && <AssetResizePanel key={resizeSource.id} source={resizeSource} settings={snapshot?.settings} busy={busy} onCancel={()=>setView("library")} onChooseFolder={purpose=>void execute(()=>chooseFolder(purpose))} onExport={outputSpec=>void execute(()=>resizeAsset(outputSpec))}/>}
    {view==="create" && <div className="asset-create-layout">
      <form className="asset-create-form" onSubmit={event=>{event.preventDefault();void execute(create);}}>
        <div className="asset-section-heading"><h2>무엇을 만들까요?</h2><div className="asset-segment" role="group" aria-label="생성 유형"><button type="button" aria-pressed={mode==="image"} onClick={()=>setMode("image")}><ImageIcon size={16}/>이미지</button><button type="button" aria-pressed={mode==="model3d"} onClick={()=>setMode("model3d")}><Box size={16}/>3D</button></div></div>
        <fieldset disabled={busy}>
          <div className="asset-field-grid"><label className="asset-field">에셋 이름<input required maxLength={120} value={spec.title} onChange={e=>setField("title",e.target.value)} placeholder="예: 오프닝 바다 배경"/></label><label className="asset-field">프로젝트<input required maxLength={120} value={spec.project} onChange={e=>setField("project",e.target.value)} placeholder="예: 씬포켓, Loca" list="asset-project-names"/><datalist id="asset-project-names">{Array.from(new Set(snapshot?.assets.map(a=>a.project) ?? [])).map(name=><option key={name} value={name}/>)}</datalist></label></div>
          <label className="asset-field">사용 용도<select value={spec.purpose} onChange={e=>setField("purpose",e.target.value as AssetSpec["purpose"])}><option value="video">영상 제작용 — 배경·장면·썸네일</option><option value="project">프로젝트 에셋 — 앱·게임·웹·3D</option></select></label>
          <label className="asset-field">{mode==="image" ? "이미지 프롬프트" : "에셋 설명 · 선택"}<textarea aria-label={mode==="image" ? "이미지 프롬프트" : "에셋 설명 · 선택"} value={spec.prompt} required={mode==="image"} maxLength={12000} rows={6} onChange={e=>setField("prompt",e.target.value)} placeholder={mode==="image" ? "장면, 피사체, 구도, 조명, 배경을 구체적으로 적어주세요.\n예: 고요한 새벽 바다. 화면 오른쪽 아래에 작은 배, 왼쪽은 자막 여백. 글자와 로고 없음." : "3D 도형의 사용처나 재질 메모를 남기세요. 이 텍스트로 AI 모델을 생성하지는 않습니다."}/></label>
          {mode==="image" ? <>
            <ImageOutputControls spec={spec} onChange={setSpec}/>
          </> : <>
            <div className="asset-field-grid"><label className="asset-field">기본 도형<select value={shape} onChange={e=>setShape(e.target.value)}><option value="box">박스</option><option value="sphere">구 · 타원체</option><option value="cylinder">원기둥</option><option value="plane">평면</option></select></label><label className="asset-field">출력 파일<select value={modelFormat} onChange={e=>setModelFormat(e.target.value)}><option value="glb">GLB · 재질 포함</option><option value="obj">OBJ · 메시 + 법선</option><option value="stl">STL · 바이너리 메시</option></select></label></div>
            <div className="asset-field-grid three">{["가로 X (m)","높이 Y (m)","깊이 Z (m)"].map((label,index)=><label key={label} className="asset-field">{label}<input type="number" min={0.001} max={1000} step="any" value={size[index]} required onChange={e=>setSize(current=>current.map((n,i)=>i===index?Number(e.target.value):n))}/></label>)}</div>
            <div className="asset-field-grid"><label className="asset-field">곡면 분할 수<input type="number" min={8} max={64} value={segments} onChange={e=>setSegments(Number(e.target.value))}/></label><label className="asset-field">GLB 재질 색상<input type="color" value={color} onChange={e=>setColor(e.target.value)}/></label></div>
            <p className="asset-inline-note">실제 메시 파일을 로컬에서 생성합니다. 자유형 AI 3D 생성·이미지의 입체 복원 기능은 아닙니다. STL은 자체 단위가 없으므로 가져오는 도구에서 미터 기준을 확인하세요.</p>
          </>}
          <div className="asset-submit-row"><span><SlidersHorizontal size={16}/>{mode==="image" ? `${spec.width} × ${spec.height} · ${spec.format.toUpperCase()}` : `${modelFormat.toUpperCase()} · 로컬 생성`}</span><button type="submit" className="asset-button primary" disabled={busy||loading||!snapshot}>{mode==="image" ? <ClipboardList size={17}/> : <Box size={17}/>} {mode==="image" ? "요청 큐에 추가" : "3D 파일 생성"}</button></div>
        </fieldset>
      </form>
      <aside className="asset-workflow">
        <section><h2>생성부터 재사용까지</h2><p>AI가 이미지를 만들고,<br/>Studio는 파일을 정리합니다.</p><div className="asset-flow"><span>앱에서 요청</span><ArrowRight size={16}/><span>이미지 API</span><ArrowRight size={16}/><span>에셋 보관함</span></div><p className="asset-inline-note">Agent 탭의 모델 설정에서 이미지 생성 모델(OpenAI 또는 Gemini)과 API 키를 저장한 뒤 작업 큐의 이미지 생성을 누르세요.</p><details className="asset-details"><summary>다른 AI 도구로 만들기</summary><p>Studio MCP(--studio-mcp)를 연결한 AI 도구에 요청을 복사해 전달할 수 있습니다. 다운로드한 이미지는 파일 연결로 가져올 수 있습니다.</p></details></section>
        <section className="asset-output-settings"><h3>용도별 저장 폴더</h3>{(["video","project"] as const).map(p=><div key={p} className="asset-folder"><div><span>{p==="video" ? "영상 제작용" : "프로젝트 에셋"}</span><code title={snapshot?.settings[p==="video"?"videoRoot":"projectRoot"]}>{snapshot?.settings[p==="video"?"videoRoot":"projectRoot"] ?? "불러오는 중…"}</code></div><button className="asset-icon-button" disabled={busy} aria-label={`${p==="video"?"영상용":"프로젝트용"} 저장 폴더 선택`} onClick={()=>void execute(()=>chooseFolder(p))}><FolderOpen size={19}/></button></div>)}<p className="asset-inline-note">프로젝트와 에셋별 폴더를 자동 생성합니다. 원본과 규격화된 출력 파일을 따로 보존합니다.</p></section>
        <section className="asset-limits"><h3>사용 범위</h3><p>이미지 생성은 선택한 API 계정의 요금과 사용 한도가 적용됩니다.</p><p>파일당 32 MiB · 자체 포함 GLB · PNG / JPEG / WebP / ICO / OBJ / STL</p></section>
      </aside>
    </div>}

    {view==="library" && <>
      <p className="asset-inline-note" style={{marginBottom:14}}>가져오기 대상: {spec.purpose==="video" ? "영상 제작용" : "프로젝트 에셋"} / {spec.project} · {spec.width} × {spec.height} {spec.format.toUpperCase()} <button className="asset-button small" onClick={()=>setView("create")}>가져오기 설정 변경</button></p>
      <div className="asset-library-toolbar"><label className="asset-search"><Search size={17}/><input aria-label="에셋 검색" placeholder="이름, 프로젝트, 프롬프트, 태그 검색" value={query} onChange={e=>setQuery(e.target.value)}/></label><select aria-label="에셋 용도 필터" value={purpose} onChange={e=>{setPurpose(e.target.value);setOffset(0);}}><option value="all">모든 용도</option><option value="video">영상 제작용</option><option value="project">프로젝트 에셋</option></select><select aria-label="에셋 형식 필터" value={kind} onChange={e=>{setKind(e.target.value);setOffset(0);}}><option value="all">모든 형식</option><option value="image">이미지</option><option value="model3d">3D 모델</option></select><button className="asset-button" aria-pressed={favorites} onClick={()=>{setFavorites(!favorites);setOffset(0);}}><Star size={16} fill={favorites?"currentColor":"none"}/>즐겨찾기</button></div>
      <div className={`asset-library-layout${selected?" has-inspector":""}`}><div className="asset-gallery-area">
        <div className="asset-gallery-caption"><span>{snapshot ? `${snapshot.total}개 에셋` : "에셋 수 확인 전"}{snapshot && snapshot.total!==snapshot.libraryTotal && ` / 전체 ${snapshot.libraryTotal}개`}</span><span>최근 저장순 · 원본 보존</span></div>
        {loading ? <div><ActivityStatus title="보관함을 불러오는 중입니다."/><ActivitySkeleton label="에셋 목록 준비 중" rows={3}/></div> : !snapshot && loadError ? failedLibrary : !snapshot?.assets.length ? <div className="asset-empty"><Layers size={40}/><h2>{snapshot?.libraryTotal ? "조건에 맞는 에셋이 없습니다" : "흩어진 에셋을 한곳에 모으세요"}</h2><p>{snapshot?.libraryTotal ? "검색어나 필터를 바꾸어 다시 찾아보세요." : "예전에 만든 이미지와 3D 파일을 가져오면 용도별로 정리하고 다시 사용할 수 있습니다."}</p><button className="asset-button" disabled={busy} onClick={()=>snapshot?.libraryTotal ? resetFilters() : void execute(()=>importFiles())}>{snapshot?.libraryTotal ? "필터 초기화" : "기존 파일 가져오기"}</button></div> : <div className="asset-grid">{snapshot.assets.map(asset=><article key={asset.id} className={`asset-card${selected?.id===asset.id?" selected":""}`}><button className="asset-card-open" onClick={()=>setSelected(asset)} aria-label={`${asset.title} 상세 보기`} aria-pressed={selected?.id===asset.id}><AssetThumbnail asset={asset}/><div className="asset-card-meta"><div><span className={`asset-purpose ${asset.purpose}`}>{asset.purpose==="video"?"영상":"프로젝트"}</span><small>{asset.format.toUpperCase()}</small></div><h3>{asset.title}</h3><p>{asset.project}<span>{asset.kind==="image" ? `${asset.details.width} × ${asset.details.height}` : `${asset.details.triangles?.toLocaleString()} tris`}</span></p><div className="asset-card-bottom"><span>{asset.review==="approved"?"사용 승인":asset.review==="rejected"?"보류":"검토 전"}</span>{asset.favorite && <Star size={13} fill="currentColor"/>}</div></div></button></article>)}</div>}
        {snapshot && snapshot.total>PAGE_SIZE && <div className="asset-pagination"><button className="asset-button small" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-PAGE_SIZE))}><ChevronLeft size={16}/>이전</button><span>{Math.floor(offset/PAGE_SIZE)+1} / {Math.ceil(snapshot.total/PAGE_SIZE)}</span><button className="asset-button small" disabled={offset+PAGE_SIZE>=snapshot.total} onClick={()=>setOffset(offset+PAGE_SIZE)}>다음<ChevronRight size={16}/></button></div>}
      </div>{selected && <AssetInspector asset={selected} onClose={()=>setSelected(null)} onError={setError} onChanged={()=>{void refresh();void assetApi<{asset:Asset}>("get_asset",{id:selected.id}).then(r=>setSelected(current=>applyAssetRefresh(current,r.asset))).catch(e=>setError(assetError(e)));}} onResize={asset=>{setResizeSource(asset);setView("resize");setError("");setNotice("");}} onReuse={asset=>{setSpec({...asset.spec,quantity:1});setMode(asset.kind);setView("create");inform("설정을 가져왔습니다. 새 요청은 기존 에셋을 덮어쓰지 않습니다.");}}/>}</div>
    </>}

    {view==="queue" && <div className="asset-queue">{pending.length>0&&!busy&&<ActivityStatus title={`생성 대기 · ${pending.length}개 요청`} state="waiting" clock={false} detail="이미지 생성을 누르면 선택한 이미지 API로 만들고 이 큐에 저장 결과를 표시합니다."><button className="asset-button small" onClick={()=>void execute(()=>sendJobs(pending.slice(0,20)))}>이미지 생성</button><button className="asset-button small" onClick={()=>void execute(()=>copyJobs(pending.slice(0,20)))}>다른 AI 도구용 요청 복사</button></ActivityStatus>}<div className="asset-section-heading"><div><h2>생성 요청과 저장 결과</h2><p>요청 대기 → AI 생성 → 규격 변환 → 저장 완료</p></div><button className="asset-button primary" disabled={busy||pending.length===0} onClick={()=>void execute(()=>sendJobs(pending.slice(0,20)))}><Send size={16}/>대기 요청 생성{pending.length>20 ? " (최대 20개)" : ""}</button></div><p className="asset-inline-note">요청을 저장한 뒤 이미지 생성을 눌러야 만들어집니다. 다른 도구에서 만든 결과는 “파일 연결”로 가져올 수 있습니다.</p>
      {loading ? <div><ActivityStatus title="작업 큐를 불러오는 중입니다."/><ActivitySkeleton label="작업 목록 준비 중" rows={3}/></div> : !snapshot && loadError ? failedLibrary : !snapshot?.jobs.length ? <div className="asset-empty"><ClipboardList size={38}/><h2>아직 생성 요청이 없습니다</h2><p>프롬프트와 출력 규격을 지정해 첫 요청을 만들어보세요.</p><button className="asset-button" onClick={()=>setView("create")}>이미지 요청 만들기</button></div> : <div className="asset-job-list">{snapshot.jobs.map(job=><article key={job.id} className={`asset-job ${job.status}`}><span className="asset-job-icon">{job.status==="completed"?<Check size={21}/>:<ImageIcon size={21}/>}</span><div className="asset-job-info"><h3>{job.spec.title}<small>#{job.index}</small></h3><p>{job.spec.project} · {job.spec.width} × {job.spec.height} · {job.spec.format.toUpperCase()}</p><code title={job.id}>{job.id}</code></div><span className={`asset-job-status ${job.status}`}>{JOB_LABELS[job.status]}</span><div className="asset-job-actions">{job.status==="completed" ? <button className="asset-button small" onClick={()=>void execute(async()=>{const result=await assetApi<{asset:Asset}>("get_asset",{id:job.assetId});setSelected(result.asset);setView("library");})}>에셋 보기</button> : job.status==="cancelled" ? <button className="asset-button small" disabled={busy} onClick={()=>void execute(()=>updateJob(job,"queued"))}>다시 대기</button> : <><button className="asset-icon-button" disabled={busy} aria-label={`${job.spec.title} 요청 보내기`} onClick={()=>void execute(()=>sendJobs([job]))}><Send size={16}/></button><button className="asset-icon-button" disabled={busy} aria-label={`${job.spec.title} 요청 복사`} onClick={()=>void execute(()=>copyJobs([job]))}><Copy size={16}/></button><button className="asset-button small" disabled={busy} onClick={()=>void execute(()=>importFiles(job))}>파일 연결</button><button className="asset-icon-button" disabled={busy} aria-label={`${job.spec.title} 요청 취소`} onClick={()=>void execute(()=>updateJob(job,"cancelled"))}><X size={16}/></button></>}</div></article>)}</div>}
      {snapshot && snapshot.jobTotal>snapshot.jobs.length && <p className="asset-inline-note">최근 {snapshot.jobs.length}개 작업을 표시합니다. 전체 저장 이력은 {snapshot.jobTotal}개입니다.</p>}
    </div>}
  </section>;
}
