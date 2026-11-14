import assert from "node:assert/strict";
import test from "node:test";
import { createComposerGuard, IME_KEY_CODE, isSendEnter, type ComposerKey } from "../desktop/src/projects/composer-keys";

const enter = (over: Partial<ComposerKey> = {}): ComposerKey => ({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, ...over });

/** Replays an event sequence through the same rule the composer uses and counts sends. */
function sends(sequence: Array<{ type: "compositionstart" | "compositionend" } | { type: "keydown"; key: ComposerKey }>) {
  let count = 0;
  for (const event of sequence) if (event.type === "keydown" && isSendEnter(event.key)) count++;
  return count;
}

test("a plain Enter sends; Shift+Enter and other keys do not", () => {
  assert.equal(isSendEnter(enter()), true);
  assert.equal(isSendEnter(enter({ shiftKey: true })), false);
  assert.equal(isSendEnter(enter({ key: "a", keyCode: 65 })), false);
  assert.equal(isSendEnter(enter({ key: "Process", keyCode: IME_KEY_CODE })), false);
});

test("Enter while composing does not send (Chromium order: keydown before compositionend)", () => {
  assert.equal(isSendEnter(enter({ isComposing: true, keyCode: IME_KEY_CODE })), false);
  assert.equal(isSendEnter(enter({ isComposing: true })), false);
  assert.equal(sends([
    { type: "compositionstart" },
    { type: "keydown", key: enter({ isComposing: true, keyCode: IME_KEY_CODE }) },
    { type: "compositionend" }
  ]), 0);
});

test("the IME's confirming Enter after compositionend does not send (WebKit order, keyCode 229)", () => {
  assert.equal(isSendEnter(enter({ isComposing: false, keyCode: IME_KEY_CODE })), false);
  assert.equal(sends([
    { type: "compositionstart" },
    { type: "compositionend" },
    { type: "keydown", key: enter({ keyCode: IME_KEY_CODE }) }
  ]), 0);
});

test("after the composition ends, a separate Enter sends exactly once in either order", () => {
  for (const confirming of [enter({ isComposing: true, keyCode: IME_KEY_CODE }), enter({ keyCode: IME_KEY_CODE })]) {
    assert.equal(sends([
      { type: "compositionstart" },
      ...(confirming.isComposing ? [{ type: "keydown" as const, key: confirming }, { type: "compositionend" as const }] : [{ type: "compositionend" as const }, { type: "keydown" as const, key: confirming }]),
      { type: "keydown", key: enter() }
    ]), 1);
  }
});

test("Shift+Enter during or after a composition only adds a line", () => {
  assert.equal(sends([
    { type: "compositionstart" },
    { type: "keydown", key: enter({ shiftKey: true, isComposing: true, keyCode: IME_KEY_CODE }) },
    { type: "compositionend" },
    { type: "keydown", key: enter({ shiftKey: true }) }
  ]), 0);
});

test("no time-based blocking: an Enter right after compositionend that the IME did not use still sends", () => {
  assert.equal(sends([{ type: "compositionstart" }, { type: "compositionend" }, { type: "keydown", key: enter() }]), 1);
});

// ---------------------------------------------------------------------------
// The composer guard, replaying event orders the real app produced.

type Step =
  | { type: "keydown"; key: ComposerKey }
  | { type: "keyup" }
  | { type: "compositionend" }
  | { type: "input"; inputType: string; isComposing?: boolean };

/** Replays a sequence through the composer's guard and counts sends (and IME-confirming Enters). */
function replay(sequence: Step[]) {
  const guard = createComposerGuard();
  let sent = 0, confirmed = 0;
  for (const step of sequence) {
    if (step.type === "keydown") {
      const action = guard.onKeyDown(step.key);
      if (action === "send") sent++;
      if (action === "ime-confirm") confirmed++;
    } else if (step.type === "keyup") guard.onKeyUp();
    else if (step.type === "compositionend") guard.onCompositionEnd();
    else guard.onInput({ inputType: step.inputType, isComposing: step.isComposing ?? false });
  }
  return { sent, confirmed };
}

