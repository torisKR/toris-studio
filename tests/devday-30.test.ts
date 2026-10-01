import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDevDay30 } from '../lib/video/devday-30';
import { getDurationInFrames } from '../lib/video/presets';
import { projectSchema } from '../lib/video/schema';

test('30-second variants retain shared content and reserve a three-second hook and five-second CTA', () => {
  const a=createDevDay30('instagram'), b=createDevDay30('youtube');
  assert.equal(getDurationInFrames(a.scenes,30),900);
  assert.equal(a.scenes[0].durationSec,3);
  assert.equal(a.scenes[3].durationSec,5);
  assert.deepEqual(a.scenes.slice(0,3),b.scenes.slice(0,3));
  assert.match(a.scenes[3].headline,/댓글에 Dev를/);
  assert.match(b.scenes[3].headline,/관련 영상에서/);
  for(const p of [a,b]) assert.equal(projectSchema.safeParse(p).success,true);
});
test('spoken captions retain full narration; missing hook and CTA audio is explicit', () => {
  const p=createDevDay30('instagram');
  const compact=(s:string)=>s.replace(/\s/g,'');
  for(const scene of p.scenes.slice(1,3)) {
    assert.equal(compact(scene.captionCues!.map(c=>c.text).join(' ')),compact(scene.narration!));
    for(const cue of scene.captionCues!) assert.ok(cue.startSec>=0 && cue.endSec<=scene.durationSec);
  }
  for(const scene of [p.scenes[0],p.scenes[3]]) {
    assert.equal(scene.audioPath,undefined);
    assert.deepEqual(scene.captionCues,[]);
  }
});
