import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { DEVDAY_2026_SCENES } from "../lib/video/devday-2026";
import type { VideoProject, VideoScene } from "../lib/video/types";

// Inputs are the tracked source WAVs, never a previously produced video.
// New long-form narration is deliberately not represented as synthesized audio.
const output = path.resolve(".toris-studio/devday");
await mkdir(output, { recursive: true });
await mkdir("public/generated/devday", { recursive: true });
const recap = "https://openai.com/index/devday-2026-recap/";
const dots = "https://openai.com/index/introducing-dots/";
const sol = "https://openai.com/index/introducing-gpt-6-1-sol/";
const cloud = "https://learn.chatgpt.com/docs/cloud";
const updated = "2026-10-01T00:00:00.000Z";
const manifest: Array<Record<string, unknown>> = [];

function captions(text: string, duration: number) {
  const chunks: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && (line + " " + word).length > 22) { chunks.push(line); line = ""; }
    line = line ? line + " " + word : word;
  }
  if (line) chunks.push(line);
  const total = chunks.reduce((sum, item) => sum + item.length, 0);
  let cursor = 0;
  return chunks.map(text => {
    const startSec = cursor;
    cursor += duration * text.length / total;
    return { startSec, endSec: cursor, text };
  });
}

const bodies: Record<string, string> = {
  hook: "발표 사실과 해석을 나눠 보는 5가지 변화 · 2026.10.01 확인",
  dots: "공식 발표: Astra 기반 · 전용 클라우드 컴퓨터\n이용 가능 지역·플랜·관리자 설정 확인",
  sol: "Sol 표준 API / 100만 토큰: 입력 $2 · 출력 $10\nAstra Ultrafast: Codex 토큰 생성 최대 8×\n전체 작업 속도 보장 아님 · Sol Ultrafast는 출시 예정",
  codex: "Cloud Codex: 재사용 가능한 개발 환경\nAgents API: 호스팅 브라우저의 computer use\n개인 PC를 무조건 제어하는 기능이 아님",
  mcp: "연결 앱의 지원 이벤트 → 자동화\nMCP Events는 제안된 사양 · 지원 범위 확인",
  space: "Space·Pages: 공유 맥락과 문서 협업\n‘작업 시스템으로의 변화’는 Toris의 해석"
};

const shortScenes: VideoScene[] = [];
for (const [index, scene] of DEVDAY_2026_SCENES.entries()) {
  const input = `public/devday-2026/audio/${scene.id}.wav`;
  const audio = `public/generated/devday/${scene.id}.wav`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", input, "-af", "loudnorm=I=-16:TP=-1.5:LRA=9", "-ar", "48000", audio]);
  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audio], { encoding: "utf8" }).trim());
  manifest.push({ input, sha256: createHash("sha256").update(await readFile(input)).digest("hex"), duration, provenance: "Tracked WAV from ae3d38d; documented upstream as Qwen3-TTS MLX/Sohee. Not synthesized in Linux." });
  shortScenes.push({
    id: scene.id, eyebrow: scene.kicker, headline: scene.title.replace(/\n/g, " "),
    body: bodies[scene.id], narration: scene.narration,
    durationSec: Math.ceil((duration + 0.2) * 30) / 30,
    sourceUrl: scene.id === "dots" ? dots : scene.id === "sol" ? sol : recap,
    sourceLabel: index === 0 || scene.id === "space" ? "TORIS 해석 · 공식 발표 참고" : "OpenAI 발표 · 2026.09.29",
    mediaType: "image", mediaUrl: scene.asset, mediaFit: "contain",
    audioPath: `/generated/devday/${scene.id}.wav`,
    captionCues: captions(scene.narration, duration),
    accent: scene.accent, role: index === 0 ? "hook" : "point", layout: "split"
  });
}

