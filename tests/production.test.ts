import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDurationInFrames } from '../lib/video/presets';
import { evaluateVideoQuality } from '../lib/video/quality';
import { projectSchema } from '../lib/video/schema';
import { createReferenceBriefingProject } from '../lib/video/templates';
import { saveLocalProject, listLocalProjects } from '../lib/storage/local-project-repository';

test('composition duration matches separately rounded scene sequences', () => {
  assert.equal(getDurationInFrames([{durationSec:1.05},{durationSec:1.05}],30),64);
});
test('hook source cannot inflate evidence coverage, missing voice remains visible', () => {
  const p=createReferenceBriefingProject('shorts');
  p.scenes=p.scenes.slice(0,2).map((s,i)=>({...s,role:i?'proof':'hook',sourceUrl:'https://openai.com',audioPath:undefined}));
  const report=evaluateVideoQuality(p);
  assert.equal(report.sourceCoverage,1);
  assert.equal(report.checks.find(c=>c.id==='narration-audio')?.passed,false);
});
test('schema retains caption timing and media fitting and rejects reversed cues', () => {
  const p=createReferenceBriefingProject('shorts');
  p.scenes[0].captionCues=[{startSec:0,endSec:1,text:'한국어 자막'}];
  p.scenes[0].mediaFit='contain';
  assert.deepEqual(projectSchema.parse(p).scenes[0].captionCues,p.scenes[0].captionCues);
  p.scenes[0].captionCues[0].endSec=0;
  assert.equal(projectSchema.safeParse(p).success,false);
});
test('concurrent local saves retain all projects and atomically replace valid JSON', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'toris-store-test-'));
  const previous=process.env.TORIS_STUDIO_DATA_DIR;
  process.env.TORIS_STUDIO_DATA_DIR=dir;
  try {
    const projects=Array.from({length:12},()=>createReferenceBriefingProject('shorts'));
    await Promise.all(projects.map(p=>saveLocalProject(p)));
    assert.equal((await listLocalProjects()).length,12);
    assert.equal(JSON.parse(await readFile(path.join(dir,'projects.json'),'utf8')).projects.length,12);
  } finally {
    if(previous===undefined) delete process.env.TORIS_STUDIO_DATA_DIR;
    else process.env.TORIS_STUDIO_DATA_DIR=previous;
    await rm(dir,{recursive:true,force:true});
  }
});
