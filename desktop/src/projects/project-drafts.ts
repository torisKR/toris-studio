// Composer drafts, one per conversation, kept in this device's localStorage.
//
// Only the text the user typed is stored: no attachment bytes or paths, no reply target, no
// agent or mode, nothing read from files or the clipboard. A draft is keyed by project ID and
// thread ID (a project's unsaved "새 대화" has its own key), so drafts never cross conversations.
// The in-memory copy is what the screen shows; storage that is missing, broken or full only
// costs the copy on disk, never what is typed, and says so.

/** The one localStorage entry holding every draft. */
export const DRAFTS_STORAGE_KEY = "toris.projects.drafts.v1";
/** Same as the host's send limit (MAX_PROMPT_BYTES in project_chat.rs). */
export const MAX_DRAFT_BYTES = 32 * 1024;
/** All drafts together, as UTF-8 bytes of their text. */
export const MAX_DRAFTS_BYTES = 256 * 1024;
export const MAX_DRAFTS = 200;

export const DRAFT_SAVED = "초안은 이 기기에만 저장됩니다";
export const DRAFT_UNAVAILABLE = "이 기기에 초안을 저장할 수 없습니다. 입력한 내용은 화면에 남지만 앱을 닫으면 사라집니다.";
export const DRAFT_CORRUPT = "저장된 초안을 읽지 못해 비웠습니다. 지금 입력하는 내용은 다시 저장됩니다.";
export const DRAFT_TOO_LONG = `초안이 전송 한도(${MAX_DRAFT_BYTES / 1024}KiB)를 넘어 이 기기에 저장하지 않았습니다. 화면의 내용은 그대로입니다.`;
export const DRAFT_FULL = "초안 저장 공간이 가득 차 이 초안은 이 기기에 저장하지 않았습니다. 화면의 내용은 그대로입니다.";
export const DRAFT_WRITE_FAILED = "초안을 이 기기에 저장하지 못했습니다. 화면의 내용은 그대로입니다.";

/** The subset of Storage the drafts use; tests pass their own. */
export type DraftStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
type Entry = { text: string; at: number };

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** One key per conversation: the project and its thread, or `null` for the unsaved new conversation. */
export function draftSlot(projectId: string, threadId: string | null): string {
  return JSON.stringify([projectId, threadId]);
}
function parseSlot(slot: string): [string, string | null] | null {
  try {
    const value: unknown = JSON.parse(slot);
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && value[0] && (value[1] === null || typeof value[1] === "string" && value[1])) return [value[0], value[1]];
  } catch { /* not a slot */ }
  return null;
}

/** A draft kept on this device, with the conversation it was typed for. */
export type StoredDraft = { slot: string; projectId: string; threadId: string | null; text: string; at: number };

/**
 * Drafts whose conversation is not in the list shown now (a thread missing from its project, or a
 * project missing from the list), newest first. Being missing from one list read is not proof that
 * the conversation was deleted (a read can fail or come back empty), so this only finds them:
 * nothing here removes a draft. `except` leaves out the conversation already on screen.
 */
export function missingDrafts(
  drafts: StoredDraft[],
  projects: ReadonlyArray<{ id: string }>,
  threads: ReadonlyArray<{ id: string; projectId: string }>,
  except: string | null = null
): StoredDraft[] {
  return drafts.filter(d => d.slot !== except && (d.threadId === null
    ? !projects.some(p => p.id === d.projectId)
    : !threads.some(t => t.id === d.threadId && t.projectId === d.projectId)));
}

/** A planner prompt added to a draft that already has text goes after it, never over it. */
export function joinDraft(current: string, added: string): string {
  if (!current.trim()) return added;
  if (current.includes(added)) return current;
  return current.trimEnd() + "\n\n" + added;
}

/** localStorage when the page may use it, otherwise null. */
export function browserStorage(): DraftStorage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

export class DraftStore {
  readonly #storage: DraftStorage | null;
  /** What the screen shows for each conversation, saved or not. */
  readonly #drafts = new Map<string, Entry>();
  /** What is on disk now. */
  #saved = new Map<string, Entry>();
  readonly #notes = new Map<string, string>();
  #loadNote: string | null = null;
  #clock: () => number;

