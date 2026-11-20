// Settings "준비 상태" and the YouTube public-lookup panel in Chromium with explicit IPC fixtures.
// No database, account, CLI or network: every native answer below is a fixture.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createFixtureServer, shellFixture, unhandled, openSection } from './ui-fixture-helpers.mjs';

const out = resolve(process.env.TORIS_QA_OUT ?? '/private/tmp/toris-readiness-ui'); await mkdir(out, { recursive: true });
const report = { adapter: 'Chromium with explicit IPC fixtures; no database, account, CLI or network', checks: [], errors: [] };
const calls = [];
// Fresh install: no DB, no model, no keys, no logins, broker unreachable.
let state = { db: false, youtubeKey: false, youtubeLogin: false, naverBroker: false, contentModel: null };
const channel = { id: 'UCfixture00000000000000', title: '검증 채널', handle: '@fixture', url: 'https://www.youtube.com/@fixture', subscriberCount: 10, viewCount: 100, videoCount: 0, thumbnail: null };
const handler = async (command, args = {}) => {
  calls.push({ command, args });
  if (command === 'get_dashboard') return { channels: [], content: [], trends: [], integrations: [], database: { connected: state.db, message: 'fixture' } };
  if (command === 'ai_status') return { providers: state.contentModel ? [{ id: 'claude-cli', label: 'Claude Code', kind: 'subscription', available: true, detail: '', suggestedModels: [] }] : [], contentModel: state.contentModel, agentModel: null, image: null };
  if (command === 'get_settings') return { databaseConfigured: state.db, creationMode: 'remote-desktop-commander', youtubeConfigured: state.youtubeKey, naverConfigured: false, savedCollectionKeys: { youtubeApiKey: state.youtubeKey, naverClientId: false, naverClientSecret: false }, configPath: '/fixture/settings.json', schedulerEnabled: false };
  if (command === 'oauth_status') return { providers: [{ platform: 'youtube', connected: state.youtubeLogin, connectionCount: state.youtubeLogin ? 1 : 0 }, { platform: 'google_calendar', connected: false, connectionCount: 0 }] };
  if (command === 'oauth_connection_dispatch' && args.input?.action === 'brokerConfig') return { available: {}, naverSearch: state.naverBroker, clients: {} };
  if (command === 'get_scheduler_status') return { enabled: false, lastSuccessAt: null, nextRunAt: null, lastError: null, running: false };
  if (command === 'get_keychain_status') return { blocked: false };
  if (command === 'get_update_status') return { currentVersion: '0.9.0', configured: true, phase: 'idle', availableVersion: null, notes: null, publishedAt: null, downloadedBytes: 0, totalBytes: null, canCancel: false, message: 'fixture' };
  if (command === 'browser_runtime_status') return { preference: 'system', effectiveBrowser: 'system', available: true, reason: null, phase: 'idle' };
  if (command === 'mobile_status') return { available: false, enabled: false, interfaces: [], address: null, port: null, fingerprint: null, devices: [], pending: null, projects: [] };
  if (command === 'mobile_close_qr') return null;
  if (command === 'start_database') return { ok: true, message: '로컬 PostgreSQL이 준비되었습니다.' };
  if (command === 'youtube_lookup_channel') return channel;
  if (command === 'youtube_channel_videos') return { channel, videos: [], fetchedAt: '2026-11-20T00:00:00Z' };
  if (command.startsWith('plugin:event|')) return 1;
  const shared = shellFixture(command, args); if (shared !== unhandled) return shared;
  return null;
};
const tauriShim = () => {
  const callbacks = new Map(); let next = 1;
  window.__TAURI_INTERNALS__ = { transformCallback: cb => { const id = next++; callbacks.set(id, cb); return id; }, unregisterCallback: id => callbacks.delete(id), invoke: async (command, args) => window.__qaInvoke(command, args) };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
};

const server = await createFixtureServer({ server: { port: 0, strictPort: false } }); await server.listen();
const browser = await chromium.launch({ headless: true });
async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1380, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', e => report.errors.push(e.message));
  await page.exposeFunction('__qaInvoke', handler);
  await page.addInitScript(tauriShim);
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'networkidle' });
  return page;
}
const openSettings = page => page.getByRole('navigation', { name: '앱 설정', exact: true }).getByRole('button', { name: '설정', exact: true }).click();
const titleIs = (page, text) => page.waitForFunction(t => document.querySelector('h1')?.textContent === t, text);
const openReference = async page => {
  await page.getByRole('navigation', { name: 'SNS 관리 화면', exact: true }).getByRole('button', { name: '채널', exact: true }).click();
  await page.getByText('참고 YouTube 채널 조회', { exact: true }).click();
  await page.getByRole('button', { name: '공개 채널 조회 열기' }).click();
};

