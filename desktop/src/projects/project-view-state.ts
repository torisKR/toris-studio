// Which conversation a late answer belongs to.
//
// The project screen switches between conversations while reads, sends, planner syncs and
// diffs are still on their way. Each of them captures the screen it was asked from, and its
// result is applied only where it belongs: items to their own thread, a snapshot only to the
// screen that asked (never after it was left, even if reopened), a diff only if no newer one
// was asked for, and composer or error changes only to the conversation that sent.
import { mergeItems, type ChatItem } from "./project-chat-client";

/** The screen being shown: a thread, or a project's unsaved new conversation. */
export type View = { projectId: string | null; threadId: string | null };
/** One key per screen; also the key of that screen's draft. */
export const viewKey = (view: View): string => view.threadId ?? "new:" + (view.projectId ?? "");

/** The screen an async step started from, and how many times the screen changed before it. */
export type Ticket = { readonly key: string; readonly gen: number };

/** Follows the shown screen so a late result can tell whether its screen is still open. */
export class ViewTracker {
  #key: string;
  #gen = 0;
  constructor(view: View) { this.#key = viewKey(view); }
  /** Record the shown screen; leaving it starts a new generation, coming back too. */
  show(view: View): void {
    const key = viewKey(view);
    if (key !== this.#key) { this.#key = key; this.#gen++; }
  }
  get key(): string { return this.#key; }
  ticket(): Ticket { return { key: this.#key, gen: this.#gen }; }
  /** The screen was never left since the ticket: for results that replace what is shown. */
  fresh(ticket: Ticket): boolean { return ticket.key === this.#key && ticket.gen === this.#gen; }
  /** The same screen is shown now, even after leaving and coming back: for results merged by item ID. */
  showing(ticket: Ticket | string): boolean { return (typeof ticket === "string" ? ticket : ticket.key) === this.#key; }
}

/** The items on screen and the thread they belong to. */
export type Transcript = { threadId: string | null; items: ChatItem[] };
export const EMPTY_TRANSCRIPT: Transcript = { threadId: null, items: [] };

const NO_ITEMS: ChatItem[] = [];
/** What the transcript shows for `shown`: nothing while it still holds another thread's rows. */
export const itemsFor = (transcript: Transcript, shown: string | null): ChatItem[] =>
  shown && transcript.threadId === shown ? transcript.items : NO_ITEMS;

/**
 * Items of `threadId` (streamed, sent, synced or linked) added to what is shown, by item ID.
 * Items of a thread that is not shown are dropped: its stored record shows them when opened.
 */
export function addItems(transcript: Transcript, shown: string | null, threadId: string, incoming: ChatItem[]): Transcript {
  if (!shown || threadId !== shown) return transcript;
  const base = itemsFor(transcript, shown);
  const items = mergeItems(base, incoming);
  return transcript.threadId === shown && items === base ? transcript : { threadId: shown, items };
}

/**
 * The stored record of the shown thread: its items in stored order, then items that arrived
 * live before it and are not in it yet, so a late snapshot never hides a newer live item.
 * The caller applies it only while its ticket is fresh.
 */
export function applySnapshot(transcript: Transcript, shown: string | null, threadId: string, stored: ChatItem[]): Transcript {
  if (!shown || threadId !== shown) return transcript;
  return { threadId: shown, items: mergeItems(stored, itemsFor(transcript, shown)) };
}

/** An error shown only on the screen whose work failed. */
export type Failure = { key: string; text: string } | null;
export const failureText = (failure: Failure, key: string): string => failure && failure.key === key ? failure.text : "";

/** Numbers each request of one kind; only the latest one's answer may be shown. */
export class LatestRequest {
  #n = 0;
  begin(): number { return ++this.#n; }
  isLatest(n: number): boolean { return n === this.#n; }
}
