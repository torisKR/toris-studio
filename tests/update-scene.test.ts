import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDevDay30} from '../lib/video/devday-30';
import {updateProjectScene} from '../lib/video/update-scene';

test('delayed audio attachment preserves intervening edits and targets its original scene',()=>{
 const current=createDevDay30('instagram');
 current.title='Title edited during upload';
 current.scenes[1].headline='Headline edited during upload';
 const next=updateProjectScene(current,current.id,'codex',{audioPath:'/generated/new.wav',captionCues:undefined});
 assert.equal(next.title,current.title);
 assert.equal(next.scenes[1].headline,current.scenes[1].headline);
 assert.equal(next.scenes[1].audioPath,'/generated/new.wav');
 assert.deepEqual(next.scenes[2],current.scenes[2]);
});
test('delayed upload cannot overwrite another project or recreate a deleted scene',()=>{
 const a=createDevDay30('instagram'),b=createDevDay30('youtube');
 assert.equal(updateProjectScene(b,a.id,'codex',{audioPath:'old.wav'}),b);
 a.scenes=a.scenes.filter(s=>s.id!=='codex');
 assert.equal(updateProjectScene(a,a.id,'codex',{audioPath:'old.wav'}),a);
});
