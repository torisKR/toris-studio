import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Read-only preview UI with an inert media response. Native OS creation and
// WebKit MP4 decoding require a separate desktop run; this proves UI isolation.
const output = '/private/tmp/toris-native-preview';
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: resolve('desktop/vite.config.ts'), server: { port: 0, strictPort: false } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1040, height: 760 }, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [], appLoads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/src\/App\.tsx/.test(request.url())) appLoads.push(request.url()); });
  await page.route('**/__qa_preview/**', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.addInitScript(() => {
    const listeners = new Map();
    const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
    const tracked = new Set(['beforeunload', 'toris-native-preview-change']);
    window.addEventListener = (type, callback, options) => {
      if (tracked.has(type)) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); }
      add(type, callback, options);
    };
    window.removeEventListener = (type, callback, options) => { listeners.get(type)?.delete(callback); remove(type, callback, options); };
    let invokes = 0, resets = 0;
    const load = HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load = function () { resets += 1; return load.call(this); };
    window.__TAURI_INTERNALS__ = {
      invoke: () => { invokes += 1; throw new Error('Preview must not invoke native commands'); },
      convertFileSrc: (key, protocol) => {
        if (protocol !== 'toris-preview') throw new Error('Unexpected preview protocol');
        return `${location.origin}/__qa_preview/${key}`;
      }
    };
    window.__TORIS_RENDER_PREVIEW__ = { key: 'a'.repeat(32), title: 'MP4 · aaaaaaaa', fileSize: 4096 };
    window.__qaPreview = () => ({ invokes, resets, listeners: Object.fromEntries([...listeners].map(([key, value]) => [key, value.size])) });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'MP4 · aaaaaaaa' }).waitFor();
  const baseline = await page.evaluate(() => window.__qaPreview());
  assert.equal(baseline.listeners['toris-native-preview-change'], 1);
  // Vite also registers a development beforeunload listener. Reuse must retain
  // exactly the baseline set, including that server-owned listener.
  assert.ok(baseline.listeners.beforeunload >= 1);
  for (let iteration = 0; iteration < 20; iteration++) {
    const key = (iteration + 1).toString(16).padStart(32, '0');
    await page.evaluate(({ key, iteration }) => {
      window.__TORIS_RENDER_PREVIEW__ = { key, title: `MP4 · fixture ${iteration}`, fileSize: 4096 };
      window.dispatchEvent(new Event('toris-native-preview-change'));
    }, { key, iteration });
    await page.waitForFunction(key => document.querySelector('video')?.getAttribute('src')?.endsWith(key), key);
  }
  const after = await page.evaluate(() => window.__qaPreview());
  assert.deepEqual(after.listeners, baseline.listeners);
  assert.equal(after.invokes, 0);
  assert.equal(appLoads.length, 0, 'the preview must not mount/load workspace background work');
  assert.equal(after.resets - baseline.resets, 40, 'each replacement resets the old media source and loads the new one');
  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
  assert.equal(await page.locator('video').getAttribute('src'), null);
  await page.setViewportSize({ width: 480, height: 420 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: `${output}/preview.png` });
  assert.deepEqual(errors, []);
  const report = { mode: 'Chromium with inert local media fixtures; no native OS playback claim', previewReuses: 20, baseline, after, appLoads: appLoads.length, errors, screenshot: `${output}/preview.png` };
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await context.close();
} finally {
  await browser?.close();
  await server.close();
}
