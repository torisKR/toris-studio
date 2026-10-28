import type { EngineInfo, EngineStatus, ProductionAspect, ProductionInput, ProductionQuality, Size, Storyboard } from "./production-client";

export const DURATION_PRESETS = [15, 30, 60] as const;
export type DurationChoice = (typeof DURATION_PRESETS)[number] | "custom";
export const CUSTOM_MIN = 10, CUSTOM_MAX = 120;

export const ASPECTS: Record<ProductionAspect, string> = { "9:16": "9:16 세로", "16:9": "16:9 가로", "1:1": "1:1 정사각" };
export const STYLES = { realistic: "실사", cinematic: "시네마틱", animation: "애니메이션", documentary: "다큐멘터리" } as const;
export const QUALITIES: Record<ProductionQuality, string> = { preview: "미리보기", standard: "표준", high: "고화질" };
export const SUBTITLES = { "shorts-bold": "쇼츠 굵은 자막", "clean-bottom": "하단 깔끔한 자막", none: "자막 없음" } as const;
export const BGMS = { none: "없음", ambient: "잔잔한 앰비언트", pulse: "리듬감 있는 펄스" } as const;
const QUALITY_SPEC: Record<ProductionQuality, { frames: number; steps: number; long: number; short: number }> = {
  preview: { frames: 33, steps: 20, long: 640, short: 368 },
  standard: { frames: 49, steps: 30, long: 832, short: 480 },
  high: { frames: 81, steps: 50, long: 832, short: 480 }
};

/** AI generation size per the contract (1:1 always 480×480). */
export function generationSize(aspect: ProductionAspect, quality: ProductionQuality): Size & { frames: number; steps: number } {
  const spec = QUALITY_SPEC[quality];
  const base = aspect === "1:1" ? { width: 480, height: 480 } : aspect === "16:9" ? { width: spec.long, height: spec.short } : { width: spec.short, height: spec.long };
  return { ...base, frames: spec.frames, steps: spec.steps };
}
export function outputSize(aspect: ProductionAspect): Size {
  return aspect === "16:9" ? { width: 1920, height: 1080 } : aspect === "1:1" ? { width: 1080, height: 1080 } : { width: 1080, height: 1920 };
}
export const sizeText = (size: Size) => size.width + "×" + size.height;
export const sceneCount = (durationSec: number) => Math.min(12, Math.max(2, Math.ceil(durationSec / 5)));

export type ComposerState = {
  topic: string; duration: DurationChoice; customSec: string; aspect: ProductionAspect; style: ProductionInput["style"];
  narration: boolean; speaker: string; subtitleStyle: ProductionInput["subtitleStyle"]; bgm: ProductionInput["bgm"];
  quality: ProductionQuality; engine: string;
};
export const initialComposer: ComposerState = {
  topic: "", duration: 30, customSec: "45", aspect: "9:16", style: "cinematic", narration: true, speaker: "Sohee",
  subtitleStyle: "shorts-bold", bgm: "none", quality: "preview", engine: ""
};

export function durationOf(state: ComposerState): number | null {
  if (state.duration !== "custom") return state.duration;
  const value = Number(state.customSec);
  return Number.isInteger(value) && value >= CUSTOM_MIN && value <= CUSTOM_MAX ? value : null;
}

export function usableEngine(engine: EngineInfo | undefined) { return !!engine && engine.supported && engine.enabled; }

/** Why "영상 생성" cannot run yet, or null when it can. */
export function composerProblem(state: ComposerState, status: EngineStatus | null): string | null {
  if (!state.topic.trim()) return "영상 주제를 입력하세요.";
  if (durationOf(state) === null) return "직접 길이는 " + CUSTOM_MIN + "~" + CUSTOM_MAX + "초 사이의 정수로 정하세요.";
  if (!status) return "영상 엔진 상태를 확인하는 중입니다.";
  const engine = status.engines.find(item => item.id === state.engine);
  if (!engine) return "사용할 수 있는 영상 엔진이 없습니다.";
  if (!usableEngine(engine)) return engine.reason ?? "이 엔진은 아직 사용할 수 없습니다.";
  if (!engine.installed) return "영상 엔진을 먼저 설치하세요.";
  if (status.ffmpegReady === false) return "FFmpeg가 없어 편집 단계를 실행할 수 없습니다. 설정에서 미디어 런타임을 확인하세요.";
  return null;
}

export function composerInput(state: ComposerState): ProductionInput {
  const durationSec = durationOf(state);
  if (durationSec === null) throw new Error("영상 길이를 확인하세요.");
  return {
    topic: state.topic.trim(), durationSec, aspect: state.aspect, style: state.style, narration: state.narration,
    subtitleStyle: state.subtitleStyle, bgm: state.bgm, quality: state.quality, engine: state.engine,
    ...(state.narration ? { speaker: state.speaker } : {})
  };
}

export const PROMPT_MAX = 600;
export function storyboardProblem(storyboard: Storyboard): string | null {
  if (!storyboard.title.trim()) return "영상 제목을 입력하세요.";
  for (const scene of storyboard.scenes) {
    if (!Number.isFinite(scene.durationSec) || scene.durationSec < 2 || scene.durationSec > 12) return "장면 " + scene.order + "의 길이는 2~12초입니다.";
    if (!scene.prompt.trim()) return "장면 " + scene.order + "의 영상 프롬프트를 입력하세요.";
    if (scene.prompt.length > PROMPT_MAX) return "장면 " + scene.order + "의 영상 프롬프트는 " + PROMPT_MAX + "자 이하로 줄이세요.";
  }
  return null;
}

export const JOB_STATUS_LABELS = {
  planning: "기획 중", awaiting_approval: "스토리보드 확인 대기", running: "생성 중", paused: "일시정지",
  failed: "실패", cancelled: "취소됨", done: "완료"
} as const;
export const ASSET_STATUS_LABELS = { pending: "대기", running: "생성 중", done: "완료", failed: "실패", stale: "다시 필요", waiting: "확인 대기" } as const;

export function shortDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "날짜 없음" : new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "요청을 처리하지 못했습니다.";
}

