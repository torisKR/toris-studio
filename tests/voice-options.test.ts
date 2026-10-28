import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCaptionCues } from "../lib/video/editing";
import { spokenNarration } from "../lib/video/voice-options";

test("captions show what is spoken, not narration tags or stress markers", () => {
  assert.equal(spokenNarration("[차분한 다큐][Ryan] 첫 **문장**\n[쉼:600] 둘째\n[공지] 그대로"), "첫 문장\n둘째\n[공지] 그대로");
  assert.equal(spokenNarration("[화자: aiden] 안녕"), "안녕");
  const cues = resolveCaptionCues({ id: "s", headline: "", body: "", narration: "[IT 뉴스] **새 기능**을 소개합니다", durationSec: 4 }, "shorts");
  assert.equal(cues.map(cue => cue.text).join(" "), "새 기능을 소개합니다");
});

