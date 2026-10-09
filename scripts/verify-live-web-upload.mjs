#!/usr/bin/env node
/** Live HTTP preflight only. It refuses to submit an upload when credentials are configured.
 * Uses this checkout and its real .env files; creates no video, posts, or credentials.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const portServer=net.createServer();
portServer.listen(0,'127.0.0.1');await once(portServer,'listening');
const port=portServer.address().port;
await new Promise((resolve,reject)=>portServer.close(error=>error?reject(error):resolve()));
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port',String(port)],{stdio:['ignore','pipe','pipe'],env:process.env});
// Do not relay runtime logs: diagnostics must not expose provider/configuration errors.
child.stdout.resume();child.stderr.resume();
let exited=false;let failed=false;
child.on('exit',()=>{exited=true;});child.on('error',()=>{failed=true;});
const base=`http://127.0.0.1:${port}`;
try {
  let health;
  const deadline=Date.now()+90000;
  while(Date.now()<deadline && !exited && !failed){
    try {const response=await fetch(`${base}/api/health`,{signal:AbortSignal.timeout(6000)});if(response.ok){health=await response.json();break;}}catch{}
    await delay(500);
  }
  assert.equal(health?.ok,true,'Live local Next.js health endpoint did not become ready. No upload attempted.');
  if(health.youtubeConfigured) {
    console.log(JSON.stringify({checkedAt:new Date().toISOString(),status:'blocked',reason:'Upload credentials exist: specify the intended test channel/video before a live upload.',publicPostsCreated:0},null,2));
  } else {
    const response=await fetch(`${base}/api/youtube/upload`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fileName:'qa-not-uploaded.mp4',title:'Toris QA preflight — no upload',privacyStatus:'private'}),signal:AbortSignal.timeout(60000)});
    const body=await response.json();
    assert.equal(response.status,503);
    assert.equal(body.code,'YOUTUBE_UPLOAD_NOT_CONFIGURED');
    const denied=await fetch(`${base}/api/youtube/upload`,{method:'POST',headers:{'content-type':'application/json',origin:'https://external.invalid'},body:JSON.stringify({fileName:'qa-not-uploaded.mp4',title:'Rejected origin'}),signal:AbortSignal.timeout(10000)});
    assert.equal(denied.status,403);
    console.log(JSON.stringify({checkedAt:new Date().toISOString(),status:'passed',runtime:'real Next.js HTTP with actual local configuration',webUploadConfigured:false,uploadPreflightHttp:response.status,uploadPreflightCode:body.code,foreignOriginHttp:denied.status,providerUploadAttempted:false,publicPostsCreated:0},null,2));
  }
} finally {
  if(!exited){child.kill('SIGTERM');for(let i=0;i<30&&!exited;i++)await delay(100);if(!exited)child.kill('SIGKILL');}
}
