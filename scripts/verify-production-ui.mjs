// 영상·모션 탭의 "주제 → AI 영상" 흐름을 Chromium + 명시적 IPC fixture로 검사합니다.
// 메모리 안의 가짜 작업이 production_get 폴링과 production-event로 진행합니다. Rust·모델·FFmpeg는 실행하지 않습니다.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createFixtureServer, shellFixture, unhandled } from './ui-fixture-helpers.mjs';

const out = resolve(process.env.TORIS_QA_OUT ?? '/private/tmp/toris-production-ui'); await mkdir(out, { recursive: true });
const report = { adapter: 'Chromium with explicit IPC fixtures and an in-memory production job; no Rust job runner, model, TTS or FFmpeg', checks: [], errors: [], unexpected: [] };
const clone = value => structuredClone(value);
const calls = [];
const STAGE_IDS = ['plan', 'storyboard', 'scenes', 'voice', 'subtitles', 'edit', 'qa', 'done'];

// ── fake engine ─────────────────────────────────────────────
let engineInstalled = false, installPolls = -1;
function engineStatus() {
  if (installPolls >= 0 && ++installPolls >= 2) { engineInstalled = true; installPolls = -1; }
  const install = installPolls >= 0 ? { phase: 'running', step: '모델 파일 내려받는 중', done: installPolls + 1, total: 3 } : { phase: engineInstalled ? 'done' : 'idle' };
  return {
    engines: [
      { id: 'wan2.1-t2v-1.3b', label: 'Wan2.1 T2V 1.3B', installed: engineInstalled, supported: true, license: 'Apache-2.0', commercialUse: true, revision: '37ec512', sizeGb: 17.4, memoryGb: 18, enabled: true, install },
      { id: 'wan2.2-ti2v-5b', label: 'Wan2.2 TI2V 5B', installed: false, supported: false, license: 'Apache-2.0', commercialUse: true, sizeGb: 32, memoryGb: 24, enabled: false, reason: '24GB 메모리에서 아직 검증하지 않았습니다.' }
    ],
    tts: { installed: true }, ffmpeg: { available: true }
  };
}

