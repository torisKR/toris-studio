import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Bot, Check, Inbox, ChevronDown, Copy, Reply, ChevronRight, CircleAlert, FileDiff, FolderOpen, FolderPlus, GitBranch, LoaderCircle, MessageSquarePlus, PanelRightClose, PanelRightOpen, RefreshCw, Search, Send, Sparkles, Square, Trash2, Wrench, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { refreshNetwork } from "../reason/reason-client";
import type { ReasonMessage, ReasonPeer } from "../reason/types";
import {
  addProject, AGENT_LABELS, askHosted, askPeer, awaitingPlanner, HOSTED_ASSISTANTS, HOSTED_LABELS, linkMessage, linkWorktree, threadStarted, createThread, deleteThread, diffLines, implementationPrompt, listProjects, mergeItems, MODE_LABELS, normalizeEvent, readChanges,
  readThread, removeProject, searchProjects, sendMessage, sortThreads, stopTurn, syncPeers, toRows, updateThread,
  type ChatAgent, type ChatItem, type HostedAssistant, type ChatMode, type Changes, type Project, type SearchHit, type Thread
} from "./project-chat-client";
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

function HostedRequestCard({ item }: { item: ChatItem }) {
  const [copied, setCopied] = useState("");
  const copy = () => void invoke("copy_text", { text: item.prompt ?? "" })
    .then(() => setCopied("복사했습니다. " + (item.peerName ?? "어시스턴트") + "에 붙여넣으세요."))
    .catch(cause => setCopied(errorText(cause)));
  return <div className="pc-msg user peer hosted">
    <span className="pc-peer-label"><Sparkles size={12} />{item.peerName ?? "어시스턴트"}에게 기획 요청 · <code>{item.code}</code></span>
    <div className="pc-bubble">{item.text}</div>
    <div className="pc-hosted">
      <p>{item.peerName ?? "어시스턴트"}는 이름으로 메시지를 받을 수 없어서, 이 전달문을 그 앱에 붙여넣어야 합니다. 첫 줄에 코드를 붙여 Studio로 보낸 기획만 이 대화에 표시됩니다.</p>
      <details><summary>전달문 보기</summary><pre>{item.prompt}</pre></details>
      <div className="pc-hosted-actions">
        <button type="button" className="social-button compact primary" onClick={copy} disabled={!item.prompt}>{copied.startsWith("복사") ? <Check size={13} /> : <Copy size={13} />}전달문 복사</button>
        {copied && <span role="status">{copied}</span>}
      </div>
    </div>
  </div>;
}

function ItemRow({ item, onImplement, onReply }: { item: ChatItem; onImplement: (item: ChatItem) => void; onReply: (item: ChatItem) => void }) {
  switch (item.kind) {
    case "user": return <div className="pc-msg user"><div className="pc-bubble">{item.text}</div></div>;
    case "assistant": return <div className="pc-msg assistant"><Markdown text={item.text} /></div>;
    case "thinking": return <details className="pc-thinking"><summary>생각</summary><p>{item.text}</p></details>;
    case "result": return <div className="pc-result">{item.text}</div>;
    case "notice": return <div className={"pc-notice" + (item.isError ? " warn" : "")}>{item.text}</div>;
    case "error": return <div className="pc-notice error" role="alert"><CircleAlert size={14} />{item.text}</div>;
    case "tool_result": return <div className={"pc-tool" + (item.isError ? " error" : "")}><pre>{item.text}</pre></div>;
    case "peer_request": return <div className="pc-msg user peer"><span className="pc-peer-label"><Sparkles size={12} />{item.peerName ?? item.peer}에게 보냄</span><div className="pc-bubble">{item.text}</div></div>;
    case "hosted_request": return <HostedRequestCard item={item} />;
    case "peer_reply": return <div className="pc-msg peer-reply">
      <span className="pc-peer-label" title={item.peer}><Sparkles size={12} />{item.peerName ?? item.peer}의 기획 · {time(item.at)}</span>
      <Markdown text={item.text} />
      <div className="pc-reply-actions">
        <button type="button" className="social-button compact primary" onClick={() => onImplement(item)}><Wrench size={13} />이 기획으로 구현</button>
        {item.peer && item.messageId && <button type="button" className="social-button compact" onClick={() => onReply(item)}><Reply size={13} />답장</button>}
      </div>
    </div>;
    default: return null;
  }
}

