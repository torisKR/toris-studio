import assert from "node:assert/strict";
import test from "node:test";
import { DATA_PRESETS, chartText, ideaProviderOf, motionPresets, parseChart, readIdeaMetadata, readMotion } from "../desktop/src/video-idea";

test("chart input accepts 2-8 label: value lines and rejects anything Rust would refuse", () => {
  assert.deepEqual(parseChart("1월: 3\n2월: 7.5\n"), [{ label: "1월", value: 3 }, { label: "2월", value: 7.5 }]);
  assert.deepEqual(parseChart("비율: 시간: 4\nB: 1"), [{ label: "비율: 시간", value: 4 }, { label: "B", value: 1 }], "the last colon splits");
  const nine = Array.from({ length: 9 }, (_, i) => String(i) + ": " + String(i)).join("\n");
  for (const bad of ["하나: 1", "a: -1\nb: 2", "a: x\nb: 2", "a 1\nb: 2", ": 1\nb: 2", "가".repeat(17) + ": 1\nb: 2", nine]) {
    assert.equal(typeof parseChart(bad), "string", bad);
  }
  assert.equal(chartText([{ label: "1월", value: 3 }, { label: "2월", value: 7.5 }]), "1월: 3\n2월: 7.5");
  assert.equal(chartText(null), "");
});

test("every data preset is a known motion preset with its own scene field", () => {
  for (const [preset, field] of Object.entries(DATA_PRESETS)) {
    assert.ok(preset in motionPresets, preset);
    assert.ok(readMotion({ preset, intensity: 0.6 }), preset);
    assert.ok(["countUp", "chart", "logoPath"].includes(field));
  }
  assert.equal(Object.keys(motionPresets).length, 12, "matches the Rust PRESET_IDS list");
  assert.equal(readMotion({ preset: "movie=x", intensity: 0.5 }), null);
});

test("older saved provider names still read as the Agent tab model", () => {
  assert.equal(ideaProviderOf("chatgpt"), "agent-model");
  assert.equal(ideaProviderOf("agent-model"), "agent-model");
  assert.equal(ideaProviderOf("template"), "template");
  assert.equal(ideaProviderOf("remote"), "");
  const meta = { version: 1, topic: "t", category: "tech", createdAt: "2026-10-27T00:00:00Z", reviewRequired: true, motionSkill: "toris-video-motion" };
  for (const provider of ["agent-model", "template", "chatgpt", "opencodex"]) assert.ok(readIdeaMetadata({ ...meta, provider }), provider);
  assert.equal(readIdeaMetadata({ ...meta, provider: "evil" }), null);
});
