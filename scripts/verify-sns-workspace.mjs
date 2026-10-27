#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import { chromium } from 'playwright';
import { createFixtureServer, projectRoot,fixtureBridge,shellFixture,unhandled } from './ui-fixture-helpers.mjs';

// Actual frontend, explicit bounded native fixtures. No DB, vault, installed app,
// OAuth, provider request, publication or real ChatGPT/RDC session is involved.
const artifacts=path.resolve(process.env.TORIS_SNS_UI_ARTIFACTS||path.join(projectRoot,'docs/review/sns'));await mkdir(artifacts,{recursive:true});
const platforms=['youtube','instagram','facebook','threads','tiktok','naver_blog','naver_clip','x'];
const names={youtube:'YouTube',instagram:'Instagram',facebook:'Facebook Page',threads:'Threads',tiktok:'TikTok',naver_blog:'네이버 블로그',naver_clip:'네이버 클립',x:'X'};
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const now=`${today}T00:00:00Z`;const previousDate=new Date(`${today}T00:00:00Z`);previousDate.setUTCDate(previousDate.getUTCDate()-1);const yesterday=previousDate.toISOString().slice(0,10);
const channels=platforms.map(platform=>({id:`channel-${platform}`,platform,name:`검증 ${names[platform]}`,handle:`@fixture-${platform}`,url:platform==='x'?'https://x.com/fixture':'https://example.com/fixture',createdAt:now}));
const connections=[
 {connectionId:'11111111-1111-4111-8111-111111111111',platform:'youtube',accountId:'UC-fixture-A',accountTitle:'동일 이름 계정',scopes:['read'],readAuthorized:true,publishingAuthorized:false,connected:true,needsReconnect:false},
 {connectionId:'22222222-2222-4222-8222-222222222222',platform:'youtube',accountId:'UC-fixture-B',accountTitle:'동일 이름 계정',scopes:['read','publish'],readAuthorized:true,publishingAuthorized:true,connected:true,needsReconnect:false},
];
let bindings=[{channelId:'channel-youtube',connectionId:connections[0].connectionId,platform:'youtube',accountId:connections[0].accountId}];
const observation=(patch={})=>({id:randomUUID(),sourceId:'fixture-api-source',platform:'youtube',accountId:'UC-fixture-A',connectionId:connections[0].connectionId,sourceKind:'api',expiresAt:new Date(Date.now()+30*86400000).toISOString(),metric:'views',definition:'YouTube 원본 조회수 · fixture',unit:'count',aggregation:'period',periodStart:today,periodEnd:today,timezone:'America/Los_Angeles',contentId:'',dimensions:{},value:0,status:'available',observedAt:now,apiVersion:'youtubeAnalytics/v2',provenance:{fixture:true,originalMetric:'views'},...patch});
const baseRows=[observation(),observation({id:'missing-row',contentId:'video-missing',value:null,status:'not_returned'}),observation({id:'other-account',accountId:'UC-fixture-B',connectionId:connections[1].connectionId,value:72})];
const legacySource={id:'legacy-source-A',sourceKind:'import',platform:'youtube',accountId:'UC-fixture-A',reportChannelId:'channel-youtube',connectionId:null,label:'이전 계정 원본 보고서',filename:'legacy-account-A.csv',digest:'fixture-legacy-only',status:'active',metadata:{timezone:'Asia/Seoul'},createdAt:now};
const legacyRow=observation({id:'legacy-observation-A',sourceId:legacySource.id,sourceKind:'import',reportChannelId:'channel-youtube',accountId:'UC-fixture-A',connectionId:null,expiresAt:null,metric:'legacy_report_views',definition:'이전 계정 공식 내보내기 조회수',timezone:'Asia/Seoul',value:11,apiVersion:'user-report'});
const imports=[legacySource],importRows=[legacyRow],previews=new Map(),creations=[],calls=[],errors=[],generatedPrompts=[];let clipboard='',paused=false,previewInput,deferAccountQuery=false,deferMappedPreview=false;const pendingAccountQueries=[],pendingMappedPreviews=[],exports=[];
const report={adapter:'Actual React application in headless Chromium with explicit sanitized IPC fixtures; native/provider/real RDC execution is separate',checks:[],screenshots:[],errors,node:process.version};
let server,browser,page,credentialFixture;
const status=()=>({schemaReady:true,migrationRequired:false,paused,jobs:[{connectionId:connections[0].connectionId,platform:'youtube',accountId:'UC-fixture-A',status:'partial',lastSyncAt:now,nextSyncAt:now,cursor:{},coverage:{from:today,to:today,partial:true},message:'검증 자료: 실제 반환한 하루만 표시합니다.'}],capabilities:platforms.map(platform=>({platform,apiVersion:platform==='x'?'manual-report':'fixture-v1',accountRequirement:'검증 fixture의 실제 계정 선택 필요',requiredScopes:[],metrics:['views'],history:'확인한 기간만 표시',latency:'원본 집계 지연 유지',limitations:['실제 제공자의 권한·응답을 검증한 결과가 아닙니다.'],manualOnly:['x','naver_blog','naver_clip'].includes(platform)})),limits:{maxBytes:5242880,maxRows:10000,maxColumns:100}});
const waitFixture=async(test,label)=>{for(let i=0;i<100;i++){if(test())return;await page.waitForTimeout(50);}assert.fail(`Fixture did not reach ${label}`);};
const capture=async name=>{await page.evaluate(()=>scrollTo(0,0));const file=`${name}.png`;await page.screenshot({path:path.join(artifacts,file),fullPage:true});report.screenshots.push(file);};
const noOverflow=async label=>{const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(el=>{const r=el.getBoundingClientRect();return r.width&&r.right>innerWidth+1&&getComputedStyle(el).position!=='fixed';}).slice(0,10).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right}))}));assert.ok(layout.scroll<=layout.width+1,`${label}: ${JSON.stringify(layout)}`);};
try{
 credentialFixture=await mkdtemp(path.join(tmpdir(),'toris-sns-denied-'));
 const credentialPath=path.join(credentialFixture,'.codex','auth.json'),credentialSentinel=`fixture-only-${randomUUID()}`;
 await mkdir(path.dirname(credentialPath));await writeFile(credentialPath,JSON.stringify({fixture:credentialSentinel}));
 server=await createFixtureServer({configFile:path.join(projectRoot,'desktop/vite.config.ts'),server:{port:0,strictPort:false,watch:{ignored:['**/src-tauri/**','**/docs/review/**']}}});await server.listen();
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1380,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('__snsFixture',async(command,args={})=>{
  calls.push({command,args:structuredClone(args)});
  if(/codexify|open_webui/.test(command)){errors.push(`Removed execution path called: ${command}`);throw new Error(errors.at(-1));}
  if(command==='ai_status')return {providers:[{id:'codex-cli',label:'Codex CLI',kind:'subscription',available:true,detail:'fixture',suggestedModels:[]}],contentModel:{provider:'codex-cli',model:''},agentModel:null,image:null};
  if(command==='ai_generate'){generatedPrompts.push(args.input.prompt);return {text:'fixture 모델 초안 · 검토한 뒤 사용합니다.',provider:'codex-cli',model:''};}
  if(command==='get_dashboard')return {channels,content:[{id:'content-fixture',platform:'youtube',channelId:'channel-youtube',title:'보존할 기획 초안',body:'사용자 작성 fixture 원고',status:'draft',scheduledAt:null,url:null,createdAt:now,updatedAt:now}],trends:[],integrations:[],database:{connected:true,message:'격리된 UI fixture'}};
  if(command==='oauth_connections')return {connections,bindings,warnings:[]};
  if(command==='oauth_connection_dispatch'){
   assert.equal(args.input.action,'bindChannel','No OAuth/provider operation belongs to this browser fixture');
   const {channelId,connectionId,accountId}=args.input;assert.equal(channelId,'channel-youtube');assert.equal(connectionId,connections[1].connectionId);assert.equal(accountId,connections[1].accountId);
   bindings=[{channelId,connectionId,platform:'youtube',accountId}];return {connections,bindings,warnings:[]};
  }
  if(command==='analytics_dispatch'){
   const input=args.input;
   if(input.action==='status')return status();
   if(input.action==='pause'){paused=input.paused;return status();}
   if(input.action==='query'){
    if(input.channelId){assert.ok(channels.some(channel=>channel.id===input.channelId),'Scoped reads carry the stable channel ID');assert.ok(['api','import'].includes(input.sourceKind));if(input.sourceKind==='import')assert.equal(input.accountId,undefined,'Imported reports use one stable-channel read, not a current-account fanout');}
    const visibleImports=importRows.filter(row=>imports.some(source=>source.id===row.sourceId&&source.status==='active'));
    const result={observations:[...baseRows,...visibleImports].filter(r=>(!input.platform||r.platform===input.platform)&&(!input.accountId||r.accountId===input.accountId)&&(!input.sourceKind||r.sourceKind===input.sourceKind)&&(!input.channelId||r.sourceKind==='api'||r.reportChannelId===input.channelId)),hasMore:false,coverage:status().jobs,totalIsNotComputed:true};
    if(deferAccountQuery&&input.accountId==='UC-fixture-B'&&input.sourceKind==='api')return await new Promise((resolve,reject)=>pendingAccountQueries.push({resolve:()=>resolve(result),reject:()=>reject(new Error('두 번째 계정 지연 조회 fixture 실패'))}));
    return result;
   }
   if(input.action==='reportQuery'){assert.equal(input.connectionId,connections[1].connectionId);assert.equal(input.accountId,connections[1].accountId);assert.equal(input.platform,'youtube');return {sourceId:'fixture-api-source',observations:[baseRows[2]],coverage:{from:today,to:today},status:'ready',message:'정확한 두 번째 계정에 고정한 상세 분석 fixture'};}
   if(input.action==='importHistory'){assert.equal(input.accountId,undefined);assert.ok(channels.some(channel=>channel.id===input.channelId));return {imports:imports.filter(source=>source.reportChannelId===input.channelId)};}
   if(input.action==='importPreview'){
    const correction=input.replaceImportId===legacySource.id;
    assert.equal(input.platform,correction?'youtube':'x');assert.equal(input.channelId,correction?'channel-youtube':'channel-x');assert.equal(input.accountId,correction?'UC-fixture-A':'channel-x');assert.equal(input.replaceImportId,correction?legacySource.id:undefined,'Correction is chosen before preview and pins the original source owner');
    assert.equal(input.timezone,'Asia/Seoul');assert.equal(input.aggregation,'period');assert.equal(typeof input.text,'string');assert.equal(input.bytesBase64,undefined);assert.match(input.filename,/\.txt$/,'Pasted comma CSV must use delimiter auto-detection, not be forced into TSV');
    const mapped=!!input.mapping,metric=correction?'legacy_report_views':'x_report_views',definition=correction?'이전 계정 공식 내보내기 조회수':'X 공식 내보내기 조회수 · API와 별도';
    if(mapped){assert.deepEqual(input.mapping,{date:'date',metrics:{views:metric}});assert.deepEqual(input.definitions,{[metric]:{definition,unit:'count'}});previewInput=structuredClone(input);}
    const common={platform:input.platform,accountId:input.accountId,reportChannelId:input.channelId,connectionId:null,expiresAt:null,sourceKind:'import',metric,definition,timezone:'Asia/Seoul',apiVersion:'user-report',provenance:{filename:input.filename,mapping:input.mapping}};
    const result={previewId:randomUUID(),headers:['date','views'],sample:[[today,correction?'17':'0'],[yesterday,'']],rowCount:2,observationCount:mapped?2:0,observations:mapped?[observation({...common,value:correction?17:0}),observation({...common,periodStart:yesterday,periodEnd:yesterday,value:null,status:'not_returned'})]:[],errors:mapped?[]:['열 매핑이 필요합니다.'],warnings:['사용자 매핑 보고서이며 API와 동등한 지표로 간주하지 않습니다.'],canCommit:mapped,expiresAt:new Date(Date.now()+86400000).toISOString()};
    previews.set(result.previewId,{input:structuredClone(input),result});
    if(mapped&&deferMappedPreview)return await new Promise(resolve=>pendingMappedPreviews.push(()=>resolve(result)));
    return result;
   }
   if(input.action==='importCommit'){
    const preview=previews.get(input.previewId);assert.ok(preview?.result.canCommit);assert.equal(input.replaceImportId,preview.input.replaceImportId,'Commit uses the replacement captured by its reviewed preview');
    const correction=!!input.replaceImportId;if(correction){assert.equal(input.replaceImportId,legacySource.id);assert.equal(preview.input.accountId,'UC-fixture-A');assert.equal(bindings[0].accountId,'UC-fixture-B');legacySource.status='replaced';}
    const source={id:randomUUID(),sourceKind:'import',platform:preview.input.platform,accountId:preview.input.accountId,reportChannelId:preview.input.channelId,label:correction?'이전 계정 수정 보고서':'X 검증 보고서',filename:preview.input.filename,digest:'fixture-only',status:'active',metadata:{timezone:preview.input.timezone,aggregation:preview.input.aggregation,definitions:preview.input.definitions},createdAt:now};imports.push(source);importRows.push(...preview.result.observations.map(row=>({...row,sourceId:source.id})));return {source,idempotent:false,replacedSourceId:input.replaceImportId??null};
   }
   throw new Error(`Unexpected analytics fixture action ${input.action}`);
  }
  if(command==='creation_request_create'){assert.equal(args.input.kind,'text');const request={id:randomUUID(),...args.input,revision:randomUUID(),status:'saved',createdAt:now,readAt:null,draftReceivedAt:null,draft:null};creations.push(request);return {request,prompt:`Remote Desktop Commander\n${JSON.stringify({command:fixtureBridge.mcpExecutable,args:['--studio-mcp']})}\nstudio_creation_request_get ${request.id} ${request.revision}\n${request.prompt}`};}
  if(command==='creation_request_list')return {requests:structuredClone(creations)};
  if(command==='workspace_export_report'){assert.match(args.input.content,/UC-fixture-B/);assert.doesNotMatch(args.input.content,/UC-fixture-A/);exports.push(args.input);return null;}
  if(command==='copy_text'){clipboard=args.text;return null;}
  if(command==='search_keywords')return {query:'',mode:'local',items:[],total:0,libraryCount:0,indexLimit:500,truncated:false,searchedAt:now,warnings:[]};
  if(command==='get_keyword_status')return {databaseConnected:true,libraryCount:0,indexLimit:500,sources:[],engines:[],running:false};
  if(command==='get_keyword_runs')return [];
  const shared=shellFixture(command,args);if(shared!==unhandled)return shared;
  errors.push(`Unexpected native command ${command}`);throw new Error(`Unexpected native command ${command}`);
 });
 await page.addInitScript(()=>{window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__snsFixture(command,args)};});
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`,{waitUntil:'networkidle'});
 const denied=await page.request.get(new URL(`/@fs/${credentialPath.replaceAll('\\','/')}`,page.url()).href);assert.equal(denied.status(),403);assert.ok(!(await denied.text()).includes(credentialSentinel));report.checks.push('Actual Vite worktree policy serves app and rejects an existing owned credential-path fixture outside allowed roots without exposing its content');
 const main=page.getByRole('navigation',{name:'주 메뉴',exact:true});
 assert.deepEqual(await main.getByRole('button').allTextContents(),['SNS 관리','콘텐츠','제작','게시','운영']);
 await page.getByRole('navigation',{name:'SNS 관리 화면',exact:true}).waitFor();
 const platformSelect=page.locator('.sns-workspace-filters').getByLabel('플랫폼',{exact:false});assert.deepEqual(await platformSelect.locator('option').evaluateAll(options=>options.map(o=>o.value)),['all',...platforms]);
 await page.getByRole('heading',{name:'원본 수치와 콘텐츠별 성과',exact:true}).waitFor();
 const values=page.locator('.sns-table-scroll tbody tr td:nth-child(2)');assert.ok((await values.allTextContents()).some(t=>/^0\s/.test(t)));assert.ok((await values.allTextContents()).some(t=>t.includes('—')));
 await page.getByText('지표 정의·수집 정보',{exact:true}).first().click();await page.getByText('YouTube 원본 조회수 · fixture',{exact:true}).first().waitFor();await page.getByText(/America\/Los_Angeles/).first().waitFor();
 await noOverflow('1380 overview');await capture('overview-1380');report.checks.push('Four primary destinations, eight platform navigation, original definition/timezone, and zero versus unavailable are distinct');
 await page.getByRole('navigation',{name:'SNS 관리 화면',exact:true}).getByRole('button',{name:'채널',exact:true}).click();
 assert.equal(await page.locator('.sns-channel-card').count(),8);
 await page.getByRole('button',{name:/검증 YouTube/}).click();await page.getByRole('navigation',{name:'채널 상세',exact:true}).getByRole('button',{name:'연결·권한',exact:true}).click();
 const choice=page.getByLabel('이 채널의 인증 계정',{exact:false});assert.equal(await choice.locator('option').count(),3);
 deferAccountQuery=true;await choice.selectOption(JSON.stringify([connections[1].connectionId,connections[1].accountId]));await page.getByRole('button',{name:'선택한 계정 연결',exact:true}).click();await page.getByText('실제 계정 ID UC-fixture-B',{exact:true}).waitFor();
 await page.getByRole('navigation',{name:'채널 상세',exact:true}).getByRole('button',{name:'성과',exact:true}).click();
 await waitFixture(()=>pendingAccountQueries.length>0,'delayed B account query');
 assert.equal(await page.getByRole('button',{name:'CSV 내보내기',exact:true}).count(),0,'A rows cannot be exported while B is pending');
 assert.equal(await page.locator('.sns-table-scroll tbody tr').count(),0,'A rows cannot remain under B identity');
 deferAccountQuery=false;for(const pending of pendingAccountQueries.splice(0))pending.reject();
 await page.getByRole('alert').filter({hasText:'두 번째 계정 지연 조회 fixture 실패'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'CSV 내보내기',exact:true}).count(),0,'A rows cannot be exported after B rejects');
 assert.equal(await page.locator('.sns-table-scroll tbody tr').count(),0);
 await page.getByRole('button',{name:'다시 확인',exact:true}).click();
 await page.locator('.sns-table-scroll tbody tr').first().waitFor();assert.match(await page.locator('.sns-table-scroll tbody tr td:nth-child(2)').first().innerText(),/^72/);
 await page.getByRole('button',{name:'CSV 내보내기',exact:true}).click();await waitFixture(()=>exports.length===1,'B-only CSV export');
 report.checks.push('Pending or rejected B-account reads clear A rows and CSV actions; recovery exports only the exact B account');
 await page.getByRole('button',{name:'상세 분석 조회',exact:true}).click();await page.getByText('정확한 두 번째 계정에 고정한 상세 분석 fixture',{exact:true}).waitFor();
 await page.setViewportSize({width:820,height:620});await noOverflow('820 channel');await capture('channel-820');report.checks.push('Same-name accounts remain independently keyed; exact connectionId + accountId binds channel and detailed reports');
 deferAccountQuery=true;await page.getByLabel('자료 출처',{exact:false}).selectOption('api');await waitFixture(()=>pendingAccountQueries.length>0,'second delayed B account query');
 await page.locator('.sns-workspace-filters').getByLabel('채널',{exact:false}).selectOption('channel-x');
 deferAccountQuery=false;for(const pending of pendingAccountQueries.splice(0))pending.resolve();
 await page.getByRole('heading',{name:'확인한 성과가 아직 없습니다',exact:true}).waitFor();
 assert.equal(await page.locator('.sns-table-scroll tbody tr').count(),0);assert.equal(await page.getByRole('button',{name:'CSV 내보내기',exact:true}).count(),0,'Late B results cannot revive API rows/export under X');
 report.checks.push('A late B API result cannot render or export after changing the selected channel to X');await page.getByRole('navigation',{name:'채널 상세',exact:true}).getByRole('button',{name:'연결·권한',exact:true}).click();await page.getByText('수동 관리',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'계정 추가',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'상세 분석 조회',exact:true}).count(),0);report.checks.push('X has manual channel/report guidance and no OAuth or native API query controls');
 await page.getByRole('navigation',{name:'SNS 관리 화면',exact:true}).getByRole('button',{name:'가져온 보고서',exact:true}).click();await page.getByLabel('대상 채널',{exact:false}).selectOption('channel-x');await page.getByLabel('CSV·표 붙여넣기',{exact:true}).fill(`date,views\n${today},0\n${yesterday},`);await page.getByRole('button',{name:'1. 열 확인',exact:true}).click();
 await page.getByLabel('날짜 열',{exact:false}).selectOption('date');await page.getByLabel('views 지표',{exact:true}).fill('x_report_views');await page.getByLabel('views 원본 정의',{exact:true}).fill('X 공식 내보내기 조회수 · API와 별도');
 const reviewButton=page.getByRole('button',{name:'2. 수치 검토',exact:true});
 for(const change of ['target','timezone','mapping']){
  deferMappedPreview=true;await reviewButton.click();await waitFixture(()=>pendingMappedPreviews.length===1,`deferred mapped preview ${change}`);
  if(change==='target')await page.getByLabel('대상 채널',{exact:false}).selectOption('channel-instagram');
  if(change==='timezone')await page.getByLabel('보고서 시간대',{exact:false}).fill('UTC');
  if(change==='mapping')await page.getByLabel('views 지표',{exact:true}).fill('edited_metric');
  deferMappedPreview=false;pendingMappedPreviews.shift()();await reviewButton.waitFor({state:'visible'});
  await page.getByText('입력이 변경되었습니다. 현재 채널과 열 매핑으로 다시 검토하세요.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'가져오기 전 검토',exact:true}).count(),0,`${change} change invalidates deferred preview`);
  assert.equal(await page.getByRole('button',{name:'3. 검토한 보고서 저장',exact:true}).count(),0,`${change} change cannot revive stale commit`);
  if(change==='target')await page.getByLabel('대상 채널',{exact:false}).selectOption('channel-x');
  if(change==='timezone')await page.getByLabel('보고서 시간대',{exact:false}).fill('Asia/Seoul');
  if(change==='mapping')await page.getByLabel('views 지표',{exact:true}).fill('x_report_views');
 }
 report.checks.push('Deferred mapped previews stay invalid after changing target, timezone or metric mapping; review and commit never revive');
 await reviewButton.click();await page.getByRole('heading',{name:'가져오기 전 검토',exact:true}).waitFor();
 assert.equal(imports.filter(source=>source.reportChannelId==='channel-x').length,0);await page.getByText('사용자 매핑 보고서이며 API와 동등한 지표로 간주하지 않습니다.',{exact:true}).waitFor();const review=page.locator('.sns-import-review');assert.equal(await review.locator('tbody tr').count(),2);assert.match(await review.locator('tbody tr').nth(0).locator('td').nth(1).innerText(),/^0/);assert.match(await review.locator('tbody tr').nth(1).locator('td').nth(1).innerText(),/—.*미제공/s);assert.match(await review.innerText(),/X 공식 내보내기 조회수 · API와 별도/);assert.match(await review.innerText(),/Asia\/Seoul/);assert.match(await review.innerText(),/사용자 보고서/);await noOverflow('820 mapped import');await capture('report-preview-820');
 await page.getByRole('button',{name:'3. 검토한 보고서 저장',exact:true}).click();await page.getByText('검토한 보고서를 저장했습니다.',{exact:true}).waitFor();await page.getByText('X 검증 보고서',{exact:true}).waitFor();report.checks.push('X report import requires explicit column mapping, original metric definition/timezone and preview before commit; provenance remains user-file based');
 // A legacy source retains remote-A ownership through the local channel alias after binding B.
 await page.locator('.sns-workspace-filters').getByLabel('채널',{exact:false}).selectOption('channel-youtube');
 await page.getByRole('navigation',{name:'SNS 관리 화면',exact:true}).getByRole('button',{name:'전체 성과',exact:true}).click();await page.getByLabel('자료 출처',{exact:false}).selectOption('import');
 await page.locator('.sns-table-scroll tbody tr').first().waitFor();assert.match(await page.locator('.sns-table-scroll tbody tr td:nth-child(2)').first().innerText(),/^11/);assert.match(await page.locator('.sns-table-scroll tbody tr td').first().innerText(),/검증 YouTube/);assert.equal(bindings[0].accountId,'UC-fixture-B');
 const scopedImportCall=calls.findLast(call=>call.command==='analytics_dispatch'&&call.args.input.action==='query'&&call.args.input.sourceKind==='import');assert.equal(scopedImportCall.args.input.channelId,'channel-youtube');assert.equal(scopedImportCall.args.input.accountId,undefined);
 await page.getByRole('navigation',{name:'SNS 관리 화면',exact:true}).getByRole('button',{name:'가져온 보고서',exact:true}).click();await page.getByLabel('대상 채널',{exact:false}).selectOption('channel-youtube');await page.getByText(legacySource.label,{exact:true}).waitFor();report.checks.push('A remote-A legacy report remains visible under its stable local channel after binding account B; import reads and history use channelId once');
 const replacement=page.getByLabel('수정본인 경우 교체할 보고서',{exact:false});await replacement.selectOption(legacySource.id);
 await page.getByLabel('CSV·표 붙여넣기',{exact:true}).fill(`date,views\n${today},17\n${yesterday},`);await page.getByRole('button',{name:'1. 열 확인',exact:true}).click();await page.getByLabel('날짜 열',{exact:false}).selectOption('date');await page.getByLabel('views 지표',{exact:true}).fill('legacy_report_views');await page.getByLabel('views 원본 정의',{exact:true}).fill('이전 계정 공식 내보내기 조회수');
 deferMappedPreview=true;await reviewButton.click();await waitFixture(()=>pendingMappedPreviews.length===1,'deferred legacy correction preview');assert.equal(previewInput.accountId,'UC-fixture-A');assert.equal(previewInput.replaceImportId,legacySource.id);
 await replacement.selectOption('');deferMappedPreview=false;pendingMappedPreviews.shift()();await page.getByText('입력이 변경되었습니다. 현재 채널과 열 매핑으로 다시 검토하세요.',{exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'가져오기 전 검토',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'3. 검토한 보고서 저장',exact:true}).count(),0);report.checks.push('Changing the correction selection while mapped preview is deferred never revives review or commit');
 await replacement.selectOption(legacySource.id);await reviewButton.click();await page.getByRole('heading',{name:'가져오기 전 검토',exact:true}).waitFor();assert.match(await page.locator('.sns-import-review tbody tr').first().innerText(),/17/);await noOverflow('820 legacy correction');await capture('legacy-correction-820');
 await page.getByRole('button',{name:'3. 검토한 보고서 저장',exact:true}).click();await page.getByText('이전 계정 수정 보고서',{exact:true}).waitFor();const originalHistory=page.locator('.sns-import-history article').filter({hasText:legacySource.label});assert.match(await originalHistory.innerText(),/수정본으로 교체됨/);const correction=imports.find(source=>source.label==='이전 계정 수정 보고서');assert.equal(correction.accountId,'UC-fixture-A');assert.equal(correction.reportChannelId,'channel-youtube');
 await page.getByRole('navigation',{name:'SNS 관리 화면',exact:true}).getByRole('button',{name:'전체 성과',exact:true}).click();await page.locator('.sns-table-scroll tbody tr').first().waitFor();assert.match(await page.locator('.sns-table-scroll tbody tr td:nth-child(2)').first().innerText(),/^17/);
 await page.getByLabel('자료 출처',{exact:false}).selectOption('api');await page.locator('.sns-table-scroll tbody tr').first().waitFor();assert.match(await page.locator('.sns-table-scroll tbody tr td:nth-child(2)').first().innerText(),/^72/);assert.equal(baseRows[2].value,72);report.checks.push('Reselected correction preview and commit pin the original report owner/replacement; reviewed 17 replaces imported 11 while B API 72 remains separate');
 await main.getByRole('button',{name:'콘텐츠',exact:true}).click();await page.getByRole('button',{name:'트렌드 탐색',exact:true}).first().click();await page.getByLabel('관심 키워드',{exact:true}).fill('보존할 검색어');await main.getByRole('button',{name:'SNS 관리',exact:true}).click();await main.getByRole('button',{name:'콘텐츠',exact:true}).click();assert.equal(await page.getByLabel('관심 키워드',{exact:true}).inputValue(),'보존할 검색어');
 await page.keyboard.press('Control+k');const menu=page.getByRole('dialog',{name:'어디로 이동할까요?',exact:true});await menu.getByRole('combobox',{name:'화면 이름 검색',exact:true}).fill('문구');await page.keyboard.press('Enter');await page.getByRole('heading',{name:'어떤 콘텐츠를 만들까요?',exact:true}).waitFor();
 await page.getByLabel('주제와 작성 방향',{exact:false}).fill('fixture 검토 원고');await page.getByLabel('참고 자료와 맥락',{exact:false}).fill('사용자가 입력한 맥락을 유지합니다.');await page.getByRole('button',{name:'AI로 작성',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#social-ai-manual-output')?.value==='fixture 모델 초안 · 검토한 뒤 사용합니다.');assert.equal(generatedPrompts.length,1);assert.match(generatedPrompts[0],/사용자가 입력한 맥락/);assert.equal(creations.length,0,'model writing saves no ChatGPT request');assert.equal(calls.some(c=>c.command==='open_external'),false);
 await main.getByRole('button',{name:'SNS 관리',exact:true}).click();await main.getByRole('button',{name:'제작',exact:true}).click();assert.equal(await page.getByLabel('주제와 작성 방향',{exact:false}).inputValue(),'fixture 검토 원고');assert.equal(await page.getByLabel('문구 · 직접 편집',{exact:true}).inputValue(),'fixture 모델 초안 · 검토한 뒤 사용합니다.');
 creations.push({id:randomUUID(),kind:'text',title:'외부 도구 요청',prompt:'',revision:randomUUID(),status:'draft-received',createdAt:now,readAt:now,draftReceivedAt:now,draft:{text:'명시적인 수신 fixture · 검토한 뒤 사용합니다.'}});
 const inbox=page.getByRole('region',{name:'제작 요청과 수신 초안',exact:true});const topic=page.getByLabel('주제와 작성 방향',{exact:false});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await topic.focus();await inbox.getByRole('button',{name:'초안 검토',exact:true}).waitFor({timeout:15000});assert.ok(await topic.evaluate(el=>el===document.activeElement),'Background receipt updates preserve keyboard focus');page.once('dialog',dialog=>dialog.accept());await inbox.getByRole('button',{name:'초안 검토',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#social-ai-manual-output')?.value==='명시적인 수신 fixture · 검토한 뒤 사용합니다.');assert.equal(generatedPrompts.length,1,'reviewing a received draft calls no model');
 report.checks.push('Keyboard navigation and remembered section context preserve unsaved work; AI로 작성 uses the selected model, and a draft received through Studio MCP is reviewed with confirmation and without a model call');
 await noOverflow('820 creation');await capture('creation-820');await page.setViewportSize({width:1380,height:900});await noOverflow('1380 creation');await capture('creation-1380');
 assert.deepEqual(errors,[]);report.passed=true;report.calls=calls.map(({command,args})=>({command,...(['oauth_connection_dispatch','analytics_dispatch'].includes(command)?{action:args.input?.action}:{})}));await writeFile(path.join(artifacts,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){report.failure=String(error);await writeFile(path.join(artifacts,'failure.json'),JSON.stringify(report,null,2));if(page){await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(path.join(artifacts,'failure.html'),await page.content().catch(()=>''));}throw error;}finally{try{await browser?.close();}finally{try{await server?.close();}finally{if(credentialFixture)await rm(credentialFixture,{recursive:true,force:true});}}}
