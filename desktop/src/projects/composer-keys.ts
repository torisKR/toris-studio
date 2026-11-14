/** What the composer's keydown handler needs from a keyboard event. */
export type ComposerKey = {
  key: string;
  shiftKey: boolean;
  /** `KeyboardEvent.isComposing`: true while an input method (e.g. Korean) is composing. */
  isComposing: boolean;
  /** Legacy `keyCode`: 229 marks a key the input method handled. */
  keyCode: number;
};

/** What the guard needs from an `input`/`beforeinput` event. */
export type ComposerInput = { inputType: string; isComposing: boolean };

/** keyCode browsers report for a key the input method consumed. */
export const IME_KEY_CODE = 229;

/**
 * True when this keydown, on its own, is a plain Enter the input method did not use.
 *
 * - While composing (Chromium/Firefox: the confirming Enter's keydown has `isComposing`), it does not send.
 * - A keydown with keyCode 229 belongs to the input method, so it does not send.
 * - Shift+Enter adds a line.
 *
 * This alone misses Tauri's WKWebView on macOS: see `createComposerGuard`.
 */
export function isSendEnter(event: ComposerKey): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  return !event.isComposing && event.keyCode !== IME_KEY_CODE;
}

/** What one composer keydown should do. */
export type ComposerKeyAction = "send" | "ime-confirm" | "none";

/**
 * Per-composer guard for the Enter that confirms an input-method syllable.
 *
 * Observed in the real app (Tauri WKWebView, macOS 2-Set Korean, keys g k s then Enter):
 * no composition events fire at all. Each key first produces an `insertReplacementText`
 * input ("ㅎ" → "하" → "한"), then its keydown. The confirming Enter does the same — the
 * input method re-commits "한" with `insertReplacementText` — and its keydown then arrives
 * as a plain Enter (keyCode 13, `isComposing` false). `isSendEnter` alone sent it.
 *
 * So an input-method commit (`compositionend`, or an input that is composing or an
 * `insertReplacementText`) marks the key being pressed; the next keydown reads and clears
 * the mark, and any keyup clears it too. No timers: a separate Enter pressed afterwards
 * sends exactly once, and Chromium's order (keydown while composing, then compositionend,
 * then keyup) leaves no mark behind.
 */
export function createComposerGuard() {
  let committed = false;
  return {
    onCompositionEnd() { committed = true; },
    onInput(event: ComposerInput) {
      if (event.isComposing || event.inputType === "insertReplacementText") committed = true;
    },
    onKeyUp() { committed = false; },
    onKeyDown(event: ComposerKey): ComposerKeyAction {
      const imeCommitted = committed;
      committed = false;
      if (!isSendEnter(event)) return "none";
      return imeCommitted ? "ime-confirm" : "send";
    }
  };
}
