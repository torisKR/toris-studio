import { createFixtureServer, shellFixture, unhandled } from './ui-fixture-helpers.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// UI interaction checks with isolated IPC fixtures. No vault/account/provider call.
const output = '/private/tmp/toris-desktop-interactions';
await mkdir(output, { recursive: true });
const calls = [], errors = [];
const server = await createFixtureServer({ configFile: resolve('desktop/vite.config.ts'), server: { port: 0, strictPort: false } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1380, height: 960 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('__qaInvoke', async (command, args = {}) => {
    calls.push({ command, args });
    if (command === 'get_dashboard') return { channels: [], content: [], trends: [], integrations: [], database: { connected: false, message: '격리된 UI 검증' } };
    if (command === 'video_list_projects') return [];
    if (command === 'video_template_library_get') return {version:1,favorites:[],recent:[]};
    // This lifecycle fixture deliberately exercises unavailable catalog recovery.
    // verify-video-templates.mjs covers every real Rust recipe separately.
    if (command === 'video_template_catalog') throw new Error('격리된 탐색 fixture의 템플릿 읽기 오류');
    if (command === 'media_status') return { ffmpegAvailable: false, ffprobeAvailable: false, fontAvailable: false };
    if (command === 'set_main_activity') return null;
    const shared=shellFixture(command,args);if(shared!==unhandled)return shared;
    errors.push(`Unexpected fixture IPC ${command}`);throw new Error(`Unexpected native operation in isolated UI test: ${command}`);
  });
  await page.addInitScript(() => {
    const intervals = new Set(), keyListeners = new Set();
    const set = window.setInterval.bind(window), clear = window.clearInterval.bind(window);
    window.setInterval = (...args) => { const id = set(...args); intervals.add(id); return id; };
    window.clearInterval = id => { intervals.delete(id); clear(id); };
    const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
    document.addEventListener = (type, listener, options) => { if (type === 'keydown') keyListeners.add(listener); add(type, listener, options); };
    document.removeEventListener = (type, listener, options) => { if (type === 'keydown') keyListeners.delete(listener); remove(type, listener, options); };
    window.__qaResources = () => ({ intervals: intervals.size, keyListeners: keyListeners.size });
    window.__TAURI_INTERNALS__ = { invoke: (command, args) => window.__qaInvoke(command, args) };
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '메뉴 검색 · Ctrl 또는 Command K', exact: true }).waitFor();
  assert.equal(calls.filter(call => call.command === 'get_dashboard').length, 1, 'StrictMode must share the native snapshot read');
  assert.equal((await page.evaluate(() => window.__qaResources())).keyListeners, 1, 'one live menu shortcut listener');
  await page.keyboard.press('Control+k');
  const menu = page.getByRole('dialog', { name: '어디로 이동할까요?' });
  await menu.waitFor();
  const search = menu.getByRole('combobox', { name: '화면 이름 검색' });
  await search.fill('영상');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: '영상·모션', exact: true }).waitFor();
  await page.getByText('격리된 탐색 fixture의 템플릿 읽기 오류',{exact:true}).waitFor();
  await page.keyboard.press('Meta+k');
  await menu.waitFor();
  await search.fill('없는 화면');
  await menu.getByText('일치하는 메뉴가 없습니다.', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.desktop-native-activity'));
  const baseline = await page.evaluate(() => window.__qaResources());
  for (let iteration = 0; iteration < 20; iteration++) {
    await page.keyboard.press('Control+k');
    await search.fill(iteration % 2 ? '영상' : 'SNS 관리');
    await page.keyboard.press('Enter');
  }
  await page.waitForFunction(() => !document.querySelector('.desktop-native-activity'));
  const after = await page.evaluate(() => window.__qaResources());
  assert.equal(after.keyListeners, baseline.keyListeners, 'tab/menu cycles must not accumulate shortcut listeners');
  assert.equal(after.intervals, baseline.intervals, 'tab/menu cycles must not accumulate intervals (Vite may own a development heartbeat)');
  await page.setViewportSize({ width: 820, height: 720 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'minimum desktop width must not overflow');
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: false });
  assert.deepEqual(errors, []);
  assert.equal(calls.some(call => /upload|submit|keychain/.test(call.command)||call.command==='oauth_connection_dispatch'), false);
  const report = { mode: 'Chromium with isolated IPC fixtures; native OS window/progress is not exercised', menuCycles: 20, strictModeSnapshotCalls: calls.filter(call => call.command === 'get_dashboard').length, baseline, after, errors, screenshot: `${output}/desktop.png` };
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await server.close();
}
