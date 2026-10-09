import catalog from "./preset-catalog.json";
import type { AssetSpec } from "./contracts";
export type ImageOutputFormat = "png" | "jpeg" | "webp" | "ico";
export type PresetGroup = "play" | "web" | "campaign" | "ads" | "video";
export type AssetPreset = {
  id: string; group: PresetGroup; label: string; size: readonly [number, number];
  formats: readonly ImageOutputFormat[]; alpha: "rgba" | "opaque" | "optional"; maxBytes?: number; note: string;
};
// The exact same catalog is compiled into the Rust validator. Never infer identity from dimensions.
export const PRESETS: readonly AssetPreset[] = catalog.map(p=>({
  ...p, group:p.group as PresetGroup, size:[p.size[0],p.size[1]],
  formats:p.formats as ImageOutputFormat[], alpha:p.alpha as AssetPreset["alpha"]
}));
export const PRESET_GROUPS: ReadonlyArray<{id: PresetGroup; label: string}> = [
  {id:"play",label:"Play 스토어"}, {id:"web",label:"웹 아이콘"},
  {id:"campaign",label:"앱 캠페인"}, {id:"ads",label:"AdMob·전면 광고"}, {id:"video",label:"기존 영상 규격"}
];
export function selectedPreset(spec: Pick<AssetSpec,"presetId">): AssetPreset | undefined {
  return PRESETS.find(p=>p.id===spec.presetId);
}
export function availableFormats(spec: Pick<AssetSpec,"presetId">): readonly ImageOutputFormat[] {
  return selectedPreset(spec)?.formats ?? ["png","jpeg","webp","ico"];
}
export function applyPreset(spec: AssetSpec, id: string): AssetSpec {
  if (id==="custom") return {...spec,presetId:"custom"};
  const preset=PRESETS.find(p=>p.id===id);
  if (!preset) throw new Error("등록되지 않은 프리셋입니다.");
  return {...spec,presetId:id,width:preset.size[0],height:preset.size[1],
    format:preset.formats.includes(spec.format) ? spec.format : preset.formats[0],
    backgroundMode:preset.alpha==="opaque" ? "solid" : spec.backgroundMode ?? "transparent",
    backgroundColor:spec.backgroundColor ?? "#ffffff"};
}
export function changeOutputSize(spec:AssetSpec,key:"width"|"height",value:number):AssetSpec {
  return {...spec,presetId:"custom",[key]:value};
}
export function outputValidationError(spec:AssetSpec):string {
  if (spec.presetId && spec.presetId!=="custom") {
    const preset=selectedPreset(spec);
    if (!preset) return "등록되지 않은 프리셋입니다. 사용자 지정 또는 다른 규격을 선택하세요.";
    if (spec.width!==preset.size[0] || spec.height!==preset.size[1]) return "선택한 프리셋의 픽셀 규격과 다릅니다. 사용자 지정으로 변경하세요.";
    if (!preset.formats.includes(spec.format)) return "선택한 프리셋에서 허용하지 않는 파일 형식입니다.";
  }
  if (!["png","jpeg","webp","ico"].includes(spec.format)) return "출력 형식을 확인하세요.";
  if (spec.format==="ico" && (spec.width!==spec.height || spec.width>256)) return "ICO는 16~256px 정사각형 규격을 선택하세요.";
  if (spec.backgroundColor!==undefined && !/^#[0-9a-fA-F]{6}$/.test(spec.backgroundColor)) return "배경색은 #RRGGBB 형식으로 입력하세요.";
  if (spec.backgroundMode!==undefined && !["transparent","solid"].includes(spec.backgroundMode)) return "배경 처리 방식을 확인하세요.";
  return "";
}
