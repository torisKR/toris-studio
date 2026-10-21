import assert from 'node:assert/strict';
import { execFileSync,spawn } from 'node:child_process';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { nativeBinary,projectRoot } from './ui-fixture-helpers.mjs';

// The debug-only creation home prevents this fixture from opening user data.
// This uses the compiled MCP receiver, including native media validation.
export function buildCreationFixture(){
 execFileSync('cargo',['build','--quiet','--locked','--offline','--manifest-path',path.join(projectRoot,'desktop/src-tauri/Cargo.toml'),'--no-default-features','--bin','toris-studio-desktop','--example','creation_qa_bridge'],{cwd:projectRoot,env:process.env,timeout:240000,stdio:['ignore','pipe','pipe']});
}
export async function receiveCreationFixture(input,draft){
 const home=await mkdtemp(path.join(tmpdir(),'studio-video-receipt-'));
 const env={...process.env,TORIS_STUDIO_CREATION_TEST_HOME:home,TORIS_STUDIO_ASSET_HOME:home};
 let child,reader;const pending=new Map();let sequence=0,stderr='';
 const unpack=value=>{assert.notEqual(value.isError,true,JSON.stringify(value));return JSON.parse(value.content.find(block=>block.type==='text').text);};
 try{
  const seeded=JSON.parse(execFileSync(nativeBinary('creation_qa_bridge',{example:true}),[],{env,input:JSON.stringify({action:'create',input}),encoding:'utf8',timeout:20000}));assert.equal(seeded.ok,true,JSON.stringify(seeded));const request=seeded.result.request;
  child=spawn(nativeBinary('toris-studio-desktop'),['--studio-mcp'],{env,stdio:['pipe','pipe','pipe']});
  child.stderr.on('data',data=>stderr=(stderr+data).slice(-2000));
  reader=createInterface({input:child.stdout});reader.on('line',line=>{const message=JSON.parse(line),waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);clearTimeout(waiter.timer);message.error?waiter.reject(new Error(JSON.stringify(message.error))):waiter.resolve(message.result);});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Creation stdio timeout ${method}: ${stderr}`));},20000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'sanitized-video-ui-fixture',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const read=unpack(await call('tools/call',{name:'studio_creation_request_get',arguments:{requestId:request.id,revision:request.revision}}));assert.ok(read.readAt,'MCP get records an actual read');
  const receipt=unpack(await call('tools/call',{name:'studio_creation_draft_receive',arguments:{requestId:request.id,revision:request.revision,draft}}));assert.equal(receipt.reviewRequired,true);assert.deepEqual(receipt.draft,draft);
  return {...request,status:'draft-received',readAt:read.readAt,draftReceivedAt:receipt.draftReceivedAt,draft:receipt.draft};
 }finally{reader?.close();child?.kill();for(const waiter of pending.values())clearTimeout(waiter.timer);await rm(home,{recursive:true,force:true});}
}
