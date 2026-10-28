// Local voice (TTS) controls in Chromium with explicit IPC fixtures. No Python, model or audio runs.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createFixtureServer, shellFixture, unhandled } from './ui-fixture-helpers.mjs';

const out = resolve(process.env.TORIS_QA_OUT ?? '/private/tmp/toris-voice-ui'); await mkdir(out, { recursive: true });
const report = { adapter: 'Chromium with explicit IPC fixtures; no Python, model download or audio', checks: [], errors: [] };
const license = { commercialUse: true, model: { name: 'Qwen3-TTS-12Hz-1.7B-CustomVoice', license: 'Apache-2.0', url: 'https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice' }, runtime: [{ name: 'mlx-audio', license: 'MIT' }, { name: 'MLX', license: 'MIT' }] };
let tts = { supported: true, state: 'stopped', owned: false, narration: false, installed: false, python: null, model: null, install: { phase: 'idle', step: '', log: [] }, lastError: null, endpoint: 'http://127.0.0.1:50010', license };
let polls = 0;
const calls = [];
const server = await createFixtureServer({ server: { port: 0, strictPort: false } }); await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1380, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', e => report.errors.push(e.message));
  await page.exposeFunction('__qaInvoke', async (command, args = {}) => {
    calls.push(command);
    if (command === 'get_dashboard') return { channels: [], content: [], trends: [], integrations: [], database: { connected: true, message: 'QA' } };
    if (command === 'get_settings') return { configPath: '/fixture/config.json', databaseConfigured: true, youtubeConfigured: false, naverConfigured: false, savedCollectionKeys: {}, lastCollectedAt: null };
    if (command === 'get_scheduler_status') return { enabled: false, running: false, lastRunAt: null, nextRunAt: null, lastError: null };
    if (command === 'get_keychain_status') return { available: true, blocked: false };
    if (command === 'get_update_status') return { phase: 'idle', currentVersion: '0.4.2', availableVersion: null, message: '' };
    if (command === 'browser_runtime_status') return { installed: true, version: 'fixture', preferences: { openLinks: 'system' } };
    if (command === 'tts_status') {
      if (tts.install.phase === 'running' && ++polls >= 2) tts = { ...tts, installed: true, python: { source: 'mlx-narration', path: '/fixture/.venv/bin/python' }, model: { source: 'huggingface', path: '/fixture/hub' }, install: { phase: 'done', step: '설치 완료', log: [...tts.install.log, '▶ 음성 모델 사용: huggingface'] } };
      if (tts.state === 'starting' && ++polls >= 4) tts = { ...tts, state: 'running', owned: true, narration: true };
      return structuredClone(tts);
    }
    if (command === 'tts_install') { polls = 0; tts = { ...tts, install: { phase: 'running', step: 'Python 런타임 사용: mlx-narration', log: ['▶ Python 런타임 사용: mlx-narration'] } }; return structuredClone(tts); }
    if (command === 'tts_start') { polls = 2; tts = { ...tts, state: 'starting' }; return structuredClone(tts); }
    if (command === 'tts_stop') { tts = { ...tts, state: 'stopped', owned: false }; return structuredClone(tts); }
    if (command.startsWith('plugin:event|')) return 1;
    const shared = shellFixture(command, args); if (shared !== unhandled) return shared;
    return null;
  });
  await page.addInitScript(() => {
    const callbacks = new Map(); let next = 1;
    window.__TAURI_INTERNALS__ = { transformCallback: cb => { const id = next++; callbacks.set(id, cb); return id; }, unregisterCallback: id => callbacks.delete(id), invoke: async (command, args) => window.__qaInvoke(command, args) };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto('http://127.0.0.1:' + server.httpServer.address().port, { waitUntil: 'networkidle' });
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: '어디로 이동할까요?' }).getByRole('combobox', { name: '화면 이름 검색' }).fill('설정');
  await page.keyboard.press('Enter');
  const section = page.getByRole('region', { name: '로컬 음성 (TTS)' });
  await section.getByText('설치 필요').waitFor();
  await section.getByText('상업적 이용 가능 · 모델 Apache-2.0').waitFor();
  await section.getByText('상업적 이용 근거와 주의할 점').click();
  await section.getByText('실제 사람 목소리를 흉내 내거나 복제하려면', { exact: false }).waitFor();
  assert.equal(await section.getByRole('button', { name: '켜기' }).count(), 0, 'nothing to start before install');
  report.checks.push('Settings shows install-needed state, the commercial-use badge and its basis and limits');

  await section.getByRole('button', { name: '음성 엔진 설치' }).click();
  await section.getByLabel('설치 기록').getByText('Python 런타임 사용: mlx-narration', { exact: false }).waitFor();
  await section.getByText('런타임: MLX-Narration · 모델: Hugging Face 캐시').waitFor();
  await section.getByRole('button', { name: '켜기' }).click();
  await section.getByText('켜는 중 · 모델 불러오는 중').waitFor();
  await section.getByText('켜짐', { exact: true }).waitFor();
  await section.getByRole('button', { name: '끄기' }).click();
  await section.getByText('꺼짐', { exact: true }).waitFor();
  assert.deepEqual(calls.filter(c => ['tts_install', 'tts_start', 'tts_stop'].includes(c)), ['tts_install', 'tts_start', 'tts_stop']);
  report.checks.push('Install reports progress and reuses MLX-Narration; start shows loading then running; stop returns to off');
  await page.screenshot({ path: resolve(out, 'settings-voice.png'), fullPage: false });
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} finally { await writeFile(resolve(out, 'verification.json'), JSON.stringify(report, null, 2)); await browser.close(); await server.close(); }

