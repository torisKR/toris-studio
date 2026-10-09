import type { ChatMessage, ChatReceipt, ChatState } from "./codexify-client";

export type RequestStage = "saved" | "delivered" | "read" | "reply";
export type RequestProgress = {
  request: ChatMessage | ChatReceipt;
  content: string;
  stage: RequestStage;
  reply: ChatMessage | null;
  queuedAfter: boolean;
};
export type CodingProgress = {
  latest: RequestProgress | null;
  recent: RequestProgress[];
  stale: boolean;
  agentWaiting: boolean;
  title: string;
  detail: string;
  tone: "neutral" | "waiting" | "observed" | "warning";
};

export const progressLabels: Record<RequestStage, string> = {
  saved: "요청 저장됨",
  delivered: "ChatGPT 도구에 전달됨",
  read: "ChatGPT 읽음 확인",
  reply: "이 요청 이후 응답 도착",
};

/** Offsets are transport evidence. Neither an acknowledgement nor a reply proves work completed. */
export function requestProgress(request: ChatMessage | ChatReceipt, state: ChatState | null): RequestProgress {
  const nextRequest = state?.messages.find(message => message.role === "user" && message.start >= request.end);
  const reply = state?.messages.filter(message => message.role === "agent" && message.start >= request.end && (!nextRequest || message.start < nextRequest.start)).at(-1) ?? null;
  const stage: RequestStage = reply ? "reply" : state && state.read_through >= request.end ? "read" : state && state.delivered_through >= request.end ? "delivered" : "saved";
  return { request, content: "markdown" in request ? request.markdown : "요청 내용을 확인하려면 대화 기록을 새로고침하세요.", stage, reply, queuedAfter: Boolean(nextRequest) };
}

export function codingProgress(input: {
  state: ChatState | null;
  receipt: ChatReceipt | null;
  conversationSelected: boolean;
  observedAt: number;
  now: number;
  error?: string;
}): CodingProgress {
  const { state, receipt, observedAt, now } = input;
  const requests = (state?.messages ?? []).filter(message => message.role === "user");
  const recent = requests.slice(-4).reverse().map(request => requestProgress(request, state));
  const latestRequest = requests.at(-1);
  const newerReceipt = receipt && (!latestRequest || receipt.end > latestRequest.end) ? receipt : null;
  const latest = newerReceipt ? requestProgress(newerReceipt, state) : recent[0] ?? null;
  // Wall-clock freshness is separate from Codexify's server clock.
  const stale = Boolean(input.error) || Boolean(input.conversationSelected && (!state || !observedAt || Math.max(0, now - observedAt) > 15_000));
  const agentWaiting = !stale && Boolean(state?.agent_waiting_until_ms && state.agent_waiting_until_ms > state.server_time_ms + Math.max(0, now - observedAt));
  if (!input.conversationSelected) return { latest: null, recent: [], stale: false, agentWaiting: false, title: "대화 연결이 필요합니다", detail: "연결 설정에서 작업 프로젝트를 저장하고 사용할 Codexify 대화를 선택하세요.", tone: "neutral" };
  if (stale) return { latest, recent, stale, agentWaiting: false, title: "최근 작업 상태를 확인할 수 없습니다", detail: input.error || "마지막 확인 이후 상태 갱신이 지연되고 있습니다. 연결 확인을 눌러 다시 확인하세요.", tone: "warning" };
  if (!latest) return { latest, recent, stale, agentWaiting, title: agentWaiting ? "ChatGPT가 새 요청을 기다리고 있습니다" : "보낸 요청이 없습니다", detail: agentWaiting ? "연결된 대화의 chat_await 대기를 확인했습니다. 아래에서 작업을 요청할 수 있습니다." : "아래에서 요청을 보내세요. ChatGPT 대화에서 연결 시작 안내를 실행하면 앱 요청을 읽을 수 있습니다.", tone: "neutral" };
  if (latest.stage === "reply") return { latest, recent, stale, agentWaiting, title: "최근 ChatGPT 응답이 도착했습니다", detail: "이 요청 이후의 응답을 아래에서 확인하세요. 작업 완료 여부는 응답 내용과 실제 결과로 확인합니다.", tone: "observed" };
  if (latest.stage === "read") return { latest, recent, stale, agentWaiting, title: "ChatGPT 응답을 기다리고 있습니다", detail: "ChatGPT 도구가 요청을 읽었습니다. 현재 실행 중인 작업이나 완료 여부는 아직 확인되지 않았습니다.", tone: "waiting" };
  if (latest.stage === "delivered") return { latest, recent, stale, agentWaiting, title: "ChatGPT가 요청을 읽기를 기다리고 있습니다", detail: "요청이 ChatGPT 도구 응답으로 전달됐습니다. 읽음 확인과 작업 응답을 기다리고 있습니다.", tone: "waiting" };
  return { latest, recent, stale, agentWaiting, title: "ChatGPT 전달을 기다리고 있습니다", detail: agentWaiting ? "요청을 로컬에 저장했습니다. 연결된 ChatGPT 도구가 요청을 가져오면 전달 상태가 갱신됩니다." : "요청은 로컬에 저장됐습니다. 등록한 ChatGPT 대화에서 연결 시작 안내를 실행해 요청을 읽게 하세요.", tone: "waiting" };
}

export function elapsedLabel(start: number | null, current: number): string {
  if (start == null || !Number.isFinite(start) || !Number.isFinite(current)) return "시간 기록 없음";
  const seconds = Math.max(0, Math.floor((current - start) / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  return `${Math.floor(seconds / 86400)}일 전`;
}