function ChangesPanel({ project, threadId, refreshKey, onClose }: { project: Project; threadId: string | null; refreshKey: number; onClose: () => void }) {
  const [changes, setChanges] = useState<Changes | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setChanges(await readChanges(project.id, undefined, threadId ?? undefined)); } catch (cause) { setChanges(null); setError(errorText(cause)); } finally { setLoading(false); }
  }, [project.id, threadId]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  const lines = useMemo(() => diffLines(changes?.diff ?? ""), [changes?.diff]);
  return <aside className="pc-changes" aria-label="변경 사항">
    <header><strong><FileDiff size={15} />변경 사항</strong>
      <span>{changes?.branch && <><GitBranch size={12} />{changes.branch}</>}</span>
      <button type="button" className="pc-icon" aria-label="변경 사항 새로고침" onClick={() => void load()} disabled={loading}>{loading ? <LoaderCircle size={14} className="social-spin" /> : <RefreshCw size={14} />}</button>
      <button type="button" className="pc-icon" aria-label="변경 사항 닫기" onClick={onClose}><PanelRightClose size={15} /></button>
    </header>
    {changes?.folder && changes.folder !== project.folder && <p className="pc-muted pc-changes-folder" title={changes.folder}>worktree: {changes.folder}</p>}
    {error && <p className="pc-error" role="alert">{error}</p>}
    {changes && !changes.isRepo && <p className="pc-muted">git 저장소가 아니어서 변경 사항을 보여 줄 수 없습니다.</p>}
    {changes?.isRepo && !changes.files.length && <p className="pc-muted">바뀐 파일이 없습니다.</p>}
    {!!changes?.files.length && <ul className="pc-files">{changes.files.map(file => <li key={file}><code>{file.slice(0, 2)}</code><span>{file.slice(3)}</span></li>)}</ul>}
    {!!changes?.diff && <pre className="pc-diff">{lines.map((line, i) => <span key={i} className={line.kind}>{line.text + "\n"}</span>)}</pre>}
    {changes?.truncated && <p className="pc-muted">diff가 커서 앞부분만 표시합니다.</p>}
  </aside>;
}

