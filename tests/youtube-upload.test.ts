import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { google as googleApi } from "googleapis";
import { POST } from "../app/api/youtube/upload/route";
// Narrow the generated overloads for node:test; this is the same provider object used by the client.
const google = googleApi as unknown as { youtube: (...args: unknown[]) => unknown };

function request(body: unknown, headers: Record<string,string> = {}) {
  return new Request("http://127.0.0.1:3000/api/youtube/upload",{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});
}
const input={fileName:"clip.mp4",title:"QA test",description:"Not sent to a real provider"};
const authNames=["YOUTUBE_CLIENT_ID","YOUTUBE_CLIENT_SECRET","YOUTUBE_REDIRECT_URI","YOUTUBE_REFRESH_TOKEN"] as const;
async function isolated(configured: boolean, run:(root:string)=>Promise<void>) {
  const original=process.cwd(); const root=await mkdtemp(path.join(os.tmpdir(),"toris-youtube-qa-"));
  const env=Object.fromEntries(authNames.map(key=>[key,process.env[key]]));
  try {
    process.chdir(root);
    for(const key of authNames){if(configured)process.env[key]=key==="YOUTUBE_REDIRECT_URI"?"http://127.0.0.1/callback":"fixture-secret";else delete process.env[key];}
    await mkdir(path.join(root,"public/renders"),{recursive:true});
    const mp4=Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,2,0,105,115,111,109,109,112,52,50]);
    await writeFile(path.join(root,"public/renders/clip.mp4"),mp4);
    await run(root);
  } finally {process.chdir(original);for(const key of authNames){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}await rm(root,{recursive:true,force:true});}
}

test("upload denies hostile origins and invalid inputs before OAuth or provider calls",async t=>{
  let calls=0;
  t.mock.method(console,"error",()=>{});
  t.mock.method(google,"youtube",(()=>{calls++;throw new Error("must not call provider");}) as unknown as typeof google.youtube);
  await isolated(false,async()=>{
    assert.equal((await POST(request(input,{origin:"https://evil.test"}))).status,403);
    for(const change of [{fileName:"../clip.mp4"},{fileName:"sub/clip.mp4"},{fileName:"secret.txt"},{fileName:"clip.mp4\u0000"},{title:""},{title:"x".repeat(101)},{privacyStatus:"everyone"},{arbitraryEndpoint:"https://evil.test"}]) {
      assert.equal((await POST(request({...input,...change}))).status,400,JSON.stringify(change));
    }
    assert.equal((await POST(new Request("http://127.0.0.1:3000/api/youtube/upload",{method:"POST",headers:{"content-type":"application/json"},body:"{"}))).status,400);
    assert.equal((await POST(request({...input,description:"x".repeat(40000)}))).status,413);
    assert.equal(calls,0);
  });
});

test("missing web upload credentials return actionable 503 rather than a misleading generic 500",async t=>{
  t.mock.method(console,"error",()=>{});
  await isolated(false,async()=>{
    const response=await POST(request(input));
    assert.equal(response.status,503);
    const body=await response.json();
    assert.equal(body.code,"YOUTUBE_UPLOAD_NOT_CONFIGURED");
    assert.match(body.error,/데스크톱|업로드/);
    assert.equal(response.headers.get("cache-control"),"no-store");
  });
});

test("symlinked and non-video uploads never reach YouTube even with configured credentials",async t=>{
  let calls=0;
  t.mock.method(console,"error",()=>{});
  t.mock.method(google,"youtube",(()=>{calls++;throw new Error("must not call provider");}) as unknown as typeof google.youtube);
  await isolated(true,async root=>{
    await writeFile(path.join(root,"private-source.txt"),"private fixture");
    await symlink(path.join(root,"private-source.txt"),path.join(root,"public/renders/linked.mp4"));
    await writeFile(path.join(root,"public/renders/not-video.mp4"),"not an MP4");
    for(const fileName of ["linked.mp4","not-video.mp4"]){const response=await POST(request({...input,fileName}));assert.equal(response.status,400,fileName);}
    assert.equal(calls,0);
  });
});

test("upstream auth errors and request objects cannot leak credentials in response or logs",async t=>{
  const logs:unknown[]=[];
  t.mock.method(console,"error",(...args:unknown[])=>{logs.push(args);});
  t.mock.method(google,"youtube",(()=>({videos:{insert:async()=>{throw Object.assign(new Error("Bearer EXAMPLE_PRIVATE_TOKEN"),{code:401,config:{headers:{Authorization:"Bearer EXAMPLE_PRIVATE_TOKEN"}},response:{status:401,data:{error:{message:"client_secret=EXAMPLE_PRIVATE_TOKEN"}}}});}}})) as unknown as typeof google.youtube);
  await isolated(true,async()=>{
    const response=await POST(request(input));
    const body=await response.text();
    assert.equal(response.status,401);
    assert.doesNotMatch(body,/EXAMPLE_PRIVATE_TOKEN|client_secret|Bearer/);
    assert.doesNotMatch(JSON.stringify(logs),/EXAMPLE_PRIVATE_TOKEN|client_secret|Bearer/);
  });
});

test("successful upload defaults to private, disables duplicate retries and validates provider confirmation",async t=>{
  t.mock.method(console,"error",()=>{});
  let parameters:Record<string,unknown>={},options:Record<string,unknown>={};let empty=false;
  t.mock.method(google,"youtube",(()=>({videos:{insert:async(p:Record<string,unknown>,o:Record<string,unknown>)=>{parameters=p;options=o;return {data:empty?{}:{id:"QAONLY12345",status:{privacyStatus:"private"}}};}}})) as unknown as typeof google.youtube);
  await isolated(true,async()=>{
    const response=await POST(request(input)); assert.equal(response.status,200);
    const body=await response.json();assert.equal(body.video.id,"QAONLY12345");
    assert.equal((parameters.requestBody as {status:{privacyStatus:string}}).status.privacyStatus,"private");
    assert.equal(parameters.notifySubscribers,false);
    assert.equal(options.retry,false);
    empty=true;
    assert.equal((await POST(request(input))).status,502);
  });
});
