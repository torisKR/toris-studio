import type {
  SceneLayout,
  SceneRole,
  VideoFormat,
  VideoProject,
  VideoScene,
  VideoTemplateId
} from "./types";

export type VideoTemplateDefinition = {
  id: VideoTemplateId;
  name: string;
  description: string;
  bestFor: string;
  formats: VideoFormat[];
  scenePattern: Array<{
    role: SceneRole;
    layout: SceneLayout;
    label: string;
    targetDurationSec: [number, number];
  }>;
};

export const VIDEO_TEMPLATES: Record<VideoTemplateId, VideoTemplateDefinition> = {
  "reference-briefing": {
    id: "reference-briefing",
    name: "Reference Briefing",
    description:
      "공식 자료·화면 캡처·사용자 반응을 빠르게 교차하는 리서치형 브리핑 템플릿",
    bestFor: "AI 뉴스, 제품 발표, 테크 이슈, 비교·리서치형 설명 영상",
    formats: ["youtube-landscape", "vertical", "shorts"],
    scenePattern: [
      { role: "hook", layout: "hero", label: "HOOK", targetDurationSec: [5, 8] },
      { role: "point", layout: "split", label: "KEY POINT", targetDurationSec: [10, 18] },
      { role: "proof", layout: "media-focus", label: "PROOF", targetDurationSec: [8, 16] },
      { role: "reaction", layout: "reaction-grid", label: "REACTIONS", targetDurationSec: [10, 18] },
      { role: "cost", layout: "split", label: "COST / CONDITION", targetDurationSec: [8, 16] },
      { role: "action", layout: "action-card", label: "ACTION", targetDurationSec: [8, 14] },
      { role: "outro", layout: "hero", label: "TAKEAWAY", targetDurationSec: [5, 10] }
    ]
  },
  "adaptive-promo": {
    id: "adaptive-promo",
    name: "Adaptive Promo",
    description:
      "서비스·앱·브랜드의 문제→해결→실제 화면→행동 흐름을 화면비와 길이에 맞춰 자동 재구성하는 홍보 템플릿",
    bestFor: "앱 홍보, SaaS 소개, 서비스 런칭, 제품 데모, 브랜드 쇼츠·롱폼",
    formats: ["youtube-landscape", "vertical", "shorts"],
    scenePattern: [
      { role: "hook", layout: "hero", label: "HOOK", targetDurationSec: [4, 8] },
      { role: "point", layout: "split", label: "PROBLEM / BENEFIT", targetDurationSec: [8, 24] },
      { role: "proof", layout: "media-focus", label: "PRODUCT", targetDurationSec: [8, 30] },
      { role: "reaction", layout: "reaction-grid", label: "PAYOFF", targetDurationSec: [8, 22] },
      { role: "action", layout: "action-card", label: "CTA", targetDurationSec: [6, 16] },
      { role: "outro", layout: "hero", label: "BRAND", targetDurationSec: [4, 10] }
    ]
  }
};

const COLORS: Record<SceneRole, string> = {
  hook: "#77E0B5",
  point: "#8AD8FF",
  proof: "#A78BFA",
  reaction: "#F8C76A",
  cost: "#FFB56B",
  action: "#FF9BA4",
  outro: "#77E0B5"
};

function scene(
  id: string,
  role: SceneRole,
  layout: SceneLayout,
  headline: string,
  body: string,
  narration: string,
  durationSec: number,
  sourceLabel: string,
  extra: Partial<VideoScene> = {}
): VideoScene {
  return {
    id,
    role,
    layout,
    eyebrow: sourceLabel,
    headline,
    body,
    narration,
    durationSec,
    sourceLabel,
    mediaType: "none",
    accent: COLORS[role],
    ...extra
  };
}

function project(
  template: VideoTemplateId,
  format: VideoFormat,
  title: string,
  subtitle: string,
  scenes: VideoScene[]
): VideoProject {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title,
    subtitle,
    format,
    template,
    language: "ko",
    scenes,
    createdAt: now,
    updatedAt: now
  };
}

