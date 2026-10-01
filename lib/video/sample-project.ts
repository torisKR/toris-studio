import { createReferenceBriefingProject } from "./templates";
import type { VideoProject } from "./types";

export function createSampleProject(): VideoProject {
  const project = createReferenceBriefingProject("youtube-landscape");

  return {
    ...project,
    id: "00000000-0000-4000-8000-000000000001",
    title: "자는 동안 일하는 AI, 왜 반응이 갈렸을까?",
    subtitle: "공식 발표·실사용 반응·비용 조건을 분리해서 보는 리서치형 브리핑"
  };
}