try {
  // 1. Fresh install: every feature row says what is missing and offers one fix.
  let page = await openPage();
  await openSettings(page);
  const ready = page.getByRole('region', { name: '준비 상태' });
  await ready.locator('li').first().waitFor();
  const rows = await ready.locator('li').evaluateAll(items => items.map(li => ({ feature: li.querySelector('strong')?.textContent, status: li.querySelector('span')?.textContent, button: li.querySelector('button')?.textContent ?? null })));
  assert.deepEqual(rows.map(r => r.feature), ['문구·영상 초안·주간 콘텐츠 (AI)', 'AI 이미지 생성', '채널·콘텐츠·일정 저장 (로컬 DB)', '트렌드·채널 조회 (YouTube)', '트렌드 (네이버 블로그 검색)', 'SNS 분석·게시']);
  assert.ok(rows.every(r => r.status.startsWith('필요: ')), 'nothing is ready on a fresh install');
  assert.deepEqual(rows.map(r => r.button), ['모델 설정 열기', '모델 설정 열기', 'DB 시작', 'SNS 연결 열기', '키 입력으로 이동', 'DB 시작']);
  await page.screenshot({ path: resolve(out, 'readiness-fresh.png'), fullPage: false });
  report.checks.push('Fresh install: six rows, each missing item stated with one fix button');

  // 2. Each button goes where it says.
  const row = name => ready.locator('li').filter({ has: page.locator('strong', { hasText: name }) });
  await row('로컬 DB').getByRole('button', { name: 'DB 시작' }).click();
  await page.getByText('로컬 PostgreSQL이 준비되었습니다.').first().waitFor();
  assert.ok(calls.some(c => c.command === 'start_database'), 'DB 시작 starts the local database');
  await row('네이버 블로그').getByRole('button', { name: '키 입력으로 이동' }).click();
  // The key fields scroll into view (smooth scroll: poll until the fieldset top is inside the window).
  await page.waitForFunction(() => { const set = document.getElementById('settings-youtube-key')?.closest('fieldset'); const top = set?.getBoundingClientRect().top; return top !== undefined && top >= -1 && top < innerHeight; }, null, { timeout: 5000 });
  await row('(AI)').getByRole('button', { name: '모델 설정 열기' }).click();
  await titleIs(page, 'Agent');
  await openSettings(page);
  await row('YouTube').getByRole('button', { name: 'SNS 연결 열기' }).click();
  await titleIs(page, 'SNS 관리');
  report.checks.push('Fix buttons: DB 시작 calls start_database, 키 입력 scrolls the key fields into view, 모델 설정 opens Agent, SNS 연결 opens SNS 관리');

  // 3. YouTube panel without key or login: lookup stays off and both ways to fix it are named.
  await openReference(page);
  await page.getByText('YouTube 계정을 연결하면', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('채널 핸들 또는 채널 주소').isDisabled(), true, 'no key and no login: the query field is off');
  assert.equal(await page.getByRole('button', { name: '채널 조회' }).isDisabled(), true, 'no key and no login: lookup stays off');
  assert.equal(calls.filter(c => c.command === 'youtube_lookup_channel').length, 0);
  report.checks.push('YouTube panel without key or login: lookup disabled, key or account connection offered');
  await page.close();

  // 4. Logged-in YouTube account, broker search and a content model: those rows are ready, and the panel looks up through the login.
  state = { ...state, youtubeLogin: true, naverBroker: true, contentModel: { provider: 'claude-cli', model: 'sonnet' } };
  page = await openPage();
  await openSettings(page);
  const after = page.getByRole('region', { name: '준비 상태' });
  const afterRow = name => after.locator('li').filter({ has: page.locator('strong', { hasText: name }) });
  for (const name of ['YouTube', '네이버 블로그', '(AI)']) await afterRow(name).getByText('준비됨').waitFor();
  assert.equal(await afterRow('YouTube').getByRole('button').count(), 0, 'a ready row has no fix button');
  await openSection(page, 'SNS 관리');
  await openReference(page);
  await page.locator('.desktop-youtube-connection').getByText('계정 연결됨', { exact: false }).waitFor();
  await page.getByLabel('채널 핸들 또는 채널 주소').fill('@fixture');
  await page.getByRole('button', { name: '채널 조회' }).click();
  await page.getByText('검증 채널').first().waitFor();
  assert.deepEqual(calls.findLast(c => c.command === 'youtube_lookup_channel').args, { input: { query: '@fixture' } }, 'only the query crosses IPC; the token stays native');
  await page.screenshot({ path: resolve(out, 'youtube-login.png'), fullPage: false });
  report.checks.push('YouTube login, broker search and a content model mark their rows ready; the YouTube panel looks up via the connected account');
  await page.close();

  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} finally { await writeFile(resolve(out, 'verification.json'), JSON.stringify(report, null, 2)); await browser.close(); await server.close(); }
