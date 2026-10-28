// The workflows this runtime ships. Add a workflow here with defineWorkflow-style specs.
import { buildGraph } from "../graph/build.js";
import { buildOpsTriage, buildWeeklyContent } from "./hub.js";
import { buildVideoProduction } from "./production.js";
import { WorkflowRegistry } from "./workflow.js";

export function defaultWorkflows(): WorkflowRegistry {
  const registry = new WorkflowRegistry();
  registry.define({
    id: "coding",
    label: "코드 작업",
    description: "Supervisor가 Frontend·Backend Expert에게 나눠 맡기고 QA가 빌드·테스트로 검증합니다.",
    needsProject: true,
    build: ctx => buildGraph(ctx),
  });
  registry.define({
    id: "weekly-content",
    label: "주간 콘텐츠 초안",
    description: "채널·트렌드·이번 주 일정으로 SNS 초안을 쓰고, 규칙 검사를 통과한 초안만 승인받아 콘텐츠 플래너에 저장합니다.",
    needsProject: false,
    build: ctx => buildWeeklyContent(ctx),
  });
  registry.define({
    id: "ops-triage",
    label: "운영 점검",
    description: "운영 상태의 실패·이상 항목을 우선순위대로 정리하고, 승인한 항목만 일정·작업에 엽니다.",
    needsProject: false,
    build: ctx => buildOpsTriage(ctx),
  });
  registry.define({
    id: "video-production",
    label: "영상 스토리보드",
    description: "주제·길이·비율·스타일로 장면별 대본·나레이션·영상 프롬프트를 쓰고, 규칙 검사를 통과한 스토리보드만 돌려줍니다. 승인은 영상 제작 화면에서 합니다.",
    needsProject: false,
    build: ctx => buildVideoProduction(ctx),
  });
  return registry;
}
