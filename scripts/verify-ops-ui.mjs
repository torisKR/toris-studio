// Ops tab check in Chromium with explicit IPC fixtures. No DB, tokens or network.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFixtureServer, shellFixture, unhandled, openSection } from './ui-fixture-helpers.mjs';
import { chromium } from 'playwright';

const out = resolve(process.env.TORIS_QA_OUT ?? '/private/tmp/toris-ops-ui'); await mkdir(out, { recursive: true });
const report = { adapter: 'Chromium with explicit IPC fixtures; no database, credentials or network', checks: [], errors: [] };
const ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
const snap = (source, state, summary, minutes = 5, detail = {}) => ({ source, state, summary, detail, observedAt: ago(minutes) });
let products = [
  { id: 'p1', name: 'Toris 앱', kind: 'app', githubRepo: 'torisKR/toris_app', cloudflareWorker: null, cloudflarePages: null, healthUrl: null, playPackage: 'com.toris.app', statuses: [
    snap('play', 'in_review', 'production · 1.2.0 (4) 심사 중(미공개)'), snap('github_ci', 'passing', 'Android 통과'), snap('github_release', 'draft', 'v1.2.0 초안(미공개)') ] },
  { id: 'p2', name: 'toris.kr', kind: 'web', githubRepo: null, cloudflareWorker: 'toris-site', cloudflarePages: null, healthUrl: 'https://toris.kr/health', playPackage: null, statuses: [
    snap('cloudflare', 'deployed', 'Worker 최신 배포가 트래픽을 받고 있습니다.'), snap('http', 'unhealthy', 'HTTP 503 · 120ms', 120) ] },
];
let secrets = { github_token: true, cloudflare_token: false, cloudflare_account: true, play_service_account: false };
let cliStatus = { gh: { installed: true, signedIn: true }, cf: { installed: true, signedIn: false }, wrangler: { installed: false, signedIn: null } };
const cliLogins = [];
const calls = [];
const server = await createFixtureServer({ server: { port: 0, strictPort: false } }); await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1380, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.exposeFunction('__qaInvoke', async (command, args = {}) => {
    calls.push({ command, args });
    if (command === 'get_dashboard') return { channels: [], content: [], trends: [], integrations: [], database: { connected: true, message: 'QA' } };
    if (command === 'ops_overview') return { products, secrets };
    if (command === 'ops_cli_status') return cliStatus;
    if (command === 'agent_cli_login') { cliLogins.push(args); return { started: true }; }
    if (command === 'ops_refresh') return { snapshots: 5 };
    if (command === 'ops_open_task') return { id: 'w1' };
    if (command === 'ops_save_secret') { secrets = { ...secrets, [args.kind]: args.value !== null }; return secrets; }
    if (command === 'ops_save_product') { const input = args.input; products = [...products, { id: 'p3', statuses: [], ...input }]; return { id: 'p3' }; }
    if (command === 'ops_delete_product') { products = products.filter(p => p.id !== args.id); return null; }
    if (command === 'planner_today') return { events: [], work: [], openConflicts: 0, calendar: { linked: false, lastSyncedAt: null, lastError: null } };
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
  await openSection(page, '운영', '운영 상태');
  const ops = page.getByRole('region', { name: '운영 상태' });
  await ops.getByRole('heading', { name: 'Toris 앱' }).waitFor();
  const app = ops.locator('li.ops-card', { has: page.getByRole('heading', { name: 'Toris 앱' }) });
  assert.deepEqual(await app.locator('.ops-source').allTextContents(), ['GitHub CI', 'GitHub 릴리스', 'Google Play'], 'sources are ordered CI, release, store');
  assert.deepEqual(await app.locator('.ops-state').allTextContents(), ['CI 통과', '초안', '심사 중 · 미공개']);
  assert.equal(await app.getByText('공개', { exact: true }).count(), 0, 'nothing in review or draft is shown as public');
  const site = ops.locator('li.ops-card', { has: page.getByRole('heading', { name: 'toris.kr' }) });
  assert.deepEqual(await site.locator('.ops-state').allTextContents(), ['배포됨', '응답 이상'], 'deployed and unhealthy are shown side by side');
  await site.getByText('오래됨').waitFor();
  await ops.getByText('확인 필요 1').waitFor();
  assert.equal(await app.getByRole('button', { name: /작업 만들기/ }).count(), 0, 'healthy or pending states offer no task');
  report.checks.push('CI passing, release draft, Play in review, deployed and unhealthy keep separate labels; stale snapshot is marked');

  await site.getByRole('button', { name: 'toris.kr 헬스체크 작업 만들기' }).click();
  await ops.getByText('헬스체크 작업을 일정·작업에 열었습니다', { exact: false }).waitFor();
  assert.deepEqual(calls.findLast(c => c.command === 'ops_open_task').args, { product: 'p2', source: 'http' });
  await ops.getByRole('button', { name: '일정·작업 열기' }).click();
  await page.getByRole('region', { name: '일정과 작업' }).waitFor();
  await openSection(page, '운영', '운영 상태');
  report.checks.push('A failing source becomes a planner task and the notice links to the planner');

  await ops.getByRole('button', { name: /연결 설정/ }).click();
  const settings = page.getByRole('region', { name: '운영 연결 설정' });
  await settings.getByLabel('Cloudflare 계정 ID').fill('0123456789abcdef0123456789abcdef');
  await settings.locator('form', { hasText: 'Cloudflare 계정 ID' }).getByRole('button', { name: '저장' }).click();
  await ops.getByRole('status').filter({ hasText: 'Cloudflare 계정 ID 저장됨' }).waitFor();
  assert.equal(await settings.getByLabel('Cloudflare 계정 ID').inputValue(), '', 'the field is cleared after saving');
  assert.equal(await settings.getByLabel('Cloudflare 계정 ID').getAttribute('type'), 'password');
  assert.equal(await page.content().then(html => html.includes('0123456789abcdef0123456789abcdef')), false, 'the value is not left in the DOM');
  report.checks.push('Secrets are write-only: masked input, cleared after save, only the saved flag comes back');

  await ops.getByRole('button', { name: '제품 추가' }).click();
  const dialog = page.getByRole('dialog', { name: '제품 추가' });
  await dialog.getByLabel('이름').fill('메모 서비스');
  await dialog.getByLabel(/헬스체크 주소/).fill('http://example.com');
  await dialog.getByRole('button', { name: '저장' }).click();
  await dialog.getByText('https://로 시작해야', { exact: false }).waitFor();
  assert.equal(calls.filter(c => c.command === 'ops_save_product').length, 0, 'invalid input never reaches IPC');
  await dialog.getByLabel(/헬스체크 주소/).fill('https://memo.example.com/health');
  await dialog.getByRole('button', { name: '저장' }).click();
  await ops.getByRole('heading', { name: '메모 서비스' }).waitFor();
  assert.deepEqual(Object.keys(calls.findLast(c => c.command === 'ops_save_product').args.input).sort(), ['cloudflarePages', 'cloudflareWorker', 'githubRepo', 'healthUrl', 'kind', 'name', 'playPackage']);
  await ops.locator('li.ops-card', { hasText: '메모 서비스' }).getByText('아직 확인하지 않았습니다', { exact: false }).waitFor();
  report.checks.push('Product form validates before IPC and sends only allowed fields');

  // GitHub and Cloudflare come from the user's own gh/cf login; only Cloudflare account ID and Play key are typed.
  const conn = ops.getByRole('region', { name: '운영 연결 설정' });
  await conn.getByText('gh 로그인됨').waitFor();
  await conn.getByText('cf 로그인 필요').waitFor();
  assert.equal(await conn.getByLabel('GitHub 토큰').count(), 0, 'no GitHub token input');
  assert.equal(await conn.getByLabel('Cloudflare 토큰').count(), 0, 'no Cloudflare token input');
  await conn.getByLabel('Cloudflare 계정 ID').waitFor();
  await conn.getByRole('button', { name: 'cf 로그인' }).click();
  assert.deepEqual(cliLogins, [{ tool: 'cf' }]);
  cliStatus = { ...cliStatus, cf: { installed: true, signedIn: true } };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await conn.getByText('cf 로그인됨').waitFor();
  await conn.getByRole('button', { name: '저장된 GitHub 토큰 삭제' }).click();
  assert.deepEqual(calls.findLast(c => c.command === 'ops_save_secret').args, { kind: 'github_token', value: null });
  await conn.getByRole('button', { name: '저장된 GitHub 토큰 삭제' }).waitFor({ state: 'detached' });
  report.checks.push('Ops: gh/cf login state with login buttons; no token inputs; a legacy saved token can only be deleted');

  await ops.getByRole('button', { name: '지금 확인' }).click();
  await ops.getByText('상태 5건을 새로 확인했습니다.').waitFor();
  await ops.getByRole('button', { name: '메모 서비스 삭제' }).click();
  await ops.getByRole('heading', { name: '메모 서비스' }).waitFor({ state: 'detached' });
  report.checks.push('Manual refresh and delete round-trip through IPC');
  await page.screenshot({ path: resolve(out, 'ops.png'), fullPage: true });
  await page.setViewportSize({ width: 600, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no horizontal overflow at 600px');
  await page.screenshot({ path: resolve(out, 'ops-narrow.png'), fullPage: true });
  report.checks.push('No horizontal overflow at 600px');
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} finally { await writeFile(resolve(out, 'verification.json'), JSON.stringify(report, null, 2)); await browser.close(); await server.close(); }
