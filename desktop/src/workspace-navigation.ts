export type View = "sns" | "content" | "trends" | "keywords" | "ai" | "assets" | "video" | "agent" | "publications" | "planner" | "ops" | "settings";
export type Section = "sns" | "content" | "creation" | "publications" | "operations" | "settings";
export const MAIN_SECTIONS = [{ id: "sns", label: "SNS 관리" }, { id: "content", label: "콘텐츠" }, { id: "creation", label: "제작" }, { id: "publications", label: "게시" }, { id: "operations", label: "운영" }] as const;
const items: Record<Section, { id: View; label: string; group: string }[]> = {
  sns: [{ id: "sns", label: "SNS 관리", group: "운영" }],
  content: [{ id: "content", label: "콘텐츠 플래너", group: "콘텐츠" }, { id: "trends", label: "트렌드 탐색", group: "콘텐츠" }, { id: "keywords", label: "키워드 탐색", group: "콘텐츠" }],
  creation: [{ id: "ai", label: "문구", group: "제작" }, { id: "assets", label: "이미지·에셋", group: "제작" }, { id: "video", label: "영상·모션", group: "제작" }, { id: "agent", label: "Agent", group: "제작" }],
  publications: [{ id: "publications", label: "게시", group: "운영" }],
  operations: [{ id: "planner", label: "일정·작업", group: "운영" }, { id: "ops", label: "운영 상태", group: "운영" }],
  settings: [{ id: "settings", label: "설정", group: "앱" }]
};
const SECTION_OF: Partial<Record<View, Section>> = { ai: "creation", assets: "creation", video: "creation", agent: "creation", trends: "content", keywords: "content", planner: "operations", ops: "operations" };
export function sectionFor(view: View): Section { return SECTION_OF[view] ?? (view as Section); }
export function sectionItems(section: Section) { return items[section]; }
export function restoreView(raw: string | null): View { return Object.values(items).flat().some(item => item.id === raw) ? raw as View : "sns"; }
export function rememberView(memory: Partial<Record<Section, View>>, view: View) { return { ...memory, [sectionFor(view)]: view }; }
