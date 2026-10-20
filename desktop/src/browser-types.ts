export type BrowserChoice = "system" | "playwright";

/** Native-only runtime details, cookies and opened URLs never cross this boundary. */
export type BrowserRuntimeStatus = {
  preference: BrowserChoice;
  effectiveBrowser: BrowserChoice;
  available: boolean;
  reason: string | null;
  phase: "idle" | "running" | "recovery_required";
};
