import type { VideoProject } from "./types";

export type QualityCheck = {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
  weight: number;
};

export type VideoQualityReport = {
  score: number;
  grade: "A" | "B" | "C" | "D";
  durationSec: number;
  mediaCoverage: number;
  sourceCoverage: number;
  checks: QualityCheck[];
};

function ratio(count: number, total: number) {
  return total > 0 ? count / total : 0;
}

export function evaluateVideoQuality(project: VideoProject): VideoQualityReport {
  const scenes = project.scenes;
  const durationSec = scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
  const mediaCoverage = ratio(
    scenes.filter((scene) => scene.mediaType && scene.mediaType !== "none" && scene.mediaUrl).length,
    scenes.length
  );
  const sourceCoverage = ratio(
    scenes.filter((scene) => Boolean(scene.sourceUrl)).length,
    scenes.filter((scene) => !["hook", "action", "outro"].includes(scene.role ?? "")).length
  );

  const first = scenes[0];
  const layouts = new Set(scenes.map((scene) => scene.layout).filter(Boolean));
  const narrationDensity = scenes.map((scene) => ({
    id: scene.id,
    value: scene.narration.replace(/\s+/g, "").length / Math.max(1, scene.durationSec)
  }));
  const denseScenes = narrationDensity.filter(({ value }) => value > 9.5);
  const sparseScenes = narrationDensity.filter(({ value }) => value < 2.2);

  const checks: QualityCheck[] = [
    {
      id: "hook",
      label: "8초 이내 Hook",
      passed: Boolean(first && first.durationSec <= 8 && first.headline.length <= 42),
      detail: first
        ? `첫 장면 ${first.durationSec}초 · 헤드라인 ${first.headline.length}자`
        : "첫 장면이 없습니다.",
      weight: 18
    },
    {
      id: "visual-variety",
      label: "레이아웃 변화",
      passed: layouts.size >= Math.min(4, scenes.length),
      detail: `${layouts.size}개 레이아웃 사용`,
      weight: 14
    },
    {
      id: "media",
      label: "실제 화면/B-roll 비중",
      passed: mediaCoverage >= 0.5 || project.format === "shorts" && mediaCoverage >= 0.25,
      detail: `${Math.round(mediaCoverage * 100)}% 장면에 실제 미디어 연결`,
      weight: 18
    },
    {
      id: "sources",
      label: "근거 장면 출처",
      passed: sourceCoverage >= 0.6,
      detail: `${Math.round(sourceCoverage * 100)}% 근거 장면에 sourceUrl 연결`,
      weight: 16
    },
    {
      id: "narration-density",
      label: "내레이션 속도",
      passed: denseScenes.length === 0 && sparseScenes.length === 0,
      detail:
        denseScenes.length || sparseScenes.length
          ? `빠름 ${denseScenes.length}개 · 느림 ${sparseScenes.length}개`
          : "장면 길이 대비 대본 밀도가 안정적",
      weight: 14
    },
    {
      id: "structure",
      label: "Hook → 근거 → 반응 → Action 구조",
      passed:
        scenes.some((scene) => scene.role === "hook") &&
        scenes.some((scene) => ["point", "proof"].includes(scene.role ?? "")) &&
        scenes.some((scene) => scene.role === "reaction") &&
        scenes.some((scene) => scene.role === "action"),
      detail: "리서치형 브리핑의 핵심 서사 구조",
      weight: 12
    },
    {
      id: "duration",
      label: "포맷 길이",
      passed:
        project.format === "shorts"
          ? durationSec <= 60
          : durationSec >= 45 && durationSec <= 720,
      detail: `총 ${Math.round(durationSec)}초`,
      weight: 8
    }
  ];

  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const score = Math.round(
    checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0) /
      totalWeight *
      100
  );
  const grade = score >= 90 ? "A" : score >= 78 ? "B" : score >= 65 ? "C" : "D";

  return {
    score,
    grade,
    durationSec,
    mediaCoverage,
    sourceCoverage,
    checks
  };
}
