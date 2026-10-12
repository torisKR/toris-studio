import { invoke } from "@tauri-apps/api/core";

export function createActivityReporter(write: (active: boolean) => Promise<unknown>) {
  const tokens = new Set<symbol>();
  let aggregate = false, desired = false, acknowledged: boolean | undefined;
  let writing = false;
  function flush() {
    if (writing || acknowledged === desired) return;
    writing = true;
    const active = desired;
    void Promise.resolve().then(() => write(active)).then(
      () => { acknowledged = active; },
      () => { acknowledged = undefined; }
    ).finally(() => {
      writing = false;
      if (desired !== active) flush();
    });
  }
  function update() { desired = aggregate || tokens.size > 0; flush(); }
  return {
    set(active: boolean) { aggregate = active; update(); },
    begin() {
      if (tokens.size >= 128) return () => {};
      const token = Symbol(); tokens.add(token); update();
      let released = false;
      return () => {
        if (released) return;
        released = true; tokens.delete(token); update();
      };
    }
  };
}

const activity = createActivityReporter(active => invoke("set_main_activity", { active }));
export function setMainActivity(active: boolean) { activity.set(active); }
export function beginMainActivity(): () => void { return activity.begin(); }
export function openRenderPreview(path: string): Promise<void> {
  return invoke("native_open_render_preview", { path });
}

export type RenderPreviewInfo = { key: string; title: string; fileSize: number };
export function getRenderPreviewInfo(): RenderPreviewInfo | null {
  const value: unknown = (window as Window & { __TORIS_RENDER_PREVIEW__?: unknown }).__TORIS_RENDER_PREVIEW__;
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RenderPreviewInfo>;
  return typeof candidate.key === "string" && /^[0-9a-f]{32}$/.test(candidate.key)
    && typeof candidate.title === "string" && candidate.title.length <= 120
    && typeof candidate.fileSize === "number" && Number.isSafeInteger(candidate.fileSize)
    && candidate.fileSize > 0 && candidate.fileSize <= 2 * 1024 ** 3
    ? candidate as RenderPreviewInfo : null;
}
