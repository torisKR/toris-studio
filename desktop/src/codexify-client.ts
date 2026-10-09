import { invoke } from "@tauri-apps/api/core";
import { studioToolInstruction } from "./codexify";

export type CodexifyProfile = {
  mcpUrl: string;
  pluginUrl: string;
  conversationUrl: string;
  projectRoot: string;
  conversationId: string;
};
export type CodexifyConnection = {
  reachable: boolean;
  serverName: string | null;
  protocolVersion: string | null;
  toolCount: number;
  studioTools: string[];
  missingStudioTools: string[];
  fileReceiverReady: boolean;
  ownerReady: boolean;
  checkedAt: string;
  message: string;
};
export type CodexifyChat = {
  id: string;
  title: string;
  workspace: string;
  projectMatches?: boolean;
  lastEntryEnd: number;
  lastEntryAtMs: number | null;
  lastAgentCallAtMs: number | null;
  agentWaitingUntilMs: number | null;
  totalToolCalls: number;
};
export type CodexifyChats = { chats: CodexifyChat[]; serverTimeMs: number };
export type ChatMessage = {
  id: string;
  role: "user" | "agent" | "warning";
  markdown: string;
  start: number;
  end: number;
  created_at_ms: number | null;
  tool_call_count: number | null;
};
export type ChatState = {
  messages: ChatMessage[];
  revision: string;
  delivered_through: number;
  read_through: number;
  last_agent_call_at_ms: number | null;
  agent_waiting_until_ms: number | null;
  server_time_ms: number;
  total_tool_calls?: number;
  has_more: boolean;
  before: number | null;
  unchanged: boolean;
};
export type ChatReceipt = { id: string; end: number; created_at_ms: number | null; tool_call_count: number | null };
export type BridgeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
const nativeInvoke: BridgeInvoke = (command, args) => invoke(command, args);

export function profileKey(profile: CodexifyProfile): string {
  return JSON.stringify([profile.mcpUrl, profile.pluginUrl, profile.conversationUrl, profile.projectRoot, profile.conversationId]);
}

/** Native projectMatches verifies Codexify's workspace namespace against the saved full path. */
export function projectChats(chats: CodexifyChat[], projectRoot: string): CodexifyChat[] {
  const normalized = projectRoot.trim().replace(/[\\/]+$/, "");
  const basename = normalized.split(/[\\/]/).pop();
  if (!basename) return [];
  return chats.filter(chat => typeof chat.projectMatches === "boolean" ? chat.projectMatches : chat.workspace === basename);
}

export function agentWaiting(state: Pick<ChatState, "agent_waiting_until_ms" | "server_time_ms">): boolean {
  return state.agent_waiting_until_ms != null && state.agent_waiting_until_ms > state.server_time_ms;
}

export function receiptState(receipt: Pick<ChatReceipt, "end">, state: Pick<ChatState, "delivered_through" | "read_through"> | null): "saved" | "delivered" | "read" {
  if (state && receipt.end <= state.read_through) return "read";
  if (state && receipt.end <= state.delivered_through) return "delivered";
  return "saved";
}

export function connectedChatUrl(profile: CodexifyProfile): string {
  const value = profile.conversationUrl.trim() || profile.pluginUrl.trim();
  if (!value) throw new Error("연결 설정에 등록한 ChatGPT 플러그인 주소 또는 대화 주소를 저장하세요.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("ChatGPT 연결 주소를 확인하세요."); }
  const validPath = /^\/plugins\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) || /^\/c\/[a-zA-Z0-9-]+\/?$/.test(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.port || url.username || url.password || url.search || url.hash || !validPath) {
    throw new Error("https://chatgpt.com의 등록된 플러그인 또는 대화 주소를 사용하세요.");
  }
  return url.href;
}

export function bootstrapPrompt(profile: CodexifyProfile): string {
  if (!profile.projectRoot.trim()) throw new Error("먼저 Codexify 작업 프로젝트의 절대 경로를 저장하세요.");
  return [
    "등록한 Toris Studio Codexify 플러그인을 사용해 Toris Studio 데스크톱 앱과 연결해줘.",
    `setup과 get_agent_brief로 연결 상태와 현재 프로젝트를 먼저 확인해줘. 아직 프로젝트가 연결되지 않았다면 set_project_root(${JSON.stringify({ path: profile.projectRoot, createWorktree: false })})로 기존 프로젝트를 선택해줘. 다른 프로젝트가 이미 연결돼 있으면 임의로 바꾸지 말고 알려줘.`,
    studioToolInstruction(),
    "chat_write로 연결 준비 상태를 알려주고 chat_await로 앱에서 보낸 요청을 기다려줘. 요청을 받으면 작업 시작, 주요 단계, 문제 발생, 검증한 결과마다 chat_write로 현재 하는 일과 다음 단계를 알려줘. 아직 확인하지 않은 성공이나 완료율은 추측하지 말고, 내가 종료를 요청할 때까지 다시 chat_await로 기다려줘.",
    "이미지를 요청하면 ChatGPT에서 실제로 생성한 파일의 download_url/file_id를 Studio 파일 수신 도구에 전달해줘. 도구 이름과 파일 스키마·_meta를 실제 목록에서 확인하고, 생성 또는 파일 수신이 확인되기 전에는 완료라고 말하지 마.",
    "앱의 메시지 저장만으로 새 ChatGPT 턴이 시작되는 것은 아니야. 연결이 종료되면 ChatGPT 대화에서 다시 시작해야 한다는 점을 알려줘.",
  ].join("\n\n");
}

export async function getProfile(call: BridgeInvoke = nativeInvoke): Promise<CodexifyProfile> {
  return await call("codexify_connection_get") as CodexifyProfile;
}

export async function openConnectedChat(call: BridgeInvoke = nativeInvoke): Promise<void> {
  const url = connectedChatUrl(await getProfile(call));
  await call("open_external", { url });
}

/** A saved receipt is not evidence that ChatGPT started a turn or generated an image. */
export async function sendToConnectedChat(
  message: string,
  requestId: string = crypto.randomUUID(),
  call: BridgeInvoke = nativeInvoke,
  expectedProfile?: CodexifyProfile,
): Promise<{ receipt: ChatReceipt; waiting: boolean }> {
  if (!message.trim()) throw new Error("ChatGPT에 요청할 내용을 입력하세요.");
  const profile = await getProfile(call);
  if (expectedProfile && profileKey(profile) !== profileKey(expectedProfile)) throw new Error("화면에 표시된 연결이 변경되었습니다. 현재 연결을 확인한 뒤 다시 전송하세요.");
  if (!profile.projectRoot.trim() || !profile.conversationId) throw new Error("연결 설정에서 작업 프로젝트와 Codexify 대화를 선택해 저장하세요.");
  const listed = await call("codexify_chats") as CodexifyChats;
  if (!projectChats(listed.chats, profile.projectRoot).some(chat => chat.id === profile.conversationId)) {
    throw new Error("선택한 대화가 저장된 작업 프로젝트의 대화 목록에 없습니다. 연결 설정에서 다시 선택하세요.");
  }
  const state = await call("codexify_chat_read") as ChatState;
  if (profileKey(profile) !== profileKey(await getProfile(call))) throw new Error("요청 준비 중 연결 설정이 변경되었습니다. 현재 연결을 확인한 뒤 다시 전송하세요.");
  const result = await call("codexify_chat_send", { input: { requestId, message, expectedProfile: profile } }) as { sent: ChatReceipt };
  return { receipt: result.sent, waiting: agentWaiting(state) };
}
