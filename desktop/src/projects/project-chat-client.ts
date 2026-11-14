import { nativeInvoke, type BridgeInvoke } from "../ai-client";

export const CHAT_AGENTS = ["claude", "codex"] as const;
export type ChatAgent = typeof CHAT_AGENTS[number];
export type ChatMode = "plan" | "edit";
export const AGENT_LABELS: Record<ChatAgent, string> = { claude: "Claude Opus 5.5 · medium", codex: "Codex" };
export const MODE_LABELS: Record<ChatMode, string> = { plan: "기획 (읽기 전용)", edit: "편집 (파일 수정)" };
export const ITEM_KINDS = ["user", "assistant", "thinking", "tool", "tool_result", "notice", "error", "result", "peer_request", "peer_reply", "hosted_request"] as const;
export type ItemKind = typeof ITEM_KINDS[number];

export type Project = { id: string; name: string; folder: string; addedAt: string };
export type Thread = { id: string; projectId: string; title: string; agent: ChatAgent; mode: ChatMode; providerSession: string | null; createdAt: string; updatedAt: string; running: boolean };
export type ChatItem = { id: string; kind: ItemKind; text: string; tool?: string; toolId?: string; isError?: boolean; peer?: string; peerName?: string; messageId?: string; code?: string; prompt?: string; at: string };
/** Hosted assistants reach Reason Network only through its MCP server and cannot be messaged by name. */
export const HOSTED_ASSISTANTS = ["muse", "dots", "grok"] as const;
export type HostedAssistant = typeof HOSTED_ASSISTANTS[number];
export const HOSTED_LABELS: Record<HostedAssistant, string> = { muse: "Muse", dots: "OpenAI Dots", grok: "Grok Bot" };
export type Changes = { isRepo: boolean; branch: string | null; files: string[]; diff: string; truncated: boolean };
export type ChatEvent = { threadId: string; kind: "items"; items: ChatItem[] } | { threadId: string; kind: "state"; running: boolean; thread?: Thread };

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => value && typeof value === "object" && !Array.isArray(value) ? value as Rec : {};
const str = (value: unknown) => typeof value === "string" ? value : "";
const list = (value: unknown) => Array.isArray(value) ? value : [];

export function normalizeProject(value: unknown): Project | null {
  const r = rec(value);
  return str(r.id) && str(r.folder) ? { id: str(r.id), name: str(r.name) || str(r.folder).split("/").pop() || "project", folder: str(r.folder), addedAt: str(r.addedAt) } : null;
}
export function normalizeThread(value: unknown): Thread | null {
  const r = rec(value);
  if (!str(r.id) || !str(r.projectId) || !CHAT_AGENTS.includes(r.agent as ChatAgent) || (r.mode !== "plan" && r.mode !== "edit")) return null;
  return { id: str(r.id), projectId: str(r.projectId), title: str(r.title) || "새 대화", agent: r.agent as ChatAgent, mode: r.mode, providerSession: str(r.providerSession) || null,
    createdAt: str(r.createdAt), updatedAt: str(r.updatedAt), running: r.running === true };
}
export function normalizeItem(value: unknown): ChatItem | null {
  const r = rec(value);
  if (!str(r.id) || !ITEM_KINDS.includes(r.kind as ItemKind)) return null;
  const item: ChatItem = { id: str(r.id), kind: r.kind as ItemKind, text: str(r.text), at: str(r.at) };
  if (str(r.tool)) item.tool = str(r.tool);
  if (str(r.toolId)) item.toolId = str(r.toolId);
  if (r.isError === true) item.isError = true;
  if (str(r.peer)) item.peer = str(r.peer);
  if (str(r.messageId)) item.messageId = str(r.messageId);
  if (str(r.peerName)) item.peerName = str(r.peerName);
  if (str(r.code)) item.code = str(r.code);
  if (str(r.prompt)) item.prompt = str(r.prompt);
  return item;
}
const compact = <T,>(values: (T | null)[]) => values.filter((v): v is T => v !== null);

