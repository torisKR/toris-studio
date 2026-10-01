import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSocialCaption } from '../remotion/templates/SocialFocusScene';
import { createDevDay30 } from '../lib/video/devday-30';

test('social narration remains captioned after replacing audio clears obsolete cues', () => {
  const scene = { ...createDevDay30('instagram').scenes[1], captionCues: undefined };
  const start = getSocialCaption(scene, 0);
  const end = getSocialCaption(scene, scene.durationSec - 1 / 30);
  assert.ok(start.length > 0);
  assert.ok(end.length > 0);
  assert.notEqual(start, end);
  assert.ok(scene.narration.startsWith(start));
  assert.ok(scene.narration.endsWith(end));
});

test('social explicit cue gaps and empty cue lists stay silent', () => {
  const scene = createDevDay30('instagram').scenes[1];
  assert.equal(getSocialCaption(scene, 4.5), '');
  assert.equal(getSocialCaption(scene, 5.2), scene.captionCues![1].text);
  assert.equal(getSocialCaption({ ...scene, captionCues: [] }, 0), '');
  assert.equal(getSocialCaption({ ...scene, narration: '', captionCues: undefined }, 0), '');
});
