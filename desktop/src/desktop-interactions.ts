export function createSingleFlight<T>() {
  let pending: Promise<T> | null = null;
  function run(read: () => Promise<T>): Promise<T> {
    if (!pending) {
      const request = Promise.resolve().then(read);
      pending = request;
      const release = () => { if (pending === request) pending = null; };
      void request.then(release, release);
    }
    return pending;
  }
  // A completed write makes an earlier snapshot obsolete. Old consumers retain
  // their own promise, while the next read must fetch the committed state.
  run.invalidate = () => { pending = null; };
  return run;
}

export function commandShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "isComposing" | "repeat">): "open" | null {
  return !event.repeat && !event.isComposing && !event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" ? "open" : null;
}

export function filterCommands<T extends { label: string; group: string }>(items: readonly T[], query: string): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item => terms.every(term => `${item.label} ${item.group}`.toLocaleLowerCase().includes(term)));
}

export function moveCommandSelection(current: number, direction: 1 | -1, length: number) {
  return length > 0 ? ((current + direction) % length + length) % length : 0;
}