// ── fake job store ──────────────────────────────────────────
const jobs = new Map();
let failVoiceOnce = true, nextId = 1;
const stage = (job, id) => job.stages.find(s => s.id === id);
function newJob(input) {
  const id = 'job-' + nextId++, now = new Date().toISOString();
  const count = Math.min(12, Math.max(2, Math.ceil(input.durationSec / 5)));
  return { id, createdAt: now, updatedAt: now, status: 'planning', settings: clone(input),
    stages: STAGE_IDS.map(s => ({ id: s, status: s === 'plan' ? 'running' : 'pending', done: 0, total: s === 'scenes' || s === 'voice' ? count : 0 })),
    storyboard: null, scenes: [], generation: { width: 368, height: 640, frames: 33, steps: 20 }, output: { width: 1080, height: 1920 },
    final: null, qa: [], provenance: null, error: null, sceneCount: count };
}
function storyboardOf(job) {
  return { title: '2050 서울 시네마틱', story: '미래 서울의 하루를 따라갑니다.', style: { look: 'cinematic', palette: 'neon teal', consistency: 'same skyline' }, template: true,
    scenes: Array.from({ length: job.sceneCount }, (_, i) => ({ id: 's' + (i + 1), order: i + 1, durationSec: 5, script: '장면 ' + (i + 1), narration: '서울의 미래 ' + (i + 1), caption: '미래 서울 ' + (i + 1), prompt: 'futuristic seoul skyline shot ' + (i + 1), transition: 'cut' })) };
}
const scenePath = (job, s, kind) => '/fixture/public/productions/' + job.id + '/' + kind + '/' + s.id + '/key-' + s.id + (kind === 'scenes' ? '.mp4' : '.wav');
function stepAssets(job, stageId, kind) {
  const st = stage(job, stageId); st.status = 'running';
  const running = job.scenes.find(s => s[kind].status === 'running');
  if (running) { running[kind] = { status: 'done', path: scenePath(job, running, kind === 'video' ? 'scenes' : 'voice') }; }
  else { const next = job.scenes.find(s => s[kind].status !== 'done'); if (next) next[kind] = { status: 'running' }; }
  st.done = job.scenes.filter(s => s[kind].status === 'done').length;
  if (st.done === job.scenes.length) { st.status = 'done'; return true; }
  return false;
}
function tick(job) {
  if (job.status === 'planning') {
    Object.assign(stage(job, 'plan'), { status: 'done' }); Object.assign(stage(job, 'storyboard'), { status: 'awaiting_approval' });
    job.storyboard = storyboardOf(job); job.status = 'awaiting_approval';
    job.scenes = job.storyboard.scenes.map(s => ({ id: s.id, order: s.order, video: { status: 'pending' }, voice: { status: 'pending' } }));
    return;
  }
  if (job.status !== 'running') return;
  if (stage(job, 'scenes').status !== 'done') { stepAssets(job, 'scenes', 'video'); return; }
  if (job.settings.narration && stage(job, 'voice').status !== 'done') {
    if (failVoiceOnce) { failVoiceOnce = false; Object.assign(stage(job, 'voice'), { status: 'failed', error: '음성 서버에 연결하지 못했습니다.' }); job.status = 'failed'; job.error = { stage: 'voice', message: '음성 서버에 연결하지 못했습니다.' }; return; }
    stepAssets(job, 'voice', 'voice'); return;
  }
  for (const id of ['subtitles', 'edit', 'qa']) if (stage(job, id).status !== 'done') { stage(job, id).status = 'done'; return; }
  stage(job, 'done').status = 'done'; job.status = 'done';
  job.final = { path: '/fixture/public/productions/' + job.id + '/final.mp4', durationSec: 15.2, width: 1080, height: 1920, sizeBytes: 9 * 1024 ** 2 };
  job.editProject = { id: job.id, title: job.storyboard?.title ?? 'AI 영상', format: 'shorts', template: 'adaptive-promo', language: 'ko', scenes: job.scenes.map(sc => ({ id: sc.id, headline: '', body: '', narration: '', durationSec: 5, mediaType: 'video', mediaUrl: '/productions/' + job.id + '/scenes/' + sc.id + '/k.mp4', layout: 'media-focus' })), production: { jobId: job.id, aspect: '9:16' } };
  job.qa = [{ id: 'duration', label: '길이 15초 ±1초', passed: true }, { id: 'audio', label: '오디오 -14 LUFS', passed: true }, { id: 'black', label: '검은 화면 없음', passed: true }];
  job.provenance = { commercialUse: true, narrationRights: 'conditional', engine: 'wan2.1-t2v-1.3b', revision: '37ec512', licenses: [{ name: 'Wan2.1-T2V-1.3B', license: 'Apache-2.0' }, { name: 'mlx-examples', license: 'MIT' }, { name: 'Qwen3-TTS', license: 'Apache-2.0' }], notes: ['스토리보드는 템플릿으로 만들었습니다.'] };
}
const previews = [];
const touched = job => { job.updatedAt = new Date().toISOString(); return clone(job); };
function production(command, args) {
  const job = args.jobId ? jobs.get(args.jobId) : null;
  if (args.jobId && !job) throw new Error('unknown job ' + args.jobId);
  switch (command) {
    case 'production_engine_status': return engineStatus();
    case 'production_engine_install': assert.equal(args.engine, 'wan2.1-t2v-1.3b'); installPolls = 0; return null;
    case 'production_create': { assert.ok(engineInstalled, 'create only after the engine is installed'); const created = newJob(args); jobs.set(created.id, created); return clone(created); }
    case 'production_list': return [...jobs.values()].reverse().map(j => ({ id: j.id, title: j.storyboard?.title ?? j.settings.topic, topic: j.settings.topic, status: j.status, updatedAt: j.updatedAt, durationSec: j.settings.durationSec, aspect: j.settings.aspect }));
    case 'production_get': tick(job); return touched(job);
    case 'production_approve': {
      assert.equal(job.status, 'awaiting_approval');
      job.storyboard = { ...clone(args.storyboard), template: job.storyboard.template };
      stage(job, 'storyboard').status = 'done'; stage(job, 'scenes').status = 'running'; job.status = 'running'; return touched(job);
    }
    case 'production_pause': job.status = 'paused'; return touched(job);
    case 'production_resume': job.status = 'running'; return touched(job);
    case 'production_cancel': job.status = 'cancelled'; return touched(job);
    case 'production_retry': {
      job.error = null; job.status = 'running'; job.final = null;
      const kind = args.stage === 'voice' ? 'voice' : 'video';
      if (args.sceneId) { const s = job.scenes.find(x => x.id === args.sceneId); assert.ok(s, 'retry names a real scene'); s[kind] = { status: 'pending' }; }
      const st = stage(job, args.stage); st.status = 'running'; st.error = undefined; st.done = job.scenes.filter(s => s[kind].status === 'done').length;
      for (const id of ['subtitles', 'edit', 'qa']) stage(job, id).status = 'stale'; stage(job, 'done').status = 'pending';
      return touched(job);
    }
    case 'production_open_final': assert.equal(job.status, 'done'); return { path: job.final.path };
    case 'production_save_video': assert.equal(job.status, 'done'); return { saved: '/Users/qa/Movies/2050 서울.mp4' };
    case 'production_publication_draft': assert.equal(job.status, 'done'); return { publicationId: 'pub-1', status: 'draft' };
  }
  return unhandled;
}

