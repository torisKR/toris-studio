#!/usr/bin/env node
// Runs the packaged-app startup check (desktop/src-tauri/src/startup_smoke.js) verbatim in WebKit
// against freshly built desktop assets, without packaging the app. The native check only runs in
// installer CI, so a new startup IPC that the isolated fixture does not answer used to surface only
// after a full release build. This applies the same pass rules as `valid()` in startup_smoke.rs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'desktop/dist');
const RESULT_TIMEOUT_MS = 30_000;

/** Reads a `const NAME: [&str; N] = [...]` list from the Rust check so both sides use one source. */
export function rustList(source, name) {
  const match = source.match(new RegExp(`const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`));
  if (!match) throw new Error(`startup_smoke.rs has no ${name} list`);
  return [...match[1].matchAll(/"([^"]*)"/g)].map(found => found[1]);
}
/** Keys of the Rust `native_fixtures()` JSON, which the script below must mirror. */
export function rustNativeFixtureKeys(source) {
  const body = source.match(/fn native_fixtures\(\)[\s\S]*?serde_json::json!\(\{([\s\S]*?)\}\)\s*\n\}/)?.[1];
  if (!body) throw new Error('startup_smoke.rs has no native_fixtures() JSON');
  return [...body.matchAll(/^\s*"([a-z_]+)":/gm)].map(found => found[1]).sort();
}
export function jsList(source, name) {
  const match = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  if (!match) throw new Error(`startup_smoke.js has no ${name} list`);
  return [...match[1].matchAll(/'([^']*)'/g)].map(found => found[1]);
}

/** Same rules as `valid()` in startup_smoke.rs. Returns the reasons it fails (empty when it passes). */
export function problems(result, { navigation, reads }) {
  const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const out = [];
  if (JSON.stringify(result.navigation) !== JSON.stringify(navigation)) out.push(`주 메뉴 ${JSON.stringify(result.navigation)}`);
  if (!result.sns) out.push('SNS 관리 화면 없음');
  if (!result.noBoundary) out.push('시작 오류 화면');
  if (!result.settingsLoaded) out.push('설정 화면이 다 열리지 않음');
  if (result.failures.length) out.push(`실패 ${JSON.stringify(result.failures)}`);
  if (JSON.stringify(result.reads) !== JSON.stringify(reads)) out.push(`읽기 ${JSON.stringify(result.reads)} ≠ ${JSON.stringify(reads)}`);
  if (!isoDate(result.from) || !isoDate(result.to) || result.from > result.to) out.push(`분석 기간 ${result.from}~${result.to}`);
  return out;
}

// Mirrors native_fixtures() in startup_smoke.rs: default settings, idle scheduler/browser/update.
function nativeFixtures(version) {
  return {
    get_settings: { databaseConfigured: false, creationMode: 'remote-desktop-commander', youtubeConfigured: false, naverConfigured: false, savedCollectionKeys: { youtubeApiKey: false, naverClientId: false, naverClientSecret: false }, configPath: '/fixture/settings.json', schedulerEnabled: false },
    get_scheduler_status: { enabled: false, lastSuccessAt: null, nextRunAt: null, lastError: null, running: false },
    get_keychain_status: { blocked: false },
    browser_runtime_status: { preference: 'playwright', effectiveBrowser: 'playwright', available: true, reason: null, phase: 'idle' },
    get_update_status: { revision: 0, configured: true, currentVersion: version, phase: 'idle', availableVersion: null, notes: null, publishedAt: null, downloadedBytes: 0, totalBytes: null, message: 'Isolated native startup fixture', canCancel: false },
  };
}

// The Tauri v2 internals the isolated webview has: invoke goes through __TAURI_INTERNALS__.postMessage,
// which startup_smoke.js itself defines (Tauri's invoke_system). Rejected commands are recorded by name.
const tauriShim = () => {
  const callbacks = new Map();
  let next = 1;
  window.__unexpectedCommands = [];
  window.ipc = { postMessage: text => window.__smokeResult(text) };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback: (callback, once) => { const id = next++; callbacks.set(id, value => { if (once) callbacks.delete(id); return callback?.(value); }); return id; },
    unregisterCallback: id => callbacks.delete(id),
    runCallback: (id, value) => callbacks.get(id)?.(value),
    invoke: (cmd, payload = {}, options) => new Promise((resolve, reject) => {
      const callback = window.__TAURI_INTERNALS__.transformCallback(resolve, true);
      const error = window.__TAURI_INTERNALS__.transformCallback(reason => {
        if (reason === 'Unsupported isolated startup fixture') window.__unexpectedCommands.push(cmd.endsWith('_dispatch') ? `${cmd}:${payload?.input?.action}` : cmd);
        reject(reason);
      }, true);
      window.__TAURI_INTERNALS__.postMessage({ cmd, callback, error, payload, options });
    }),
  };
};

