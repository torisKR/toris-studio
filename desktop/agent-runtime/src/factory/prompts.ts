// The director proposes a spec. It does not receive secrets and cannot name commands.
export const FACTORY_SYSTEM = [
  "너는 게임·앱 팩토리 디렉터다. 사용자의 요청을 닫힌 스키마의 JSON 명세로만 바꾼다.",
  "규칙: URL, 파일 경로, 명령, 코드, 토큰, 비밀값을 넣지 않는다. 스키마에 없는 필드를 만들지 않는다.",
  "kind가 game이면 engine은 godot, app이면 engine은 kotlin이고 view는 ui다.",
  "view가 2d이면 artStyle은 pixel-16bit 또는 pixel-8bit이고 models는 0이다. view가 3d이면 artStyle은 lowpoly이고 models는 1 이상이다.",
  "platform은 android. monetization.ads와 iap는 none-in-mvp. limits.maxApiCostUsd는 5 이하. limits.maxConcurrentHeavyJobs는 1. limits.maxAttemptsPerTask는 3.",
  "게임 acceptance에는 boot-to-menu와 android-debug-apk가 있어야 한다. 앱 acceptance에는 screen-opens와 android-debug-apk가 있어야 한다.",
  "JSON 객체 하나만 출력한다.",
].join("\n");

/** The opinion steers the spec only when the user asked to apply it. Recording leaves the prompt unchanged. */
export function opinionChoice(opinion: string | undefined, apply: boolean | undefined): { text: string; steer: string } {
  const text = (opinion ?? "").trim().slice(0, 500);
  if (!text) return { text: "", steer: "" };
  if (apply !== true) return { text, steer: "" };
  return { text, steer: text };
}

export function opinionNote(choice: { text: string; steer: string }, outcome: "preview" | "reflected" | "unapplied"): string | null {
  if (!choice.text) return null;
  if (!choice.steer) return "의견을 남겼습니다. 기획에는 반영하지 않습니다.";
  switch (outcome) {
    case "preview": return "이 의견은 시작 후 모델이 명세를 쓸 때 반영됩니다. 미리보기 명세는 규칙으로 만든 것입니다.";
    case "reflected": return "사용자 의견을 기획에 반영했습니다.";
    case "unapplied": return "모델 명세를 쓰지 못해 의견은 템플릿 명세에 반영하지 못했습니다.";
    default: {
      const neverOutcome: never = outcome;
      return neverOutcome;
    }
  }
}

export function factoryPrompt(brief: string, kind: "game" | "app", opinion = ""): string {
  const lines = ["종류: " + kind, "요청:", brief.slice(0, 2000)];
  if (opinion.trim()) lines.push("사용자 의견:", opinion.trim().slice(0, 500));
  lines.push("schemaVersion은 1이다.");
  return lines.join("\n");
}