type Props = { active: boolean };
export function ProjectChat({ active }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [projectId, setProjectId] = useState<string | null>(() => { try { return localStorage.getItem("toris.projects.project"); } catch { return null; } });
  const [threadId, setThreadId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [text, setText] = useState("");
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
  const [error, setError] = useState("");
  const [showChanges, setShowChanges] = useState(true);
  const [changesKey, setChangesKey] = useState(0);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLUListElement>(null);
  const threadRef = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  threadRef.current = threadId;

  const project = projects.find(p => p.id === projectId) ?? null;
  const thread = threads.find(t => t.id === threadId) ?? null;
  const projectThreads = useMemo(() => threads.filter(t => t.projectId === projectId), [threads, projectId]);
  const found = useMemo(() => searchProjects(query, projects, threads), [query, projects, threads]);

  // Each thread (and each project's unsaved "새 대화") keeps its own draft, so opening another
  // thread from the sidebar or search never carries half-typed text into it.
  const draftKey = threadId ?? "new:" + (projectId ?? "");
  const drafts = useRef(new Map<string, string>());
  const draftKeyRef = useRef(draftKey);
  const textNow = useRef(text);
  const carryDraft = useRef(false);
  textNow.current = text;
  // A layout effect swaps the draft in the same commit that opens the thread, so its input never
  // shows empty (or the previous thread's text) for a frame.
  useLayoutEffect(() => {
    const previous = draftKeyRef.current;
    if (previous === draftKey) return;
    draftKeyRef.current = draftKey;
    if (carryDraft.current) { carryDraft.current = false; return; } // the new thread created by sending keeps its text
    drafts.current.set(previous, textNow.current);
    setText(drafts.current.get(draftKey) ?? "");
  }, [draftKey]);
  const sortedPeers = useMemo(() => [...peers].sort((a, b) => Number(PLANNER.test(b.name)) - Number(PLANNER.test(a.name))), [peers]);
  const run = async (task: () => Promise<void>) => { setBusy(true); setError(""); try { await task(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  const upsert = (next: Thread) => setThreads(current => sortThreads([next, ...current.filter(t => t.id !== next.id)]));

  const reload = useCallback(async () => {
    try {
      const data = await listProjects();
      setProjects(data.projects); setThreads(data.threads);
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
      if (event.kind === "items") { if (event.threadId === threadRef.current) setItems(current => mergeItems(current, event.items)); }
      else {
        setThreads(current => sortThreads(current.map(t => t.id === event.threadId ? { ...(event.thread ?? t), running: event.running } : t)));
        if (!event.running && event.threadId === threadRef.current) setChangesKey(k => k + 1);
      }
    }).then(unlisten => { if (alive) stop = unlisten; else unlisten(); }).catch(() => {});
    return () => { alive = false; stop?.(); };
  }, [active]);

  useEffect(() => {
    if (!threadId) { setItems([]); return; }
    let alive = true;
    void readThread(threadId).then(data => { if (alive) { setItems(data.items); upsert(data.thread); } }).catch(cause => alive && setError(errorText(cause)));
    return () => { alive = false; };
  }, [threadId]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [items.length, threadId]);

  // Planner replies arrive through Reason Network; check while a request is unanswered.
  const waitingPeer = useMemo(() => awaitingPlanner(items), [items]);
  useEffect(() => { setReplyTo(null); setShowInbox(false); }, [threadId]);
  const linked = useMemo(() => new Set(items.filter(i => i.kind === "peer_reply").map(i => i.messageId)), [items]);
  const unlinked = useMemo(() => inbox.filter(m => !linked.has(m.id)).slice(-20).reverse(), [inbox, linked]);
  const pull = (m: ReasonMessage) => thread && void run(async () => {
    const added = await linkMessage(thread.id, m.id);
    setItems(prev => mergeItems(prev, added));
    setShowInbox(false);
  });
  useEffect(() => {
    if (!active || !threadId || !waitingPeer) return;
    const timer = window.setInterval(() => { void syncPeers(threadId).then(fresh => fresh.length && setItems(current => mergeItems(current, fresh))).catch(() => {}); }, 8000);
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
    if (projectId === p.id) { setProjectId(null); setThreadId(null); }
    await reload();
  });
  const dropThread = (t: Thread) => run(async () => {
    if (!window.confirm(`"${t.title}" 대화를 지울까요?`)) return;
    await deleteThread(t.id);
    if (threadId === t.id) setThreadId(null);
    setThreads(current => current.filter(x => x.id !== t.id));
  });
  // Before a thread starts it may move into an existing git worktree of the project; the host
  // picks the folder in an OS dialog, verifies it with git and asks for confirmation.
  const started = threadStarted(thread, items);
  const attachWorktree = () => project && void run(async () => {
    let current = thread;
    const created = !current;
    if (!current) current = await createThread(project.id, newAgent, newMode);
    const linked = await linkWorktree(current.id, null).catch(async cause => { if (created) await deleteThread(current.id).catch(() => {}); throw cause; });
    if (!linked) { if (created) await deleteThread(current.id).catch(() => {}); return; }
    upsert(linked); setThreadId(linked.id); threadRef.current = linked.id; setChangesKey(k => k + 1);
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

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!project || !text.trim() || busy || thread?.running && target === "agent") return;
    const message = text;
    void run(async () => {
      let current = thread;
      if (!current) { current = await createThread(project.id, newAgent, newMode); upsert(current); carryDraft.current = true; setThreadId(current.id); threadRef.current = current.id; }
      if (replyTo?.peer && replyTo.messageId) {
        const sent = await askPeer(current.id, replyTo.peer, message, undefined, replyTo.messageId);
        setItems(prev => mergeItems(prev, sent));
        setReplyTo(null);
      } else if (target === "agent") {
        upsert(await sendMessage(current.id, message));
      } else if (target.startsWith("hosted:")) {
        const made = await askHosted(current.id, target.slice(7) as HostedAssistant, message);
        setItems(prev => mergeItems(prev, made));
      } else {
        const sent = await askPeer(current.id, target, message);
        setItems(prev => mergeItems(prev, sent));
      }
      setText("");
    });
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
  };
  const answer = (reply: ChatItem) => { setReplyTo(reply); inputRef.current?.focus(); };
  const implement = (reply: ChatItem) => void run(async () => {
    setReplyTo(null);
    setTarget("agent");
    if (thread && thread.mode !== "edit") upsert(await updateThread(thread.id, { mode: "edit" }));
    setText(implementationPrompt(reply));
    inputRef.current?.focus();
  });
  const setMode = (mode: ChatMode) => thread ? void run(async () => upsert(await updateThread(thread.id, { mode }))) : setNewMode(mode);
  const mode = thread?.mode ?? newMode;
  const agent = thread?.agent ?? newAgent;
  const rows = useMemo(() => toRows(items), [items]);

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
    </nav>

    <div className="pc-main">
      {!project ? <div className="pc-welcome">
        <h2>앱 폴더를 넣고 채팅으로 만드세요</h2>
        <p>왼쪽에서 프로젝트를 추가하면 그 폴더에서 <strong>Claude Opus 5.5 (medium)</strong> 또는 Codex가 채팅으로 기획하고 코드를 고칩니다. Muse·OpenAI Dots·Grok Bot에게 기획을 맡기고 답장을 그대로 구현으로 넘길 수도 있습니다.</p>
        <button type="button" className="social-button primary" onClick={() => setAdding(true)}><FolderPlus size={16} />프로젝트 추가</button>
      </div> : <>
        <header className="pc-head">
          <div className="pc-title"><strong>{thread?.title ?? "새 대화"}</strong><span title={project.folder}>{project.name} · {AGENT_LABELS[agent]}</span></div>
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
          {!started && <button type="button" className="social-button compact" disabled={busy} onClick={attachWorktree}><FolderOpen size={12} />{thread?.worktree ? "다른 worktree로 바꾸기" : "기존 worktree 연결"}</button>}
          {started && thread?.worktree && <span className="pc-workdir-fixed">대화 시작 후 고정</span>}
        </div>
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
              <li><button type="button" onClick={() => setText("이 프로젝트 구조를 살펴보고 다음에 만들 기능을 기획해줘.")}>프로젝트를 살펴보고 다음 기능 기획</button></li>
              <li><button type="button" onClick={() => setText("README와 설정을 확인하고 앱을 실행하는 방법을 알려줘.")}>실행 방법 확인</button></li>
              <li><button type="button" onClick={() => setText("테스트를 실행하고 실패하는 것을 고쳐줘.")}>테스트 실행 후 실패 수정</button></li>
            </ul>
          </div>}
          {rows.map(row => row.type === "tool" ? <ToolRow key={row.call.id} call={row.call} result={row.result} /> : <ItemRow key={row.item.id} item={row.item} onImplement={implement} onReply={answer} />)}
          {thread?.running && <div className="pc-working"><LoaderCircle size={14} className="social-spin" />{AGENT_LABELS[thread.agent]}이(가) 작업 중입니다</div>}
          {waitingPeer && <div className="pc-working"><LoaderCircle size={14} className="social-spin" />기획 답장을 기다리는 중입니다 (Reason Network, 8초마다 확인)</div>}
          <div ref={endRef} />
        </div>
        {error && <p className="pc-error" role="alert"><CircleAlert size={14} />{error}<button type="button" className="pc-icon subtle" aria-label="닫기" onClick={() => setError("")}><X size={12} /></button></p>}
        <form className="pc-composer" onSubmit={submit}>
          {replyTo && <div className="pc-replying" role="status"><Reply size={13} />{replyTo.peerName ?? replyTo.peer}에게 답장 · Reason Network로 보내며, 상대는 check_inbox로 받습니다
            <button type="button" className="pc-icon subtle" aria-label="답장 취소" onClick={() => setReplyTo(null)}><X size={12} /></button></div>}
          <textarea ref={inputRef} value={text} onChange={event => setText(event.target.value)} onKeyDown={onKey} rows={3}
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
            <span className="pc-hint">{replyTo ? "보낸 쪽에게만 답장" : target === "agent" ? (mode === "edit" ? "편집: 이 폴더의 파일을 묻지 않고 수정" : "기획: 읽기만 함") : target.startsWith("hosted:") ? "전달문을 만들고, 코드가 붙은 답장을 이 대화에 표시" : "답장이 오면 이 대화에 표시"} · Enter 보내기</span>
            <button type="submit" className="social-button primary compact" disabled={busy || !text.trim() || target === "agent" && !replyTo && !!thread?.running}>
              {busy ? <LoaderCircle size={14} className="social-spin" /> : <Send size={14} />}보내기</button>
          </div>
        </form>
      </>}
    </div>
    {project && showChanges && <ChangesPanel key={thread?.worktree?.path ?? project.folder} project={project} threadId={thread?.id ?? null} refreshKey={changesKey} onClose={() => setShowChanges(false)} />}
  </section>;
}
