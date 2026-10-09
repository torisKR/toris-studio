#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const home = await mkdtemp(resolve(tmpdir(),'toris-mcp-verify-'));
const executable = resolve(`desktop/src-tauri/target/debug/toris-studio-desktop${process.platform==='win32'?'.exe':''}`);
const nativeBinary = process.env.TORIS_TEST_NATIVE_MCP_BINARY ?? (process.argv.includes('--native') ? executable : undefined);
const child = spawn(nativeBinary ?? process.execPath,nativeBinary ? ['--studio-mcp'] : ['--import','tsx','mcp/asset-stdio.ts'],{
  env:{HOME:process.env.HOME,PATH:process.env.PATH,NODE_ENV:'test',TORIS_STUDIO_ASSET_HOME:home},
  stdio:['pipe','pipe','pipe']
});
const waiting=new Map();let sequence=0;let stderr='';
child.stderr.on('data',data=>{stderr+=data.toString();});
const reader=createInterface({input:child.stdout});
reader.on('line',line=>{
  try {
    const message=JSON.parse(line), request=waiting.get(message.id);
    if(!request)return;
    waiting.delete(message.id);clearTimeout(request.timer);
    if(message.error)request.reject(new Error(JSON.stringify(message.error)));else request.resolve(message.result);
  }catch(error){for(const request of waiting.values())request.reject(error);}
});
function call(method,params={}){
  return new Promise((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{waiting.delete(id);reject(new Error(`MCP timeout: ${method}; ${stderr.slice(0,500)}`));},20000);
    waiting.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
}
function unpack(response){assert.notEqual(response.isError,true,JSON.stringify(response));return JSON.parse(response.content.find(c=>c.type==='text').text);}
try {
  const initialized=await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'toris-asset-verifier',version:'1.0.0'}});
  assert.equal(initialized.serverInfo.name,'toris-studio-assets');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const {tools}=await call('tools/list');assert.equal(tools.length,nativeBinary ? 10 : 8);
  const presets=unpack(await call('tools/call',{name:'studio_asset_presets',arguments:{}}));
  assert.equal(presets.presets.length,31);
  assert.deepEqual(presets.presets.find(p=>p.id==='play-icon').size,[512,512]);
  const receive=tools.find(tool=>tool.name==='studio_asset_receive');
  assert.deepEqual(receive._meta['openai/fileParams'],['file']);
  assert.deepEqual(receive.inputSchema.properties.file.required,['download_url','file_id']);
  assert.deepEqual(Object.keys(receive.inputSchema.properties.file.properties).sort(),['download_url','file_id','file_name','mime_type']);
  const input={title:'MCP protocol verification',prompt:'Test data. No AI generation call.',purpose:'project',project:'Verification',width:320,height:180,format:'png',fit:'contain',quantity:2};
  const queued=unpack(await call('tools/call',{name:'studio_asset_request',arguments:input}));
  assert.equal(queued.generated,false);assert.equal(queued.jobs.length,2);
  const list=unpack(await call('tools/call',{name:'studio_asset_list',arguments:{jobIds:queued.jobs.map(j=>j.id)}}));
  assert.equal(list.jobs.length,2);assert.equal(list.libraryTotal,0);
  const denied=await call('tools/call',{name:'studio_asset_receive',arguments:{file:{file_id:'test-ref',download_url:'http://127.0.0.1/private'},jobId:queued.jobs[0].id}});
  assert.equal(denied.isError,true);
  const mesh=unpack(await call('tools/call',{name:'studio_asset_create_3d',arguments:{spec:input,shape:'box',size:[1,1,1],format:'glb'}}));
  assert.equal(mesh.asset.kind,'model3d');assert.equal(mesh.asset.details.triangles,12);
  const seed=JSON.parse(execFileSync(executable,['--asset-command'],{input:JSON.stringify({action:'import',input:{filename:'fixture.png',dataBase64:(await readFile('desktop/public/brand/toris-logo.png')).toString('base64'),spec:{...input,quantity:1}}}),env:{HOME:process.env.HOME,PATH:process.env.PATH,TORIS_STUDIO_ASSET_HOME:home},encoding:'utf8',timeout:30000}));
  assert.equal(seed.ok,true);
  const resized=unpack(await call('tools/call',{name:'studio_asset_resize',arguments:{id:seed.result.asset.id,spec:{...input,quantity:1,presetId:'play-feature',width:1024,height:500,backgroundColor:'#123456'}}}));
  assert.equal(resized.asset.details.hasAlphaChannel,false);
  assert.equal(resized.asset.sourceAssetId,seed.result.asset.id);
  const favicon=unpack(await call('tools/call',{name:'studio_asset_resize',arguments:{id:seed.result.asset.id,spec:{...input,quantity:1,presetId:'favicon-32',width:32,height:32,format:'ico'}}}));
  assert.deepEqual([...(await readFile(favicon.asset.outputPath)).subarray(0,6)],[0,0,1,0,1,0]);
  const review=unpack(await call('tools/call',{name:'studio_asset_review',arguments:{id:mesh.asset.id,favorite:true,tags:['MCP test']}}));
  assert.equal(review.asset.favorite,true);
  await call('tools/call',{name:'studio_asset_job_status',arguments:{id:queued.jobs[0].id,status:'cancelled'}});
  const final=unpack(await call('tools/call',{name:'studio_asset_list',arguments:{jobStatus:'pending'}}));
  assert.equal(final.jobs.length,1);assert.equal(final.libraryTotal,4);
  console.log(JSON.stringify({passed:true,protocol:initialized.protocolVersion,tools:tools.map(t=>t.name),checks:['real stdio initialize/list/call','complete OpenAI file descriptor','persistent request queue','unsafe file URL rejected','actual GLB export','metadata updates','pending job filtering','31 shared presets','Play no-alpha resize via MCP','real ICO resize via MCP'],chatgptConnectionTested:false,realChatgptFileReceiptTested:false},null,2));
}finally{
  for(const request of waiting.values())clearTimeout(request.timer);
  reader.close();child.kill('SIGTERM');
  await new Promise(resolve=>child.once('close',resolve));
  await rm(home,{recursive:true,force:true});
}
