import assert from "node:assert/strict";
import test from "node:test";
import { codexifyOverlay, connectionPrompt, studioToolInstruction } from "../desktop/src/codexify";
import { handoffText, defaultSpec } from "../desktop/src/assets/contracts";
const native={mcpServers:{"toris-studio":{command:"/Applications/Toris Studio.app/Contents/MacOS/toris-studio-desktop",args:["--studio-mcp"]}}};
test("direct bridge preserves native arguments and disables Codex discovery without carrying secrets",()=>{
 const result=codexifyOverlay(native,"/Users/toris/projects/toris_studio");
 assert.equal(result.workDir,"/Users/toris/projects/toris_studio");assert.equal("multiProject" in result,false);assert.equal(result.agentChat.enabled,true);
 assert.equal(result.mcpServers.studio.mode,"direct");assert.deepEqual(result.mcpServers.studio.args,["--studio-mcp"]);
 assert.deepEqual(result.codexMcp,{enabled:false,useCli:false});assert.equal(result.mcpServers.studio.command,native.mcpServers["toris-studio"].command);
 assert.equal(result.mcpServers.studio.tools.length,10);assert.ok(result.mcpServers.studio.tools.includes("studio_asset_receive"));
 assert.doesNotMatch(JSON.stringify(result),/apiKey|token|openaiTunnel/);
});
test("copyable config rejects a shell, wrong worker argument, unsafe or relative project paths",()=>{
 for(const project of ["../project","/","/.","//","/./","//./","/\\","C:\\","C:/","C:\\.","C:\\.\\","C:/./","C:////","/Users/toris/../etc","/tmp/\nproject"]){
  assert.throws(()=>codexifyOverlay(native,project),undefined,project);
  assert.throws(()=>connectionPrompt(project),undefined,project);
 }
 assert.throws(()=>codexifyOverlay({mcpServers:{studio:{command:"sh",args:["-c","echo"]}}},"/tmp/project"));
});
test("copyable config retains absolute Mac and Windows project subdirectories",()=>{
 const windows={mcpServers:{studio:{command:"C:\\Program Files\\Toris Studio\\toris-studio-desktop.exe",args:["--studio-mcp"]}}};
 for(const project of ["/Users/toris/projects/selected","/tmp/./project/","C:\\Projects\\Studio","D:/Projects/Studio/"]){
  assert.equal(codexifyOverlay(native,project).workDir,project);
  assert.ok(connectionPrompt(project).includes(project));
 }
 assert.equal(codexifyOverlay(windows,"C:\\Projects\\Studio").mcpServers.studio.command,windows.mcpServers.studio.command);
});
test("connection handoff uses the same explicitly selected project as the overlay",()=>{
 assert.ok(connectionPrompt("/Users/toris/projects/selected").includes("/projects/selected"));
 assert.ok(!connectionPrompt("/Users/toris/projects/selected").includes("/projects/toris_studio"));
 assert.throws(()=>connectionPrompt("../other"));
});
test("ChatGPT handoff discovers direct tool prefixes and never sends encoded bytes as a file reference",()=>{
 assert.match(connectionPrompt(),/studio__studio_connection_check/);assert.match(studioToolInstruction(),/실제 도구/);
 const text=handoffText([{id:"job",batchId:"batch",index:1,spec:{...defaultSpec,prompt:"test"},status:"queued",createdAt:"",updatedAt:"",assetId:null,outputRoot:"/tmp"}]);
 assert.match(text,/studio__studio_asset_receive/);assert.match(text,/_meta/);assert.match(text,/base64/);
 assert.doesNotMatch(text,/무제한/);
});
test("asset handoff preserves the connected project and the requested asset project",()=>{
 const text=handoffText([{id:"job",batchId:"batch",index:1,spec:{...defaultSpec,project:"Windows App",prompt:"test"},status:"queued",createdAt:"",updatedAt:"",assetId:null,outputRoot:"C:\\StudioAssets"}]);
 assert.doesNotMatch(text,/\/Users\/toris\/projects\/toris_studio/);
 assert.match(text,/프로젝트를 전환하거나 기존 Studio 저장 폴더를 변경하지 마/);
 assert.match(text,/"project": "Windows App"/);
 assert.match(text,/studio__studio_asset_receive/);
});