export function createReferenceBriefingProject(
  format: VideoFormat = "youtube-landscape"
): VideoProject {
  const shorts = format === "shorts";

  const scenes = shorts
    ? [
        scene("hook", "hook", "hero", "이 발표, 좋은 기능보다 먼저 확인할 게 있습니다", "기능·가격·실사용 반응을 45초 안에 분리해서 봅니다.", "새 기능이 나왔다는 소식보다 중요한 건 실제로 내 일을 줄여주는지, 그리고 비용이 얼마인지입니다. 핵심만 빠르게 보겠습니다.", 7, "HOOK", { badge: "45 SEC" }),
        scene("point", "point", "split", "핵심은 ‘자동 실행’이 아니라 작업 연결입니다", "앞 단계 결과가 다음 단계 입력으로 이어질 때 자동화 가치가 커집니다.", "첫 번째 포인트입니다. 단순 예약 실행보다 중요한 건 앞 단계 결과를 다음 작업으로 연결하는 구조입니다.", 11, "01 · KEY POINT"),
        scene("reaction", "reaction", "reaction-grid", "반응은 편리함과 통제 부담으로 갈립니다", "속도 기대와 비용·권한 우려를 동시에 보여줍니다.", "사용자 반응은 두 갈래입니다. 반복 업무가 줄어든다는 기대가 있는 반면 비용과 권한 관리 부담을 지적하는 반응도 나옵니다.", 12, "02 · REACTIONS"),
        scene("action", "action", "action-card", "지금은 작은 반복 업무 하나로 검증하세요", "실패 비용이 낮고 결과를 측정할 수 있는 업무가 가장 좋습니다.", "결론은 간단합니다. 전체 업무를 한 번에 맡기기보다 실패 비용이 낮은 반복 작업 하나로 시간 절감과 비용을 먼저 측정하세요.", 10, "03 · ACTION")
      ]
    : [
        scene("hook", "hook", "hero", "반응이 갈린 발표, 기능보다 중요한 건 따로 있습니다", "공식 발표·실제 사용 반응·비용 조건을 분리해서 확인합니다.", "오늘 발표에서 눈에 띄는 기능은 많았습니다. 하지만 실제로 써볼 가치가 있는지는 기능 설명만으로 판단하기 어렵습니다. 공식 정보와 사용자 반응, 비용 조건을 분리해서 보겠습니다.", 8, "AI BRIEFING", { badge: "5 MIN BRIEF" }),
        scene("point-1", "point", "split", "첫 번째 핵심: 반복 작업이 아니라 ‘연결된 작업 흐름’", "예약 실행보다 중요한 건 이전 결과를 다음 단계의 입력으로 넘기는 구조입니다.", "첫 번째 핵심은 단순 반복 실행이 아닙니다. 앞선 작업의 결과를 다음 단계가 받아서 계속 처리할 수 있을 때 실제 자동화 가치가 생깁니다.", 14, "01 · KEY POINT"),
        scene("proof", "proof", "media-focus", "공식 화면에서 실제 동작 범위를 확인합니다", "지원 범위·제한·제공 시점을 화면 근거와 함께 보여주는 구간입니다.", "여기서는 공식 문서나 제품 화면을 크게 보여주고, 실제로 지원되는 범위와 아직 제한된 조건을 구분해서 확인합니다.", 13, "02 · OFFICIAL SOURCE", { badge: "SOURCE CHECK" }),
        scene("reaction", "reaction", "reaction-grid", "사용자 반응은 ‘시간 절감’과 ‘통제 부담’으로 갈립니다", "커뮤니티 의견은 사실 확인 자료가 아니라 사용성 신호로 분리합니다.", "사용자 반응은 두 갈래입니다. 반복 업무가 줄어든다는 기대가 있는 반면, 비용과 권한을 어디까지 맡겨야 하는지 부담스럽다는 반응도 함께 나옵니다.", 15, "03 · REACTIONS"),
        scene("cost", "cost", "split", "결국 판단 기준은 가격과 사용 제한입니다", "월 비용·사용량·지역·계정 조건을 기능과 별도로 확인해야 합니다.", "좋은 기능이라도 가격과 사용 제한이 맞지 않으면 실사용 가치는 낮아집니다. 월 비용과 사용량 제한, 계정 조건을 반드시 따로 확인해야 합니다.", 13, "04 · COST & LIMIT"),
        scene("action", "action", "action-card", "지금 할 일은 세 가지면 충분합니다", "작은 업무로 시작하고, 시간 절감과 실패율을 기록하고, 비용을 비교합니다.", "지금은 세 가지만 하면 됩니다. 실패 비용이 낮은 반복 업무 하나를 고르고, 전후 시간을 기록하고, 한 달 비용과 비교해서 계속 쓸지 결정하세요.", 13, "05 · ACTION"),
        scene("outro", "outro", "hero", "기능보다 ‘내 시간을 얼마나 줄이는가’를 보세요", "좋은 자동화는 신기한 기능이 아니라 반복 시간을 줄이고 결과를 재현합니다.", "결론입니다. 새로운 기능이 많아도 판단 기준은 하나입니다. 내 반복 시간을 실제로 줄이고, 결과를 안정적으로 재현하는지 확인하세요.", 8, "TAKEAWAY")
      ];

  return project(
    "reference-briefing",
    format,
    "AI 발표, 기능보다 중요한 3가지",
    shorts ? "공식 정보·반응·비용을 45초 안에" : "공식 발표와 사용자 반응을 분리해서 보는 리서치형 브리핑",
    scenes
  );
}

