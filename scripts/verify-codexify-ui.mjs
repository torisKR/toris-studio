import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Explicit IPC fixtures exercise app interaction; no live ChatGPT messages or images.
const project = '/projects/studio';
const conversationId = 'a'.repeat(64);
let profile = {mcpUrl:'http://127.0.0.1:21228/mcp',pluginUrl:'',conversationUrl:'',projectRoot:'',conversationId:''};
let messages = [], waiting = false, acknowledged = false;
const calls = [], errors = [];
const server = await createServer({configFile:resolve('desktop/vite.config.ts'),server:{port:0,strictPort:false}});
await server.listen();
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1380,height:950},reducedMotion:'reduce'});
await page.exposeFunction('__qaInvoke', async (command,args={}) => {
  calls.push({command,args});
  if(command==='get_dashboard')return {channels:[],content:[],trends:[],integrations:[],database:{connected:false,message:'QA fixture'}};
  if(command==='ai_status')return {providers:[],defaultProvider:null};
  if(command==='search_keywords')return {items:[],total:0,libraryCount:0,warnings:[]};
  if(command==='integration_status')return {oauth:{providers:[]},mcp:{lastToolCallAt:null,lastFileReceivedAt:null,chatgptLoginVerified:false},mcpConfig:{mcpServers:{studio:{command:'/Applications/Toris Studio.app/Contents/MacOS/toris-studio-desktop',args:['--studio-mcp']}}},lastUpload:null,version:'test'};
  if(command==='codexify_connection_get')return {...profile};
  if(command==='codexify_connection_save'){profile={...args.input};return {...profile};}
  if(command==='codexify_connection_check')return {reachable:true,serverName:'Codexify',protocolVersion:'2025-11-25',toolCount:64,studioTools:['studio__studio_asset_receive'],missingStudioTools:[],fileReceiverReady:true,ownerReady:true,checkedAt:new Date().toISOString(),message:'QA bridge ready'};
  if(command==='codexify_chats')return {chats:[{id:conversationId,title:'Studio fixture chat',workspace:'studio',lastEntryEnd:100,lastEntryAtMs:1000,lastAgentCallAtMs:1000,agentWaitingUntilMs:null,totalToolCalls:1}],serverTimeMs:1000};
  if(command==='codexify_chat_read')return {messages,revision:1,delivered_through:acknowledged?300:0,read_through:acknowledged?300:0,last_agent_call_at_ms:1000,agent_waiting_until_ms:waiting?60000:null,server_time_ms:1000,has_more:false,before:null,unchanged:false};
  if(command==='codexify_chat_send'){
    assert.ok(args.input.requestId);assert.ok(args.input.message.trim());
    const sent={id:'message-1',end:300,created_at_ms:1001,tool_call_count:0};
    messages=[{...sent,role:'user',markdown:args.input.message,start:100}];
    return {sent};
  }
  if(command==='copy_text'||command==='open_external')return null;
  throw new Error(`Unexpected ${command}`);
});
await page.addInitScript(()=>{window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__qaInvoke(command,args)};});
page.on('pageerror', error=>errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`,{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'연결·게시 QA',exact:true}).click();
  const panel=page.getByRole('region',{name:'Codexify 앱 연결'});
  await panel.getByLabel('등록한 ChatGPT 플러그인 주소').fill('https://chatgpt.com/plugins/plugin_fixture');
  await panel.getByLabel('Codexify 작업 프로젝트').fill(project);
  await panel.getByRole('button',{name:'연결 설정 저장',exact:true}).click();
  await panel.getByText('Codexify 연결 설정을 이 기기에 저장했습니다.',{exact:true}).waitFor();
  await panel.getByLabel('Codexify 연결 대화').selectOption(conversationId);
  await panel.getByRole('button',{name:'앱 요청 보내기',exact:true}).waitFor();
  await panel.getByLabel('Codexify ChatGPT 요청').fill('<img src=x onerror=alert(1)> 테스트 요청');
  await panel.getByRole('button',{name:'앱 요청 보내기',exact:true}).click();
  await panel.getByText('요청을 저장했습니다. ChatGPT 대화에서 연결 시작 안내를 실행하면 대기 중인 요청을 읽을 수 있습니다.',{exact:true}).waitFor();
  assert.equal(calls.filter(c=>c.command==='codexify_chat_send').length,1);
  assert.equal(await panel.locator('.codexify-message img').count(),0,'Chat messages must render as text');
  assert.match(await panel.locator('.codexify-message').innerText(),/앱 요청 저장됨/);
  acknowledged=true;waiting=true;
  messages.push({id:'reply',role:'agent',markdown:'실제 이미지 생성물이 아닌 QA 응답',start:300,end:500,created_at_ms:1002,tool_call_count:1});
  await panel.getByRole('button',{name:'연결 확인',exact:true}).click();
  await panel.getByText('실제 이미지 생성물이 아닌 QA 응답',{exact:true}).waitFor();
  await panel.getByText('앱 요청 대기 중',{exact:true}).waitFor();
  assert.match(await panel.locator('.codexify-message.user').innerText(),/ChatGPT 도구 확인됨/);
  await panel.getByRole('button',{name:'등록한 ChatGPT 열기',exact:true}).click();
  assert.equal(calls.find(c=>c.command==='open_external').args.url,profile.pluginUrl);
  await page.getByRole('button',{name:'AI 작업실',exact:true}).click();
  await page.getByLabel('주제와 작성 방향',{exact:true}).fill('AI 작업실 전달 QA');
  await page.getByRole('button',{name:'연결된 대화에 보내기',exact:true}).click();
  await page.getByText('요청을 Codexify 대화에 저장했습니다.',{exact:false}).waitFor();
  assert.equal(calls.filter(c=>c.command==='codexify_chat_send').length,2);
  assert.match(calls.filter(c=>c.command==='codexify_chat_send')[1].args.input.message,/AI 작업실 전달 QA/);
  await page.getByRole('button',{name:'연결·게시 QA',exact:true}).click();
  await panel.getByText('연결 설정',{exact:true}).click();
  assert.equal(await panel.getByLabel('Codexify 작업 프로젝트').inputValue(),project);
  const out=resolve('docs/review/codexify-app');await mkdir(out,{recursive:true});
  await page.screenshot({path:resolve(out,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:820,height:720});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.screenshot({path:resolve(out,'narrow.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['saved connection restored','explicit project conversation','real IPC send','idle queue is not generation','agent acknowledgement and reply','safe text rendering','AI workspace handoff','820px no overflow'],adapter:'Chromium IPC fixtures; no live model calls'},null,2));
} finally {await browser.close();await server.close();}
