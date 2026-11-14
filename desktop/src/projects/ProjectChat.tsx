import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Bot, Check, Inbox, ChevronDown, Copy, Reply, ChevronRight, CircleAlert, FolderOpen, FolderPlus, GitBranch, GitBranchPlus, LoaderCircle, MessageSquarePlus, PanelRightOpen, RefreshCw, Search, Send, Sparkles, Square, Trash2, Wrench, X, FileText, Paperclip, Activity, CircleCheck, CircleSlash } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { refreshNetwork } from "../reason/reason-client";
import type { ReasonMessage, ReasonPeer } from "../reason/types";
import {
  addProject, AGENT_LABELS, askHosted, askPeer, plannerRequests, replyLink, HOSTED_ASSISTANTS, HOSTED_LABELS, linkMessage, linkWorktree, threadStarted, planWorktree, createWorktree, pendingWorktrees, resumeWorktree, forgetWorktree, createThread, deleteThread, implementationPrompt, listProjects, MODE_LABELS, normalizeEvent, attachFile, attachmentBlock, attachmentsAllowed, detachFile, formatBytes, MAX_ATTACHMENTS, MAX_ATTACHMENTS_BYTES, JOB_LABELS, jobRows, MAX_RUNNING,
  readThread, removeProject, searchProjects, sendMessage, sortThreads, stopTurn, syncPeers, toRows, updateThread,
  type ChatAgent, type ChatItem, type PlannerRequest, type HostedAssistant, type ChatMode, type Project, type SearchHit, type Thread, type WorktreePlan, type PendingWorktree, type Attachment, type AttachmentRef, type Job
} from "./project-chat-client";
import { addItems, applySnapshot, EMPTY_TRANSCRIPT, failureText, itemsFor, ViewTracker, type Failure, type Ticket, type Transcript } from "./project-view-state";
import { ThreadPreview } from "./ThreadPreview";
import { createComposerGuard } from "./composer-keys";
import { browserStorage, DRAFT_SAVED, DraftStore, draftSlot, joinDraft, missingDrafts } from "./project-drafts";
import { COPIED_NOTE, copyDraft, DISCARD_CONFIRM, DraftRecovery } from "./DraftRecovery";
import { ChangesPanel } from "./ChangesPanel";
import "./ProjectChat.css";

const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
const PLANNER = /muse|dots|grok/i;
const time = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }); };

/** A small, safe Markdown subset: fences, headings, lists, quotes, inline code and bold. Never HTML. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 1 ? <code key={i}>{part.slice(1, -1)}</code>
      : part.startsWith("**") && part.endsWith("**") && part.length > 3 ? <strong key={i}>{part.slice(2, -2)}</strong>
        : <Fragment key={i}>{part}</Fragment>);
}
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith("```"); i++) body.push(lines[i]);
      i++;
      blocks.push(<pre key={blocks.length}><code>{body.join("\n")}</code></pre>);
    } else if (/^#{1,4}\s/.test(line)) {
      blocks.push(<p key={blocks.length} className="pc-md-heading">{inline(line.replace(/^#+\s/, ""))}</p>); i++;
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const entries: string[] = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i]); i++) entries.push(lines[i].replace(/^\s*([-*]|\d+\.)\s/, ""));
      const children = entries.map((entry, k) => <li key={k}>{inline(entry)}</li>);
      blocks.push(ordered ? <ol key={blocks.length}>{children}</ol> : <ul key={blocks.length}>{children}</ul>);
    } else if (line.startsWith(">")) {
      const quote: string[] = [];
      for (; i < lines.length && lines[i].startsWith(">"); i++) quote.push(lines[i].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={blocks.length}>{inline(quote.join(" "))}</blockquote>);
    } else if (!line.trim()) { i++; } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*([-*]|\d+\.)\s|>|\s*```)/.test(lines[i]); i++) para.push(lines[i]);
      blocks.push(<p key={blocks.length}>{para.flatMap((p, k) => k ? [<br key={"b" + k} />, ...inline(p)] : inline(p))}</p>);
    }
  }
  return <div className="pc-md">{blocks}</div>;
}

function ToolRow({ call, result }: { call: ChatItem; result: ChatItem | null }) {
  const [open, setOpen] = useState(false);
  const pending = !result;
  return <div className={"pc-tool" + (result?.isError ? " error" : "")}>
    <button type="button" className="pc-tool-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      <Wrench size={13} /><strong>{call.tool ?? "도구"}</strong>
      <span className="pc-tool-summary">{call.text.split("\n")[0] || "—"}</span>
      {pending ? <LoaderCircle size={13} className="social-spin" aria-label="실행 중" /> : result?.isError ? <CircleAlert size={13} aria-label="실패" /> : null}
    </button>
    {open && <div className="pc-tool-body">
      {call.text.includes("\n") && <pre>{call.text}</pre>}
      {result ? <pre>{result.text || "(출력 없음)"}</pre> : <p>결과를 기다리는 중입니다.</p>}
    </div>}
  </div>;
}

/** Files a recorded message carried: names and sizes only, marked apart from the typed text. */
function Attached({ files }: { files?: AttachmentRef[] }) {
  if (!files?.length) return null;
  return <ul className="pc-attached" aria-label="첨부한 파일">{files.map(f =>
    <li key={f.name}><Paperclip size={11} /><span title={f.name}>{f.name}</span><small>{formatBytes(f.bytes)}</small></li>)}</ul>;
}

/** Files picked for the next message: what will be sent, with a preview and a remove button each. */
function PendingAttachments({ files, busy, onRemove }: { files: Attachment[]; busy: boolean; onRemove: (file: Attachment) => void }) {
  if (!files.length) return null;
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  return <div className="pc-pending" aria-label="보낼 첨부">
    <p className="pc-muted">첨부 {files.length}/{MAX_ATTACHMENTS} · {formatBytes(total)}/{MAX_ATTACHMENTS_BYTES / 1024}KiB · 보낼 때 Studio가 파일을 다시 확인합니다</p>
    <ul>{files.map(f => <li key={f.id} className={f.changed ? "changed" : ""}>
      <details>
        <summary><FileText size={12} /><span title={f.name}>{f.name}</span><small>{formatBytes(f.bytes)}</small>{f.changed && <em>선택 후 바뀜 · 새 내용 확인</em>}</summary>
        <pre aria-label={`${f.name} 미리보기`}>{f.text}</pre>
      </details>
      <button type="button" className="pc-icon subtle" aria-label={`${f.name} 첨부 제거`} disabled={busy} onClick={() => onRemove(f)}><X size={12} /></button>
    </li>)}</ul>
  </div>;
}

/** What Studio knows of a request's answer. A hosted request is never shown as sent or received:
 * Studio only made the prompt the user pastes. */
