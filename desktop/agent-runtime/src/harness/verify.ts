// Shared verification step. Facts outrank model opinions: a failing command or
// check makes the verdict "fail" no matter what the reviewer model says.
export type CheckResult = { name: string; ok: boolean; detail: string };
export type CommandOutcome = { log: string; exit: number | null };

export type Verdict = {
  verdict: "pass" | "fail";
  /** Why the facts failed, prepended to the reviewer's own text. */
  factNote: string;
};

/** Merges command exits, deterministic checks and the reviewer's verdict. */
export function decide(review: unknown, commands: CommandOutcome[], checks: CheckResult[] = []): Verdict {
  const exits = commands.map(c => c.exit).filter((exit): exit is number => exit !== null && exit !== 0);
  const failedChecks = checks.filter(check => !check.ok);
  const notes = [
    exits.length ? `검증 명령이 실패했습니다 (exit ${exits.join(", ")}).` : "",
    ...failedChecks.map(check => `검사 실패: ${check.name} — ${check.detail}`),
  ].filter(Boolean);
  const factsFailed = notes.length > 0;
  return { verdict: review === "pass" && !factsFailed ? "pass" : "fail", factNote: notes.length ? `${notes.join(" ")} ` : "" };
}

export function checksLog(checks: CheckResult[]): string {
  return checks.map(check => `[${check.ok ? "통과" : "실패"}] ${check.name}: ${check.detail}`).join("\n");
}
