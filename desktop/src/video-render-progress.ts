import { createElement } from "react";

export type VideoRenderProgressMessage = {
  stage: "preparing" | "rendering" | "joining" | "completed";
  completedScenes: number;
  totalScenes: number;
};

const stages = ["preparing", "rendering", "joining", "completed"] as const;

export function initialRenderProgress(totalScenes: number): VideoRenderProgressMessage {
  if (!Number.isSafeInteger(totalScenes) || totalScenes < 1) throw new Error("출력할 장면이 없습니다.");
  return { stage: "preparing", completedScenes: 0, totalScenes };
}

/** Count scenes actually finished by Rust; never estimate time or overall percent. */
export function nextRenderProgress(current: VideoRenderProgressMessage, value: unknown): VideoRenderProgressMessage {
  if (!value || typeof value !== "object") return current;
  const next = value as VideoRenderProgressMessage;
  if (!stages.includes(next.stage) || !Number.isSafeInteger(next.completedScenes) || next.totalScenes !== current.totalScenes
    || next.completedScenes < current.completedScenes || next.completedScenes > next.totalScenes
    || stages.indexOf(next.stage) < stages.indexOf(current.stage)
    || (next.stage === "preparing" && next.completedScenes !== 0)
    || ((next.stage === "joining" || next.stage === "completed") && next.completedScenes !== next.totalScenes)) return current;
  if (next.stage === current.stage && next.completedScenes === current.completedScenes) return current;
  return { stage: next.stage, completedScenes: next.completedScenes, totalScenes: next.totalScenes };
}

/** One render owns one listener. Settlement closes it before clearing the UI. */
export function createRenderProgressSession(totalScenes: number, onChange: (value: VideoRenderProgressMessage | null) => void) {
  let current = initialRenderProgress(totalScenes);
  let closed = false;
  return {
    snapshot: () => current,
    receive(value: unknown) {
      if (closed) return;
      const next = nextRenderProgress(current, value);
      if (next === current) return;
      current = next;
      onChange(current);
    },
    settle() { if (!closed) { closed = true; onChange(null); } },
    close() { closed = true; }
  };
}

export function renderProgressLabel(progress: VideoRenderProgressMessage): string {
  switch (progress.stage) {
    case "preparing": return "렌더 준비 중";
    case "rendering": return `장면 렌더링 · ${progress.completedScenes}/${progress.totalScenes}장면 완료`;
    case "joining": return "최종 MP4 합치는 중";
    // Even a terminal channel message must wait for the command's durable result.
    case "completed": return "출력 파일 확인 중";
  }
}

export function VideoRenderProgress({ progress }: { progress: VideoRenderProgressMessage }) {
  const count = `${progress.completedScenes}/${progress.totalScenes}장면`;
  return createElement("div", { className: "desktop-video-progress-detail", role: "status", "aria-live": "polite", "aria-atomic": true },
    createElement("strong", null, renderProgressLabel(progress)),
    createElement("progress", { max: progress.totalScenes, value: progress.completedScenes, "aria-label": "완료한 장면 수", "aria-valuetext": `${count} 완료. 최종 MP4 저장 완료는 별도로 확인합니다.` }, count),
    createElement("p", null, `${count} 렌더 완료 · 장면 수를 표시하며 전체 작업 시간의 진행률은 아닙니다.`)
  );
}