function RequestState({ request, hosted }: { request?: PlannerRequest; hosted: boolean }) {
  if (!request) return null;
  const text = request.state === "answered" ? `답장 ${request.replies}개 받음`
    : request.state === "unknown" ? "이전 기록 · 답장 연관 확인 불가"
      : hosted ? "답장 대기 · 전달문을 보냈는지는 Studio가 알 수 없습니다" : "답장 대기";
  return <span className={"pc-request-state " + request.state}>{request.state === "answered" ? <CircleCheck size={11} /> : request.state === "unknown" ? <CircleSlash size={11} /> : <LoaderCircle size={11} />}{text}</span>;
}

/** Which request a planner reply answers, as the host decided it; a reply it could not tie to a
 * request says so instead of guessing. */
function ReplyFor({ item, requests }: { item: ChatItem; requests: PlannerRequest[] }) {
  const link = replyLink(item, requests);
  if (link.kind === "unmatched") return <span className="pc-reply-for unmatched">요청 연관 미확인 · 직접 가져온 메시지라 어느 요청도 닫지 않습니다</span>;
  if (link.kind === "legacy") return <span className="pc-reply-for unmatched">요청 연관 정보 없음 (이전 기록)</span>;
  if (!link.request) return <span className="pc-reply-for unmatched">요청 연관 미확인</span>;
  const r = link.request;
  return <span className="pc-reply-for" title={r.text}>↳ {r.name}에게 보낸 요청 “{r.text.length > 40 ? r.text.slice(0, 40) + "…" : r.text}”의 답장{r.code ? ` · 전달 코드 ${r.code}로 분류` : ""}</span>;
}

function HostedRequestCard({ item, request }: { item: ChatItem; request?: PlannerRequest }) {
  const [copied, setCopied] = useState("");
  const copy = () => void invoke("copy_text", { text: item.prompt ?? "" })
    .then(() => setCopied("복사했습니다. " + (item.peerName ?? "어시스턴트") + "에 붙여넣어 보내세요. 복사만으로는 보내지지 않습니다."))
    .catch(cause => setCopied(errorText(cause)));
  return <div className="pc-msg user peer hosted">
    <span className="pc-peer-label"><Sparkles size={12} />{item.peerName ?? "어시스턴트"}에게 기획 요청 · <code title="답장을 이 요청에 분류하는 표시일 뿐, 보낸 쪽의 신원을 인증하지 않습니다">{item.code}</code></span>
    <RequestState request={request} hosted />
    <div className="pc-bubble">{item.text}</div>
    <Attached files={item.attachments} />
    <div className="pc-hosted">
      <p>{item.peerName ?? "어시스턴트"}는 이름으로 메시지를 받을 수 없어서, 이 전달문을 그 앱에 붙여넣어야 합니다. 첫 줄에 코드를 붙여 Studio로 보낸 기획만 이 대화에 표시됩니다. 코드는 답장을 분류할 뿐 보낸 쪽의 신원을 인증하지 않습니다.</p>
      <details><summary>전달문 보기</summary><pre>{item.prompt}</pre></details>
      <div className="pc-hosted-actions">
        <button type="button" className="social-button compact primary" onClick={copy} disabled={!item.prompt}>{copied.startsWith("복사") ? <Check size={13} /> : <Copy size={13} />}전달문 복사</button>
        {copied && <span role="status">{copied}</span>}
      </div>
    </div>
  </div>;
}

function ItemRow({ item, requests, onImplement, onReply }: { item: ChatItem; requests: PlannerRequest[]; onImplement: (item: ChatItem) => void; onReply: (item: ChatItem) => void }) {
  const request = requests.find(r => r.id === item.id);
  switch (item.kind) {
    case "user": return <div className="pc-msg user"><div className="pc-bubble">{item.text}</div><Attached files={item.attachments} /></div>;
    case "assistant": return <div className="pc-msg assistant"><Markdown text={item.text} /></div>;
    case "thinking": return <details className="pc-thinking"><summary>생각</summary><p>{item.text}</p></details>;
    case "result": return <div className="pc-result">{item.text}</div>;
    case "notice": return <div className={"pc-notice" + (item.isError ? " warn" : "")}>{item.text}</div>;
    case "error": return <div className="pc-notice error" role="alert"><CircleAlert size={14} />{item.text}</div>;
    case "tool_result": return <div className={"pc-tool" + (item.isError ? " error" : "")}><pre>{item.text}</pre></div>;
    case "peer_request": return <div className="pc-msg user peer"><span className="pc-peer-label"><Sparkles size={12} />{item.peerName ?? item.peer}에게 보냄</span><RequestState request={request} hosted={false} /><div className="pc-bubble">{item.text}</div></div>;
    case "hosted_request": return <HostedRequestCard item={item} request={request} />;
    case "peer_reply": return <div className="pc-msg peer-reply">
      <span className="pc-peer-label" title={item.peer}><Sparkles size={12} />{item.peerName ?? item.peer}의 기획 · {time(item.at)}</span>
      <ReplyFor item={item} requests={requests} />
      <Markdown text={item.text} />
      <div className="pc-reply-actions">
        <button type="button" className="social-button compact primary" onClick={() => onImplement(item)}><Wrench size={13} />이 기획으로 구현</button>
        {item.peer && item.messageId && <button type="button" className="social-button compact" onClick={() => onReply(item)}><Reply size={13} />답장</button>}
      </div>
    </div>;
    default: return null;
  }
}

