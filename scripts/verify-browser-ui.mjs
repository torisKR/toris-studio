import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { resolve } from 'node:path';

// A wrong persisted choice, lost draft, duplicate save, stale status or OAuth
// browser override must fail through the real rendered desktop components.
const server = await createServer({ configFile: resolve('desktop/vite.config.ts'), server: { port: 0, strictPort: false, watch: { ignored: ['**/src-tauri/**'] } } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, reducedMotion: 'reduce' });
const calls = [], errors = [];
let preference = 'playwright', available = true, reason = null, phase = 'idle';
let failSave = false, failRead = false, releaseSave = null, deferRead = false, releaseRead = null;
const runtimeStatus = () => ({ preference, effectiveBrowser: available ? preference : 'system', available, reason, phase });
await page.exposeFunction('__qaInvoke', async (command, args = {}) => {
  calls.push({ command, args });
  if (command === 'get_dashboard') return { channels: [], content: [], trends: [], integrations: [], database: { connected: false, message: 'fixture' } };
  if (command === 'ai_status') return { providers: [], defaultProvider: null };
  if (command === 'get_settings') return { databaseConfigured: false, opencodexBaseUrl: '', opencodexModel: '', opencodexAllowedModels: [], youtubeConfigured: false, naverConfigured: false, configPath: '/fixture/settings.json', schedulerEnabled: false };
  if (command === 'get_scheduler_status') return { enabled: false, lastSuccessAt: null, nextRunAt: null, lastError: null, running: false };
  if (command === 'get_keychain_status') return { blocked: false };
  if (command === 'get_update_status') return { currentVersion: '0.1.24', configured: true, phase: 'idle', availableVersion: null, notes: null, publishedAt: null, downloadedBytes: 0, totalBytes: null, canCancel: false, message: 'fixture' };
  if (command === 'plugin:event|listen') return 1;
  if (command === 'plugin:event|unlisten') return null;
  if (command === 'browser_runtime_status') {
    if (failRead) throw new Error('private error https://example.test/?code=do-not-render');
    const snapshot = runtimeStatus();
    if (deferRead) { deferRead = false; await new Promise(resolve => { releaseRead = resolve; }); }
    return snapshot;
  }
  if (command === 'save_browser_preferences') {
    assert.deepEqual(Object.keys(args), ['input']);
    assert.deepEqual(Object.keys(args.input), ['browser']);
    assert.ok(['system', 'playwright'].includes(args.input.browser));
    if (releaseSave === 'defer') await new Promise(resolve => { releaseSave = resolve; });
    if (failSave) throw new Error('private error https://example.test/?token=do-not-render');
    preference = args.input.browser;
    return runtimeStatus();
  }
  if (command === 'oauth_status') return { providers: [{ platform: 'youtube', label: 'YouTube', clientConfigured: true, connected: false, expiresAt: null, refreshable: false, needsReconnect: false, detail: 'fixture', redirectUri: 'http://127.0.0.1:38471/oauth/youtube/callback', pending: false, publishingAuthorized: false, publishingScopes: [], tiktokAuditDeclared: false }] };
  if (command === 'oauth_begin_login') { assert.deepEqual(args, { platform: 'youtube' }); return null; }
  if (command === 'open_external') return null;
  throw new Error(`Unexpected fixture command: ${command}`);
});
await page.addInitScript(() => {
  const callbacks = new Map(), events = new Map(); let nextCallback = 1;
  window.__qaBrowserEvent = payload => {
    for (const handler of events.get('browser-runtime-error') ?? []) callbacks.get(handler)?.({ event: 'browser-runtime-error', id: handler, payload });
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback: callback => { const id = nextCallback++; callbacks.set(id, callback); return id; },
    unregisterCallback: id => callbacks.delete(id),
    invoke: (command, args) => {
      if (command === 'plugin:event|listen') { events.set(args.event, [...(events.get(args.event) ?? []), args.handler]); return Promise.resolve(args.handler); }
      if (command === 'plugin:event|unlisten') { events.set(args.event, (events.get(args.event) ?? []).filter(handler => handler !== args.eventId)); return Promise.resolve(null); }
      return window.__qaInvoke(command, args);
    }
  };
});
page.on('pageerror', error => errors.push(error.message));
async function settings() {
  await page.getByRole('button', { name: '연결 설정', exact: true }).first().click();
  const panel = page.getByRole('region', { name: '링크를 여는 브라우저', exact: true });
  await panel.waitFor({ timeout: 5000 });
  await panel.getByRole('radio', { name: 'Playwright 전용 브라우저', exact: true }).waitFor();
  return panel;
}
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.__qaBrowserEvent('private https://example.test/?code=do-not-render'));
  await page.getByRole('alert').filter({ hasText: '브라우저 종료를 확인하지 못했습니다' }).waitFor({ timeout: 5000 });
  assert.equal(await page.getByText('do-not-render', { exact: false }).count(), 0);
  let panel = await settings();
  const pw = () => panel.getByRole('radio', { name: 'Playwright 전용 브라우저', exact: true });
  const system = () => panel.getByRole('radio', { name: '시스템 기본 브라우저', exact: true });
  const save = () => panel.getByRole('button', { name: '브라우저 설정 저장', exact: true });
  assert.equal(await pw().isChecked(), true);
  await panel.getByText('저장된 선택', { exact: true }).waitFor();
  await panel.getByText('실제 사용할 브라우저', { exact: true }).waitFor();
  assert.equal(await save().isDisabled(), true);
  await system().check();
  await panel.getByRole('button', { name: '브라우저 상태 확인', exact: true }).click();
  await panel.getByRole('button', { name: '브라우저 상태 확인', exact: true }).waitFor();
  assert.equal(await system().isChecked(), true, 'status refresh must preserve the unsaved choice');
  failSave = true;
  await save().click();
  await panel.getByRole('alert').filter({ hasText: '저장하지 못했습니다' }).waitFor();
  assert.equal(await system().isChecked(), true);
  assert.equal(preference, 'playwright');
  assert.equal(await page.getByText('do-not-render', { exact: false }).count(), 0);
  failSave = false;
  releaseSave = 'defer';
  const beforeSave = calls.filter(call => call.command === 'save_browser_preferences').length;
  await save().click();
  await panel.getByRole('button', { name: '브라우저 설정 저장 중', exact: true }).waitFor();
  assert.equal(await system().isDisabled(), true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal(calls.filter(call => call.command === 'save_browser_preferences').length, beforeSave + 1);
  assert.equal(typeof releaseSave, 'function');
  releaseSave(); releaseSave = null;
  await panel.getByText('브라우저 설정을 저장했습니다.', { exact: true }).waitFor();
  assert.equal(preference, 'system');
  assert.equal(await save().isDisabled(), true);
  await page.reload({ waitUntil: 'networkidle' });
  panel = await settings();
  assert.equal(await system().isChecked(), true, 'reload must restore the persisted system preference');
  available = false; reason = '이 운영체제에서는 Playwright를 사용할 수 없습니다.';
  await pw().check(); await save().click();
  await panel.getByText(reason, { exact: true }).waitFor();
  const effective = panel.locator('dl > div').filter({ has: page.getByText('실제 사용할 브라우저', { exact: true }) });
  await effective.getByText('시스템 기본 브라우저', { exact: true }).waitFor();
  assert.equal(await pw().isChecked(), true, 'fallback must not replace the saved preference');
  deferRead = true;
  await panel.getByRole('button', { name: '브라우저 상태 확인', exact: true }).click();
  assert.equal(typeof releaseRead, 'function');
  phase = 'recovery_required'; reason = '브라우저 종료를 확인하지 못했습니다.';
  await page.evaluate(() => window.__qaBrowserEvent('private https://example.test/?code=do-not-render'));
  releaseRead(); releaseRead = null;
  await panel.getByText('복구 확인 필요', { exact: true }).waitFor({ timeout: 5000 });
  await panel.getByText(/전용 브라우저의 재실행이 차단/).waitFor();
  failRead = true;
  await panel.getByRole('button', { name: '브라우저 상태 확인', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: '상태를 확인하지 못했습니다' }).waitFor();
  assert.equal(await page.getByText('do-not-render', { exact: false }).count(), 0);
  failRead = false;
  await page.setViewportSize({ width: 820, height: 720 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.getByRole('button', { name: 'SNS 로그인', exact: true }).click();
  await page.getByRole('button', { name: '브라우저에서 로그인', exact: true }).click();
  await page.getByText('시스템 기본 브라우저에서 로그인을 완료하세요.', { exact: false }).waitFor();
  assert.equal(calls.filter(call => call.command === 'oauth_begin_login').length, 1);
  assert.equal(await page.getByRole('button', { name: 'Aside로 로그인', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['Playwright default', 'saved and effective choices', 'preserved draft on refresh', 'save failure and redacted error', 'serialized save with disabled controls', 'persisted preference after reload', 'unsupported OS fallback', 'recovery state', 'read failure', '820px no overflow', 'OAuth system-only IPC'], adapter: 'Chromium real desktop UI; native IPC fixture only' }, null, 2));
} finally { await browser.close(); await server.close(); }
