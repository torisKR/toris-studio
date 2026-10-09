import React, { useId } from "react";
import type { AssetSpec } from "./contracts";
import { applyPreset, availableFormats, changeOutputSize, PRESETS, PRESET_GROUPS, selectedPreset } from "./presets";

const formatLabels={png:"PNG",jpeg:"JPEG",webp:"WebP",ico:"ICO · 실제 아이콘 파일"};
export function ImageOutputControls({spec,onChange,showQuantity=true}: {
  spec:AssetSpec;onChange:(next:AssetSpec)=>void;showQuantity?:boolean;
}) {
  const id=useId();
  const preset=selectedPreset(spec);
  const opaque=preset?.alpha==="opaque" || spec.format==="jpeg";
  const solid=opaque || spec.backgroundMode==="solid";
  const color=spec.backgroundColor ?? "#ffffff";
  return <div className="asset-output-controls">
    <label className="asset-field" htmlFor={`${id}-preset`}>출력 규격 프리셋
      <select id={`${id}-preset`} aria-label="출력 규격 프리셋" value={spec.presetId ?? "custom"} onChange={e=>onChange(applyPreset(spec,e.target.value))}>
        <option value="custom">사용자 지정 · 크기 직접 입력</option>
        {PRESET_GROUPS.map(group=><optgroup key={group.id} label={group.label}>
          {PRESETS.filter(p=>p.group===group.id).map(p=><option key={p.id} value={p.id}>{p.size[0]} × {p.size[1]} · {p.label}</option>)}
        </optgroup>)}
      </select>
    </label>
    <p className="asset-preset-note" aria-live="polite">{preset?.note ?? "가로·세로를 직접 입력하세요. 프리셋 선택 후 크기를 수정하면 사용자 지정으로 전환됩니다."}</p>
    <div className={`asset-field-grid${showQuantity?" three":""}`}>
      <label className="asset-field">가로 (px)<input aria-label="가로 (px)" type="number" min={16} max={8192} required value={spec.width} onChange={e=>onChange(changeOutputSize(spec,"width",Number(e.target.value)))}/></label>
      <label className="asset-field">세로 (px)<input aria-label="세로 (px)" type="number" min={16} max={8192} required value={spec.height} onChange={e=>onChange(changeOutputSize(spec,"height",Number(e.target.value)))}/></label>
      {showQuantity && <label className="asset-field">요청 수량<input aria-label="요청 수량" type="number" min={1} max={100} required value={spec.quantity} onChange={e=>onChange({...spec,quantity:Number(e.target.value)})}/></label>}
    </div>
    <div className="asset-field-grid">
      <label className="asset-field">출력 형식<select aria-label="출력 형식" value={spec.format} onChange={e=>onChange({...spec,format:e.target.value as AssetSpec["format"]})}>{availableFormats(spec).map(format=><option key={format} value={format}>{formatLabels[format]}</option>)}</select></label>
      <label className="asset-field">규격 맞춤<select aria-label="규격 맞춤" value={spec.fit} onChange={e=>onChange({...spec,fit:e.target.value as AssetSpec["fit"]})}><option value="contain">전체 보존 · 여백 추가</option><option value="cover">화면 채움 · 중앙 자르기</option></select></label>
    </div>
    <div className="asset-field-grid">
      <label className="asset-field">배경 처리<select aria-label="배경 처리" disabled={opaque} value={solid?"solid":"transparent"} onChange={e=>onChange({...spec,backgroundMode:e.target.value as AssetSpec["backgroundMode"]})}><option value="transparent">투명 배경 유지</option><option value="solid">지정 색상으로 합성</option></select></label>
      <label className="asset-field">배경색<span className="asset-color-control"><input aria-label="배경색 선택" type="color" disabled={!solid} value={/^#[0-9a-fA-F]{6}$/.test(color)?color:"#ffffff"} onChange={e=>onChange({...spec,backgroundColor:e.target.value})}/><input aria-label="배경색 HEX" type="text" value={color} disabled={!solid} maxLength={7} pattern="#[0-9a-fA-F]{6}" onChange={e=>onChange({...spec,backgroundColor:e.target.value})}/></span></label>
    </div>
    <p className="asset-inline-note">{preset?.alpha==="opaque" ? "투명 영역과 여백은 배경색에 합성합니다. PNG는 알파 채널 없는 RGB 24비트로 저장합니다." : preset?.alpha==="rgba" ? "앱 아이콘은 배경 처리와 관계없이 RGBA 32비트 PNG로 저장합니다." : spec.format==="ico" ? "선택한 크기 하나를 포함하는 ICO입니다. 16~256px 정사각형만 지원합니다." : "투명한 원본도 보존됩니다. 배경색 합성은 새 출력 파일에만 적용됩니다."}</p>
  </div>;
}
