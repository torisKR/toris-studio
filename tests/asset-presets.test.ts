import assert from "node:assert/strict";
import test from "node:test";
import { PRESETS, defaultSpec, validationError, handoffText } from "../desktop/src/assets/contracts";
import { applyPreset, changeOutputSize, availableFormats } from "../desktop/src/assets/presets";

test("catalog contains Play, favicon and every one of the fourteen supplied advertising dimensions", () => {
  const expected: Record<string, readonly number[]> = {
    "play-icon":[512,512], "play-feature":[1024,500], "play-phone-portrait":[1080,1920], "play-phone-landscape":[1920,1080],
    "play-tablet-portrait":[1440,2560], "play-tablet-landscape":[2560,1440],
    "favicon-16":[16,16], "favicon-32":[32,32], "favicon-48":[48,48], "favicon-64":[64,64], "favicon-96":[96,96],
    "campaign-square":[1200,1200], "campaign-landscape":[1200,628], "campaign-portrait":[1200,1500], "campaign-fullscreen":[1080,1920],
    "admob-mobile":[320,50], "admob-large-mobile":[320,100], "admob-rectangle":[300,250], "admob-banner":[468,60], "admob-leaderboard":[728,90], "admob-landscape-mobile":[480,32],
    "interstitial-phone-portrait":[320,480], "interstitial-phone-landscape":[480,320], "interstitial-tablet-portrait":[768,1024], "interstitial-tablet-landscape":[1024,768]
  };
  for (const [id,size] of Object.entries(expected)) assert.deepEqual(PRESETS.find(p=>p.id===id)?.size,size,id);
  assert.equal(new Set(PRESETS.map(p=>p.id)).size,PRESETS.length);
  assert.equal(PRESETS.length,31);
});
test("same pixel dimensions retain distinct preset identities and Play format rules",()=>{
  const play=applyPreset(defaultSpec,"play-phone-portrait");
  const video=applyPreset(play,"shorts");
  assert.equal(play.presetId,"play-phone-portrait");
  assert.equal(video.presetId,"shorts");
  assert.equal(play.width,video.width);
  assert.equal(play.backgroundMode,"solid");
  assert.deepEqual(availableFormats(play),["png","jpeg"]);
  assert.deepEqual(availableFormats(applyPreset(play,"favicon-32")),["png","ico"]);
  assert.equal(applyPreset({...defaultSpec,format:"webp"},"play-icon").format,"png");
  assert.equal(applyPreset({...defaultSpec,format:"ico",width:32,height:32},"landscape").format,"png");
});
test("editing dimensions explicitly leaves a fixed preset; malformed persisted options fail safely",()=>{
  const next=changeOutputSize(applyPreset(defaultSpec,"play-icon"),"width",640);
  assert.equal(next.presetId,"custom");
  assert.equal(next.width,640);
  assert.match(validationError({...defaultSpec,presetId:"play-icon"},false),/규격|프리셋/);
  assert.match(validationError({...defaultSpec,presetId:"does-not-exist"},false),/프리셋/);
  assert.match(validationError({...defaultSpec,backgroundColor:"javascript:bad"},false),/배경/);
  assert.match(validationError({...defaultSpec,format:"ico"},false),/ICO/);
});
test("handoff preserves preset ID and background rather than treating a Play screenshot as a generic video",()=>{
  const spec=applyPreset({...defaultSpec,prompt:"실제 앱 화면을 사용"},"play-phone-portrait");
  const text=handoffText([{id:"test",batchId:"batch",index:1,spec,status:"queued",createdAt:"",updatedAt:"",assetId:null,outputRoot:"/tmp/output"}]);
  assert.match(text,/play-phone-portrait/);
  assert.match(text,/backgroundColor/);
  assert.match(text,/solid/);
});
