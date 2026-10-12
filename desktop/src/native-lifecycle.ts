/** Own resources as soon as they exist, including late async listener registrations. */
export function createDisposalScope() {
  let disposed = false;
  const cleanups = new Set<() => void>();
  const add = (cleanup: () => void | Promise<void>) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      cleanups.delete(release);
      // The Tauri UnlistenFn type returns void, but its native unregister
      // implementation can return a promise. Invoke immediately, and consume
      // asynchronous failure so window teardown cannot leak a rejection.
      const pending = cleanup();
      if (pending) void Promise.resolve(pending).catch(() => {});
    };
    if (disposed) release();
    else cleanups.add(release);
    return release;
  };
  return {
    active: () => !disposed,
    add,
    dispose() {
      if (disposed) return;
      disposed = true;
      // Reverse allocation order, and do not let one failed native unlisten keep
      // unrelated observers, timers or GPU resources alive.
      for (const cleanup of [...cleanups].reverse()) {
        try { cleanup(); } catch { /* Continue releasing the remaining resources. */ }
      }
    }
  };
}

/** A view's slow old read must neither overwrite nor lock its next activation. */
export function createPanelReadGate() {
  let active = false;
  let epoch = 0;
  let pending: number | null = null;
  const invalidate = () => { ++epoch; pending = null; };
  return {
    activate() { active = true; invalidate(); },
    deactivate() { active = false; invalidate(); },
    begin() {
      if (!active || pending !== null) return null;
      const request = ++epoch;
      pending = request;
      return {
        current: () => active && request === epoch,
        finish() { if (pending === request) pending = null; }
      };
    }
  };
}
