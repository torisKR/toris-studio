import { nativeInvoke, type BridgeInvoke } from "./ai-client";

export type OpsSource = "github_ci" | "github_release" | "cloudflare" | "http" | "play";
export type OpsState = "passing" | "failing" | "running" | "deployed" | "deploy_failed" | "healthy" | "unhealthy" | "draft" | "in_review" | "public" | "halted" | "unknown" | "error";
export type OpsStatus = { source: OpsSource; state: OpsState; summary: string; detail: Record<string, unknown>; observedAt: string };
export type ProductKind = "app" | "web" | "service";
export type Product = { id: string; name: string; kind: ProductKind; githubRepo: string | null; cloudflareWorker: string | null; cloudflarePages: string | null; healthUrl: string | null; playPackage: string | null; statuses: OpsStatus[] };
export type SecretKind = "github_token" | "cloudflare_token" | "cloudflare_account" | "play_service_account";
export type OpsOverview = { products: Product[]; secrets: Partial<Record<SecretKind, boolean>> };
export type ProductDraft = { id?: string; name: string; kind: ProductKind; githubRepo: string; cloudflareWorker: string; cloudflarePages: string; healthUrl: string; playPackage: string };
export type Tone = "good" | "bad" | "pending" | "info" | "neutral";

export const SOURCE_LABELS: Record<OpsSource, string> = { github_ci: "GitHub CI", github_release: "GitHub 릴리스", cloudflare: "Cloudflare 배포", http: "헬스체크", play: "Google Play" };
/** Each state keeps its own wording: CI passing is not deployed, deployed is not healthy, in review is not public. */
export const STATE_LABELS: Record<OpsState, { label: string; tone: Tone }> = {
  passing: { label: "CI 통과", tone: "good" },
  failing: { label: "CI 실패", tone: "bad" },
  running: { label: "진행 중", tone: "pending" },
  deployed: { label: "배포됨", tone: "info" },
  deploy_failed: { label: "배포 실패", tone: "bad" },
  healthy: { label: "정상 응답", tone: "good" },
  unhealthy: { label: "응답 이상", tone: "bad" },
  draft: { label: "초안", tone: "neutral" },
  in_review: { label: "심사 중 · 미공개", tone: "pending" },
  public: { label: "공개", tone: "good" },
  halted: { label: "중단·거절", tone: "bad" },
  unknown: { label: "알 수 없음", tone: "neutral" },
  error: { label: "확인 불가", tone: "bad" },
};
export const SECRET_LABELS: Record<SecretKind, { label: string; hint: string; multiline?: boolean }> = {
  github_token: { label: "GitHub 토큰", hint: "Actions·Contents 읽기 전용 fine-grained 토큰. 공개 저장소는 없어도 됩니다." },
  cloudflare_account: { label: "Cloudflare 계정 ID", hint: "대시보드 URL의 32자리 계정 ID" },
  cloudflare_token: { label: "Cloudflare 토큰", hint: "Workers Scripts·Pages 읽기 권한만 준 API 토큰" },
  play_service_account: { label: "Play 서비스 계정 JSON", hint: "Play Console에서 앱 정보 보기 권한만 준 서비스 계정 키", multiline: true },
};
export const KIND_LABELS: Record<ProductKind, string> = { app: "앱", web: "웹", service: "서비스" };

const ATTENTION: readonly OpsState[] = ["failing", "deploy_failed", "unhealthy", "halted", "error"];
export function needsAttention(status: OpsStatus): boolean {
  return ATTENTION.includes(status.state);
}

/** Older than maxMinutes means the dashboard should not be trusted without a refresh. */
export function isStale(status: OpsStatus, now: Date, maxMinutes = 60): boolean {
  const at = new Date(status.observedAt).getTime();
  return Number.isNaN(at) || now.getTime() - at > maxMinutes * 60_000;
}

/** Stable order: CI, release, deploy, health, store. */
export function orderedStatuses(statuses: readonly OpsStatus[]): OpsStatus[] {
  const order = Object.keys(SOURCE_LABELS);
  return [...statuses].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
}

export function emptyDraft(): ProductDraft {
  return { name: "", kind: "app", githubRepo: "", cloudflareWorker: "", cloudflarePages: "", healthUrl: "", playPackage: "" };
}
export function draftOf(product: Product): ProductDraft {
  return { id: product.id, name: product.name, kind: product.kind, githubRepo: product.githubRepo ?? "", cloudflareWorker: product.cloudflareWorker ?? "", cloudflarePages: product.cloudflarePages ?? "", healthUrl: product.healthUrl ?? "", playPackage: product.playPackage ?? "" };
}

/** Same rules as the Rust validator and the table CHECKs; returns the first problem or null. */
export function draftError(draft: ProductDraft): string | null {
  if (!draft.name.trim()) return "제품 이름을 입력하세요.";
  const repo = draft.githubRepo.trim(), worker = draft.cloudflareWorker.trim(), pages = draft.cloudflarePages.trim(), url = draft.healthUrl.trim(), pkg = draft.playPackage.trim();
  if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return "GitHub 저장소는 owner/repo 형식입니다.";
  const cf = /^[a-z0-9][a-z0-9-]{0,62}$/;
  if (worker && !cf.test(worker)) return "Worker 이름은 소문자, 숫자, -만 씁니다.";
  if (pages && !cf.test(pages)) return "Pages 프로젝트 이름은 소문자, 숫자, -만 씁니다.";
  if (url && !/^https:\/\/[^\s/]+/.test(url)) return "헬스체크 주소는 https://로 시작해야 합니다.";
  if (pkg && !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(pkg)) return "Play 패키지 이름 형식을 확인하세요 (예: com.example.app).";
  return null;
}

/** Only the fields the native validator accepts; blank values become null. */
export function productInput(draft: ProductDraft): Record<string, string | null> {
  const value = (raw: string) => raw.trim() || null;
  return { ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), kind: draft.kind, githubRepo: value(draft.githubRepo), cloudflareWorker: value(draft.cloudflareWorker), cloudflarePages: value(draft.cloudflarePages), healthUrl: value(draft.healthUrl), playPackage: value(draft.playPackage) };
}

export function loadOverview(call: BridgeInvoke = nativeInvoke): Promise<OpsOverview> {
  return call("ops_overview") as Promise<OpsOverview>;
}
export function saveProduct(draft: ProductDraft, call: BridgeInvoke = nativeInvoke): Promise<{ id: string }> {
  return call("ops_save_product", { input: productInput(draft) }) as Promise<{ id: string }>;
}
export function deleteProduct(id: string, call: BridgeInvoke = nativeInvoke): Promise<void> {
  return call("ops_delete_product", { id }) as Promise<void>;
}
export function refreshOps(call: BridgeInvoke = nativeInvoke): Promise<{ snapshots: number }> {
  return call("ops_refresh") as Promise<{ snapshots: number }>;
}
export function openTask(product: string, source: OpsSource, call: BridgeInvoke = nativeInvoke): Promise<{ id: string }> {
  return call("ops_open_task", { product, source }) as Promise<{ id: string }>;
}
/** Saves (or clears with null) a credential; only the saved/missing map comes back. */
export function saveSecret(kind: SecretKind, value: string | null, call: BridgeInvoke = nativeInvoke): Promise<OpsOverview["secrets"]> {
  return call("ops_save_secret", { kind, value }) as Promise<OpsOverview["secrets"]>;
}
