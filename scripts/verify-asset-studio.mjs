#!/usr/bin/env node
/** Real asset-engine integration with a browser-hosted Tauri IPC test adapter.
 * Native file dialogs are represented by explicit fixture selections. No user
 * library, credentials, ChatGPT endpoint, or existing application is modified.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { validateBytes } from 'gltf-validator';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = resolve(root, 'desktop/src-tauri/target/debug/toris-studio-desktop');
const scratch = await mkdtemp(resolve(tmpdir(), 'toris-assets-qa-'));
const artifacts = resolve(root, 'docs/review/asset-studio');
await mkdir(artifacts, { recursive: true });
let clipboard = '';
let pickerPaths = [];
const reports = { adapter: 'Playwright Chromium + real Rust --asset-command core; native dialogs represented by fixture choices', checks: [], screenshots: [], errors: [], glb: [] };

async function worker(action, input = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(binary, ['--asset-command'], {
      env: { HOME: process.env.HOME, PATH: process.env.PATH, TORIS_STUDIO_ASSET_HOME: scratch },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const chunks = []; let stderr = '';
    child.stdout.on('data', data => chunks.push(data));
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', () => {
      try { const result = JSON.parse(Buffer.concat(chunks).toString()); if (!result.ok) reject(new Error(result.error)); else accept(result.result); }
      catch (error) { reject(new Error(`Worker response failed: ${error.message}; ${stderr.slice(0,300)}`)); }
    });
    child.stdin.end(JSON.stringify({ action, input }));
  });
}

const baseSpec = { title: 'QA 이미지', prompt: '테스트용 이미지, 실제 AI 생성물이 아닙니다.', purpose: 'video', project: '검증용 프로젝트', width: 640, height: 360, format: 'png', fit: 'contain', quantity: 1 };
let server;
let browser;
try {
  // Independently validate GLB bytes before exercising the UI.
  for (const shape of ['box', 'sphere', 'cylinder', 'plane']) {
    const result = await worker('create_mesh', { spec: { ...baseSpec, title: `${shape} · 로컬 모델`, purpose: 'project' }, shape, size: [1,2,1], color: '#92b8ff', segments: 24, format: 'glb' });
    const bytes = await readFile(result.asset.outputPath);
    const validation = await validateBytes(new Uint8Array(bytes), { uri: `${shape}.glb`, maxIssues: 100 });
    assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues));
    reports.glb.push({ shape, errors: validation.issues.numErrors, warnings: validation.issues.numWarnings, triangles: result.asset.details.triangles });
  }
  reports.checks.push('All four native GLB shapes pass the Khronos glTF validator');

  const logo = await readFile(resolve(root, 'desktop/public/brand/toris-logo.png'));
  for (const [title, purpose, width, height] of [['영상 썸네일', 'video', 1280,720], ['앱 아이콘', 'project',1024,1024], ['쇼츠 타이틀', 'video',1080,1920]]) {
    await worker('import', { filename: `${title}.png`, dataBase64: logo.toString('base64'), spec: { ...baseSpec, title: `${title} · 검증용`, purpose, width, height }, source: 'imported' });
  }
  const fixturePath = resolve(scratch, '선택한_원본.png');
  await writeFile(fixturePath, logo);
  pickerPaths = [fixturePath];

  server = await createServer({ configFile: resolve(root,'desktop/vite.config.ts'), server: { port: 0, strictPort: false } });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width:1380, height:1000 }, deviceScaleFactor:1, reducedMotion:'reduce' });
  await page.exposeFunction('__assetQaInvoke', async (command, args = {}) => {
    if (command === 'asset_command') {
      // The worker deliberately excludes GUI-only file/path commands. Run a
      // small test bridge executable for those commands, not a mocked result.
      if (['import_paths','settings','thumbnail','payload'].includes(args.action)) {
        return new Promise((accept,reject)=>{
          const child=spawn(resolve(root,'desktop/src-tauri/target/debug/examples/asset_qa_bridge'),[],{env:{...process.env,TORIS_STUDIO_ASSET_HOME:scratch},stdio:['pipe','pipe','pipe']});
          const chunks=[];child.stdout.on('data',b=>chunks.push(b));child.stderr.resume();child.on('error',reject);
          child.on('close',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString());if(value.ok)accept(value.result);else reject(new Error(value.error));}catch(e){reject(e);}});
          child.stdin.end(JSON.stringify({action:args.action,input:args.input}));
        });
      }
      return worker(args.action,args.input);
    }
    if (command === 'asset_choose_files') return pickerPaths;
    if (command === 'asset_choose_folder') return { cancelled: true };
    if (command === 'asset_reveal') { reports.checks.push('File reveal receives an existing asset ID'); return; }
    if (command === 'copy_text') { clipboard = args.text; return; }
    if (command === 'get_dashboard') return { channels:[],content:[],trends:[],integrations:[],database:{connected:false,message:'QA: DB 미사용'} };
    if (command === 'ai_status') return { providers:[],defaultProvider:null };
    throw new Error(`Unexpected IPC call: ${command}`);
  });
  await page.addInitScript(() => { window.__TAURI_INTERNALS__ = { invoke:(command,args)=>window.__assetQaInvoke(command,args) }; });
  page.on('pageerror',error=>reports.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`,{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'이미지 생성기',exact:true}).click();
  await page.getByRole('button',{name:'요청 큐에 추가',exact:true}).waitFor({state:'visible'});
  await page.getByLabel('에셋 이름',{exact:true}).fill('작업 큐 검증');
  await page.getByLabel('이미지 프롬프트',{exact:true}).fill('검증용 요청입니다. 실제 이미지 생성은 호출하지 않습니다.');
  await page.getByLabel('요청 수량',{exact:true}).fill('2');
  await page.screenshot({path:resolve(artifacts,'01-create.png'),fullPage:true});
  reports.screenshots.push('01-create.png');
  await page.getByRole('button',{name:'요청 큐에 추가',exact:true}).click();
  await page.getByText('2개 요청을 저장했습니다.',{exact:false}).waitFor();
  assert.equal((await worker('snapshot')).jobs.length,2);
  await page.getByRole('button',{name:'대기 요청 복사',exact:true}).click();
  await page.getByText('2개 요청을 복사했습니다.',{exact:false}).waitFor();
  assert.match(clipboard,/studio_asset_receive/);
  reports.checks.push('Create two persistent queued requests and copy actionable ChatGPT handoff');
  await page.screenshot({path:resolve(artifacts,'02-queue.png'),fullPage:true});
  reports.screenshots.push('02-queue.png');
  await page.getByRole('button',{name:'파일 연결',exact:true}).first().click();
  await page.getByText('1개 에셋을 가져왔습니다.',{exact:false}).waitFor();
  const state=await worker('snapshot');
  assert.equal(state.jobs.filter(j=>j.status==='completed').length,1);
  assert.equal(state.libraryTotal,8);
  assert.equal((await readFile(fixturePath)).length,logo.length);
  reports.checks.push('Native-picker fixture imports through actual Rust core, preserves source, and completes exactly one job');
  await page.getByRole('button',{name:'에셋 상세 닫기',exact:true}).click();
  await page.locator('.asset-card img').first().waitFor({state:'visible'});
  await page.screenshot({path:resolve(artifacts,'03-library.png'),fullPage:true});
  reports.screenshots.push('03-library.png');
  await page.getByRole('button',{name:'sphere · 로컬 모델 상세 보기',exact:true}).click();
  await page.locator('.asset-model-help').waitFor({state:'visible'});
  assert.equal(await page.locator('.asset-preview-status.error').count(),0);
  await page.screenshot({path:resolve(artifacts,'04-model-preview.png'),fullPage:true});
  reports.screenshots.push('04-model-preview.png');
  reports.checks.push('Real GLB loads into the lazy WebGL inspector and renders without page errors');
  await page.getByRole('button',{name:'즐겨찾기 등록',exact:true}).click();
  await page.getByRole('button',{name:'즐겨찾기 해제',exact:true}).waitFor();
  await page.getByLabel('검토 상태',{exact:true}).selectOption('approved');
  await page.getByLabel('태그',{exact:true}).fill('검증, 모델');
  await page.getByRole('button',{name:'태그 저장',exact:true}).click();
  await page.getByRole('button',{name:'에셋 상세 닫기',exact:true}).click();
  await page.getByRole('button',{name:'즐겨찾기',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.asset-card').length===1);
  assert.equal((await worker('snapshot',{favorite:true})).total,1);
  reports.checks.push('Favorites, approved review, tags, and filtering persist in the native store');
  await page.getByRole('button',{name:'즐겨찾기',exact:true}).click();
  await page.getByLabel('에셋 검색',{exact:true}).fill('존재하지 않는 에셋');
  await page.getByText('조건에 맞는 에셋이 없습니다',{exact:true}).waitFor();
  await page.getByRole('button',{name:'필터 초기화',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.asset-card').length===8);
  await page.setViewportSize({width:820,height:720});
  await page.screenshot({path:resolve(artifacts,'05-library-narrow.png'),fullPage:true});
  reports.screenshots.push('05-library-narrow.png');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),false);
  reports.checks.push('Empty search recovery and 820px window layout without horizontal overflow');
  await page.setViewportSize({width:1380,height:1000});
  await page.getByRole('button',{name:'앱 아이콘 · 검증용 상세 보기',exact:true}).click();
  await page.getByRole('button',{name:'크기 변경·내보내기',exact:true}).click();
  const resize=page.locator('.asset-resize-panel');
  await resize.getByLabel('출력 규격 프리셋',{exact:true}).selectOption('play-feature');
  assert.equal(await resize.getByLabel('출력 규격 프리셋',{exact:true}).locator('option').count(),32);
  assert.equal(await resize.getByLabel('가로 (px)',{exact:true}).inputValue(),'1024');
  assert.equal(await resize.getByLabel('세로 (px)',{exact:true}).inputValue(),'500');
  assert.deepEqual(await resize.getByLabel('출력 형식',{exact:true}).locator('option').evaluateAll(nodes=>nodes.map(n=>n.value)),['png','jpeg']);
  assert.equal(await resize.getByLabel('배경 처리',{exact:true}).isDisabled(),true);
  await resize.getByLabel('배경색 HEX',{exact:true}).fill('#123456');
  await resize.getByLabel('새 에셋 이름',{exact:true}).fill('Play 그래픽 검증');
  await page.screenshot({path:resolve(artifacts,'06-play-resize.png'),fullPage:true});
  reports.screenshots.push('06-play-resize.png');
  await resize.getByRole('button',{name:'새 파일로 내보내기',exact:true}).click();
  await page.getByText('1024 × 500 PNG 파일을 새 에셋으로 저장했습니다.',{exact:false}).waitFor();
  const playExport=(await worker('snapshot')).assets.find(a=>a.title==='Play 그래픽 검증');
  assert.ok(playExport.sourceAssetId);
  assert.equal(playExport.details.originalWidth,512);
  const rgbBytes=await readFile(playExport.outputPath);
  assert.equal(rgbBytes[24],8);assert.equal(rgbBytes[25],2);
  assert.equal(playExport.details.hasAlphaChannel,false);
  assert.deepEqual(await readFile(playExport.originalPath),logo);
  reports.checks.push('Play feature export through the UI creates actual RGB24 PNG at 1024x500 from the preserved original');
  await page.getByRole('button',{name:'크기 변경·내보내기',exact:true}).click();
  await resize.getByLabel('출력 규격 프리셋',{exact:true}).selectOption('favicon-32');
  await resize.getByLabel('출력 형식',{exact:true}).selectOption('ico');
  await resize.getByLabel('배경 처리',{exact:true}).selectOption('transparent');
  await resize.getByLabel('새 에셋 이름',{exact:true}).fill('Favicon 32 검증');
  const beforeInvalid=(await worker('snapshot')).libraryTotal;
  await resize.getByLabel('가로 (px)',{exact:true}).fill('300');
  assert.equal(await resize.getByLabel('출력 규격 프리셋',{exact:true}).inputValue(),'custom');
  await resize.getByRole('button',{name:'새 파일로 내보내기',exact:true}).click();
  await page.getByText('ICO는 16~256px 정사각형 규격을 선택하세요.',{exact:true}).waitFor();
  assert.equal(await resize.getByLabel('가로 (px)',{exact:true}).inputValue(),'300');
  assert.equal((await worker('snapshot')).libraryTotal,beforeInvalid);
  await resize.getByLabel('출력 규격 프리셋',{exact:true}).selectOption('favicon-32');
  await page.getByRole('button',{name:'에셋 알림 닫기',exact:true}).click();
  await page.setViewportSize({width:820,height:720});
  await page.screenshot({path:resolve(artifacts,'07-favicon-resize-narrow.png'),fullPage:true});
  reports.screenshots.push('07-favicon-resize-narrow.png');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),false);
  await resize.getByRole('button',{name:'새 파일로 내보내기',exact:true}).click();
  await page.getByText('32 × 32 ICO 파일을 새 에셋으로 저장했습니다.',{exact:false}).waitFor();
  const icon=(await worker('snapshot')).assets.find(a=>a.title==='Favicon 32 검증');
  const icoBytes=await readFile(icon.outputPath);
  assert.deepEqual([...icoBytes.subarray(0,8)],[0,0,1,0,1,0,32,32]);
  assert.deepEqual(await readFile(icon.originalPath),logo);
  reports.checks.push('Favicon ICO export, preset-to-custom editing, invalid-size recovery without lost input, and narrow resize layout');
  assert.deepEqual(reports.errors,[]);
  console.log(JSON.stringify(reports,null,2));
} finally {
  await writeFile(resolve(artifacts,'verification.json'),JSON.stringify(reports,null,2));
  await browser?.close();
  await server?.close();
  await rm(scratch,{recursive:true,force:true});
}