const jamo = (key: string): Step[] => [
  { type: "input", inputType: "insertReplacementText" },
  { type: "keydown", key: { key, shiftKey: false, isComposing: false, keyCode: IME_KEY_CODE } },
  { type: "keyup" }
];
/** Real Tauri WKWebView, macOS 2-Set Korean, g k s: no composition events, insertReplacementText per jamo. */
const typedHan: Step[] = [
  { type: "input", inputType: "insertText" },
  { type: "keydown", key: { key: "ㅎ", shiftKey: false, isComposing: false, keyCode: IME_KEY_CODE } },
  { type: "keyup" },
  ...jamo("ㅏ"),
  ...jamo("ㄴ")
];
/** The confirming Enter as captured: the IME re-commits "한", then a plain Enter keydown (keyCode 13, not composing). */
const confirmingEnter: Step[] = [
  { type: "input", inputType: "insertReplacementText" },
  { type: "keydown", key: enter() },
  { type: "keyup" }
];

test("WKWebView (captured in the real app): the Enter that confirms 한 does not send", () => {
  // Before the guard, the keydown alone looked like a plain Enter.
  assert.equal(isSendEnter(enter()), true);
  assert.deepEqual(replay([...typedHan, ...confirmingEnter]), { sent: 0, confirmed: 1 });
});

test("WKWebView: the same Enter with its keyup delivered before the commit still does not send", () => {
  // The automation that pressed the keys delivered keyup before the input and keydown.
  assert.deepEqual(replay([...typedHan, { type: "keyup" }, { type: "input", inputType: "insertReplacementText" }, { type: "keydown", key: enter() }]), { sent: 0, confirmed: 1 });
});

test("WKWebView: a separate Enter after the confirming one sends exactly once", () => {
  assert.deepEqual(replay([...typedHan, ...confirmingEnter, { type: "keydown", key: enter() }, { type: "keyup" }]), { sent: 1, confirmed: 1 });
});

test("Chromium order with the guard: composing Enter does not send, the next Enter sends once", () => {
  assert.deepEqual(replay([
    { type: "input", inputType: "insertCompositionText", isComposing: true },
    { type: "keydown", key: enter({ isComposing: true, keyCode: IME_KEY_CODE }) },
    { type: "compositionend" },
    { type: "keyup" },
    { type: "keydown", key: enter() },
    { type: "keyup" }
  ]), { sent: 1, confirmed: 0 });
});

test("plain text (English, space) then Enter sends once; Shift+Enter after a commit only adds a line", () => {
  assert.deepEqual(replay([
    { type: "keydown", key: { key: "a", shiftKey: false, isComposing: false, keyCode: 65 } },
    { type: "input", inputType: "insertText" },
    { type: "keyup" },
    { type: "keydown", key: enter() },
    { type: "keyup" }
  ]), { sent: 1, confirmed: 0 });
  assert.deepEqual(replay([...typedHan, { type: "input", inputType: "insertReplacementText" }, { type: "keydown", key: enter({ shiftKey: true }) }, { type: "keyup" }]), { sent: 0, confirmed: 0 });
});

test("no time-based blocking: the guard only remembers the key being pressed", () => {
  // A commit followed by any other key's keyup or keydown leaves nothing for a later Enter.
  assert.deepEqual(replay([{ type: "input", inputType: "insertReplacementText" }, { type: "keyup" }, { type: "keydown", key: enter() }]), { sent: 1, confirmed: 0 });
  assert.deepEqual(replay([{ type: "compositionend" }, { type: "keydown", key: { key: " ", shiftKey: false, isComposing: false, keyCode: 32 } }, { type: "keydown", key: enter() }]), { sent: 1, confirmed: 0 });
});
