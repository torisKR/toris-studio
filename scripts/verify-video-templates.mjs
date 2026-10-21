import { createFixtureServer, shellFixture, unhandled, fixtureBridge } from './ui-fixture-helpers.mjs';
import assert from 'node:assert/strict';
import {buildCreationFixture,receiveCreationFixture} from './creation-native-fixture.mjs';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

// Node 24. Isolated local UI checks using the real, pure Rust template output.
// No application configuration, vault, account, provider, upload, or real chat.
// Pass --fixtures /absolute/file.json to reuse an already compiled Rust result.
const output = '/private/tmp/toris-video-templates';
await mkdir(output, { recursive: true });
const fixtureArg = process.argv.indexOf('--fixtures');
const fixtureText = fixtureArg >= 0
  ? await readFile(resolve(process.argv[fixtureArg + 1]), 'utf8')
  : (await promisify(execFile)('cargo', [
    'run', '--quiet', '--locked', '--offline', '--manifest-path', resolve('desktop/src-tauri/Cargo.toml'),
    '--no-default-features', '--example', 'video-template-fixtures',
  ], { timeout: 240_000, maxBuffer: 32 * 1024 * 1024 })).stdout;
const fixtures = JSON.parse(fixtureText);
assert.equal(fixtures.catalog.length, 10, 'ten real Rust recipes are available');
assert.ok(fixtures.cases.length >= 54, 'real Rust previews cover topics and independently editable controls');
const oldTopic = '늦은 이전 주제 QA';
const newTopic = '새로 선택한 영상 주제 QA';
const keyOf = input => JSON.stringify([
  input.templateId, input.topic ?? '', input.category ?? '', input.format ?? '',
  input.language ?? '', input.sceneCount ?? null, input.durationSec ?? null,
]);
const previews = new Map(fixtures.cases.map(item => [keyOf(item.input), item.result]));
const clone = value => structuredClone(value);
const creations=[];let receivedVideoProject;buildCreationFixture();
const calls = [], errors = [], unexpected = [];
const savedProjects = new Map();
const library = { version: 1, favorites: [], recent: [] };
const knownRecipe = id => fixtures.catalog.some(item => item.id === id);
let releaseOldPreview;
let holdOldPreview = true;
let cancelExport = true;
const server = await createFixtureServer({ configFile: resolve('desktop/vite.config.ts'), server: { port: 0, strictPort: false } });
await server.listen();
let browser, page;
try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1380, height: 960 }, reducedMotion: 'no-preference' });
  page.setDefaultTimeout(15_000);
  page.on('dialog',dialog=>dialog.accept());
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  await page.exposeFunction('__qaInvoke', async (command, args = {}) => {
    calls.push({ command, args: clone(args) });
    if (command === 'get_dashboard') return { channels: [], content: [], trends: [], integrations: [], database: { connected: false, message: '격리된 템플릿 UI 검증' } };
    if (command === 'video_list_projects') return clone([...savedProjects.values()]);
    if (command === 'media_status') return { ffmpegAvailable: false, ffprobeAvailable: false, fontAvailable: false, ttsConfigured: false, dataPath: '격리된 메모리 프로젝트 저장소', renderer: 'fixture only' };
    if (command === 'set_main_activity') return null;
    if (command === 'video_template_catalog') return clone(fixtures.catalog);
    if (command === 'video_template_library_get') return clone(library);
    if (command === 'video_template_favorite') {
      assert.ok(knownRecipe(args.templateId), 'favorite refers to a real native catalog recipe');
      assert.equal(typeof args.enabled, 'boolean');
      library.favorites = library.favorites.filter(id => id !== args.templateId);
      if (args.enabled) library.favorites.push(args.templateId);
      return clone(library);
    }
    if (command === 'video_template_record_use') {
      assert.ok(knownRecipe(args.templateId), 'recent use refers to a real native catalog recipe');
      library.recent = [args.templateId, ...library.recent.filter(id => id !== args.templateId)].slice(0, 10);
      return clone(library);
    }
    if (command === 'video_template_preview') {
      const result = previews.get(keyOf(args.input));
      if (!result) throw new Error(`No real Rust fixture for requested preview: ${keyOf(args.input)}`);
      if (args.input.topic === oldTopic && holdOldPreview) {
        holdOldPreview = false;
        await new Promise(resolveOld => { releaseOldPreview = resolveOld; });
      }
      return clone(result);
    }
    if (command === 'video_save_project') {
      assert.equal(typeof args.input.id, 'string');
      if(receivedVideoProject&&args.input.title===receivedVideoProject.title){assert.deepEqual(args.input.scenes,receivedVideoProject.scenes);assert.equal(args.input.templateRecipe,undefined);}else assert.ok(args.input.templateRecipe?.id, 'saved template draft retains its recipe');
      savedProjects.set(args.input.id, clone(args.input));
      return clone(args.input);
    }
    if (command === 'video_export_project') {
      assert.ok(['markdown', 'json'].includes(args.format));
      assert.equal(args.project.templateRecipe?.id, fixtures.catalog[2].id);
      if (cancelExport) { cancelExport = false; return null; }
      return `${output}/fixture-export.${args.format === 'markdown' ? 'md' : 'json'}`;
    }
    if(command==='creation_request_list')return {requests:clone(creations)};
    if(command==='creation_request_create'){const request={id:'fixture-video-request',...args.input,revision:'fixture-revision',status:'saved',createdAt:new Date().toISOString()};return {request,prompt:`Remote Desktop Commander ${JSON.stringify({command:fixtureBridge.mcpExecutable,args:['--studio-mcp']})} ${args.input.prompt}`};}
    const shared=shellFixture(command,args);if(shared!==unhandled)return shared;
    unexpected.push(command);
    throw new Error(`Unexpected native operation in isolated template UI test: ${command}`);
  });
  await page.addInitScript(() => {
    const intervals = new Set(), timeouts = new Set(), frames = new Set(), listeners = new Map();
    const nativeInterval = window.setInterval.bind(window), clearInterval = window.clearInterval.bind(window);
    const nativeTimeout = window.setTimeout.bind(window), clearTimeout = window.clearTimeout.bind(window);
    const nativeFrame = window.requestAnimationFrame.bind(window), cancelFrame = window.cancelAnimationFrame.bind(window);
    window.setInterval = (...args) => { const id = nativeInterval(...args); intervals.add(id); return id; };
    window.clearInterval = id => { intervals.delete(id); clearInterval(id); };
    window.setTimeout = (callback, delay, ...args) => {
      if (typeof callback !== 'function') return nativeTimeout(callback, delay, ...args);
      const id = nativeTimeout(() => { timeouts.delete(id); callback(...args); }, delay);
      timeouts.add(id); return id;
    };
    window.clearTimeout = id => { timeouts.delete(id); clearTimeout(id); };
    window.requestAnimationFrame = callback => {
      const id = nativeFrame(timestamp => { frames.delete(id); callback(timestamp); });
      frames.add(id); return id;
    };
    window.cancelAnimationFrame = id => { frames.delete(id); cancelFrame(id); };
    const nativeAdd = EventTarget.prototype.addEventListener, nativeRemove = EventTarget.prototype.removeEventListener;
    const tracked = target => target === window || target === document || (typeof MediaQueryList !== 'undefined' && target instanceof MediaQueryList);
    const captureOf = options => typeof options === 'boolean' ? options : Boolean(options?.capture);
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (listener && tracked(this)) {
        let own = listeners.get(this); if (!own) { own = new Map(); listeners.set(this, own); }
        const key = `${type}:${captureOf(options)}`;
        let values = own.get(key); if (!values) { values = new Set(); own.set(key, values); }
        values.add(listener);
      }
      return nativeAdd.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      if (tracked(this)) {
        const own = listeners.get(this), key = `${type}:${captureOf(options)}`;
        const values = own?.get(key); values?.delete(listener);
        if (!values?.size) own?.delete(key);
        if (!own?.size) listeners.delete(this);
      }
      return nativeRemove.call(this, type, listener, options);
    };
    window.__qaResources = () => ({
      intervals: intervals.size, timeouts: timeouts.size, raf: frames.size,
      listeners: [...listeners.values()].reduce((total, own) => total + [...own.values()].reduce((sum, values) => sum + values.size, 0), 0),
    });
    let visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    window.__qaSetVisibility = value => { visibility = value; document.dispatchEvent(new Event('visibilitychange')); };
    window.__TAURI_INTERNALS__ = { invoke: (command, args) => window.__qaInvoke(command, args) };
  });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await page.goto(origin, { waitUntil: 'networkidle' });
  const navigate = async query => {
    await page.keyboard.press('Control+k');
    const menu = page.getByRole('dialog', { name: '어디로 이동할까요?' });
    await menu.getByRole('combobox', { name: '화면 이름 검색' }).fill(query);
    await page.keyboard.press('Enter');
  };
  await navigate('영상');
  const gallery = page.getByRole('region', { name: '영상 템플릿 선택', exact: true });
  const cards = gallery.locator('.vt-card');
  const selectCard = index => cards.nth(index).locator('.vt-card-select');
  const useTemplate = gallery.getByRole('button', { name: '이 템플릿으로 시작', exact: true });
  const ready = async () => { await useTemplate.waitFor(); await page.waitForFunction(() => !document.querySelector('.vt-use-button')?.disabled); };
  await cards.first().waitFor();
  assert.equal(await cards.count(), fixtures.catalog.length);
  for (let index = 0; index < fixtures.catalog.length; index++) {
    await selectCard(index).click(); await ready();
    assert.equal(await selectCard(index).getAttribute('aria-pressed'), 'true');
    assert.equal(await gallery.locator('.vt-preview-heading h4').innerText(), fixtures.catalog[index].name);
  }
  const filters = gallery.getByRole('group', { name: '템플릿 카테고리' });
  await filters.getByRole('button').nth(1).click();
  assert.ok(await cards.count() > 0 && await cards.count() < fixtures.catalog.length, 'category filter narrows the recipes');
  await filters.getByRole('button', { name: /^전체 / }).click();
  assert.equal(await cards.count(), fixtures.catalog.length);
  const search = gallery.getByRole('searchbox', { name: '템플릿 검색' });
  await search.fill('존재하지 않는 템플릿 QA');
  await gallery.locator('.vt-empty').filter({ hasText: '검색 조건에 맞는 템플릿이 없습니다.' }).waitFor();
  assert.equal(await cards.count(), 0);
  await gallery.getByRole('button', { name: '검색 조건 초기화', exact: true }).click();
  assert.equal(await cards.count(), fixtures.catalog.length);
  const views = gallery.getByRole('group', { name: '템플릿 라이브러리 보기' });
  const allView = views.getByRole('button', { name: /^전체 / });
  const favoriteView = views.getByRole('button', { name: /^즐겨찾기 / });
  const recentView = views.getByRole('button', { name: /^최근 사용 / });
  await favoriteView.click();
  await gallery.locator('.vt-empty').filter({ hasText: '즐겨찾는 템플릿이 없습니다.' }).waitFor();
  assert.equal(await cards.count(), 0);
  await allView.click();
  const favorite = index => cards.nth(index).locator('.vt-favorite');
  await favorite(0).click();
  await page.waitForFunction(name => document.querySelector(`button[aria-label="${name} 즐겨찾기 해제"]`)?.getAttribute('aria-pressed') === 'true', fixtures.catalog[0].name);
  await favorite(2).click();
  await page.waitForFunction(() => document.querySelectorAll('.vt-favorite[aria-pressed="true"]').length === 2);
  assert.equal(await selectCard(fixtures.catalog.length - 1).getAttribute('aria-pressed'), 'true', 'favorite changes must not choose another recipe');
  await favoriteView.click();
  assert.equal(await cards.count(), 2);
  await favorite(0).click();
  await page.waitForFunction(() => document.querySelectorAll('.vt-card').length === 1);
  await allView.click(); await favorite(0).click();
  await page.waitForFunction(() => document.querySelectorAll('.vt-favorite[aria-pressed="true"]').length === 2);
  await recentView.click();
  await gallery.locator('.vt-empty').filter({ hasText: '최근 사용한 템플릿이 없습니다.' }).waitFor();
  assert.deepEqual(library.recent, [], 'previewing or favoriting must not be recorded as use');
  await allView.click();
  console.log('Template QA: ten recipes, filters, empty views, and favorite toggling passed');

  await selectCard(0).click(); await ready();
  const timeline = gallery.getByRole('group', { name: '영상 장면 선택' });
  await timeline.getByRole('button').nth(1).click();
  assert.equal(await timeline.getByRole('button').nth(1).getAttribute('aria-pressed'), 'true');
  assert.match(await gallery.locator('.vt-stage').getAttribute('aria-label'), /^장면 2:/);
  const topic = gallery.getByLabel('템플릿 영상 주제', { exact: true });
  await topic.fill(oldTopic);
  await page.waitForFunction(() => document.querySelector('.vt-preview-panel')?.getAttribute('aria-busy') === 'true');
  for (let index = 0; !releaseOldPreview && index < 30; index++) await page.waitForTimeout(25);
  assert.equal(typeof releaseOldPreview, 'function', 'old preview request reached the controlled race');
  await topic.fill(newTopic); await ready();
  assert.ok((await gallery.locator('.vt-stage-copy').innerText()).includes(newTopic));
  releaseOldPreview();
  await page.waitForTimeout(350);
  assert.ok((await gallery.locator('.vt-stage-copy').innerText()).includes(newTopic), 'late old result must not replace the latest topic');
  console.log('Template QA: timeline selection and latest-topic race passed');

  const category = gallery.getByRole('combobox', { name: '템플릿 카테고리', exact: true });
  const format = gallery.getByLabel('템플릿 영상 형식', { exact: true });
  const language = gallery.getByLabel('템플릿 언어', { exact: true });
  const sceneCount = gallery.getByLabel('템플릿 장면 수', { exact: true });
  const targetDuration = gallery.getByLabel('템플릿 목표 길이', { exact: true });
  await category.selectOption('tech'); await ready();
  assert.equal(calls.findLast(call => call.command === 'video_template_preview').args.input.category, 'tech');
  await category.selectOption(fixtures.catalog[0].categories[0]); await ready();
  await format.selectOption('youtube-landscape'); await ready();
  assert.match(await gallery.locator('.vt-stage').getAttribute('class'), /landscape/);
  await language.selectOption('en'); await ready();
  assert.equal(calls.findLast(call => call.command === 'video_template_preview').args.input.language, 'en');
  await sceneCount.selectOption('6'); await ready();
  assert.equal(await timeline.getByRole('button').count(), 6, 'scene control updates the real native composition');
  await targetDuration.selectOption('60'); await ready();
  assert.equal(await gallery.getByRole('slider', { name: '영상 구성 재생 위치' }).getAttribute('max'), '60');
  const controlled = calls.findLast(call => call.command === 'video_template_preview').args.input;
  assert.equal(controlled.format, 'youtube-landscape'); assert.equal(controlled.language, 'en');
  assert.equal(controlled.sceneCount, 6); assert.equal(controlled.durationSec, 60);
  await targetDuration.selectOption(String(fixtures.catalog[0].durationSec)); await ready();
  await sceneCount.selectOption(String(fixtures.catalog[0].sampleProject.scenes.length)); await ready();
  await language.selectOption('ko'); await ready();
  await format.selectOption(fixtures.catalog[0].format); await ready();
  console.log('Template QA: category, format, language, scene-count, and duration controls passed');

  const play = gallery.getByRole('button', { name: '구성 재생', exact: true });
  await play.click();
  await page.waitForFunction(() => window.__qaResources().raf === 1);
  await page.waitForTimeout(180);
  await gallery.getByRole('button', { name: '일시정지', exact: true }).click();
  await page.waitForFunction(() => window.__qaResources().raf === 0);
  await play.click();
  await page.evaluate(() => window.__qaSetVisibility('hidden'));
  await page.waitForFunction(() => window.__qaResources().raf === 0);
  await play.waitFor();
  assert.equal(await gallery.getByRole('button', { name: '일시정지', exact: true }).count(), 0);
  await page.evaluate(() => window.__qaSetVisibility('visible'));
  await play.click();
  await navigate('SNS 관리');
  await page.waitForFunction(() => window.__qaResources().raf === 0);
  await navigate('영상'); await ready();
  assert.equal(await gallery.getByRole('button', { name: '일시정지', exact: true }).count(), 0, 'returning to the video tab must not resume playback');
  console.log('Template QA: playback pause and hidden/inactive cleanup passed');

  await page.waitForTimeout(350);
  const baseline = await page.evaluate(() => window.__qaResources());
  for (let iteration = 0; iteration < 20; iteration++) {
    await selectCard(iteration % fixtures.catalog.length).click(); await ready();
  }
  await page.waitForTimeout(350);
  const after = await page.evaluate(() => window.__qaResources());
  assert.deepEqual(after, baseline, 'twenty template replacements must not accumulate listeners, timers, or RAFs');
  console.log('Template QA: twenty replacements retained the baseline resource counts');
  await useTemplate.click();
  const editorTitle = page.getByLabel('영상 제목', { exact: true });
  await editorTitle.waitFor();
  assert.equal(await editorTitle.inputValue(), newTopic);
  assert.equal(calls.filter(call => call.command === 'video_save_project').length, 0, 'using a template creates an editable unsaved draft');
  await editorTitle.fill('유지해야 할 편집 QA');
  await selectCard(2).click(); await ready();
  await useTemplate.click();
  const confirmation = page.getByRole('dialog', { name: '편집 내용을 저장할까요?' });
  await confirmation.waitFor();
  assert.equal(await editorTitle.inputValue(), '유지해야 할 편집 QA', 'dirty content remains until the user chooses');
  await confirmation.getByRole('button', { name: '계속 편집', exact: true }).click();
  assert.equal(await editorTitle.inputValue(), '유지해야 할 편집 QA');
  assert.deepEqual(library.recent, [fixtures.catalog[9].id], 'cancelled replacement must not enter recent use');
  await useTemplate.click(); await confirmation.waitFor();
  await confirmation.getByRole('button', { name: '변경사항 버리기', exact: true }).click();
  assert.equal(await editorTitle.inputValue(), newTopic);
  await page.locator('.desktop-video-editor').getByRole('button', { name: '저장', exact: true }).click();
  await page.getByText('영상 프로젝트를 로컬 파일에 저장했습니다.', { exact: true }).waitFor();
  assert.equal(savedProjects.size, 1, 'explicit save writes one draft to the isolated memory store');
  const saved = clone([...savedProjects.values()][0]);
  assert.equal(saved.templateRecipe.id, fixtures.catalog[2].id);
  assert.deepEqual(library.recent, [fixtures.catalog[2].id, fixtures.catalog[9].id]);
  await page.reload({ waitUntil: 'networkidle' }); await navigate('영상');
  await editorTitle.waitFor();
  assert.equal(await editorTitle.inputValue(), newTopic, 'mock native list restores the saved draft after reload');
  await favoriteView.click();
  await cards.first().waitFor();
  assert.equal(await cards.count(), 2, 'favorites restore through mock native library after reload');
  await recentView.click();
  assert.equal(await cards.count(), 2);
  assert.ok((await selectCard(0).getAttribute('aria-label')).startsWith(fixtures.catalog[2].name), 'recent recipes restore in native order');
  assert.ok((await selectCard(1).getAttribute('aria-label')).startsWith(fixtures.catalog[9].name));
  await allView.click();
  await selectCard(2).click(); await ready(); await topic.fill(newTopic); await ready();
  const saveCount = calls.filter(call => call.command === 'video_save_project').length;
  await page.getByRole('button', { name: 'ChatGPT에 영상 초안 요청', exact: true }).click();
  await page.getByText('영상 요청을 저장했습니다. RDC 전달문을 ChatGPT에 붙여넣고 수신 초안을 검토하세요.', { exact: true }).waitFor();
  const send = calls.findLast(call => call.command === 'creation_request_create');
  assert.ok(send,'UI creates a saved video request');
  const promptPreview=calls.findLast(call=>call.command==='video_template_preview');assert.equal(promptPreview.args.input.templateId,fixtures.catalog[2].id,'RDC request is prepared from the selected real recipe');
  const generatedDraft=JSON.parse(send.args.input.prompt.slice(send.args.input.prompt.lastIndexOf('\n\n')+2));
  const preparedProject=previews.get(keyOf(promptPreview.args.input)).project;assert.equal(generatedDraft.project.title,preparedProject.title);assert.deepEqual(generatedDraft.project.scenes,preparedProject.scenes.map(({id,headline,body,narration,durationSec,motion})=>({id,headline,body,narration,durationSec,motion})), 'Closed prompt contains the selected recipe scenes and motion');
  assert.ok(send.args.input.prompt.includes(newTopic));
  assert.equal(calls.filter(call => call.command === 'video_save_project').length, saveCount, 'chat receipt must not be presented as a newly generated or saved project');
  assert.equal(savedProjects.size, 1);
  assert.equal(await editorTitle.inputValue(), newTopic);
  await editorTitle.fill('현재 편집을 내보내는 영상 QA');
  await page.getByRole('button', { name: 'Markdown 내보내기', exact: true }).click();
  await page.getByText('내보내기를 취소했습니다.', { exact: true }).waitFor();
  const cancelledExport = calls.findLast(call => call.command === 'video_export_project');
  assert.equal(cancelledExport.args.project.title, '현재 편집을 내보내는 영상 QA');
  assert.equal(cancelledExport.args.format, 'markdown');
  assert.equal(await editorTitle.inputValue(), '현재 편집을 내보내는 영상 QA');
  await page.getByRole('button', { name: 'JSON 내보내기', exact: true }).click();
  await page.getByText(`프로젝트 JSON을 저장했습니다: ${output}/fixture-export.json`, { exact: true }).waitFor();
  const successfulExport = calls.findLast(call => call.command === 'video_export_project');
  assert.equal(successfulExport.args.project.title, '현재 편집을 내보내는 영상 QA');
  assert.equal(successfulExport.args.format, 'json');
  assert.deepEqual(savedProjects.get(saved.id), saved, 'mock export must leave the saved project unchanged');
  await page.getByRole('button', { name: '영상 프로젝트 복제', exact: true }).click();
  await confirmation.waitFor();
  await confirmation.getByRole('button', { name: '계속 편집', exact: true }).click();
  assert.equal(await editorTitle.inputValue(), '현재 편집을 내보내는 영상 QA');
  await page.getByRole('button', { name: '영상 프로젝트 복제', exact: true }).click();
  await confirmation.waitFor();
  await confirmation.getByRole('button', { name: '변경사항 버리기', exact: true }).click();
  assert.ok((await editorTitle.inputValue()).includes('현재 편집을 내보내는 영상 QA'));
  assert.equal(await editorTitle.inputValue(), '현재 편집을 내보내는 영상 QA 사본');
  assert.equal(calls.filter(call => call.command === 'video_save_project').length, saveCount, 'duplicate remains an editable unsaved draft');
  assert.deepEqual(savedProjects.get(saved.id), saved, 'duplicate must retain the original saved project');
  console.log('Template QA: latest edited export snapshot, cancelled/successful export, and duplicate protection passed');
  assert.deepEqual(Object.keys(generatedDraft.project).sort(),['format','language','scenes','template','title']);
  assert.deepEqual(Object.keys(generatedDraft.project.scenes[0]).sort(),['body','durationSec','headline','id','motion','narration']);
  receivedVideoProject={...generatedDraft.project,title:'네이티브 수신 검토 영상 QA'};
  const nativeReceipt=await receiveCreationFixture(send.args.input,{project:receivedVideoProject});
  creations.push(nativeReceipt);const inbox=page.getByRole('region',{name:'제작 요청과 수신 초안',exact:true});
  await inbox.getByRole('button',{name:'새로고침',exact:true}).click();await inbox.getByRole('button',{name:'초안 검토',exact:true}).click();
  const importDialog=page.getByRole('dialog',{name:'영상 프로젝트 JSON 가져오기',exact:true});await importDialog.waitFor();assert.deepEqual(JSON.parse(await importDialog.getByLabel('VideoProject JSON',{exact:true}).inputValue()),receivedVideoProject);
  assert.equal(savedProjects.size,1,'Native receipt and user review do not save a video project');
  await importDialog.getByRole('button',{name:'가져와 저장',exact:true}).click();await page.getByText('JSON을 새 영상 프로젝트로 가져와 저장했습니다.',{exact:true}).waitFor();assert.equal(await editorTitle.inputValue(),receivedVideoProject.title);assert.equal(savedProjects.size,2,'Only explicit import saves to the memory IPC fixture');assert.deepEqual(savedProjects.get(saved.id),saved,'Receipt import preserves the original saved template');
  console.log('Template QA: actual UI prompt -> compiled native MCP get/receive -> reviewed JSON import passed (save fixture only)');
  await page.setViewportSize({ width: 820, height: 720 });
  await gallery.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '820px desktop layout must not overflow');
  await page.screenshot({ path: `${output}/gallery-820.png`, fullPage: false });
  await page.setViewportSize({ width: 1380, height: 960 });
  await gallery.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
  const stageGeometry = await gallery.locator('.vt-stage').evaluate(stage => {
    const bounds = stage.getBoundingClientRect(), style = getComputedStyle(stage);
    const copy = stage.querySelector('.vt-stage-copy'), copyStyle = getComputedStyle(copy);
    return { width: bounds.width, height: bounds.height, display: style.display, visibility: style.visibility, opacity: style.opacity, copyOpacity: copyStyle.opacity, copyVisibility: copyStyle.visibility, className: stage.className };
  });
  assert.ok(stageGeometry.width > 100 && stageGeometry.height > 100, 'wide preview remains measurable after a viewport change');
  assert.equal(stageGeometry.visibility, 'visible');
  assert.equal(stageGeometry.copyOpacity, '1');
  await gallery.locator('.vt-stage').screenshot({ path: `${output}/stage-wide.png` });
  await page.screenshot({ path: `${output}/gallery.png`, fullPage: false });
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  const report = {
    mode: 'Chromium with pure Rust catalog/preview data and isolated IPC; compiled native creation receipt and media validation; native OS, real AI, real project persistence and MP4 are not exercised',
    templates: fixtures.catalog.map(item => item.id), nativeFixtureCases:fixtures.cases.length,templateCycles: 20,
    filterAndEmptyRestore: true, favoriteToggleAndRestore: 'memory fixture only', recentOnlyAfterUseAndRestore: 'memory fixture only',
    previewControls: { category: 'tech', format: 'youtube-landscape', language: 'en', sceneCount: 6, durationSec: 60 },
    latePreviewIgnored: true, timelineSelection: true,
    playbackStoppedWhenHiddenOrInactive: true, hiddenMode: 'simulated visibilitychange',
    dirtyDraftProtected: true, explicitSaveAndReload: 'memory fixture only',
    selectedRecipeProjectionIncluded: true, chatReceiptIsNotGeneration: true, nativeCreationReceipt:'actual compiled stdio get/receive with native media validation in an isolated home',reviewedJsonImport:'actual dialog, explicit save to memory IPC fixture only',
    exportEditedSnapshotAndCancellation: 'memory mock IPC only; native picker and file write are not exercised',
    duplicateProtectedOriginal: true,
    baseline, after, stageGeometry, errors, unexpected, screenshots: [`${output}/gallery.png`, `${output}/gallery-820.png`, `${output}/stage-wide.png`],
  };
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await page?.screenshot({ path: `${output}/failure.png`, fullPage: false }).catch(() => {});
  await writeFile(`${output}/failure.json`, JSON.stringify({ error: String(error), errors, unexpected, lastCommands: calls.slice(-8).map(call => call.command) }, null, 2));
  console.error(error);
  throw error;
} finally {
  releaseOldPreview?.();
  await browser?.close();
  await server.close();
}
