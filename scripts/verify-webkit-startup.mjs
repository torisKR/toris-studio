#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {webkit} from 'playwright';
import {shellFixture, unhandled} from './ui-fixture-helpers.mjs';

// Test the built desktop assets with the native CSP, rather than Vite's dev
// server. Native IPC is an explicit read-only fixture; no user profile is read.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dist=path.join(root,'desktop/dist');
const config=JSON.parse(await readFile(path.join(root,'desktop/src-tauri/tauri.conf.json'),'utf8'));
const files=new Set(await readdir(dist,{recursive:true}));
assert.ok(files.has('index.html'),'Build the desktop UI before checking WebKit startup');
const failures=[];
const server=createServer(async(req,res)=>{
 try{
  const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
  const name=pathname==='/'?'index.html':pathname.slice(1);
  if(req.method!=='GET'||!files.has(name))throw new Error('Unknown built asset');
  const body=await readFile(path.join(dist,name));
  res.setHeader('Content-Security-Policy',config.app.security.csp);
  const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
  res.setHeader('Content-Type',types[path.extname(name)]??'application/octet-stream');
  res.end(body);
 }catch{res.writeHead(404);res.end();}
});
let browser;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await webkit.launch({headless:true});
 for(const slashDisplay of [false,true]){
  const page=await browser.newPage({viewport:{width:1380,height:900},locale:'ko-KR'});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('response',response=>{if(response.status()>=400)errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);});
  await page.exposeFunction('__startupFixture',async(command,args={})=>{
   if(command==='get_dashboard')return {channels:[],content:[],trends:[],integrations:[],database:{connected:false,message:'Isolated WebKit startup fixture'}};
   const value=shellFixture(command,args);
   if(value!==unhandled)return value;
   errors.push(`Unexpected native startup command: ${command}`);
   throw new Error(errors.at(-1));
  });
  await page.addInitScript(({slashDisplay})=>{
   window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__startupFixture(command,args)};
   if(slashDisplay){
    const original=Intl.DateTimeFormat;
    Intl.DateTimeFormat=new Proxy(original,{construct(target,args){
     const formatter=Reflect.construct(target,args);
     if(args[0]==='en-CA')Object.defineProperty(formatter,'format',{value:value=>new original('en-US',args[1]).format(value)});
     return formatter;
    }});
   }
  },{slashDisplay});
  await page.clock.setFixedTime(new Date('2026-12-31T15:05:00Z'));
  const response=await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'});
  assert.equal(response.headers()['content-security-policy'],config.app.security.csp);
  await page.getByRole('navigation',{name:'SNS 관리 화면',exact:true}).waitFor({timeout:12000});
  assert.deepEqual(await page.getByRole('navigation',{name:'주 메뉴',exact:true}).getByRole('button').allTextContents(),['SNS 관리','콘텐츠','제작','게시','운영']);
  assert.equal(await page.getByLabel('분석 시작일',{exact:true}).inputValue(),'2026-12-05');
  assert.equal(await page.getByLabel('분석 종료일',{exact:true}).inputValue(),'2027-01-01');
  assert.deepEqual(errors,[],`WebKit production startup (${slashDisplay?'slash':'native'} display)`);
  failures.push({display:slashDisplay?'slash':'native',pageErrors:errors.length,checks:'production CSP, five destinations, KST year boundary'});
  await page.close();
 }
 console.log(JSON.stringify({browser:'WebKit',nativeProviderExecution:false,checks:failures},null,2));
}finally{
 await browser?.close();
 await new Promise(resolve=>server.close(resolve));
}