const editorProjects = [];
const server = await createFixtureServer({ server: { port: 0, strictPort: false } }); await server.listen();
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1380, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  page.on('pageerror', e => report.errors.push(e.message));
  await page.exposeFunction('__qaInvoke', async (command, args = {}) => {
    // Rust production commands take one \`input\` argument; record what the command received.
    const received = command.startsWith('production_') ? (args?.input ?? {}) : (args ?? {});
    if (command.startsWith('production_') && command !== 'production_engine_status' && command !== 'production_list') assert.ok(args && typeof args.input === 'object', command + ' sends its fields inside input');
    calls.push({ command, args: clone(received) });
    if (command === 'native_open_render_preview') { previews.push(args.path); return null; }
    if (command.startsWith('production_')) { const value = production(command, received); if (value !== unhandled) return value; report.unexpected.push(command); throw new Error('unknown production IPC ' + command); }
    if (command === 'get_dashboard') return { channels: [], content: [], trends: [], integrations: [], database: { connected: true, message: 'QA' } };
    if (command === 'get_settings') return { configPath: '/fixture/config.json', databaseConfigured: true, youtubeConfigured: false, naverConfigured: false, savedCollectionKeys: {}, lastCollectedAt: null };
    if (command === 'get_scheduler_status') return { enabled: false, running: false, lastRunAt: null, nextRunAt: null, lastError: null };
    if (command === 'get_keychain_status') return { available: true, blocked: false };
    if (command === 'get_update_status') return { phase: 'idle', currentVersion: '0.4.2', availableVersion: null, message: '' };
    if (command === 'browser_runtime_status') return { installed: true, version: 'fixture', preferences: { openLinks: 'system' } };
    if (command === 'video_list_projects') return editorProjects.slice();
    if (command === 'video_save_project') { const saved = { ...clone(args.input), createdAt: 'now', updatedAt: 'now' }; editorProjects.push(saved); return saved; }
    if (command === 'media_status') return { ffmpegAvailable: true, ffprobeAvailable: true, fontAvailable: true, ttsConfigured: false, dataPath: '/fixture/data', renderer: 'fixture' };
    if (command === 'video_template_catalog') return [];
    if (command === 'video_template_library_get') return { favorites: [], recent: [] };
    if (command === 'video_research_providers') return [];
    if (command.startsWith('plugin:event|')) return 1;
    const shared = shellFixture(command, args ?? {}); if (shared !== unhandled) return shared;
    report.unexpected.push(command);
    return null;
  });
  await page.addInitScript(() => {
    const callbacks = new Map(); let next = 1; const listeners = [];
    window.__qaEmit = (event, payload) => { for (const l of listeners) if (l.event === event) callbacks.get(l.handler)?.({ event, id: 1, payload }); return listeners.filter(l => l.event === event).length; };
    window.__TAURI_INTERNALS__ = {
      transformCallback: cb => { const id = next++; callbacks.set(id, cb); return id; },
      unregisterCallback: id => callbacks.delete(id),
      convertFileSrc: (path, protocol = 'asset') => 'http://' + protocol + '.localhost/' + encodeURIComponent(path),
      invoke: async (command, args) => {
        if (command === 'plugin:event|listen') listeners.push({ event: args.event, handler: args.handler });
        if (command === 'plugin:event|unlisten') { const i = listeners.findIndex(l => l.event === args.event); if (i >= 0) listeners.splice(i, 1); }
        return window.__qaInvoke(command, args);
      }
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  const navigate = async query => {
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: '어디로 이동할까요?' }).getByRole('combobox', { name: '화면 이름 검색' }).fill(query);
    await page.keyboard.press('Enter');
  };
  const last = command => calls.findLast(c => c.command === command);
  const count = command => calls.filter(c => c.command === command).length;
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  const emit = payload => page.evaluate(p => window.__qaEmit('production-event', p), payload);

  await page.goto(origin, { waitUntil: 'networkidle' });
  await navigate('영상');
  await page.getByRole('heading', { name: '영상·모션', exact: true }).waitFor();
  const studio = page.getByRole('region', { name: '어떤 영상을 만들까요?' });
  await studio.waitFor();
  const topic = studio.getByLabel('영상 주제', { exact: true });
  const create = studio.getByRole('button', { name: '영상 생성', exact: true });
  assert.equal(await topic.getAttribute('placeholder'), '예: 2050년 미래 서울을 보여주는 30초 시네마틱 쇼츠');
  // motion_request_list belongs to the shell's work tray; the editors' own reads must not run yet.
  assert.equal(calls.some(c => /^video_|^media_status$|^motion_(preview|draft)/.test(c.command)), false, 'the legacy editor and motion studio stay unmounted until opened');
  report.checks.push('영상·모션 opens on the topic → AI video composer; legacy editors are not mounted by default');

  // Engine missing: inline card, disabled create with reason, install progress.
  const card = studio.getByRole('group', { name: '영상 엔진 설치 필요' });
  await card.getByText('내려받기 약 17.4GB', { exact: false }).waitFor();
  await card.getByText('라이선스 Apache-2.0 · 상업적 이용 가능', { exact: false }).waitFor();
  await studio.getByText('Wan2.2 TI2V 5B: 24GB 메모리에서 아직 검증하지 않았습니다.', { exact: true }).waitFor();
  assert.equal(await studio.getByLabel('엔진', { exact: true }).locator('option', { hasText: 'Wan2.2 TI2V 5B' }).evaluate(o => o.disabled), true, 'unsupported engine is shown but not selectable');
  await topic.fill('2050년 미래 서울을 보여주는 15초 시네마틱 쇼츠');
  assert.equal(await create.isDisabled(), true);
  await studio.getByText('영상 엔진을 먼저 설치하세요.', { exact: true }).waitFor();
  await card.getByRole('button', { name: '엔진 설치', exact: true }).click();
  await card.getByRole('status').getByText('모델 파일 내려받는 중', { exact: false }).waitFor();
  await card.waitFor({ state: 'detached', timeout: 10000 });
  assert.equal(count('production_engine_install'), 1);
  report.checks.push('Missing engine shows size/license, a disabled 영상 생성 with its reason, and install progress until installed');

  // Validation.
  await topic.fill('   ');
  assert.equal(await create.isDisabled(), true, 'empty topic disables 영상 생성');
  await studio.getByText('영상 주제를 입력하세요.', { exact: true }).waitFor();
  await topic.fill('2050년 미래 서울을 보여주는 15초 시네마틱 쇼츠');
  await studio.getByText('직접', { exact: true }).click();
  const custom = studio.getByLabel('직접 길이(초)', { exact: true });
  await custom.fill('5'); assert.equal(await create.isDisabled(), true, 'custom length below 10s is rejected');
  await custom.fill('121'); assert.equal(await create.isDisabled(), true, 'custom length above 120s is rejected');
  await custom.fill('20'); assert.equal(await create.isDisabled(), false);
  await studio.getByText('15초', { exact: true }).click();
  await studio.getByText('고화질', { exact: true }).click();
  await studio.getByText('생성 해상도 480×832', { exact: false }).waitFor();
  await studio.getByText('16:9 가로', { exact: true }).click();
  assert.match(await studio.locator('.production-resolution').innerText(), /832×480[\s\S]*출력 1920×1080[\s\S]*81프레임/);
  await studio.getByText('9:16 세로', { exact: true }).click();
  await studio.getByText('미리보기', { exact: true }).click();
  assert.match(await studio.locator('.production-resolution').innerText(), /생성 해상도 368×640[\s\S]*출력 1080×1920/);
  await studio.getByText('실사', { exact: true }).click();
  await studio.getByLabel('화자', { exact: true }).selectOption('Ryan');
  await studio.getByLabel('배경 음악', { exact: true }).selectOption('ambient');
  assert.equal(await overflow(), false);
  await page.setViewportSize({ width: 820, height: 1000 });
  assert.equal(await overflow(), false, 'composer has no horizontal overflow at 820px');
  await page.screenshot({ path: resolve(out, 'composer-820.png'), fullPage: true });
  await page.setViewportSize({ width: 1380, height: 1000 });
  await page.screenshot({ path: resolve(out, 'composer-1380.png'), fullPage: true });
  report.checks.push('Validation: empty topic and custom length outside 10~120 disable 영상 생성; generation and output resolution shown separately; no overflow at 820/1380');

  // Create → storyboard review.
  await create.click();
  const sent = last('production_create').args;
  assert.deepEqual(sent, { topic: '2050년 미래 서울을 보여주는 15초 시네마틱 쇼츠', durationSec: 15, aspect: '9:16', style: 'realistic', narration: true, subtitleStyle: 'shorts-bold', bgm: 'ambient', quality: 'preview', engine: 'wan2.1-t2v-1.3b', speaker: 'Ryan' });
  const review = page.getByRole('region', { name: '스토리보드 확인' });
  await review.waitFor({ timeout: 10000 });
  await review.getByText('템플릿 초안 · AI 미사용', { exact: true }).waitFor();
  const stepper = page.getByRole('region', { name: '제작 단계' });
  assert.match(await stepper.locator('li[aria-current=step]').innerText(), /스토리보드 확인[\s\S]*확인 대기/);
  await review.getByLabel('영상 제목', { exact: true }).fill('수정한 미래 서울');
  const scene2 = review.getByRole('group', { name: '장면 2 편집' });
  await scene2.getByLabel('나레이션', { exact: true }).fill('수정한 나레이션');
  await scene2.getByLabel('자막', { exact: true }).fill('수정한 자막');
  await scene2.getByLabel(/^영상 프롬프트/).fill('edited neon seoul aerial');
  await scene2.getByLabel('길이(초)', { exact: true }).fill('13');
  const approve = review.getByRole('button', { name: '이대로 생성', exact: true });
  assert.equal(await approve.isDisabled(), true, 'scene length outside 2~12s blocks approval');
  await scene2.getByLabel('길이(초)', { exact: true }).fill('6');
  await page.setViewportSize({ width: 820, height: 1000 });
  assert.equal(await overflow(), false, 'storyboard review has no horizontal overflow at 820px');
  await page.screenshot({ path: resolve(out, 'review-820.png'), fullPage: true });
  await page.setViewportSize({ width: 1380, height: 1000 });
  await approve.click();
  const approved = last('production_approve').args;
  assert.equal(approved.storyboard.title, '수정한 미래 서울');
  assert.deepEqual({ ...approved.storyboard.scenes[1] }, { id: 's2', order: 2, durationSec: 6, script: '장면 2', narration: '수정한 나레이션', caption: '수정한 자막', prompt: 'edited neon seoul aerial', transition: 'cut' });
  assert.equal('template' in approved.storyboard, false, 'approval sends only contract storyboard fields');
  report.checks.push('production_create sends the closed settings; storyboard review edits title/narration/caption/prompt/duration and 이대로 생성 sends the edited storyboard');

  // Scenes progress via polling; events; pause/resume.
  const scenes = page.getByRole('region', { name: '장면' });
  await scenes.getByText('1/3 장면 완료', { exact: true }).waitFor({ timeout: 15000 });
  const preview = scenes.getByRole('article', { name: '장면 1' }).locator('video');
  assert.equal(await preview.getAttribute('src'), 'http://asset.localhost/' + encodeURIComponent('/fixture/public/productions/job-1/scenes/s1/key-s1.mp4'));
  await page.getByRole('button', { name: '일시정지', exact: true }).click();
  assert.equal(last('production_pause').args.jobId, 'job-1');
  await page.getByText('일시정지했습니다.', { exact: false }).waitFor();
  const getsWhilePaused = count('production_get');
  await page.waitForTimeout(1600);
  assert.equal(count('production_get'), getsWhilePaused, 'a paused job is not polled');
  // A progress event updates counts without a read.
  assert.ok(await emit({ jobId: 'job-1', stage: 'scenes', kind: 'progress', done: 2, total: 3, message: '이벤트로 받은 진행' }) >= 1, 'the panel listens to production-event');
  await stepper.getByText('이벤트로 받은 진행', { exact: true }).waitFor();
  assert.match(await stepper.locator('li.is-running').first().innerText(), /2\/3/);
  assert.equal(count('production_get'), getsWhilePaused);
  // A state event triggers a fresh read (e.g. resumed from another window).
  jobs.get('job-1').status = 'running';
  await emit({ jobId: 'job-1', stage: 'scenes', kind: 'state', done: 1, total: 3, message: '' });
  await page.getByRole('button', { name: '일시정지', exact: true }).waitFor();
  assert.ok(count('production_get') > getsWhilePaused, 'state event re-reads the job');
  await page.getByRole('button', { name: '일시정지', exact: true }).click();
  await page.getByRole('button', { name: '계속', exact: true }).click();
  assert.equal(last('production_resume').args.jobId, 'job-1');
  report.checks.push('Scenes advance with done/total counts and local previews; pause stops polling; progress and state events update the view; resume continues');

  // Failure next to the failed stage, then stage retry.
  const voiceError = stepper.getByRole('alert').filter({ hasText: '음성 서버에 연결하지 못했습니다.' });
  await voiceError.waitFor({ timeout: 20000 });
  assert.match(await stepper.locator('li.is-failed').innerText(), /나레이션/);
  await voiceError.getByRole('button', { name: /다시 시도/ }).click();
  assert.deepEqual(last('production_retry').args, { jobId: 'job-1', stage: 'voice' });
  report.checks.push('A failed stage shows its error beside the stage and 다시 시도 retries only that stage');

  // Done.
  const result = page.getByRole('region', { name: '완성 영상' });
  await result.waitFor({ timeout: 30000 });
  assert.equal(await result.getByLabel('완성 영상 재생').getAttribute('src'), 'http://asset.localhost/' + encodeURIComponent('/fixture/public/productions/job-1/final.mp4'));
  const facts = await result.locator('.production-facts').innerText();
  assert.match(facts, /생성 해상도\s*368×640/); assert.match(facts, /출력 해상도\s*1080×1920/); assert.match(facts, /15\.2초/);
  await result.getByText('3/3 통과', { exact: true }).waitFor();
  await result.getByText('영상 상업적 이용 가능', { exact: true }).waitFor();
  await result.getByText('나레이션 화자 권리 조건부', { exact: true }).waitFor();
  await result.getByText('Wan2.1-T2V-1.3B · Apache-2.0', { exact: true }).waitFor();
  assert.equal(/남은 시간|예상 시간|분 남음|초 남음/.test(await page.locator('.production').innerText()), false, 'progress never shows estimated time');
  await result.getByRole('button', { name: '새 창에서 보기', exact: true }).click();
  await result.getByRole('button', { name: 'MP4 저장', exact: true }).click();
  assert.equal(count('production_open_final'), 1);
  assert.deepEqual(previews, ['/fixture/public/productions/job-1/final.mp4'], 'the native preview window opens the final MP4');
  assert.equal(count('production_save_video'), 1);
  await page.getByRole('status').filter({ hasText: 'MP4를 저장했습니다' }).waitFor();
  await result.getByText('초안만 만듭니다. 실제 게시는 발행 화면에서 승인한 뒤에 진행됩니다.', { exact: true }).waitFor();
  await result.getByRole('button', { name: 'SNS 게시 초안 만들기', exact: true }).click();
  assert.deepEqual(last('production_publication_draft').args, { jobId: 'job-1' });
  const draftNotice = page.getByRole('status').filter({ hasText: 'SNS 게시 초안을 만들었습니다.' });
  await draftNotice.waitFor();
  assert.match(await draftNotice.innerText(), /아직 게시되지 않았으며.*승인/);
  assert.equal(calls.some(c => /publish|upload|publication_save/.test(c.command)), false, 'no direct publish from the production view');
  await page.setViewportSize({ width: 820, height: 1000 });
  assert.equal(await overflow(), false, 'result view has no horizontal overflow at 820px');
  await page.screenshot({ path: resolve(out, 'done-820.png'), fullPage: true });
  await page.setViewportSize({ width: 1380, height: 1000 });
  await page.screenshot({ path: resolve(out, 'done-1380.png'), fullPage: true });
  report.checks.push('Done: final player, generation vs output resolution, duration, QA list, license/commercial-use summary; open opens the native preview, save calls production_save_video; SNS draft only with approval wording');

  // Per-scene retry sends the right sceneId.
  await scenes.getByRole('button', { name: '장면 재생성 · 장면 2', exact: true }).click();
  assert.deepEqual(last('production_retry').args, { jobId: 'job-1', sceneId: 's2', stage: 'scenes' });
  await scenes.getByText('2/3 장면 완료', { exact: true }).waitFor();
  await result.waitFor({ timeout: 30000 });
  await scenes.getByRole('button', { name: '나레이션 다시 · 장면 3', exact: true }).click();
  assert.deepEqual(last('production_retry').args, { jobId: 'job-1', sceneId: 's3', stage: 'voice' });
  await result.waitFor({ timeout: 30000 });
  report.checks.push('장면 재생성 / 나레이션 다시 send production_retry with that scene id and stage');

  // Recent jobs survive a reload (app restart) and reopen.
  await page.reload({ waitUntil: 'networkidle' });
  await navigate('영상');
  const recent = page.getByRole('complementary', { name: '최근 작업' });
  await recent.getByRole('button', { name: /수정한 미래 서울/ }).click();
  await page.getByRole('region', { name: '완성 영상' }).waitFor();
  assert.equal(last('production_get').args.jobId, 'job-1');
  report.checks.push('Recent jobs (production_list) reopen a finished job after reload');

  // 편집기에서 다듬기: the validated edit project becomes its own editor project; reopening reuses it.
  await page.getByRole('region', { name: '완성 영상' }).getByRole('button', { name: '편집기에서 다듬기', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'AI 영상을 편집기 프로젝트로 가져왔습니다.' }).waitFor();
  assert.equal(count('video_save_project'), 1);
  assert.equal(last('video_save_project').args.input.production.jobId, 'job-1', 'the editor copy keeps the production job id');
  assert.equal(last('video_save_project').args.input.scenes[0].mediaType, 'video');
  await page.getByRole('navigation', { name: '영상 제작 모드' }).getByRole('button', { name: '주제 → AI 영상', exact: true }).click();
  await page.getByRole('region', { name: '완성 영상' }).getByRole('button', { name: '편집기에서 다듬기', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '이전에 편집기로 가져온 AI 영상을 열었습니다.' }).waitFor();
  assert.equal(count('video_save_project'), 1, 'a second open reuses the editor copy instead of overwriting edits');
  await page.getByRole('navigation', { name: '영상 제작 모드' }).getByRole('button', { name: '주제 → AI 영상', exact: true }).click();
  await page.getByRole('region', { name: '완성 영상' }).waitFor();
  report.checks.push('편집기에서 다듬기 saves the validated edit project once and opens it in the direct editor; reopening reuses that copy');

  // Cancel a second job.
  await page.getByRole('button', { name: '새 영상', exact: true }).click();
  await page.locator('#production-topic').fill('취소할 영상');
  await page.getByRole('button', { name: '영상 생성', exact: true }).click();
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('group', { name: '작업 취소 확인' }).getByRole('button', { name: '작업 취소', exact: true }).click();
  assert.equal(last('production_cancel').args.jobId, 'job-2');
  await page.getByText('이 작업은 취소되었습니다.', { exact: false }).waitFor();
  report.checks.push('취소 asks for confirmation and calls production_cancel for the open job');

  // Reduced motion: entrance animation only when motion is allowed.
  assert.equal(await page.locator('.production-progress').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await page.locator('.production-progress').evaluate(el => getComputedStyle(el).animationName), 'production-in');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  report.checks.push('prefers-reduced-motion disables the entrance animation and transitions');

  // Legacy editor and motion graphics stay reachable.
  await page.getByRole('navigation', { name: '영상 제작 모드' }).getByRole('button', { name: '직접 편집', exact: true }).click();
  await page.locator('.desktop-video-idea').waitFor();
  assert.ok(count('video_list_projects') >= 1, 'legacy editor mounts when opened');
  await page.getByRole('navigation', { name: '영상 제작 모드' }).getByRole('button', { name: '모션 그래픽', exact: true }).click();
  await page.getByRole('group', { name: '모션 그래픽 제작' }).waitFor();
  await page.getByRole('navigation', { name: '영상 제작 모드' }).getByRole('button', { name: '주제 → AI 영상', exact: true }).click();
  await page.getByRole('region', { name: '취소할 영상' }).waitFor();
  report.checks.push('직접 편집 and 모션 그래픽 remain reachable behind the secondary control and return to the production view');

  // Keyboard focus is visible on the primary control.
  await page.getByRole('button', { name: '새 영상', exact: true }).click();
  const topicField = page.locator('#production-topic');
  await topicField.focus();
  assert.equal(await topicField.evaluate(el => getComputedStyle(el).outlineStyle), 'solid', 'keyboard focus is visible');
  report.checks.push('Topic field shows a visible focus outline');

  assert.deepEqual(report.errors, []);
  assert.equal(report.unexpected.some(c => c.startsWith('production_')), false);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.failure = String(error?.stack ?? error);
  if (page) await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify(report, null, 2));
  throw error;
} finally { await writeFile(resolve(out, 'verification.json'), JSON.stringify(report, null, 2)); await browser.close(); await server.close(); }