function buildUi() {
  // Always rebuild: a stale desktop/dist would test old screens and pass silently.
  const run = spawnSync('pnpm', ['exec', 'vite', 'build', '--config', 'desktop/vite.config.ts'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  if (run.status !== 0) throw new Error(`데스크톱 화면 빌드(vite build) 실패: exit ${run.status ?? run.signal}`);
}

async function main() {
  const smokeJs = await readFile(path.join(root, 'desktop/src-tauri/src/startup_smoke.js'), 'utf8');
  const smokeRs = await readFile(path.join(root, 'desktop/src-tauri/src/startup_smoke.rs'), 'utf8');
  const config = JSON.parse(await readFile(path.join(root, 'desktop/src-tauri/tauri.conf.json'), 'utf8'));
  const navigation = rustList(smokeRs, 'NAVIGATION');
  const reads = rustList(smokeRs, 'READS');
  // The JS and Rust halves must agree, or the native check can never pass.
  assert.deepEqual(jsList(smokeJs, 'expectedNavigation'), navigation, 'startup_smoke.js와 .rs의 주 메뉴 목록이 다릅니다');
  assert.deepEqual([...jsList(smokeJs, 'expectedReads')].sort(), reads, 'startup_smoke.js와 .rs의 읽기 목록이 다릅니다');
  const fixtures = nativeFixtures(config.version);
  assert.deepEqual(Object.keys(fixtures).sort(), rustNativeFixtureKeys(smokeRs), 'native_fixtures() 키가 이 스크립트와 다릅니다');

  buildUi();
  const files = new Set(await readdir(dist, { recursive: true }));
  if (!files.has('index.html')) throw new Error('desktop/dist/index.html이 없습니다: 화면 빌드 결과를 확인하세요');
  const script = smokeJs.replace('__NATIVE_FIXTURES__', JSON.stringify(fixtures)).replace('__INVOKE_KEY__', JSON.stringify('verify-startup-smoke'));
  assert.ok(!script.includes('__NATIVE_FIXTURES__') && !script.includes('__INVOKE_KEY__'), 'startup_smoke.js 자리표시자를 바꾸지 못했습니다');

  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      const name = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (req.method !== 'GET' || !files.has(name)) throw new Error('Unknown built asset');
      res.setHeader('Content-Security-Policy', config.app.security.csp);
      res.setHeader('Content-Type', types[path.extname(name)] ?? 'application/octet-stream');
      res.end(await readFile(path.join(dist, name)));
    } catch { res.writeHead(404); res.end(); }
  });
  let browser;
  const started = Date.now();
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await webkit.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1380, height: 900 }, locale: 'ko-KR' });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const missingAssets = [];
    page.on('response', response => { if (response.status() >= 400) missingAssets.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
    let resolveResult;
    const resultText = new Promise(resolve => { resolveResult = resolve; });
    await page.exposeFunction('__smokeResult', text => resolveResult(text));
    await page.addInitScript(tauriShim);
    await page.addInitScript(script);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('시작 검사 결과가 오지 않았습니다')), RESULT_TIMEOUT_MS); });
    const text = await Promise.race([resultText, timeout]).finally(() => clearTimeout(timer));
    const message = JSON.parse(text);
    assert.equal(message.cmd, 'startup_smoke_result');
    const result = message.payload.result;
    const unexpected = await page.evaluate(() => window.__unexpectedCommands);
    const found = problems(result, { navigation, reads });
    if (unexpected.length) found.push(`고정 응답이 없는 시작 IPC: ${[...new Set(unexpected)].join(', ')}`);
    if (pageErrors.length) found.push(`페이지 오류: ${pageErrors.join(' | ')}`);
    if (missingAssets.length) found.push(`열리지 않는 자원(desktop/dist에 없음): ${[...new Set(missingAssets)].join(', ')}`);
    assert.deepEqual(found, [], `네이티브 시작 검사(startup_smoke.js)가 실패합니다:\n- ${found.join('\n- ')}`);
    console.log(JSON.stringify({ browser: 'WebKit', script: 'desktop/src-tauri/src/startup_smoke.js', passed: true, reads: result.reads, navigation: result.navigation, seconds: Math.round((Date.now() - started) / 1000) }, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