const detailData = [
  ["context", "모델보다 작업 흐름을 보세요", "질문 → 답변에서\n목표 → 실행 → 검토로", "이번 발표를 하나의 흐름으로 읽으면, 답변을 받는 일에서 업무를 맡기고 검토하는 일로 무게가 옮겨갑니다. 이것은 발표를 종합한 토리스의 해석입니다. 모든 업무가 자동으로 해결된다는 뜻은 아닙니다.", recap, "TORIS 해석", "hero"],
  ["boundaries", "상시 에이전트에도 경계가 있습니다", "연결 앱의 권한 · 행동 검토 · 사람의 확인\n첫 Dot 포함 ≠ 깊은 작업 무제한", "닷은 연결된 앱과 권한 안에서 움직입니다. 공식 문서는 중요한 결과를 검토하라고 안내합니다. 첫 닷이 플랜에 포함된다는 설명과, 코덱스나 워크 작업이 사용량에 집계된다는 조건을 함께 봐야 합니다.", dots, "OpenAI 공식 조건", "split"],
  ["pricing", "가격과 속도는 따로 비교하세요", "Sol: $2 / $0.10 / $10 · 100만 토큰\n입력 / 캐시 입력 / 출력\nAstra Ultrafast: 별도 속도 등급", "솔의 표준 에이피아이 요금은 백만 토큰 기준 입력 이 달러, 캐시 입력 십 센트, 출력 십 달러입니다. 울트라패스트의 배수는 토큰 생성 속도입니다. 도구 대기와 검토 시간을 포함한 전체 작업이 같은 배수로 빨라진다는 뜻은 아닙니다.", sol, "공식 가격 · 속도 해석 구분", "split"],
  ["studio", "이 영상도 클라우드에서 조립합니다", "Toris Studio 실제 편집 화면\n프로젝트 JSON → 미리보기 → MP4\nOpenAI 제품 시연 화면이 아닙니다", "지금 보이는 것은 토리스 스튜디오의 실제 편집 화면입니다. 같은 프로젝트 데이터를 저장하고, 리모션 미리보기와 영상 렌더에 사용합니다. 클라우드 개발 환경을 영상 제작에 적용한 이번 작업의 예시입니다. 오픈에이아이 제품 화면은 아닙니다.", "https://github.com/torisKR/toris-studio", "Toris Studio 실제 화면", "media-focus"],
  ["events", "자동화는 시작 조건부터 정하세요", "어떤 이벤트인가? → 어떤 자료인가?\n어떤 결과인가? → 누가 검토하는가?", "이벤트 자동화를 설계할 때는 시작 조건과 결과물, 검토자를 먼저 정하는 편이 좋습니다. 예를 들어 새 기획서가 들어오면 출처를 모으고 영상 대본 초안을 만드는 식입니다. 이 예시는 토리스의 활용 제안이며, 모든 앱의 모든 이벤트가 지원된다는 뜻은 아닙니다.", recap, "TORIS 활용 제안", "split"],
  ["action", "작은 업무 하나로 검증하세요", "같은 업무의 시간·오류·비용을 기록\n출시 예정과 현재 제공을 구분\n중요한 결과는 사람이 검토", "처음부터 모든 일을 맡기기보다 반복되는 작은 업무 하나를 골라 보세요. 기존 방식과 비교해 걸린 시간, 수정 횟수, 실제 비용을 기록하면 도움이 됩니다. 협업 슬라이드처럼 출시 예정인 항목과 지금 제공되는 기능도 구분해야 합니다. 계정별 이용 조건은 실행 전에 확인하세요.", recap, "TORIS 제안 · 출시 조건 확인", "action-card"]
] as const;

const longScenes: VideoScene[] = [];
for (let index = 0; index < shortScenes.length; index++) {
  longScenes.push({ ...shortScenes[index], id: `intro-${shortScenes[index].id}` });
  const [id, headline, body, narration, sourceUrl, sourceLabel, layout] = detailData[index];
  longScenes.push({
    id, headline, body, narration, sourceUrl, sourceLabel,
    eyebrow: "롱폼 편집 검토본 · 새 내레이션 대기",
    durationSec: 22, layout, role: id === "action" ? "action" : "proof",
    mediaType: "image", mediaFit: "contain",
    mediaUrl: id === "studio" ? "/generated/devday/studio-screen.png" : shortScenes[index].mediaUrl,
    accent: shortScenes[index].accent,
    captionCues: captions(narration, 22)
  });
}

for (const [format, id, title, scenes] of [
  ["shorts", "b2150d8a-f2ec-4be4-bfa9-0981c63b9c01", "DevDay 2026 · 핵심 5가지", shortScenes],
  ["vertical", "b2150d8a-f2ec-4be4-bfa9-0981c63b9c02", "DevDay 2026 · 릴스", shortScenes],
  ["youtube-landscape", "b2150d8a-f2ec-4be4-bfa9-0981c63b9c03", "DevDay 2026 · 롱폼 편집 검토본", longScenes]
] as const) {
  const project: VideoProject = { id, title, format, template: "reference-briefing", language: "ko", subtitle: "공식 자료 확인: 2026-10-01 · 사실과 해석 구분", scenes, createdAt: updated, updatedAt: updated };
  await writeFile(path.join(output, `${format}.json`), JSON.stringify(project, null, 2));
  let offset = 0;
  let cueIndex = 0;
  const timestamp = (seconds: number) => {
    const ms = Math.round(seconds * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  const subtitleBlocks: string[] = [];
  for (const scene of scenes) {
    for (const cue of scene.captionCues ?? []) {
      subtitleBlocks.push(`${++cueIndex}\n${timestamp(offset + cue.startSec)} --> ${timestamp(offset + cue.endSec)}\n${cue.text}\n`);
    }
    offset += Math.round(scene.durationSec * 30) / 30;
  }
  await writeFile(path.join(output, `${format}.srt`), subtitleBlocks.join("\n"));
  console.log(`${format}: ${scenes.reduce((sum, scene) => sum + scene.durationSec, 0).toFixed(2)}s`);
}
await writeFile(path.join(output, "input-manifest.json"), JSON.stringify({ checkedAt: updated, sources: [recap, dots, sol, cloud], audio: manifest, limitations: ["Long-form added scenes have no audio until local TTS or supplied narration is available.", "Caption timings are text-weighted estimates, not forced alignment.", "Official product screenshots unavailable; graphics are authored illustrations, Studio screenshot is this project."] }, null, 2));
