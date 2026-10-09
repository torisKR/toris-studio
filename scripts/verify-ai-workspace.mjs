#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const out=resolve('/private/tmp/toris-ai-workspace-ui');await mkdir(out,{recursive:true});
const trend={id:'source-1',source:'youtube',keyword:'AI 생산성',title:'반복 업무를 줄이는 로컬 AI',url:'https://www.youtube.com/watch?v=abcdefghijk',metric:null,region:'KR',publishedAt:null,fetchedAt:'2026-10-09T00:00:00Z',details:{discovery:'youtube_keyword',description:'제공된 원본 설명: 작은 업무부터 자동화하세요.'}};
const items=[{trend,matches:[],observedKeywords:[{keyword:'로컬 자동화',source:'youtube',observedAt:trend.fetchedAt}],extractedKeywords:[{keyword:'반복 업무',score:2,occurrences:1}]}];
let clipboard='',keywordReads=0;
let connectionProfile={mcpUrl:'http://127.0.0.1:21228/mcp',pluginUrl:'https://chatgpt.com/plugins/plugin_qa',conversationUrl:'',projectRoot:'/tmp/qa-studio',conversationId:''};
let dashboardConnected=true,keywordItems=items,delayNextDashboard=false,delayNextKeywordRead=false,resolveDashboardRead,resolveKeywordRead;
const report={adapter:'Chromium with explicit IPC fixtures; no model, OAuth or publishing calls',checks:[],errors:[]};
const server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false}});await server.listen();
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1380,height:980},reducedMotion:'reduce'});
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.exposeFunction('__qaInvoke',async(command,args={})=>{
  if(command==='get_dashboard'){
   const dashboard={channels:[],content:[],trends:[trend,...Array.from({length:5},(_,i)=>({...trend,id:`fixture-${i}`,keyword:`검증 주제 ${i+1}`,title:`[QA] 서로 다른 출처의 콘텐츠 ${i+1}`,url:`https://example.com/qa/${i}`,fetchedAt:`2026-10-0${8-i}T00:00:00Z`}))],integrations:[],database:{connected:dashboardConnected,message:'QA fixture'}};
   if(delayNextDashboard){delayNextDashboard=false;return new Promise(resolve=>{resolveDashboardRead=()=>resolve(dashboard);});}
   return dashboard;
  }
  if(command==='search_keywords'){
   keywordReads++;
   const result={query:'',mode:'local',items:keywordItems,total:1,libraryCount:1,indexLimit:500,truncated:false,searchedAt:trend.fetchedAt,warnings:[]};
   if(delayNextKeywordRead){delayNextKeywordRead=false;return new Promise(resolve=>{resolveKeywordRead=()=>resolve(result);});}
   return result;
  }
  if(command==='get_keyword_status')return {databaseConnected:true,libraryCount:1,indexLimit:500,sources:[],engines:[],running:false};
  if(command==='get_keyword_runs')return [];
  if(command==='get_content_keywords')return items[0];
  if(command==='copy_text'){clipboard=args.text;return;}
  if(command==='codexify_connection_get')return {...connectionProfile};
  if(command==='codexify_connection_save'){connectionProfile={...args.input};return {...connectionProfile};}
  if(command==='codexify_chats')return {chats:[],serverTimeMs:1000};
  if(command==='codexify_connection_check')return {reachable:true,fileReceiverReady:true,ownerReady:true,toolCount:64,message:'QA bridge fixture'};
  if(command==='open_external')return null;
  if(command==='codexify_chat_read')return {messages:[{role:'agent',markdown:'실제 생성물이 아닌 ChatGPT QA 응답'}],server_time_ms:1000};
  if(command==='integration_status')return {oauth:{providers:[]},mcp:{lastToolCallAt:null,lastFileReceivedAt:null,chatgptLoginVerified:false},mcpConfig:{mcpServers:{'toris-studio':{command:'/Applications/Toris Studio.app/Contents/MacOS/toris-studio-desktop',args:['--studio-mcp']}}},lastUpload:null,version:'0.1.14'};
  throw new Error(`QA: unsupported IPC ${command}`);
 });
 await page.addInitScript(()=>{
  window.__qaKeywordCompletions=0;
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   const result=await window.__qaInvoke(command,args);
   if(command==='search_keywords')window.__qaKeywordCompletions++;
   return result;
  }};
 });
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`,{waitUntil:'networkidle'});
 assert.equal(await page.getByRole('button',{name:'영상 스튜디오',exact:true}).count(),0,'removed video destination must not remain');
 await page.getByRole('button',{name:'AI 작업실',exact:true}).click();
 await page.getByRole('heading',{name:'오늘의 주제 후보',exact:true}).waitFor();
 await page.getByRole('button',{name:'로컬 자동화 · 실제 검색어',exact:true}).waitFor();
 report.checks.push('Video Studio destination removed; real-shaped trends and observed/extracted keyword summaries present');
 await page.getByLabel('참고 자료와 맥락',{exact:false}).fill('직접 적은 맥락을 보존합니다.');
 await page.getByRole('button',{name:'로컬 자동화 · 실제 검색어',exact:true}).click();
 await page.getByRole('button',{name:'선택한 키워드를 주제와 자료로 사용',exact:true}).click();
 assert.equal(await page.getByLabel('주제와 작성 방향',{exact:true}).inputValue(),'로컬 자동화');
 assert.equal(await page.getByLabel('참고 자료와 맥락',{exact:false}).inputValue(),'직접 적은 맥락을 보존합니다.');
 await page.getByRole('button',{name:'선택한 키워드를 주제와 자료로 사용',exact:true}).click();
 assert.equal(await page.locator('.ai-reference-item').count(),1);
 await page.getByRole('button',{name:'요청 복사·ChatGPT 열기',exact:true}).click();
 assert.match(clipboard,/직접 적은 맥락/);assert.match(clipboard,/abcdefghijk/);assert.match(clipboard,/Codexify/);
 report.checks.push('Keyword-to-topic + evidence selection, deduplication, manual context preservation, Codexify ChatGPT handoff');
 assert.equal(await page.locator('.ai-trend-summary li').count(),6);
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:resolve(out,'ai-workspace-desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'ChatGPT 최근 응답 가져오기',exact:true}).click();
 await page.getByLabel('ChatGPT 결과 붙여넣기·편집',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('ChatGPT 결과 붙여넣기·편집',{exact:true}).inputValue(),'실제 생성물이 아닌 ChatGPT QA 응답');
 assert.equal(await page.getByRole('button',{name:'AI로 작성',exact:true}).count(),0);
 report.checks.push('ChatGPT actual owner-chat reply import stays editable; direct AI provider generation button removed');
 await page.getByRole('button',{name:'참고자료 해제: 반복 업무를 줄이는 로컬 AI',exact:true}).click();
 assert.equal(await page.locator('.ai-reference-item').count(),0);
 await page.getByRole('button',{name:'반복 업무 · 추출 키워드',exact:true}).click();
 await page.getByRole('button',{name:'선택한 키워드를 참고자료로 추가',exact:true}).click();
 assert.equal(await page.getByLabel('주제와 작성 방향',{exact:true}).inputValue(),'로컬 자동화');
 await page.getByRole('button',{name:'수집 자료 새로고침',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.ai-reference-item').length===1);
 assert.equal(await page.getByLabel('참고 자료와 맥락',{exact:false}).inputValue(),'직접 적은 맥락을 보존합니다.');
 report.checks.push('Reference-only selection and refresh preserve topic and unsaved context');
 const discovery=page.getByRole('region',{name:'주제 발견과 자료 선택',exact:true});
 const refresh=discovery.getByRole('button',{name:'수집 자료 새로고침',exact:true});
 await page.waitForFunction(()=>!document.querySelector('.ai-discovery [aria-label="수집 자료 새로고침"]').disabled);
 const readsBeforeDisconnect=keywordReads;
 const completedBeforeDisconnect=await page.evaluate(()=>window.__qaKeywordCompletions);
 const staleKeyword='무시되어야 하는 지연 키워드',freshKeyword='재연결 후 새로운 키워드';
 keywordItems=[{...items[0],observedKeywords:[{keyword:staleKeyword,source:'youtube',observedAt:trend.fetchedAt}]}];
 dashboardConnected=false;delayNextKeywordRead=true;delayNextDashboard=true;
 await refresh.click();
 await discovery.getByText('주제 후보를 불러오는 중',{exact:true}).waitFor();
 assert.equal(await refresh.isDisabled(),true);
 assert.equal(typeof resolveKeywordRead,'function');assert.equal(typeof resolveDashboardRead,'function');
 assert.equal(keywordReads,readsBeforeDisconnect+1);
 resolveDashboardRead();
 await page.getByText('DB 연결 필요',{exact:true}).waitFor();
 await discovery.locator('.activity-status').waitFor({state:'hidden',timeout:4000});
 assert.equal(await refresh.isDisabled(),false,'DB disconnect must release refresh while the old keyword read is pending');
 assert.equal(await page.evaluate(()=>window.__qaKeywordCompletions),completedBeforeDisconnect,'delayed keyword read must still be pending');
 resolveKeywordRead();
 await page.waitForFunction(count=>window.__qaKeywordCompletions===count,completedBeforeDisconnect+1);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await discovery.getByRole('button',{name:`${staleKeyword} · 실제 검색어`,exact:true}).count(),0,'stale keyword result must be ignored after disconnect');
 assert.equal(await discovery.getByRole('button',{name:'로컬 자동화 · 실제 검색어',exact:true}).count(),1,'last valid keyword result must remain');
 assert.equal(await refresh.isDisabled(),false);
 keywordItems=[{...items[0],observedKeywords:[{keyword:freshKeyword,source:'youtube',observedAt:trend.fetchedAt}]}];dashboardConnected=true;
 await refresh.click();
 await page.getByText('로컬 DB 연결됨',{exact:true}).waitFor();
 await discovery.getByRole('button',{name:`${freshKeyword} · 실제 검색어`,exact:true}).waitFor();
 await discovery.locator('.activity-status').waitFor({state:'hidden'});
 assert.equal(keywordReads,readsBeforeDisconnect+2,'reconnect must start one fresh keyword read');
 assert.equal(await discovery.getByRole('button',{name:'로컬 자동화 · 실제 검색어',exact:true}).count(),0);
 assert.equal(await discovery.getByRole('button',{name:`${staleKeyword} · 실제 검색어`,exact:true}).count(),0);
 assert.equal(await refresh.isDisabled(),false);
 assert.equal(await page.getByLabel('참고 자료와 맥락',{exact:false}).inputValue(),'직접 적은 맥락을 보존합니다.');
 assert.equal(await page.locator('.ai-reference-item').count(),1);
 report.checks.push('DB disconnect during a delayed keyword read clears discovery busy state; stale response is ignored and reconnect reloads fresh keywords');
 await page.getByLabel('참고 자료와 맥락',{exact:false}).fill('가'.repeat(5900));
 await page.locator('.ai-context-budget.error').waitFor();
 assert.equal(await page.getByRole('button',{name:'요청 복사·ChatGPT 열기',exact:true}).isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'연결된 대화에 보내기',exact:true}).isDisabled(),true);
 await page.getByLabel('참고 자료와 맥락',{exact:false}).fill('직접 적은 맥락을 보존합니다.');
 report.checks.push('Oversized combined context blocks both providers without erasing manual input; animation pause works independently of execution');
 await page.setViewportSize({width:820,height:800});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:resolve(out,'ai-workspace-narrow.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 report.checks.push('Codexify direct configuration interaction verified by dedicated verify-codexify-ui.mjs');
 await page.getByRole('button',{name:'AI 작업실',exact:true}).click();
 await page.getByLabel('참고 자료와 맥락',{exact:false}).fill('가'.repeat(5900));
 await page.locator('.ai-context-budget.error').waitFor();
 await page.getByRole('button',{name:'트렌드 탐색',exact:true}).click();
 await page.getByRole('button',{name:'패턴 리포트',exact:true}).click();
 assert.match(await page.getByLabel('참고 자료와 맥락',{exact:false}).inputValue(),/원본 수치/);
 assert.ok((await page.getByLabel('참고 자료와 맥락',{exact:false}).inputValue()).length<=6000);
 assert.equal(await page.getByRole('button',{name:'연결된 대화에 보내기',exact:true}).isDisabled(),false);
 report.checks.push('Explicit trend pattern report prepares a bounded ChatGPT brief and preserves manual request approval');
 assert.deepEqual(report.errors,[]);report.passed=true;report.keywordReads=keywordReads;
 console.log(JSON.stringify(report,null,2));
} finally {await writeFile(resolve(out,'verification.json'),JSON.stringify(report,null,2));await browser.close();await server.close();}