export function createAdaptivePromoProject(
  format: VideoFormat = "shorts"
): VideoProject {
  if (format === "shorts") {
    return project(
      "adaptive-promo",
      format,
      "서비스를 45초 안에 이해시키는 쇼츠",
      "Hook → Benefit → Product → Payoff → CTA",
      [
        scene("promo-hook", "hook", "hero", "아직도 이 일을 이렇게 하고 있나요?", "첫 5초 안에 사용자가 겪는 문제 또는 원하는 결과를 보여주세요.", "매번 반복되는 이 일, 더 간단하게 끝낼 수 있습니다.", 5, "HOOK", { badge: "45 SEC" }),
        scene("promo-benefit", "point", "split", "필요한 건 더 많은 기능이 아니라 더 쉬운 흐름", "핵심 가치 한 가지를 실제 사용 장면과 함께 보여주세요.", "이 서비스는 복잡한 과정을 줄이고, 사용자가 원하는 다음 행동까지 빠르게 이어줍니다.", 9, "01 · BENEFIT"),
        scene("promo-product", "proof", "media-focus", "말보다 실제 화면으로 보여드립니다", "앱·웹 UI, 전후 비교, 핵심 인터랙션을 크게 보여주는 장면입니다.", "실제 화면에서 필요한 정보를 확인하고 바로 다음 행동으로 넘어갈 수 있습니다.", 11, "02 · PRODUCT", { badge: "REAL UI" }),
        scene("promo-payoff", "reaction", "reaction-grid", "결과는 세 가지로 정리됩니다", "시간 절약 · 쉬운 사용 · 다음 행동이라는 결과를 짧게 제시하세요.", "결국 중요한 건 시간이 줄고, 사용이 쉬워지고, 다음 행동이 자연스럽게 이어지는 것입니다.", 10, "03 · PAYOFF"),
        scene("promo-cta", "action", "action-card", "지금 가장 작은 행동부터 시작하세요", "설치·가입·체험·문의 등 실제 서비스의 한 가지 CTA만 남깁니다.", "지금 직접 확인해 보세요. 작은 시작이 다음 경험을 바꿉니다.", 7, "04 · CTA")
      ]
    );
  }

  if (format === "vertical") {
    return project(
      "adaptive-promo",
      format,
      "세로형 서비스 소개",
      "약 60~90초 제품·서비스 소개 템플릿",
      [
        scene("v-hook", "hook", "hero", "사용자가 멈춰 볼 한 문장", "문제 또는 원하는 결과를 6초 안에 제시하세요.", "처음 몇 초 안에 왜 이 서비스를 봐야 하는지 분명하게 보여드립니다.", 6, "HOOK"),
        scene("v-problem", "point", "split", "지금 사용자가 겪는 불편", "한 화면에 한 문제만 설명합니다.", "먼저 사용자가 실제로 겪는 불편을 짚어보겠습니다.", 10, "01 · PROBLEM"),
        scene("v-solution", "proof", "media-focus", "이 문제를 이렇게 바꿉니다", "서비스 화면을 크게 보여주면서 해결 흐름을 설명합니다.", "이제 같은 일을 실제 서비스에서는 어떻게 더 간단하게 처리하는지 보여드리겠습니다.", 13, "02 · SOLUTION"),
        scene("v-feature", "point", "split", "핵심 기능은 한 번에 하나씩", "기능 이름보다 사용자가 얻는 결과를 먼저 보여주세요.", "기능 자체보다 이 기능으로 무엇이 쉬워지는지를 확인해 보세요.", 12, "03 · FEATURE"),
        scene("v-proof", "reaction", "reaction-grid", "사용 후 달라지는 세 가지", "시간·정확성·연결성 등 결과를 세 카드로 정리합니다.", "사용 후 달라지는 결과를 세 가지로 정리할 수 있습니다.", 11, "04 · RESULT"),
        scene("v-action", "action", "action-card", "이제 직접 확인해 보세요", "CTA는 하나만 남기고 나머지는 제거합니다.", "지금 가장 필요한 행동 하나부터 시작해 보세요.", 8, "05 · CTA"),
        scene("v-outro", "outro", "hero", "브랜드가 기억될 한 문장", "로고·서비스명·짧은 약속으로 마무리합니다.", "복잡함은 줄이고, 중요한 경험은 더 자연스럽게 이어갑니다.", 6, "BRAND")
      ]
    );
  }

  return project(
    "adaptive-promo",
    format,
    "제품과 서비스를 설득력 있게 설명하는 롱폼",
    "약 3~4분 기본 구조 · 실제 화면과 증거 중심",
    [
      scene("lf-hook", "hook", "hero", "끝까지 볼 이유를 8초 안에 제시합니다", "결과·문제·반전 중 하나로 시작하세요.", "이 영상에서는 이 서비스가 어떤 문제를 해결하고, 실제로 어떻게 작동하며, 누구에게 필요한지 빠르게 확인해 보겠습니다.", 8, "HOOK", { badge: "LONG FORM" }),
      scene("lf-context", "point", "split", "왜 지금 이 문제가 중요한가", "사용자가 처한 상황과 기존 방식의 비용을 설명합니다.", "먼저 이 문제가 왜 반복해서 생기는지, 기존 방식에서는 무엇이 불편한지 짚어보겠습니다.", 24, "01 · CONTEXT"),
      scene("lf-problem", "proof", "media-focus", "문제를 실제 장면으로 보여주세요", "추상적인 설명보다 기존 과정·화면·실제 사례를 제시합니다.", "말로만 설명하지 않고 실제 과정에서 어디서 시간이 걸리고 실수가 생기는지 화면으로 확인해 보겠습니다.", 28, "02 · PROBLEM"),
      scene("lf-solution", "proof", "media-focus", "해결 흐름을 처음부터 끝까지", "서비스 핵심 여정을 실제 UI로 보여줍니다.", "이제 같은 작업을 서비스에서는 어떻게 처리하는지 처음부터 끝까지 따라가 보겠습니다.", 30, "03 · SOLUTION", { badge: "REAL PRODUCT" }),
      scene("lf-feature-1", "point", "split", "핵심 기능 1 · 가장 자주 쓰는 가치", "기능명이 아니라 사용자가 얻는 결과를 중심으로 설명합니다.", "첫 번째 핵심 기능은 가장 자주 반복되는 일을 줄이는 데 초점을 맞춥니다.", 24, "04 · FEATURE"),
      scene("lf-feature-2", "point", "split", "핵심 기능 2 · 다음 행동까지 연결", "한 기능에서 끝나지 않고 다음 단계로 이어지는 흐름을 보여줍니다.", "두 번째 핵심은 한 번의 작업이 다음 행동까지 자연스럽게 연결된다는 점입니다.", 24, "05 · WORKFLOW"),
      scene("lf-proof", "reaction", "reaction-grid", "그래서 무엇이 달라지는가", "시간·정확성·편의성처럼 검증 가능한 결과를 정리합니다.", "기능을 모두 본 뒤에는 실제로 무엇이 달라지는지 세 가지 기준으로 정리해 보겠습니다.", 22, "06 · PAYOFF"),
      scene("lf-objection", "cost", "split", "쓰기 전에 확인할 조건과 한계", "가격·지원 범위·제약을 숨기지 않고 분리해서 설명합니다.", "좋은 점만 보는 대신 사용 전에 확인해야 할 조건과 아직 부족한 부분도 함께 보겠습니다.", 20, "07 · CHECK"),
      scene("lf-action", "action", "action-card", "직접 검증하는 가장 작은 방법", "가입·설치·체험·문의 등 실제 CTA를 단계로 정리합니다.", "관심이 있다면 가장 작은 범위에서 직접 써보고, 전후 시간을 비교해 판단해 보세요.", 16, "08 · ACTION"),
      scene("lf-outro", "outro", "hero", "한 문장으로 다시 기억시키기", "서비스명과 핵심 약속으로 끝냅니다.", "결국 좋은 서비스는 기능이 많아서가 아니라, 실제 사용자의 다음 행동을 더 쉽게 만들어 줍니다.", 8, "TAKEAWAY")
    ]
  );
}

export function createProjectFromTemplate(
  templateId: VideoTemplateId,
  format: VideoFormat
) {
  return templateId === "adaptive-promo"
    ? createAdaptivePromoProject(format)
    : createReferenceBriefingProject(format);
}

export function applyTemplate(
  templateId: VideoTemplateId,
  current: VideoProject
): VideoProject {
  const next = createProjectFromTemplate(templateId, current.format);
  return {
    ...next,
    id: current.id,
    title: current.title || next.title,
    subtitle: current.subtitle || next.subtitle,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString()
  };
}
