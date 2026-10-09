import { invoke } from "@tauri-apps/api/core";
import { lazy, Suspense, useEffect, useState } from "react";
import { Box, Copy, FolderOpen, Image as ImageIcon, SlidersHorizontal, Star, X } from "lucide-react";
import { assetApi, assetError } from "./transport";
import { formatBytes, SOURCE_LABELS } from "./contracts";
import type { Asset } from "./contracts";
import { selectedPreset } from "./presets";
const ModelPreview = lazy(() => import("./ModelPreview"));

export function AssetThumbnail({ asset, large = false }: { asset: Asset; large?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true; setUrl(null); setFailed(false);
    if (asset.kind === "image") void assetApi<{dataUrl:string}>("thumbnail",{id:asset.id})
      .then(data=>{if(active) setUrl(data.dataUrl);}).catch(()=>{if(active) setFailed(true);});
    return ()=>{active=false;};
  },[asset.id,asset.kind]);
  return <div className={`asset-thumbnail${large ? " large" : ""}`}>
    {url ? <img src={url} alt={large ? asset.title : ""} loading="lazy" /> : asset.kind === "model3d" ? <><Box size={large ? 48 : 32} /><span>{asset.format.toUpperCase()}</span></> : <><ImageIcon size={28}/><span>{failed ? "파일 확인 필요" : "미리보기 준비"}</span></>}
  </div>;
}

export function AssetInspector({ asset, onClose, onChanged, onError, onReuse, onResize }: {
  asset: Asset; onClose:()=>void; onChanged:()=>void; onError:(error:string)=>void; onReuse:(asset:Asset)=>void; onResize:(asset:Asset)=>void;
}) {
  const [tags,setTags]=useState(asset.tags.join(", "));
  const [busy,setBusy]=useState(false);
  const [copied,setCopied]=useState(false);
  useEffect(()=>{setTags(asset.tags.join(", "));setCopied(false);},[asset.id]);
  async function update(patch:object) {
    setBusy(true);
    try {await assetApi("update_asset",{id:asset.id,...patch});onChanged();}
    catch(error){onError(assetError(error));}finally{setBusy(false);}
  }
  return <aside className="asset-inspector" aria-label="선택한 에셋 상세">
    <header><div><span>{asset.kind==="image" ? "이미지 에셋" : "3D 에셋"}</span><h2>{asset.title}</h2></div><button className="asset-icon-button" onClick={onClose} aria-label="에셋 상세 닫기"><X size={19}/></button></header>
    {asset.kind==="model3d" ? <Suspense fallback={<p className="asset-inline-note">3D 뷰어 준비 중…</p>}><ModelPreview asset={asset}/></Suspense> : <AssetThumbnail asset={asset} large/>}
    <div className="asset-inspector-body">
      <div className="asset-row"><span className={`asset-purpose ${asset.purpose}`}>{asset.purpose==="video" ? "영상 제작" : "프로젝트 에셋"}</span><button className="asset-icon-button" aria-label={asset.favorite ? "즐겨찾기 해제" : "즐겨찾기 등록"} aria-pressed={asset.favorite} disabled={busy} onClick={()=>void update({favorite:!asset.favorite})}><Star size={18} fill={asset.favorite ? "currentColor" : "none"}/></button></div>
      <dl className="asset-facts"><dt>프로젝트</dt><dd>{asset.project}</dd><dt>파일 형식</dt><dd>{asset.format.toUpperCase()}</dd><dt>{asset.kind==="image" ? "출력 규격" : "메시 정보"}</dt><dd>{asset.kind==="image" ? `${asset.details.width} × ${asset.details.height} px` : `${asset.details.triangles?.toLocaleString()} 삼각형`}</dd><dt>원본 크기</dt><dd>{formatBytes(asset.bytes)}</dd>{asset.details.outputBytes !== undefined && <><dt>출력 크기</dt><dd>{formatBytes(asset.details.outputBytes)}</dd></>}{asset.kind==="image" && selectedPreset(asset.spec) && <><dt>프리셋</dt><dd>{selectedPreset(asset.spec)?.label}</dd></>}{asset.details.hasAlphaChannel !== undefined && <><dt>알파 채널</dt><dd>{asset.details.hasAlphaChannel ? "포함" : "없음"}</dd></>}<dt>출처</dt><dd>{SOURCE_LABELS[asset.source] ?? asset.source}</dd><dt>저장 일시</dt><dd>{new Date(asset.createdAt).toLocaleString("ko-KR",{timeZone:"Asia/Seoul"})}</dd></dl>
      {asset.details.upscaled && <p className="asset-warning">원본보다 확대된 파일입니다. 픽셀 크기는 맞지만 디테일이 새로 생성되지는 않습니다.</p>}
      <label className="asset-field">검토 상태<select aria-label="검토 상태" value={asset.review} disabled={busy} onChange={event=>void update({review:event.target.value})}><option value="pending">검토 전</option><option value="approved">사용 승인</option><option value="rejected">보류</option></select></label>
      <form onSubmit={event=>{event.preventDefault();void update({tags:tags.split(",").map(t=>t.trim()).filter(Boolean)});}}><label className="asset-field">태그<input value={tags} onChange={event=>setTags(event.target.value)} placeholder="배경, 캐릭터, UI" maxLength={1300}/></label><button className="asset-button small" disabled={busy} type="submit">태그 저장</button></form>
      <details className="asset-details" open={Boolean(asset.prompt)}><summary>프롬프트와 파일 경로</summary><p>{asset.prompt || "프롬프트가 없는 가져온 파일입니다."}</p><small>출력 파일</small><code>{asset.outputPath}</code><small>보존된 원본</small><code>{asset.originalPath}</code></details>
      <div className="asset-inspector-actions">{asset.kind==="image" && <button className="asset-button primary" disabled={busy} onClick={()=>onResize(asset)}><SlidersHorizontal size={16}/>크기 변경·내보내기</button>}<button className="asset-button" onClick={()=>void invoke("asset_reveal",{id:asset.id}).catch(error=>onError(assetError(error)))}><FolderOpen size={16}/>파일 위치 열기</button><button className="asset-button" onClick={()=>void invoke("copy_text",{text:asset.outputPath}).then(()=>setCopied(true)).catch(error=>onError(assetError(error)))}><Copy size={16}/>{copied ? "경로 복사됨" : "경로 복사"}</button><button className="asset-button" onClick={()=>onReuse(asset)}>설정으로 새 요청 만들기</button></div>
    </div>
  </aside>;
}