type Props = { active: boolean };
export function ProjectChat({ active }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [projectId, setProjectId] = useState<string | null>(() => { try { return localStorage.getItem("toris.projects.project"); } catch { return null; } });
  const [threadId, setThreadId] = useState<string | null>(null);
  // The rows on screen belong to one thread; a late answer for another thread never lands here.
  const [transcript, setTranscript] = useState<Transcript>(EMPTY_TRANSCRIPT);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Drafts: one per conversation (project + thread, or the project's new conversation), kept on this device.
  const [drafts] = useState(() => new DraftStore(browserStorage()));
  const [text, setText] = useState(() => projectId ? drafts.get(draftSlot(projectId, null)) : "");
  const [target, setTarget] = useState<string>("agent");
  const [newAgent, setNewAgent] = useState<ChatAgent>("claude");
  const [newMode, setNewMode] = useState<ChatMode>("edit");
  const [peers, setPeers] = useState<ReasonPeer[]>([]);
  const [replyTo, setReplyTo] = useState<ChatItem | null>(null);
  const [inbox, setInbox] = useState<ReasonMessage[]>([]);
  const [showInbox, setShowInbox] = useState(false);
  const [path, setPath] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure>(null);
  const [showChanges, setShowChanges] = useState(true);
  const [changesKey, setChangesKey] = useState(0);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLUListElement>(null);
  const threadRef = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const imeGuard = useRef(createComposerGuard());
  threadRef.current = threadId;
  // Which screen is shown, so async work can tell whether the screen it started from is still open.
  const view = useRef<ViewTracker | null>(null);
  view.current ??= new ViewTracker({ projectId, threadId });
  view.current.show({ projectId, threadId });
  const tracker = view.current;
  /** Show `id` now, before React renders it, so work that follows counts as that thread's. */
  const focus = (id: string | null) => { threadRef.current = id; tracker.show({ projectId, threadId: id }); };
  const items = itemsFor(transcript, threadId);
  const addTo = (id: string, incoming: ChatItem[]) => setTranscript(t => addItems(t, threadRef.current, id, incoming));

  const project = projects.find(p => p.id === projectId) ?? null;
  const thread = threads.find(t => t.id === threadId) ?? null;
  // The conversation shown is no longer in the list (another run or something outside Studio
  // removed it, or the list read came back without it). Its draft stays, and nothing typed here
  // is sent: a send would otherwise start a new conversation the user did not pick.
  const missing = threadId !== null && !thread;
  /** The host listed projects at least once, so "not in the list" means something. */
  const [listed, setListed] = useState(false);
  const [, setDraftsVersion] = useState(0);
  const [missingNote, setMissingNote] = useState<{ slot: string; text: string } | null>(null);
  const projectThreads = useMemo(() => threads.filter(t => t.projectId === projectId), [threads, projectId]);
  const found = useMemo(() => searchProjects(query, projects, threads), [query, projects, threads]);

  // Each thread (and each project's unsaved "새 대화") keeps its own draft, so opening another
  // thread from the sidebar or search never carries half-typed text into it, and a reopened
  // page brings each draft back. Restoring a draft never sends it.
  const draftKey = threadId ?? "new:" + (projectId ?? "");
  const slot = projectId ? draftSlot(projectId, threadId) : null;
  const slotRef = useRef(slot);
  const carryDraft = useRef(false);
  /** The user's own typing (or a suggestion they picked): shown and kept as this conversation's draft. */
  const edit = (value: string) => { setText(value); if (slotRef.current) drafts.set(slotRef.current, value); };
  // Layout effect: the swap lands in the same commit as the new thread, so no frame shows the wrong draft.
  useLayoutEffect(() => {
    const previous = slotRef.current;
    if (previous === slot) return;
    slotRef.current = slot;
    // The new thread created by sending keeps its text, and the draft moves with it.
    if (carryDraft.current) { carryDraft.current = false; if (previous && slot) drafts.move(previous, slot); return; }
    setText(slot ? drafts.get(slot) : "");
  }, [slot]);
  const draftNote = slot ? drafts.note(slot) : null;
  const sortedPeers = useMemo(() => [...peers].sort((a, b) => Number(PLANNER.test(b.name)) - Number(PLANNER.test(a.name))), [peers]);
  const error = failureText(failure, draftKey);
  /** An error of the screen shown now. */
  const setError = (text: string) => setFailure(text ? { key: tracker.key, text } : null);
  // A task's error belongs to the conversation it worked for (`owner`, which a send moves to the
  // thread it creates); it shows only there, never on a screen opened while it ran.
  const run = async (task: (owner: { ticket: Ticket }) => Promise<void>) => {
    const owner = { ticket: tracker.ticket() };
    setBusy(true); setFailure(null);
    try { await task(owner); } catch (cause) { setFailure({ key: owner.ticket.key, text: errorText(cause) }); } finally { setBusy(false); }
  };
  const upsert = (next: Thread) => setThreads(current => sortThreads([next, ...current.filter(t => t.id !== next.id)]));

  const reload = useCallback(async () => {
    try {
      const data = await listProjects();
      setProjects(data.projects); setThreads(data.threads); setListed(true);
      setProjectId(current => current && data.projects.some(p => p.id === current) ? current : data.projects[0]?.id ?? null);
    } catch (cause) { setError(errorText(cause)); }
  }, []);
  const loadPeers = useCallback(async () => {
    try {
      const snapshot = await refreshNetwork();
      const connected = snapshot.state === "connected";
      setPeers(connected ? snapshot.peers : []);
      setInbox(connected ? snapshot.messages.filter(m => !m.video && m.text.trim()) : []);
    } catch { setPeers([]); setInbox([]); }
  }, []);
  useEffect(() => { if (active) { void reload(); void loadPeers(); } }, [active, reload, loadPeers]);
  useEffect(() => { try { if (projectId) localStorage.setItem("toris.projects.project", projectId); } catch { /* storage unavailable */ } }, [projectId]);

  // Live items and run state pushed by the host.
  useEffect(() => {
    if (!active) return;
    let alive = true; let stop: (() => void) | undefined;
    void listen("project-chat-event", ({ payload }) => {
      const event = normalizeEvent(payload);
      if (!alive || !event) return;
      if (event.kind === "items") setTranscript(t => addItems(t, threadRef.current, event.threadId, event.items));
      else {
        setThreads(current => sortThreads(current.map(t => t.id === event.threadId ? { ...(event.thread ?? t), running: event.running } : t)));
        if (!event.running && event.threadId === threadRef.current) setChangesKey(k => k + 1);
      }
    }).then(unlisten => { if (alive) stop = unlisten; else unlisten(); }).catch(() => {});
    return () => { alive = false; stop?.(); };
  }, [active]);

  useEffect(() => {
    // A switch never shows the previous thread's rows (they belong to that thread); items streamed
    // for this thread while it loads are kept after the stored ones. A read answered after its
    // screen was left, even if the thread was opened again since, is dropped for the newer read.
    setAttachments([]);
    if (!threadId) return;
    const ticket = tracker.ticket();
    void readThread(threadId).then(data => {
      if (!tracker.fresh(ticket)) return;
      setTranscript(t => applySnapshot(t, threadRef.current, threadId, data.items)); setAttachments(data.attachments); upsert(data.thread);
    }).catch(cause => { if (tracker.fresh(ticket)) setError(errorText(cause)); });
  }, [threadId]);
  // An empty thread shows its start screen from the top; only a transcript follows its end.
  useEffect(() => { if (items.length) endRef.current?.scrollIntoView({ block: "end" }); else endRef.current?.parentElement?.scrollTo({ top: 0 }); }, [items.length, threadId]);

  // Planner replies arrive through Reason Network; check while a request is unanswered. Each
  // request closes only when the host files a reply it tied to that request.
  const requests = useMemo(() => plannerRequests(items), [items]);
  const openRequests = requests.filter(r => r.state === "waiting").length;
  const waitingPeer = openRequests > 0;
  // The last check of one thread: shown only on that thread's screen.
  const [check, setCheck] = useState<{ threadId: string; checking: boolean; error: string | null; found: number | null; at: string } | null>(null);
  const checkReplies = (id: string, manual: boolean) => {
    if (manual) setCheck({ threadId: id, checking: true, error: null, found: null, at: "" });
    return syncPeers(id).then(fresh => {
      if (fresh.length) addTo(id, fresh);
      setCheck(c => manual || c?.threadId === id ? { threadId: id, checking: false, error: null, found: manual ? fresh.length : c?.found ?? null, at: new Date().toISOString() } : c);
    }).catch(cause => setCheck(c => manual || !c || c.threadId === id ? { threadId: id, checking: false, error: errorText(cause), found: null, at: new Date().toISOString() } : c));
  };
  const shownCheck = check?.threadId === threadId ? check : null;
  useEffect(() => { setReplyTo(null); setShowInbox(false); }, [threadId]);
  const linked = useMemo(() => new Set(items.filter(i => i.kind === "peer_reply").map(i => i.messageId)), [items]);
  const unlinked = useMemo(() => inbox.filter(m => !linked.has(m.id)).slice(-20).reverse(), [inbox, linked]);
  const pull = (m: ReasonMessage) => thread && void run(async () => {
    const id = thread.id;
    addTo(id, await linkMessage(id, m.id));
    if (tracker.showing(id)) setShowInbox(false);
  });
  useEffect(() => {
    if (!active || !threadId || !waitingPeer) return;
    const timer = window.setInterval(() => { void checkReplies(threadId, false); }, 8000);
    return () => window.clearInterval(timer);
  }, [active, threadId, waitingPeer]);

  const add = (typed: string | null) => run(async () => {
    const added = await addProject(typed);
    if (!added) return;
    setPath(""); setAdding(false);
    await reload(); setProjectId(added.id); setThreadId(null);
  });
  const forget = (p: Project) => run(async () => {
    if (!window.confirm(`"${p.name}"을(를) 목록에서 지울까요? 폴더와 파일은 그대로 남고, 이 프로젝트의 대화 기록만 지워집니다.`)) return;
    await removeProject(p.id);
    drafts.removeProject(p.id);
    if (projectId === p.id) { setProjectId(null); setThreadId(null); }
    await reload();
  });
  const dropThread = (t: Thread) => run(async () => {
    if (!window.confirm(`"${t.title}" 대화를 지울까요?`)) return;
    await deleteThread(t.id);
    drafts.removeThread(t.projectId, t.id);
    if (threadId === t.id) setThreadId(null);
    setThreads(current => current.filter(x => x.id !== t.id));
  });
  // Before a thread starts it may move into an existing git worktree of the project; the host
  // picks the folder in an OS dialog, verifies it with git and asks for confirmation.
  const started = threadStarted(thread, items);
  const attachWorktree = () => project && !missing && void run(async () => {
    let current = thread;
    const created = !current;
    if (!current) current = await createThread(project.id, newAgent, newMode);
    const linked = await linkWorktree(current.id, null).catch(async cause => { if (created) await deleteThread(current.id).catch(() => {}); throw cause; });
    if (!linked) { if (created) await deleteThread(current.id).catch(() => {}); return; }
    upsert(linked); setThreadId(linked.id); focus(linked.id); setChangesKey(k => k + 1);
    setAttachments([]); // the host drops files picked from the previous folder
  });
  const newThread = () => { setThreadId(null); setTarget("agent"); inputRef.current?.focus(); };

  // Search opens a project or thread only: it never stops, starts or retargets a run.
  const openHit = (hit: SearchHit) => {
    setProjectId(hit.project.id);
    setThreadId(hit.kind === "thread" ? hit.thread.id : null);
  };
  const resultButtons = () => Array.from(resultsRef.current?.querySelectorAll<HTMLButtonElement>("button.pc-hit") ?? []);
  const clearSearch = () => { setQuery(""); searchRef.current?.focus(); };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); setQuery(""); }
    else if (event.key === "ArrowDown") { event.preventDefault(); resultButtons()[0]?.focus(); }
    else if (event.key === "Enter" && found?.hits[0]) { event.preventDefault(); openHit(found.hits[0]); }
  };
  const onResultsKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const buttons = resultButtons();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") { event.preventDefault(); clearSearch(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); buttons[Math.min(at + 1, buttons.length - 1)]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); if (at <= 0) searchRef.current?.focus(); else buttons[at - 1]?.focus(); }
  };

  // An isolated thread gets its own new branch and worktree from the committed HEAD. The host names
  // them, the page only shows them; creation happens after the host's own OS confirmation.
  const [plan, setPlan] = useState<{ plan: WorktreePlan; created: boolean } | null>(null);
  const [leftovers, setLeftovers] = useState<PendingWorktree[]>([]);
  const loadLeftovers = useCallback(async () => { try { setLeftovers(await pendingWorktrees()); } catch { setLeftovers([]); } }, []);
  useEffect(() => { if (active) void loadLeftovers(); }, [active, loadLeftovers]);
  useEffect(() => { setPlan(current => current && current.plan.threadId === threadId ? current : null); }, [threadId]);
  const isolate = () => project && !missing && void run(async () => {
    let current = thread;
    const created = !current;
    if (!current) current = await createThread(project.id, newAgent, newMode);
    try {
      const next = await planWorktree(current.id);
      if (created) { upsert(current); setThreadId(current.id); focus(current.id); }
      setPlan({ plan: next, created });
    } catch (cause) { if (created) await deleteThread(current.id).catch(() => {}); throw cause; }
  });
  const dropPlan = async (shown: { plan: WorktreePlan; created: boolean }) => {
    setPlan(null);
    if (!shown.created) return;
    await deleteThread(shown.plan.threadId).catch(() => {});
    setThreads(current => current.filter(t => t.id !== shown.plan.threadId));
    if (threadRef.current === shown.plan.threadId) { setThreadId(null); focus(null); }
  };
  const confirmPlan = () => plan && void run(async () => {
    try {
      const made = await createWorktree(plan.plan.threadId);
      if (!made) return;
      setPlan(null); upsert(made); setThreadId(made.id); focus(made.id); setChangesKey(k => k + 1);
    } finally { void loadLeftovers(); }
  });
  const continueLeftover = (left: PendingWorktree) => project && void run(async () => {
    const fresh = await createThread(left.projectId, newAgent, newMode);
    const linked = await resumeWorktree(left.id, fresh.id).catch(async cause => { await deleteThread(fresh.id).catch(() => {}); throw cause; });
    if (!linked) { await deleteThread(fresh.id).catch(() => {}); return; }
    upsert(linked); setThreadId(linked.id); focus(linked.id); setChangesKey(k => k + 1);
    await loadLeftovers();
  });
  const forgetLeftover = (left: PendingWorktree) => void run(async () => {
    if (!window.confirm(`생성 기록만 지웁니다. 폴더 ${left.path}와 브랜치 ${left.branch}는 그대로 남습니다.`)) return;
    await forgetWorktree(left.id);
    await loadLeftovers();
  });
  const projectLeftovers = leftovers.filter(l => l.projectId === projectId);
  // Files come from the OS dialog in the host, inside this thread's work folder; the window keeps only IDs.
  const attach = () => project && !missing && void run(async () => {
    let current = thread;
    const created = !current;
    if (!current) current = await createThread(project.id, newAgent, newMode);
    const picked = await attachFile(current.id, attachments).catch(async cause => { if (created) await deleteThread(current.id).catch(() => {}); throw cause; });
    if (!picked) { if (created) await deleteThread(current.id).catch(() => {}); return; }
    if (created) { upsert(current); setThreadId(current.id); focus(current.id); }
    if (tracker.showing(current.id)) setAttachments(prev => [...prev.filter(a => a.id !== picked.id), picked]);
  });
  const detach = (file: Attachment) => thread && void run(async () => {
    const id = thread.id;
    const left = await detachFile(id, file.id);
    if (tracker.showing(id)) setAttachments(left);
  });
  const canAttach = attachmentsAllowed(target, !!replyTo);
  const attachBlocked = attachmentBlock(attachments);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!project || !text.trim() || busy || thread?.running && target === "agent") return;
    if (missing) { setError("원래 대화를 찾을 수 없어 보내지 않았습니다. 초안을 복사해 원하는 대화에서 직접 보내세요."); return; }
    if (attachments.length && !canAttach) { setError("첨부는 구현 에이전트나 호스팅 어시스턴트 전달문에만 넣을 수 있습니다. 첨부를 빼거나 받는 쪽을 바꾸세요."); return; }
    const message = text;
    const files = attachments;
    void run(async owner => {
      let current = thread;
      // The new conversation's draft becomes the thread's now, so a send that finishes before the
      // next render still finds (and clears) it there.
      if (!current) { current = await createThread(project.id, newAgent, newMode); drafts.move(draftSlot(project.id, null), draftSlot(project.id, current.id)); upsert(current); carryDraft.current = true; setThreadId(current.id); focus(current.id); }
      const id = current.id;
      owner.ticket = tracker.ticket(); // a failure from here on is this conversation's
      // The user may open another conversation while this one sends: its result, cleared draft,
      // attachments and reply target stay with this conversation and never touch the one shown.
      const here = () => tracker.showing(id);
      if (replyTo?.peer && replyTo.messageId) {
        addTo(id, await askPeer(id, replyTo.peer, message, undefined, replyTo.messageId));
        if (here()) setReplyTo(null);
      } else if (target === "agent" || target.startsWith("hosted:")) {
        // A refused send (a file changed or no longer passes the checks) shows the host's current preview.
        const refresh = async (cause: unknown) => { if (files.length) await readThread(id).then(data => { if (here()) setAttachments(data.attachments); }).catch(() => {}); throw cause; };
        if (target === "agent") upsert(await sendMessage(id, message, undefined, files).catch(refresh));
        else addTo(id, await askHosted(id, target.slice(7) as HostedAssistant, message, undefined, files).catch(refresh));
        if (here()) setAttachments([]);
      } else {
        addTo(id, await askPeer(id, target, message));
      }
      // Only the text that was sent leaves the draft: anything typed since stays.
      if (drafts.clearSent(draftSlot(project.id, id), message) && here()) setText("");
    });
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter that confirms a Korean (IME) syllable never sends, in Chromium's order or WKWebView's
    // (an insertReplacementText commit, then a plain Enter keydown). That Enter adds no line either.
    const action = imeGuard.current.onKeyDown({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode });
    if (action !== "none") event.preventDefault();
    if (action === "send") submit();
  };
  const answer = (reply: ChatItem) => { setReplyTo(reply); inputRef.current?.focus(); };
  const implement = (reply: ChatItem) => void run(async () => {
    const key = tracker.key;
    const asked = slotRef.current;
    setReplyTo(null);
    setTarget("agent");
    if (thread && thread.mode !== "edit") upsert(await updateThread(thread.id, { mode: "edit" }));
    // The prompt goes into the draft of the conversation it was asked in, even if another is open
    // now, after any text already there: it never replaces a draft.
    if (!asked) return;
    const merged = joinDraft(drafts.get(asked), implementationPrompt(reply));
    drafts.set(asked, merged);
    if (!tracker.showing(key)) return;
    setText(merged);
    inputRef.current?.focus();
  });
  const setMode = (mode: ChatMode) => thread ? void run(async () => upsert(await updateThread(thread.id, { mode }))) : setNewMode(mode);
  const mode = thread?.mode ?? newMode;
  const agent = thread?.agent ?? newAgent;
  const rows = useMemo(() => toRows(items), [items]);
  const jobs = useMemo(() => jobRows(threads, projects), [threads, projects]);
  const runningCount = useMemo(() => threads.filter(t => t.running).length, [threads]);
  const openJob = (job: Job) => { setProjectId(job.thread.projectId); setThreadId(job.thread.id); focus(job.thread.id); };

  return <section className={"pc-root" + (showChanges && project ? " with-changes" : "")} aria-label="프로젝트 채팅">
    <nav className="pc-sidebar" aria-label="프로젝트">
      <header><strong>프로젝트</strong><button type="button" className="pc-icon" aria-label="프로젝트 추가" aria-expanded={adding} onClick={() => setAdding(v => !v)}><FolderPlus size={16} /></button></header>
      {adding && <form className="pc-add" onSubmit={event => { event.preventDefault(); void add(path); }}>
        <input value={path} onChange={event => setPath(event.target.value)} placeholder="~/projects/my-app" aria-label="프로젝트 폴더 경로" autoFocus spellCheck={false} />
        <div><button type="submit" className="social-button compact primary" disabled={busy || !path.trim()}>추가</button>
          <button type="button" className="social-button compact" disabled={busy} onClick={() => void add(null)}><FolderOpen size={13} />폴더 선택</button></div>
      </form>}
      <div className="pc-search" role="search">
        <Search size={13} aria-hidden="true" />
        <input ref={searchRef} type="text" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onSearchKey}
          placeholder="프로젝트·대화 제목 검색" aria-label="프로젝트·대화 검색" aria-controls="pc-search-results" spellCheck={false} />
        {query && <button type="button" className="pc-icon" aria-label="검색 지우기" onClick={clearSearch}><X size={12} /></button>}
      </div>
      {!projects.length && !adding && !found && <p className="pc-muted pc-empty-side">앱 폴더를 추가하면 그 폴더에서 Claude Code·Codex와 채팅하며 기획·구현할 수 있습니다.</p>}
      {!!jobs.length && <section className="pc-jobs" aria-label="작업 현황">
        <header><Activity size={13} /><strong>작업 현황</strong><small>{runningCount}/{MAX_RUNNING} 실행 중</small></header>
        <ul>{jobs.map(job => <li key={job.thread.id} className={"pc-job " + job.state + (job.thread.id === threadId ? " active" : "")}>
          <button type="button" className="pc-job-open" aria-current={job.thread.id === threadId ? "true" : undefined} onClick={() => openJob(job)}
            title={`${job.project?.name ?? "프로젝트"} · ${job.thread.title}`}>
            {job.state === "running" ? <LoaderCircle size={12} className="social-spin" aria-hidden /> : job.state === "done" ? <CircleCheck size={12} aria-hidden /> : job.state === "failed" ? <CircleAlert size={12} aria-hidden /> : <CircleSlash size={12} aria-hidden />}
            <span className="pc-job-title">{job.thread.title}</span>
            <span className="pc-job-meta">{job.thread.agent === "claude" ? "Claude" : "Codex"} · {job.branch ?? "원본 폴더"}{job.project && job.project.id !== projectId ? ` · ${job.project.name}` : ""}</span>
            <span className="pc-job-state">{JOB_LABELS[job.state]}</span>
          </button>
          {job.state === "running" && <button type="button" className="pc-icon subtle" aria-label={`${job.thread.title} 중지`} onClick={() => void run(() => stopTurn(job.thread.id))}><Square size={11} /></button>}
        </li>)}</ul>
      </section>}
      {found && <div className="pc-results">
        <p className="pc-muted pc-empty-side" role="status">{!projects.length ? "아직 프로젝트가 없습니다. 먼저 앱 폴더를 추가하세요."
          : found.hits.length ? `제목 검색 결과 ${found.hits.length}개 · ↓로 이동, Esc로 지우기` : `"${query.trim()}"와(과) 일치하는 프로젝트·대화가 없습니다.`}</p>
        <ul id="pc-search-results" ref={resultsRef} className="pc-projects" aria-label="검색 결과" onKeyDown={onResultsKey}>{found.hits.map(hit => {
          const current = hit.kind === "thread" ? hit.thread.id === threadId : hit.project.id === projectId && !threadId;
          return <li key={hit.kind + ":" + (hit.kind === "thread" ? hit.thread.id : hit.project.id)}>
            <button type="button" className={"pc-hit" + (current ? " active" : "")} aria-current={current ? "true" : undefined}
              title={hit.kind === "project" ? hit.project.folder : hit.project.folder + " · " + hit.thread.title} onClick={() => openHit(hit)}>
              {hit.kind === "project" ? <FolderOpen size={13} /> : hit.thread.running ? <LoaderCircle size={12} className="social-spin" aria-hidden="true" /> : <Bot size={12} />}
              <span>{hit.kind === "project" ? hit.project.name : hit.thread.title}</span>
              <small>{hit.kind === "project"
                ? `프로젝트 · 대화 ${hit.threadCount}개${hit.running ? " · 실행 중" : ""}`
                : `${hit.project.name} · ${hit.thread.agent === "claude" ? "Claude" : "Codex"} · ${hit.thread.running ? "실행 중" : "대기"}`}</small>
            </button>
          </li>;
        })}</ul>
      </div>}
      {!found && <ul className="pc-projects">{projects.map(p => <li key={p.id} className={p.id === projectId ? "active" : ""}>
        <div className="pc-project-row">
          <button type="button" className="pc-project" aria-current={p.id === projectId ? "true" : undefined} title={p.folder} onClick={() => { setProjectId(p.id); setThreadId(null); }}><FolderOpen size={14} /><span>{p.name}</span></button>
          <button type="button" className="pc-icon subtle" aria-label={`${p.name} 목록에서 지우기`} onClick={() => void forget(p)}><X size={13} /></button>
        </div>
        {p.id === projectId && <ul className="pc-threads">
          <li><button type="button" className={"pc-thread new" + (!threadId ? " active" : "")} onClick={newThread}><MessageSquarePlus size={13} />새 대화</button></li>
          {projectThreads.map(t => <li key={t.id} className="pc-thread-row">
            <button type="button" className={"pc-thread" + (t.id === threadId ? " active" : "")} onClick={() => setThreadId(t.id)}>
              {t.running ? <LoaderCircle size={12} className="social-spin" aria-label="답하는 중" /> : <Bot size={12} />}
              <span>{t.title}</span><small>{t.agent === "claude" ? "Claude" : "Codex"}</small>
            </button>
            <button type="button" className="pc-icon subtle" aria-label={`${t.title} 대화 지우기`} disabled={t.running} onClick={() => void dropThread(t)}><Trash2 size={12} /></button>
          </li>)}
        </ul>}
      </li>)}</ul>}
      {listed && <DraftRecovery drafts={missingDrafts(drafts.entries(), projects, threads, missing ? slot : null)}
        projectName={id => projects.find(p => p.id === id)?.name ?? null}
        onDiscard={s => { const refused = drafts.discard(s); setDraftsVersion(v => v + 1); return refused; }} />}
    </nav>

    <div className="pc-main">
      {!project ? <div className="pc-welcome">
        <h2>앱 폴더를 넣고 채팅으로 만드세요</h2>
        <p>왼쪽에서 프로젝트를 추가하면 그 폴더에서 <strong>Claude Opus 5.5 (medium)</strong> 또는 Codex가 채팅으로 기획하고 코드를 고칩니다. Muse·OpenAI Dots·Grok Bot에게 기획을 맡기고 답장을 그대로 구현으로 넘길 수도 있습니다.</p>
        <button type="button" className="social-button primary" onClick={() => setAdding(true)}><FolderPlus size={16} />프로젝트 추가</button>
      </div> : <>
        <header className="pc-head">
          <div className="pc-title"><strong>{missing ? "원래 대화를 찾을 수 없음" : thread?.title ?? "새 대화"}</strong><span title={project.folder}>{project.name} · {AGENT_LABELS[agent]}</span></div>
          <div className="pc-head-actions">
            <div className="pc-segment" role="group" aria-label="모드">{(["plan", "edit"] as ChatMode[]).map(m =>
              <button key={m} type="button" aria-pressed={mode === m} disabled={busy || !!thread?.running} title={MODE_LABELS[m]} onClick={() => setMode(m)}>{m === "plan" ? "기획" : "편집"}</button>)}</div>
            {thread && <button type="button" className="social-button compact" aria-expanded={showInbox} onClick={() => { setShowInbox(v => !v); void loadPeers(); }}><Inbox size={12} />받은 기획 가져오기</button>}
            {thread?.running && <button type="button" className="social-button compact" onClick={() => void run(() => stopTurn(thread.id))}><Square size={12} />중지</button>}
            {!showChanges && <button type="button" className="pc-icon" aria-label="변경 사항 열기" onClick={() => setShowChanges(true)}><PanelRightOpen size={16} /></button>}
          </div>
        </header>
        <div className="pc-workdir" aria-label="작업 폴더">
          <GitBranch size={13} />
          {thread?.worktree ? <>
            <span>작업 폴더 <strong title={thread.worktree.path}>{thread.worktree.path.split("/").pop()}</strong></span>
            <span className="pc-workdir-tag">{thread.worktree.branch ?? "분리된 HEAD"}</span>
            <span title={thread.worktree.base}>기준 {thread.worktree.base.slice(0, 7)}</span>
            <span className="pc-workdir-origin" title={project.folder}>원본 {project.folder}</span>
          </> : <span title={project.folder}>작업 폴더: 원본 프로젝트 폴더 <code>{project.folder}</code></span>}
          {!started && <button type="button" className="social-button compact" disabled={busy || missing} onClick={attachWorktree}><FolderOpen size={12} />{thread?.worktree ? "다른 worktree로 바꾸기" : "기존 worktree 연결"}</button>}
          {!started && !thread?.worktree && <button type="button" className="social-button compact" disabled={busy || !!plan || missing} onClick={isolate}><GitBranchPlus size={12} />격리된 새 대화</button>}
          {started && thread?.worktree && <span className="pc-workdir-fixed">대화 시작 후 고정</span>}
        </div>
        {thread && <ThreadPreview key={thread.id} thread={thread} onSaved={upsert} />}
        {plan && <div className="pc-plan" role="group" aria-label="새 worktree 계획">
          <p><strong>이 대화용 새 브랜치와 worktree를 만듭니다.</strong> 만들기를 누르면 확인 창이 한 번 더 뜹니다.</p>
          <dl>
            <dt>원본</dt><dd title={plan.plan.projectFolder}>{plan.plan.projectFolder}</dd>
            <dt>새 폴더</dt><dd title={plan.plan.path}>{plan.plan.path}</dd>
            <dt>새 브랜치</dt><dd>{plan.plan.branch}</dd>
            <dt>기준 HEAD</dt><dd title={plan.plan.base}>{plan.plan.base.slice(0, 12)}</dd>
          </dl>
          <p className="pc-muted">마지막 커밋에서 시작합니다. 원본의 커밋하지 않은 변경, .env 같은 파일, 설치한 의존성은 옮기지 않고, 원본 폴더도 바꾸지 않습니다.</p>
          <div className="pc-plan-actions">
            <button type="button" className="social-button primary compact" disabled={busy} onClick={confirmPlan}>{busy ? <LoaderCircle size={12} className="social-spin" /> : <GitBranchPlus size={12} />}만들기</button>
            <button type="button" className="social-button compact" disabled={busy} onClick={() => void dropPlan(plan)}>취소</button>
          </div>
        </div>}
        {projectLeftovers.length > 0 && <div className="pc-leftovers" role="group" aria-label="끝나지 않은 worktree 생성">
          <p><CircleAlert size={13} /> 만들다 멈춘 worktree가 있습니다. Studio는 폴더나 브랜치를 지우지 않습니다.</p>
          <ul>{projectLeftovers.map(left => <li key={left.id}>
            <div><strong title={left.path}>{left.path}</strong> <span className="pc-workdir-tag">{left.branch}</span><p className="pc-muted">{left.guidance}</p></div>
            <div className="pc-plan-actions">
              {left.state === "ready" && <button type="button" className="social-button compact" disabled={busy} onClick={() => continueLeftover(left)}>새 대화로 이어서 연결</button>}
              <button type="button" className="social-button compact" disabled={busy} onClick={() => forgetLeftover(left)}>기록 지우기</button>
            </div>
          </li>)}</ul>
        </div>}
        {showInbox && thread && <div className="pc-inbox" aria-label="받은 메시지">
          <p className="pc-muted">Muse·Dots·Grok 같은 어시스턴트가 코드 없이 Studio로 보낸 기획을 이 대화에 붙입니다. 붙여도 자동으로 실행하지 않습니다.</p>
          {!unlinked.length && <p className="pc-muted">가져올 메시지가 없습니다.</p>}
          <ul>{unlinked.map(m => <li key={m.id}>
            <div><strong>{m.fromName ?? m.from}</strong><small title={m.from}>{m.from}{m.createdAt ? " · " + time(m.createdAt) : ""}</small><p>{m.text.length > 280 ? m.text.slice(0, 280) + "…" : m.text}</p></div>
            <button type="button" className="social-button compact" disabled={busy} onClick={() => pull(m)}>이 대화에 붙이기</button>
          </li>)}</ul>
        </div>}
        <div className="pc-transcript" aria-live="polite">
          {!items.length && <div className="pc-empty">
            <p><strong>{project.name}</strong>에서 무엇을 만들까요?</p>
            <ul>
              <li><button type="button" onClick={() => edit(joinDraft(text, "이 프로젝트 구조를 살펴보고 다음에 만들 기능을 기획해줘."))}>프로젝트를 살펴보고 다음 기능 기획</button></li>
              <li><button type="button" onClick={() => edit(joinDraft(text, "README와 설정을 확인하고 앱을 실행하는 방법을 알려줘."))}>실행 방법 확인</button></li>
              <li><button type="button" onClick={() => edit(joinDraft(text, "테스트를 실행하고 실패하는 것을 고쳐줘."))}>테스트 실행 후 실패 수정</button></li>
            </ul>
          </div>}
          {rows.map(row => row.type === "tool" ? <ToolRow key={row.call.id} call={row.call} result={row.result} /> : <ItemRow key={row.item.id} item={row.item} requests={requests} onImplement={implement} onReply={answer} />)}
          {thread?.running && <div className="pc-working"><LoaderCircle size={14} className="social-spin" />{AGENT_LABELS[thread.agent]}이(가) 작업 중입니다</div>}
          {thread && requests.length > 0 && <div className="pc-planner-check" aria-label="기획 답장 확인">
            <div className="pc-working">
              {waitingPeer ? <><LoaderCircle size={14} className="social-spin" />기획 답장을 기다리는 중입니다 · 남은 요청 {openRequests}/{requests.length}개 (Reason Network, 8초마다 확인)</>
                : <><CircleCheck size={14} />기다리는 기획 요청이 없습니다 ({requests.length}개 중 남은 요청 0개)</>}
              <button type="button" className="social-button compact" disabled={!!shownCheck?.checking} onClick={() => void checkReplies(thread.id, true)}>
                {shownCheck?.checking ? <LoaderCircle size={12} className="social-spin" /> : <RefreshCw size={12} />}기획 답장 확인</button>
            </div>
            {shownCheck?.error && <p className="pc-error" role="alert"><CircleAlert size={14} />{shownCheck.error}</p>}
            {shownCheck && !shownCheck.error && shownCheck.found !== null && !shownCheck.checking && <p className="pc-muted" role="status">{shownCheck.found ? `새 기획 답장 ${shownCheck.found}개를 가져왔습니다` : "새 기획 답장이 없습니다"} · {time(shownCheck.at)} 확인</p>}
          </div>}
          <div ref={endRef} />
        </div>
        {error && <p className="pc-error" role="alert"><CircleAlert size={14} />{error}<button type="button" className="pc-icon subtle" aria-label="닫기" onClick={() => setFailure(null)}><X size={12} /></button></p>}
        <form className="pc-composer" onSubmit={submit}>
          {missing && slot && <div className="pc-missing" role="status">
            <span><CircleAlert size={13} /> 원래 대화를 목록에서 찾을 수 없습니다. 삭제됐는지는 확인할 수 없어 초안을 그대로 둡니다. 여기서는 보내지 않으니 복사해 원하는 대화에서 직접 보내세요.</span>
            <div className="pc-missing-actions">
              <button type="button" className="social-button compact" disabled={!text} onClick={() => void copyDraft(text).then(() => setMissingNote({ slot, text: COPIED_NOTE })).catch(cause => setMissingNote({ slot, text: errorText(cause) }))}><Copy size={12} />초안 복사</button>
              <button type="button" className="social-button compact" onClick={newThread}><MessageSquarePlus size={12} />새 대화 열기</button>
              <button type="button" className="social-button compact" disabled={!drafts.get(slot)} onClick={() => {
                if (!window.confirm(DISCARD_CONFIRM)) return;
                const refused = drafts.discard(slot);
                if (refused) setMissingNote({ slot, text: refused }); else { setMissingNote(null); setText(""); setDraftsVersion(v => v + 1); }
              }}><Trash2 size={12} />이 기기의 초안만 지우기</button>
            </div>
            {missingNote?.slot === slot && <span role="status">{missingNote.text}</span>}
          </div>}
          {replyTo && <div className="pc-replying" role="status"><Reply size={13} />{replyTo.peerName ?? replyTo.peer}에게 답장 · Reason Network로 보내며, 상대는 check_inbox로 받습니다
            <button type="button" className="pc-icon subtle" aria-label="답장 취소" onClick={() => setReplyTo(null)}><X size={12} /></button></div>}
          <PendingAttachments files={attachments} busy={busy} onRemove={detach} />
          {!!attachments.length && !canAttach && <p className="pc-muted pc-attach-note" role="status">Reason Network 피어와 답장에는 첨부를 보낼 수 없습니다. 첨부를 빼거나 구현 에이전트·호스팅 어시스턴트를 고르세요.</p>}
          {draftNote && <p className="pc-muted pc-attach-note" role="status"><CircleAlert size={12} /> {draftNote}</p>}
          <textarea ref={inputRef} value={text} onChange={event => edit(event.target.value)} onKeyDown={onKey} onKeyUp={() => imeGuard.current.onKeyUp()}
            onCompositionEnd={() => imeGuard.current.onCompositionEnd()} onInput={event => imeGuard.current.onInput(event.nativeEvent as InputEvent)} rows={3}
            placeholder={replyTo ? "답장 내용을 입력하세요" : target.startsWith("hosted:") ? "어시스턴트에게 맡길 기획 요청을 입력하세요 (전달문을 만들어 드립니다)" : target === "agent" ? (mode === "plan" ? "질문하거나 기획을 요청하세요 (파일은 바꾸지 않습니다)" : "만들거나 고칠 내용을 입력하세요") : "기획자에게 보낼 요청을 입력하세요"} aria-label="메시지" />
          <div className="pc-composer-bar">
            <select value={target === "agent" ? "agent:" + agent : target} aria-label="받는 에이전트" disabled={busy || !!replyTo}
              onChange={event => { const v = event.target.value; if (v.startsWith("agent:")) { setTarget("agent"); if (!thread) setNewAgent(v.slice(6) as ChatAgent); } else setTarget(v); }}>
              <optgroup label="구현 · 이 폴더에서 실행">
                {(["claude", "codex"] as ChatAgent[]).map(a => <option key={a} value={"agent:" + a} disabled={!!thread && thread.agent !== a}>{AGENT_LABELS[a]}</option>)}
              </optgroup>
              <optgroup label="기획 · 호스팅 어시스턴트 (전달문 복사)">
                {HOSTED_ASSISTANTS.map(a => <option key={a} value={"hosted:" + a}>{HOSTED_LABELS[a]}</option>)}
              </optgroup>
              <optgroup label={peers.length ? "기획 · Reason Network" : "기획 · Reason Network 연결 없음"}>
                {sortedPeers.map(p => <option key={p.id} value={p.id}>{p.name}{PLANNER.test(p.name) ? " (추천)" : ""}{p.machine ? ` · ${p.machine}` : ""}</option>)}
              </optgroup>
            </select>
            <button type="button" className="pc-icon" aria-label="Reason Network 에이전트 새로고침" onClick={() => void loadPeers()}><RefreshCw size={13} /></button>
            <button type="button" className="social-button compact" disabled={busy || missing || !canAttach || !!attachBlocked} onClick={attach}
              title={!canAttach ? "구현 에이전트나 호스팅 어시스턴트에게 보낼 때만 첨부할 수 있습니다" : attachBlocked ?? "이 대화의 작업 폴더 안 UTF-8 텍스트 파일 (파일당 8KiB, 최대 4개·합계 16KiB)"}><Paperclip size={12} />파일 첨부</button>
            <span className="pc-hint">{replyTo ? "보낸 쪽에게만 답장" : target === "agent" ? (mode === "edit" ? "편집: 이 폴더의 파일을 묻지 않고 수정" : "기획: 읽기만 함") : target.startsWith("hosted:") ? "전달문을 만들고, 코드가 붙은 답장을 이 대화에 표시" : "답장이 오면 이 대화에 표시"} · Enter 보내기{text && !draftNote ? " · " + DRAFT_SAVED : ""}</span>
            <button type="submit" className="social-button primary compact" disabled={busy || missing || !text.trim() || target === "agent" && !replyTo && !!thread?.running || !!attachments.length && !canAttach}>
              {busy ? <LoaderCircle size={14} className="social-spin" /> : <Send size={14} />}보내기</button>
          </div>
        </form>
      </>}
    </div>
    {project && showChanges && <ChangesPanel key={thread?.worktree?.path ?? project.folder} project={project} thread={thread ?? null} refreshKey={changesKey} onClose={() => setShowChanges(false)} />}
  </section>;
}
