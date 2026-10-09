#!/usr/bin/env node
/** Actual installed Codexify -> packaged Studio MCP. Synthetic assets, private temporary store.
 * No ChatGPT/model calls, tunnel credentials, user browser state or public posts.
 */
import assert from 'node:assert/strict';
import { spawn,execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access,mkdtemp,mkdir,readFile,writeFile,rm } from 'node:fs/promises';
import { homedir,tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { createServer } from 'node:net';
const codexify=process.env.CODEXIFY_BIN||join(homedir(),'.codexify/bin/codexify');
const worker=process.env.TORIS_STUDIO_MCP_BIN||resolve('desktop/src-tauri/target/debug/toris-studio-desktop');
await access(codexify);await access(worker);
const scratch=await mkdtemp(join(tmpdir(),'toris-codexify-qa-'));
const home=join(scratch,'home'),project=join(scratch,'project'),assets=join(scratch,'assets'),drafts=join(scratch,'drafts');
await Promise.all([mkdir(home),mkdir(project),mkdir(assets),mkdir(drafts)]);
const token=randomBytes(32).toString('hex');
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const config={schemaVersion:1,workDir:project,multiProject:false,apiKey:token,port,allowedHosts:['127.0.0.1','localhost'],uiWidgets:false,codexMcp:{enabled:false,useCli:false},skills:{enabled:false},memory:{enabled:false},artifactIngress:{enabled:false},artifactEgress:{enabled:false},mcpServers:{studio:{command:worker,args:['--studio-mcp'],env:{TORIS_STUDIO_ASSET_HOME:assets,TORIS_STUDIO_DRAFT_TEST_HOME:drafts},mode:'direct',startupTimeoutSec:30,toolTimeoutSec:180}}};
const configPath=join(scratch,'codexify.config.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
const env={HOME:home,USERPROFILE:home,PATH:process.env.PATH,LANG:'en_US.UTF-8',TMPDIR:tmpdir(),RUST_LOG:'error'};
const report={scope:'Installed Codexify via authenticated temporary HTTP + real Rust Studio MCP',checks:[],chatgptGenerationTested:false,chatgptFileReceiptTested:false,tunnelCredentialsUsed:false,userLibraryChanged:false};
let child,session,sequence=0;
async function rpc(method,params={}){
 const id=++sequence;
 const response=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(session?{'Mcp-Session-Id':session,'MCP-Protocol-Version':'2025-11-25'}:{})},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(30000)});
 if(response.headers.get('mcp-session-id'))session=response.headers.get('mcp-session-id');
 assert.ok(response.ok,`MCP HTTP ${response.status}`);
 let message;
 if(response.headers.get('content-type')?.includes('text/event-stream')){
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  try{while(!message){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});for(const event of buffer.split(/\r?\n\r?\n/).slice(0,-1)){const raw=event.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(raw){const parsed=JSON.parse(raw);if(parsed.id===id)message=parsed;}}if(!message)buffer=buffer.split(/\r?\n\r?\n/).at(-1);}}finally{await reader.cancel();reader.releaseLock();}
 }else{message=await response.json();}
 assert.ok(message,`${method} response absent`);assert.equal(message.error,undefined,`${method} JSON-RPC error`);return message.result;
}
function unpack(result){assert.notEqual(result.isError,true,JSON.stringify(result));return JSON.parse(result.content.find(c=>c.type==='text').text);}
try{
 child=spawn(codexify,['--config',configPath],{env,stdio:['ignore','pipe','pipe']});let launchError;child.on('error',e=>{launchError=e.code||'spawn error';});child.stdout.resume();child.stderr.resume();
 let ready=false;
 for(let i=0;i<100;i++){if(launchError)throw new Error(`Codexify start: ${launchError}`);if(child.exitCode!==null)throw new Error(`Codexify exited: ${child.exitCode}`);try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(500)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,200));}
 assert.ok(ready,'Codexify health not ready');
 const denied=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(denied.status,401);
 const initialized=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'toris-direct-qa',version:'1'}});report.server=initialized.serverInfo;
 const list=await rpc('tools/list');const tools=list.tools.filter(t=>t.name.startsWith('studio__'));
 assert.equal(tools.length,10);const receive=tools.find(t=>t.name==='studio__studio_asset_receive');assert.deepEqual(receive._meta['openai/fileParams'],['file']);assert.deepEqual(receive.inputSchema.properties.file.required,['download_url','file_id']);assert.equal(receive.annotations.destructiveHint,false);assert.equal(receive.annotations.idempotentHint,true);
 report.checks.push('Native tool names, file schema, _meta and safety annotations survive real direct aggregation');
 const tool=(name,args={})=>rpc('tools/call',{name:`studio__${name}`,arguments:args}).then(unpack);
 const draftRequestId=randomUUID();await writeFile(join(drafts,'inbox.json'),JSON.stringify([{id:draftRequestId,status:'waiting',topic:'Synthetic QA',createdAt:new Date().toISOString()}]),{mode:0o600});
 const draftReply={requestId:draftRequestId,title:'Synthetic title',description:'Synthetic description',tags:['fixture'],hashtags:['test']};
 const draftReceived=await tool('studio_publication_draft_receive',draftReply);assert.equal(draftReceived.status,'received');assert.deepEqual(await tool('studio_publication_draft_receive',draftReply),draftReceived);
 assert.equal(JSON.parse(await readFile(join(drafts,'inbox.json'),'utf8'))[0].draft.title,'Synthetic title');assert.equal(draftReceived.approved,undefined);
 report.checks.push('Request-bound structured SNS draft crosses real Codexify, persists and is idempotent without creating approvals or posts');
 await tool('studio_connection_check');assert.equal((await tool('studio_asset_presets')).presets.length,31);
 const spec={title:'Codexify QA',prompt:'Synthetic test; no model invocation.',purpose:'project',project:'QA',width:64,height:64,format:'png',fit:'contain',quantity:1};
 const batches=await Promise.all(Array.from({length:6},()=>tool('studio_asset_request',spec)));
 assert.equal(new Set(batches.flatMap(b=>b.jobs.map(j=>j.id))).size,6);assert.equal((await tool('studio_asset_list',{jobLimit:100,jobStatus:'pending'})).jobs.length,6);
 report.checks.push('Six simultaneous direct requests persist exactly six distinct jobs');
 const seed=JSON.parse(execFileSync(worker,['--asset-command'],{encoding:'utf8',timeout:30000,env:{...env,TORIS_STUDIO_ASSET_HOME:assets},input:JSON.stringify({action:'import',input:{filename:'qa.png',dataBase64:(await readFile('desktop/public/brand/toris-logo.png')).toString('base64'),spec}})}));assert.equal(seed.ok,true);
 const outputs=await Promise.all([32,48,64].map(size=>tool('studio_asset_resize',{id:seed.result.asset.id,spec:{...spec,width:size,height:size,presetId:`favicon-${size}`,format:'ico'}})));
 for(let i=0;i<outputs.length;i++){const bytes=await readFile(outputs[i].asset.outputPath);assert.deepEqual([...bytes.subarray(0,6)],[0,0,1,0,1,0]);assert.equal(bytes[6],[32,48,64][i]);}
 const after=await tool('studio_asset_list',{limit:100});assert.equal(after.libraryTotal,4);
 const invalid=await rpc('tools/call',{name:'studio__studio_asset_receive',arguments:{file:{download_url:'http://127.0.0.1/secret',file_id:'qa'},jobId:batches[0].jobs[0].id}});assert.equal(invalid.isError,true);
 report.checks.push('Concurrent ICO transforms produce valid containers; originals preserved; unsafe host-file URLs rejected');
 report.passed=true;console.log(JSON.stringify(report,null,2));
}finally{
 if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('close',r)),new Promise(r=>setTimeout(r,4000))]);if(child.exitCode===null)child.kill('SIGKILL');}
 await mkdir('docs/review/ai-workspace',{recursive:true});await writeFile('docs/review/ai-workspace/codexify-verification.json',JSON.stringify(report,null,2));await rm(scratch,{recursive:true,force:true});
}
