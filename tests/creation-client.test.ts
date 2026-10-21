import test from "node:test";
import assert from "node:assert/strict";
import { creationApi, remoteDesktopHandoff, creationStateLabel, type CreationBridge } from "../desktop/src/creation-client";

test("creation handoff targets the installed stdio executable and never claims delivery", () => {
  const bridge: CreationBridge = { mcpExecutable: "/Applications/Toris Studio.app/Contents/MacOS/toris-studio-desktop", protocolVersion: "2025-11-25", lastObservedAt: null };
  const prompt = remoteDesktopHandoff(bridge, "studio_creation_request_get", { requestId: "r1" });
  assert.match(prompt, /Remote Desktop Commander/);
  assert.match(prompt, /--studio-mcp/);
  assert.match(prompt, /studio_creation_request_get/);
  assert.match(prompt, /r1/);
  assert.doesNotMatch(prompt, /Codexify|codexify|대화에 저장했습니다/);
  assert.equal(creationStateLabel("saved"), "요청 저장");
  assert.equal(creationStateLabel("read"), "실제 요청 조회 확인");
  assert.equal(creationStateLabel("draft-received"), "초안 수신 · 검토 필요");
});

test("creation IPC preserves request identity and propagates native rejection", async () => {
  const calls: unknown[] = [];
  await creationApi("get", { requestId: "r1" }, async (command, args) => { calls.push([command, args]); return { request: { id: "r1" } }; });
  assert.deepEqual(calls, [["creation_request_get", { input: { requestId: "r1" } }]]);
  await assert.rejects(creationApi("cancel", { requestId: "r1", revision: "h" }, async () => { throw new Error("stale"); }), /stale/);
});

test("handoff rejects a missing or nonabsolute executable", () => {
  assert.throws(() => remoteDesktopHandoff({ mcpExecutable: "studio", protocolVersion: "", lastObservedAt: null }, "studio_connection_check", {}), /실행 파일/);
});

test("template and research prompts emit only the native receipt projection",async()=>{
 const {videoDraftProjection,videoCreationPrompt}=await import("../desktop/src/creation-client");
 const full={id:"existing-project",createdAt:"now",updatedAt:"now",title:"분기 보고",format:"shorts" as const,template:"adaptive-promo" as const,language:"ko" as const,scenes:[{id:"scene-1",headline:"18%",body:"원본 수치",narration:"18퍼센트",durationSec:9,mediaType:"none" as const,accent:"#00aaff",layout:"hero" as const,role:"hook" as const,motion:{preset:"kinetic-title",intensity:0.5}}]};
 const projection=videoDraftProjection(full);
 assert.deepEqual(Object.keys(projection),["title","format","template","language","scenes"]);
 assert.deepEqual(Object.keys(projection.scenes[0]),["id","headline","body","narration","durationSec","motion"]);
 const prompt=videoCreationPrompt(full,{topic:"분기 보고",sources:[{title:"원본"}]});
 assert.deepEqual(JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n')+2)),{project:projection});
 assert.match(prompt,/studio_creation_draft_receive/);
 assert.equal(projection.scenes[0].headline,"18%");
});
