#!/usr/bin/env node
/** Failure-path audit of the shipped React UI. IPC delay/failure are controlled;
 * asset reads/writes use a real Rust worker and a disposable library. External
 * services and native dialogs are NOT represented as authenticated successes.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const scratch=await mkdtemp(resolve(tmpdir(),'toris-functional-audit-'));
const evidence=resolve(root,'docs/review/functional-audit');
await mkdir(evidence,{recursive:true});
const report={adapter:'Chromium + actual Rust asset worker; explicit disconnected external-service fixtures',checks:[],unverified:['native macOS dialogs and WKWebView','authenticated ChatGPT generation/file delivery','live publishing, OAuth and external provider calls'],source:'current checkout'};
let server,browser;
const processes=new Set();
function worker(action,input={}) {
  return new Promise((accept,reject)=>{
    const guiOnly=['thumbnail','payload'].includes(action);
    const child=spawn(resolve(root,guiOnly?'desktop/src-tauri/target/debug/examples/asset_qa_bridge':'desktop/src-tauri/target/debug/toris-studio-desktop'),guiOnly?[]:['--asset-command'],{env:{HOME:process.env.HOME,PATH:process.env.PATH,TORIS_STUDIO_ASSET_HOME:scratch},stdio:['pipe','pipe','pipe']});
    processes.add(child);const parts=[];
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('asset worker timeout'));},20000);
    child.stdout.on('data',part=>parts.push(part));child.stderr.resume();child.on('error',reject);
    child.on('close',()=>{clearTimeout(timer);processes.delete(child);try{const data=JSON.parse(Buffer.concat(parts).toString());data.ok?accept(data.result):reject(new Error(data.error));}catch(error){reject(error);}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({action,input}));
  });
}
async function check(name,fn) {
  if(process.env.AUDIT_CASE && !name.includes(process.env.AUDIT_CASE))return;
  try {const detail=await fn();report.checks.push({name,passed:true,...detail});console.log(`PASS ${name}`);}
  catch(error){report.checks.push({name,passed:false,error:error.message});console.error(`FAIL ${name}: ${error.message}`);}
}
async function screen({snapshot=()=>worker('snapshot'), width=1380, height=900}={}) {
  const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce'});
  const lifecycle=new AbortController();context.on('close',()=>lifecycle.abort());
  await context.route('https://**/*',route=>route.abort());
  const page=await context.newPage();const errors=[],calls=[];
  page.setDefaultTimeout(4000);page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('__auditInvoke',async(command,args={})=>{
    calls.push({command,action:args.action});
    if(command==='get_dashboard')return {channels:[],content:[],trends:[],integrations:[],database:{connected:false,message:'QA: 외부 DB 연결 없음'}};
    if(command==='ai_status')return {providers:[],defaultProvider:null};
    if(command==='asset_command')return args.action==='snapshot'?snapshot(args.input,lifecycle.signal):worker(args.action,args.input);
    if(command==='asset_choose_files')return [];
    if(command==='asset_choose_folder')return {cancelled:true};
    if(command==='copy_text')return;
    throw new Error(`QA 연결 미설정: ${command}`);
  });
  await page.addInitScript(()=>{window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__auditInvoke(command,args)};});
  const address=server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}/`,{waitUntil:'networkidle'});
  return {page,context,errors,calls};
}
async function assets(page) {
  await page.getByRole('button',{name:'이미지 생성기',exact:true}).click();
  await page.getByRole('button',{name:/에셋 보관함/}).click();
}
try {
  const png=await readFile(resolve(root,'desktop/public/brand/toris-logo.png'));
  await worker('import',{filename:'audit.png',dataBase64:png.toString('base64'),spec:{title:'보존 원본 검증',prompt:'Test fixture, not AI generated',purpose:'project',project:'Audit',width:64,height:64,format:'png',fit:'contain',quantity:1},source:'imported'});
  server=await createServer({configFile:resolve(root,'desktop/vite.config.ts'),server:{port:0,strictPort:false}});await server.listen();
  browser=await chromium.launch({headless:true});

  await check('all 11 navigation destinations render with unavailable-service errors contained',async()=>{
    const {page,context,errors,calls}=await screen();
    try {
      const names=['오버뷰','콘텐츠 플래너','트렌드 탐색','키워드 탐색','AI 작업실','영상 스튜디오','이미지 생성기','내 채널','YouTube 관리','SNS 로그인','연결 설정'];
      for(const name of names){await page.locator('.social-nav').getByRole('button',{name,exact:true}).click();await page.getByRole('heading',{name,exact:true,level:1}).waitFor();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
      assert.deepEqual(errors,[]);
      return {destinations:names,observedCommands:[...new Set(calls.map(c=>c.command))]};
    }finally{await context.close();}
  });
  await check('slow asset reads finish without overlapping automatic polls or infinite loading',async()=>{
    let concurrent=0,peak=0,completed=0;
    const {page,context}=await screen({snapshot:async(input,signal)=>{concurrent++;peak=Math.max(peak,concurrent);try{await delay(5600,undefined,{signal});return await worker('snapshot',input);}finally{concurrent--;completed++;}}});
    try {
      await assets(page);
      await page.locator('.asset-card').waitFor({state:'visible',timeout:7400});
      assert.equal(peak,1,'background polls must not overlap an unfinished read');
      assert.ok(completed>=1);return {peakConcurrentReads:peak};
    }finally{await context.close();}
  });
  await check('initial read failure is never mislabeled as an empty successful library',async()=>{
    const {page,context}=await screen({snapshot:async()=>{throw new Error('QA: 일시적 저장소 오류');}});
    try {
      await assets(page);await page.getByRole('alert').filter({hasText:'QA: 일시적 저장소 오류'}).waitFor();
      assert.equal(await page.getByRole('heading',{name:'흩어진 에셋을 한곳에 모으세요'}).count(),0,'read failure must not show the no-assets onboarding');
      assert.equal(await page.getByRole('heading',{name:'보관함을 불러오지 못했습니다'}).count(),1);
      await page.evaluate(()=>scrollTo(0,0));
      await page.screenshot({path:resolve(evidence,'read-failure.png'),fullPage:false});
    }finally{await context.close();}
  });
  await check('automatic recovery clears stale read errors without losing the creation draft',async()=>{
    let calls=0;
    const {page,context,errors}=await screen({snapshot:async input=>{if(++calls===1)throw new Error('QA: 복구할 읽기 오류');return worker('snapshot',input);}});
    try {
      await page.getByRole('button',{name:'이미지 생성기',exact:true}).click();
      await page.getByRole('alert').filter({hasText:'QA: 복구할 읽기 오류'}).waitFor();
      await page.getByLabel('이미지 프롬프트',{exact:true}).fill('복구해도 유지해야 하는 초안');
      await page.waitForFunction(()=>!document.querySelector('.asset-message.error'),{},{timeout:8000});
      assert.deepEqual(errors,[],'recovering a failed read must not crash React');
      assert.equal(await page.getByLabel('이미지 프롬프트',{exact:true}).inputValue(),'복구해도 유지해야 하는 초안');
    }finally{await context.close();}
  });
  await check('workspace refresh on the asset tab refreshes assets, not unrelated providers',async()=>{
    let reads=0;
    const {page,context,calls}=await screen({snapshot:async input=>{reads++;return worker('snapshot',input);}});
    try {
      await assets(page);await page.locator('.asset-card').waitFor();
      const initial=reads;const before=calls.length;
      await page.getByRole('button',{name:'워크스페이스 새로고침',exact:true}).click();
      await page.waitForFunction(()=>true);await new Promise(r=>setTimeout(r,600));
      assert.ok(reads>initial,'the visible workspace refresh must trigger an asset read immediately');
      assert.equal(calls.slice(before).some(c=>c.command==='ai_status'),false,'asset refresh must not inspect unrelated AI credentials');
    }finally{await context.close();}
  });
  await check('keyboard skip link and responsive asset layout remain usable',async()=>{
    const {page,context,errors}=await screen();
    try {
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('.social-skip-link').evaluate(e=>e===document.activeElement),true);
      await page.keyboard.press('Enter');
      const next=await page.evaluate(()=>document.activeElement?.id);
      assert.equal(next,'social-main','skip link must focus the main region');
      await assets(page);await page.locator('.asset-card').waitFor();
      for(const width of [1380,820]) {
        await page.setViewportSize({width,height:720});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      }
      await page.locator('.asset-card-open').first().click();
      await page.getByRole('button',{name:'크기 변경·내보내기',exact:true}).click();
      await page.evaluate(()=>scrollTo(0,0));
      await page.screenshot({path:resolve(evidence,'resize-narrow.png'),fullPage:false});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      assert.deepEqual(errors,[]);
    }finally{await context.close();}
  });
  await check('late search responses never replace the current search results',async()=>{
    let started,finished;
    const oldStarted=new Promise(resolve=>{started=resolve;});
    const oldFinished=new Promise(resolve=>{finished=resolve;});
    const {page,context}=await screen({snapshot:async(input,signal)=>{
      const result=await worker('snapshot',input);
      if(input.query==='missing') {started();await delay(900,undefined,{signal});finished();}
      return result;
    }});
    try {
      await assets(page);await page.locator('.asset-card').waitFor();
      await page.getByLabel('에셋 검색',{exact:true}).fill('missing');
      await Promise.race([oldStarted,delay(4000).then(()=>{throw new Error('search was not requested');})]);
      await page.getByLabel('에셋 검색',{exact:true}).fill('보존');
      await oldFinished;
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.locator('.asset-card').count(),1);
      assert.equal(await page.getByRole('heading',{name:'조건에 맞는 에셋이 없습니다'}).count(),0);
      assert.equal(await page.getByLabel('에셋 검색',{exact:true}).inputValue(),'보존');
    }finally{await context.close();}
  });
  await check('form draft and selected image survive a background refresh',async()=>{
    const {page,context}=await screen();
    try {
      await assets(page);await page.locator('.asset-card').waitFor();await page.locator('.asset-card-open').first().click();
      await page.getByLabel('태그',{exact:true}).fill('저장 전 편집 내용');
      await new Promise(r=>setTimeout(r,5300));
      assert.equal(await page.getByLabel('태그',{exact:true}).inputValue(),'저장 전 편집 내용');
      assert.equal(await page.locator('.asset-inspector').count(),1);
    }finally{await context.close();}
  });
}finally {
  await browser?.close();await server?.close();
  for(const child of processes)child.kill('SIGTERM');
  await rm(scratch,{recursive:true,force:true});
  report.passed=report.checks.every(c=>c.passed);
  await writeFile(resolve(evidence,'audit.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(!report.passed)process.exitCode=1;
}
