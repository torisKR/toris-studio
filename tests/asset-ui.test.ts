import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PRESETS, defaultSpec, handoffText, validationError, formatBytes, applyAssetRefresh } from "../desktop/src/assets/contracts";

test("late asset detail responses neither reopen a closed inspector nor replace a different selection",()=>{
  const refreshed={id:"a",title:"fresh"};
  assert.equal(applyAssetRefresh(null,refreshed),null);
  const other={id:"b",title:"other"};
  assert.equal(applyAssetRefresh(other,refreshed),other);
  assert.equal(applyAssetRefresh({id:"a",title:"stale"},refreshed),refreshed);
});
test("native CSP permits embedded GLB texture blobs without broad network access",()=>{
  const config=JSON.parse(readFileSync(new URL("../desktop/src-tauri/tauri.conf.json",import.meta.url),"utf8"));
  assert.match(config.app.security.csp,/img-src[^;]*blob:/);
  assert.match(config.app.security.csp,/connect-src[^;]*blob:/);
  assert.doesNotMatch(config.app.security.csp,/connect-src[^;]*https:\\?/);
});
test("asset presets have actual pixel dimensions and safe defaults", () => {
  assert.deepEqual(PRESETS.find(p => p.id === "shorts")?.size, [1080,1920]);
  assert.deepEqual(PRESETS.find(p => p.id === "landscape")?.size, [1920,1080]);
  assert.equal(defaultSpec.purpose, "video");
  assert.equal(validationError({...defaultSpec,title:"배경",prompt:"바다"}), "");
  assert.match(validationError({...defaultSpec,width:0}), /규격|픽셀/);
  assert.match(validationError({...defaultSpec,width:8192,height:8192}), /규격|픽셀/);
});
test("ChatGPT handoff labels a request as pending and never promises unlimited generation", () => {
  const text = handoffText([{id:"test-job",batchId:"batch",index:1,spec:{...defaultSpec,title:"배경",prompt:"바다"},status:"queued",createdAt:"2026-10-09",updatedAt:"2026-10-09",assetId:null,outputRoot:"/tmp/assets"}]);
  assert.match(text,/test-job/);
  assert.match(text,/studio_asset_receive/);
  assert.match(text,/1920/);
  assert.match(text,/사용 한도/);
  assert.doesNotMatch(text,/무제한|Codex CLI/);
});
test("invalid folder-like project names and empty prompts are rejected", () => {
  assert.match(validationError({...defaultSpec,project:"../escape"}), /프로젝트/);
  assert.match(validationError({...defaultSpec,prompt:""}), /프롬프트/);
  assert.match(validationError({...defaultSpec,quantity:101}), /수량/);
  assert.equal(formatBytes(1024), "1.0 KiB");
});

test("image generation request picks the closest API size and keeps the job's prompt, purpose and output spec", async () => {
  const { imageGenerationRequest } = await import("../desktop/src/assets/contracts");
  const job = (width: number, height: number) => ({ id: "job-1", status: "queued", spec: { ...defaultSpec, prompt: "푸른 로고", purpose: "video", width, height, format: "png", backgroundMode: "transparent" } }) as never;
  assert.equal(imageGenerationRequest(job(1920, 1080)).size, "1536x1024");
  assert.equal(imageGenerationRequest(job(1080, 1920)).size, "1024x1536");
  assert.equal(imageGenerationRequest(job(1000, 1100)).size, "1024x1024", "within 15% is square");
  const request = imageGenerationRequest(job(512, 512));
  assert.equal(request.jobId, "job-1");
  assert.match(request.prompt, /^푸른 로고\n용도: video\n최종 규격 512x512 png\. 배경: transparent$/);
});
