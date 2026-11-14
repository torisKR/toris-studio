/** What the composer's keydown handler needs from a keyboard event. */
export type ComposerKey = {
  key: string;
  shiftKey: boolean;
  /** `KeyboardEvent.isComposing`: true while an input method (e.g. Korean) is composing. */
  isComposing: boolean;
  /** Legacy `keyCode`: 229 marks a key the input method handled. */
  keyCode: number;
};

/** keyCode browsers report for a key the input method consumed. */
export const IME_KEY_CODE = 229;

/**
 * True when this keydown should send the message: a plain Enter that the input method did not use.
 *
 * - While composing (Chromium/Firefox: the confirming Enter's keydown has `isComposing`), it does not send.
 * - WebKit (Safari, Tauri's WKWebView) fires `compositionend` before the confirming Enter's keydown,
 *   so `isComposing` is already false there; that keydown still carries keyCode 229, so it does not send.
 * - Shift+Enter adds a line. A later, separate Enter (keyCode 13) sends once.
 */
export function isSendEnter(event: ComposerKey): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  return !event.isComposing && event.keyCode !== IME_KEY_CODE;
}
