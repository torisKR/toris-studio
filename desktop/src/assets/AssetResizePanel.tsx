import { useState } from "react";
import { ArrowLeft, FolderOpen, Save } from "lucide-react";
import { AssetThumbnail } from "./AssetInspector";
import { ImageOutputControls } from "./ImageOutputControls";
import { defaultSpec } from "./contracts";
import type { Asset, AssetSnapshot, AssetSpec } from "./contracts";

export function AssetResizePanel({source,settings,busy,onCancel,onExport,onChooseFolder}: {
  source:Asset;settings:AssetSnapshot["settings"]|undefined;busy:boolean;
  onCancel:()=>void;onExport:(spec:AssetSpec)=>void;onChooseFolder:(purpose:AssetSpec["purpose"])=>void;
}) {
  const [spec,setSpec]=useState<AssetSpec>(()=>({...defaultSpec,...source.spec,title:`${source.title.slice(0,100)}_변환`,quantity:1}));
  const destination=settings?.[spec.purpose==="video"?"videoRoot":"projectRoot"];
  return <section className="asset-resize-panel" aria-label="크기 변경·내보내기">
    <div className="asset-section-heading"><div><h2>크기 변경·내보내기</h2><p>보존된 원본에서 새 파일을 만듭니다. 기존 에셋은 그대로 유지됩니다.</p></div><button type="button" className="asset-button" disabled={busy} onClick={onCancel}><ArrowLeft size={16}/>보관함으로 돌아가기</button></div>
    <div className="asset-resize-layout">
      <aside className="asset-resize-source"><AssetThumbnail asset={source} large/><h3>{source.title}</h3><p className="asset-inline-note">기존 출력 미리보기 · 변환에는 보존 원본 사용</p><dl className="asset-facts"><dt>원본 규격</dt><dd>{source.details.originalWidth ?? "확인 전"} × {source.details.originalHeight ?? "확인 전"} px</dd><dt>기존 출력</dt><dd>{source.details.width} × {source.details.height} px</dd></dl><p className="asset-inline-note">작게 줄였거나 잘라낸 변환본을 다시 내보내도 보존 원본을 읽습니다. 원본에 없는 디테일을 생성하거나 스크린샷을 새로 촬영하지 않습니다.</p></aside>
      <form className="asset-create-form" onSubmit={event=>{event.preventDefault();onExport({...spec,quantity:1});}}>
        <fieldset disabled={busy}>
          <div className="asset-field-grid"><label className="asset-field">새 에셋 이름<input aria-label="새 에셋 이름" required maxLength={120} value={spec.title} onChange={e=>setSpec({...spec,title:e.target.value})}/></label><label className="asset-field">프로젝트<input aria-label="내보내기 프로젝트" required maxLength={120} value={spec.project} onChange={e=>setSpec({...spec,project:e.target.value})}/></label></div>
          <label className="asset-field">저장 용도<select aria-label="저장 용도" value={spec.purpose} onChange={e=>setSpec({...spec,purpose:e.target.value as AssetSpec["purpose"]})}><option value="video">영상 제작용</option><option value="project">프로젝트 에셋</option></select></label>
          <ImageOutputControls spec={spec} onChange={setSpec} showQuantity={false}/>
          <div className="asset-folder asset-resize-folder"><div><span>저장 폴더 · 프로젝트/에셋별 하위 폴더 생성</span><code title={destination}>{destination ?? "저장 폴더 확인 중…"}</code></div><button className="asset-icon-button" type="button" aria-label="내보내기 저장 폴더 선택" onClick={()=>onChooseFolder(spec.purpose)}><FolderOpen size={19}/></button></div>
          <div className="asset-submit-row"><span>{spec.width} × {spec.height} px · {spec.format.toUpperCase()}</span><button type="submit" className="asset-button primary" disabled={busy||!settings}><Save size={17}/>{busy?"변환·저장 중…":"새 파일로 내보내기"}</button></div>
        </fieldset>
      </form>
    </div>
  </section>;
}