/** Newest thread first. */
export function sortThreads(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Adds items not seen yet, in order, so an event and a reload never duplicate a row. */
export function mergeItems(current: ChatItem[], incoming: ChatItem[]): ChatItem[] {
  const seen = new Set(current.map(item => item.id));
  const fresh = incoming.filter(item => !seen.has(item.id) && (seen.add(item.id), true));
  return fresh.length ? [...current, ...fresh] : current;
}

export type Row = { type: "item"; item: ChatItem } | { type: "tool"; call: ChatItem; result: ChatItem | null };
/** Pairs each tool call with its result (by tool ID) into one collapsible row. */
export function toRows(items: ChatItem[]): Row[] {
  const results = new Map<string, ChatItem>();
  for (const item of items) if (item.kind === "tool_result" && item.toolId && !results.has(item.toolId)) results.set(item.toolId, item);
  const called = new Set(items.filter(item => item.kind === "tool" && item.toolId).map(item => item.toolId));
  return items.flatMap((item): Row[] => {
    if (item.kind === "tool") return [{ type: "tool", call: item, result: item.toolId ? results.get(item.toolId) ?? null : null }];
    if (item.kind === "tool_result" && item.toolId && called.has(item.toolId)) return [];
    return [{ type: "item", item }];
  });
}

/** The prompt that hands a planner's reply to the implementation agent. */
export function implementationPrompt(reply: ChatItem): string {
  return `아래는 ${reply.peerName ?? reply.peer ?? "기획자"}가 보낸 기획입니다. 이 기획대로 이 프로젝트에 구현하고, 끝나면 바꾼 파일과 확인 방법을 정리해 주세요.\n\n--- 기획 ---\n${reply.text}\n---`;
}

export type DiffLine = { kind: "add" | "del" | "hunk" | "file" | "ctx"; text: string };
export function diffLines(diff: string): DiffLine[] {
  return diff.split("\n").map(text => ({ text, kind:
    text.startsWith("diff --git") ? "file" : text.startsWith("@@") ? "hunk"
      : text.startsWith("+") && !text.startsWith("+++") ? "add" : text.startsWith("-") && !text.startsWith("---") ? "del" : "ctx" }));
}

export async function listProjects(call: BridgeInvoke = nativeInvoke): Promise<{ projects: Project[]; threads: Thread[] }> {
  const r = rec(await call("project_chat_list"));
  return { projects: compact(list(r.projects).map(normalizeProject)), threads: sortThreads(compact(list(r.threads).map(normalizeThread))) };
}
/** The host checks the folder and asks in an OS dialog. Null when cancelled. Omit path to pick a folder. */
export async function addProject(path: string | null, call: BridgeInvoke = nativeInvoke): Promise<Project | null> {
  const typed = path?.trim() ?? "";
  if (path !== null && !typed) throw new Error("프로젝트 폴더 경로를 입력하세요.");
  if (typed && !typed.startsWith("/") && !typed.startsWith("~/")) throw new Error("/ 또는 ~/ 로 시작하는 전체 경로를 입력하세요.");
  const r = rec(await call("project_chat_add_project", { input: typed ? { path: typed } : {} }));
  if (r.cancelled !== false) return null;
  const project = normalizeProject(r.project);
  if (!project) throw new Error("프로젝트를 추가하지 못했습니다.");
  return project;
}
export async function removeProject(projectId: string, call: BridgeInvoke = nativeInvoke) {
  await call("project_chat_remove_project", { input: { projectId } });
}
export async function createThread(projectId: string, agent: ChatAgent, mode: ChatMode, call: BridgeInvoke = nativeInvoke): Promise<Thread> {
  const thread = normalizeThread(await call("project_chat_thread_create", { input: { projectId, agent, mode } }));
  if (!thread) throw new Error("대화를 만들지 못했습니다.");
  return thread;
}
export async function readThread(threadId: string, call: BridgeInvoke = nativeInvoke): Promise<{ thread: Thread; items: ChatItem[] }> {
  const r = rec(await call("project_chat_thread_get", { input: { threadId } }));
  const thread = normalizeThread(r.thread);
  if (!thread) throw new Error("대화를 찾지 못했습니다.");
  return { thread, items: compact(list(r.items).map(normalizeItem)) };
}
export async function updateThread(threadId: string, change: { mode?: ChatMode; agent?: ChatAgent; title?: string }, call: BridgeInvoke = nativeInvoke): Promise<Thread> {
  const thread = normalizeThread(await call("project_chat_thread_update", { input: { threadId, ...change } }));
  if (!thread) throw new Error("대화를 바꾸지 못했습니다.");
  return thread;
}
export async function deleteThread(threadId: string, call: BridgeInvoke = nativeInvoke) {
  await call("project_chat_thread_delete", { input: { threadId } });
}
export async function sendMessage(threadId: string, text: string, call: BridgeInvoke = nativeInvoke): Promise<Thread> {
  if (!text.trim()) throw new Error("보낼 내용을 입력하세요.");
  const thread = normalizeThread(await call("project_chat_send", { input: { threadId, text } }));
  if (!thread) throw new Error("대화 상태를 확인하지 못했습니다.");
  return thread;
}
export async function stopTurn(threadId: string, call: BridgeInvoke = nativeInvoke) {
  await call("project_chat_stop", { input: { threadId } });
}
export async function askPeer(threadId: string, peer: string, text: string, call: BridgeInvoke = nativeInvoke, replyTo?: string): Promise<ChatItem[]> {
  if (!peer) throw new Error("기획을 맡길 에이전트를 고르세요.");
  if (!text.trim()) throw new Error("보낼 내용을 입력하세요.");
  const input = replyTo ? { threadId, peer, text, replyTo } : { threadId, peer, text };
  return compact(list(await call("project_chat_ask_peer", { input })).map(normalizeItem));
}
/** Records a request for a hosted assistant; the returned item carries the prompt to copy into it. */
export async function askHosted(threadId: string, assistant: HostedAssistant, text: string, call: BridgeInvoke = nativeInvoke): Promise<ChatItem[]> {
  if (!HOSTED_ASSISTANTS.includes(assistant)) throw new Error("기획을 맡길 어시스턴트를 고르세요.");
  if (!text.trim()) throw new Error("기획 요청을 입력하세요.");
  return compact(list(await call("project_chat_hosted_request", { input: { threadId, assistant, text } })).map(normalizeItem));
}
/** Files a message from Studio's Reason Network inbox in this thread; the host reads its sender and text. */
export async function linkMessage(threadId: string, messageId: string, call: BridgeInvoke = nativeInvoke): Promise<ChatItem[]> {
  if (!messageId) throw new Error("가져올 메시지를 고르세요.");
  return compact(list(await call("project_chat_link_message", { input: { threadId, messageId } })).map(normalizeItem));
}
/** A planner request is open while it has no reply after it. */
export function awaitingPlanner(items: ChatItem[]): boolean {
  let open = false;
  for (const item of items) {
    if (item.kind === "peer_request" || item.kind === "hosted_request") open = true;
    else if (item.kind === "peer_reply") open = false;
  }
  return open;
}
export async function syncPeers(threadId: string, call: BridgeInvoke = nativeInvoke): Promise<ChatItem[]> {
  return compact(list(await call("project_chat_sync_peers", { input: { threadId } })).map(normalizeItem));
}
export async function readChanges(projectId: string, call: BridgeInvoke = nativeInvoke): Promise<Changes> {
  const r = rec(await call("project_chat_changes", { input: { projectId } }));
  return { isRepo: r.isRepo === true, branch: str(r.branch) || null, files: list(r.files).map(str).filter(Boolean), diff: str(r.diff), truncated: r.truncated === true };
}
export function normalizeEvent(value: unknown): ChatEvent | null {
  const r = rec(value);
  if (!str(r.threadId)) return null;
  if (r.kind === "items") return { threadId: str(r.threadId), kind: "items", items: compact(list(r.items).map(normalizeItem)) };
  if (r.kind === "state") return { threadId: str(r.threadId), kind: "state", running: r.running === true, thread: normalizeThread(r.thread) ?? undefined };
  return null;
}

export type SearchHit =
  | { kind: "project"; project: Project; threadCount: number; running: boolean }
  | { kind: "thread"; project: Project; thread: Thread };
export type SearchResult = { query: string; hits: SearchHit[] } | null;

/** Lowercased NFC text with runs of whitespace folded, so "Pocket  App" finds "pocket app" and NFD folder names match typed Korean. */
export function searchKey(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Filters project names and thread titles only (no message bodies or code). An empty query means
 * "not searching" (null). Projects come first, then matching threads newest first; a thread whose
 * project is unknown is dropped.
 */
export function searchProjects(query: string, projects: Project[], threads: Thread[]): SearchResult {
  const key = searchKey(query);
  if (!key) return null;
  const byId = new Map(projects.map(p => [p.id, p]));
  const hits: SearchHit[] = [];
  for (const project of projects) {
    if (!searchKey(project.name).includes(key)) continue;
    const own = threads.filter(t => t.projectId === project.id);
    hits.push({ kind: "project", project, threadCount: own.length, running: own.some(t => t.running) });
  }
  for (const thread of sortThreads(threads)) {
    const project = byId.get(thread.projectId);
    if (project && searchKey(thread.title).includes(key)) hits.push({ kind: "thread", project, thread });
  }
  return { query: key, hits };
}