  constructor(storage: DraftStorage | null, clock: () => number = Date.now) {
    this.#storage = storage;
    this.#clock = clock;
    if (!storage) { this.#loadNote = DRAFT_UNAVAILABLE; return; }
    let raw: string | null;
    try { raw = storage.getItem(DRAFTS_STORAGE_KEY); } catch { this.#loadNote = DRAFT_UNAVAILABLE; return; }
    if (raw === null) return;
    const loaded = DraftStore.#parse(raw);
    if (!loaded) { this.#loadNote = DRAFT_CORRUPT; return; }
    this.#saved = loaded;
    for (const [slot, entry] of loaded) this.#drafts.set(slot, entry);
  }

  static #parse(raw: string): Map<string, Entry> | null {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return null; }
    if (!value || typeof value !== "object" || (value as { v?: unknown }).v !== 1) return null;
    const drafts = (value as { drafts?: unknown }).drafts;
    if (!drafts || typeof drafts !== "object" || Array.isArray(drafts)) return null;
    const out = new Map<string, Entry>();
    let total = 0;
    // Newest first, so a stored set that is somehow too large keeps the recent drafts.
    const entries = Object.entries(drafts as Record<string, unknown>)
      .filter((e): e is [string, Entry] => {
        const entry = e[1] as Partial<Entry> | null;
        return !!parseSlot(e[0]) && !!entry && typeof entry.text === "string" && !!entry.text && typeof entry.at === "number" && Number.isFinite(entry.at);
      })
      .sort((a, b) => b[1].at - a[1].at);
    for (const [slot, entry] of entries) {
      const size = bytes(entry.text);
      if (size > MAX_DRAFT_BYTES || total + size > MAX_DRAFTS_BYTES || out.size >= MAX_DRAFTS) continue;
      total += size;
      out.set(slot, { text: entry.text, at: entry.at });
    }
    return out;
  }

  /** A problem reading the stored drafts at start, if any. */
  get loadNote(): string | null { return this.#loadNote; }
  /** Why this conversation's draft is not on disk, or the start-up problem; null when it is saved. */
  note(slot: string): string | null { return this.#notes.get(slot) ?? this.#loadNote; }

  get(slot: string): string { return this.#drafts.get(slot)?.text ?? ""; }

  /** Every draft this device holds now (saved or only on screen), newest first. */
  entries(): StoredDraft[] {
    const out: StoredDraft[] = [];
    for (const [slot, entry] of this.#drafts) {
      const key = parseSlot(slot);
      if (key) out.push({ slot, projectId: key[0], threadId: key[1], text: entry.text, at: entry.at });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /**
   * The user chose to throw away this one draft on this device. Only `slot` goes; if the device
   * refuses the write, the draft stays (on screen and on disk) and the note says why.
   */
  discard(slot: string): string | null {
    if (!this.#storage) { this.#drafts.delete(slot); this.#notes.delete(slot); return null; }
    const next = new Map(this.#saved);
    next.delete(slot);
    const note = this.#write(next);
    if (note) return note;
    this.#drafts.delete(slot);
    this.#notes.delete(slot);
    return null;
  }

  /** Keeps `text` as this conversation's draft and saves it if it fits. Returns the note, if any. */
  set(slot: string, text: string): string | null {
    if (text) this.#drafts.set(slot, { text, at: this.#clock() }); else this.#drafts.delete(slot);
    const next = new Map(this.#saved);
    next.delete(slot);
    let note: string | null = null;
    if (text) {
      const size = bytes(text);
      const others = [...next.values()].reduce((sum, e) => sum + bytes(e.text), 0);
      if (size > MAX_DRAFT_BYTES) note = DRAFT_TOO_LONG;
      else if (others + size > MAX_DRAFTS_BYTES || next.size >= MAX_DRAFTS) note = DRAFT_FULL;
      else next.set(slot, this.#drafts.get(slot)!);
    }
    note = this.#write(next) ?? note;
    if (note) this.#notes.set(slot, note); else this.#notes.delete(slot);
    return note;
  }

  /**
   * After a send succeeded: drops this conversation's draft only if it is still the text that was
   * sent. Text typed while it was sending stays. Returns whether the draft was cleared.
   */
  clearSent(slot: string, sent: string): boolean {
    if (this.get(slot) !== sent) return false;
    this.set(slot, "");
    return true;
  }

  /** The new conversation became a thread: its draft moves with it. */
  move(from: string, to: string): void {
    if (from === to) return;
    const text = this.get(from);
    this.set(from, "");
    if (text) this.set(to, text);
  }

  /** A deleted conversation's draft, and nothing else. */
  removeThread(projectId: string, threadId: string): void { this.set(draftSlot(projectId, threadId), ""); }

  /** Every draft of a project removed from the list, and nothing else. */
  removeProject(projectId: string): void {
    for (const slot of new Set([...this.#drafts.keys(), ...this.#saved.keys()])) if (parseSlot(slot)?.[0] === projectId) this.set(slot, "");
  }

  #write(next: Map<string, Entry>): string | null {
    if (!this.#storage) return DRAFT_UNAVAILABLE;
    try {
      if (next.size) this.#storage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ v: 1, drafts: Object.fromEntries(next) }));
      else this.#storage.removeItem(DRAFTS_STORAGE_KEY);
    } catch { return DRAFT_WRITE_FAILED; }
    this.#saved = next;
    // A good write replaces whatever could not be read at start.
    if (this.#loadNote === DRAFT_CORRUPT) this.#loadNote = null;
    return null;
  }
}
