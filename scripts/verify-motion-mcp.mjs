import assert from 'node:assert/strict';
import { spawn,execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp,rm,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const home=await mkdtemp(path.join(tmpdir(),'studio-motion-mcp-')),suffix=process.platform==='win32'?'.exe':'';
const binary=path.resolve('desktop/src-tauri/target/debug/toris-studio-desktop'+suffix),helper=path.resolve('desktop/src-tauri/target/debug/examples/motion_qa_bridge'+suffix);
const project={id:crypto.randomUUID(),title:'MCP 모션 검증',format:'shorts',template:'reference-briefing',language:'ko',privateMetadata:'never expose this',motionGraphics:{version:1,description:'fixture only',tables:[],images:[]},scenes:[{id:'s',headline:'제목',body:'',narration:'',durationSec:9,graphics:{version:1,background:'#101820',elements:[]}}]};
const seeded=JSON.parse(execFileSync(helper,[],{input:JSON.stringify({action:'request',args:{input:{project,instruction:'장면을 12초로',mode:'edit',sceneIds:['s'],elementIds:[]}}}),env:{...process.env,TORIS_MOTION_QA_HOME:home},encoding:'utf8'}));assert.equal(seeded.ok,true);const request=seeded.result;
const child=spawn(binary,['--studio-mcp'],{env:{...process.env,TORIS_STUDIO_MOTION_TEST_HOME:home,TORIS_STUDIO_ASSET_HOME:home},stdio:['pipe','pipe','pipe']});child.stderr.resume();
const pending=new Map();let sequence=0;const lines=createInterface({input:child.stdout});lines.on('line',line=>{const message=JSON.parse(line),p=pending.get(message.id);if(!p)return;pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(new Error(JSON.stringify(message.error))):p.resolve(message.result);});
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(new Error('MCP timeout')),20000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
function unpack(v){assert.notEqual(v.isError,true,JSON.stringify(v));return JSON.parse(v.content.find(c=>c.type==='text').text);}
try {
 await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'motion-qa',version:'0.2.0'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const {tools}=await call('tools/list');for(const name of ['studio_motion_request_get','studio_motion_draft_receive'])assert.ok(tools.some(t=>t.name===name));
 const context=unpack(await call('tools/call',{name:'studio_motion_request_get',arguments:{requestId:request.id}}));assert.equal(context.baseHash,request.baseHash);assert.equal(context.project.privateMetadata,undefined);
 const args={requestId:request.id,projectId:project.id,baseHash:request.baseHash,draft:{operations:[{op:'set-duration',sceneId:'s',durationSec:12}]}};
 const first=unpack(await call('tools/call',{name:'studio_motion_draft_receive',arguments:args}));assert.equal(first.status,'received');assert.deepEqual(unpack(await call('tools/call',{name:'studio_motion_draft_receive',arguments:args})),first);
 const invalid=await call('tools/call',{name:'studio_motion_draft_receive',arguments:{...args,projectId:crypto.randomUUID()}});assert.equal(invalid.isError,true);
 assert.equal((await readdir(home)).some(name=>name==='projects.json'),false);
 console.log('Verified packaged stdio motion MCP: request context, privacy, reviewed receipt, duplicate idempotency, wrong-project rejection; no project saved. Fixture only, not live ChatGPT.');
} finally {lines.close();child.kill();for(const p of pending.values())clearTimeout(p.timer);await rm(home,{recursive:true,force:true});}
