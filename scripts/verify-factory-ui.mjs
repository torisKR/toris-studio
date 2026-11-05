// Factory console check in Chromium. Preview does not call a model. A blocked gate is not a pass.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createFixtureServer, openSection, shellFixture, unhandled } from './ui-fixture-helpers.mjs';

const out = resolve(process.env.TORIS_QA_OUT ?? '/tmp/toris-factory-ui');
await mkdir(out, { recursive: true });
const spec = {
  title: '무협 로그라이트', slug: 'wuxia-roguelite', kind: 'game',
  target: { engine: 'godot', view: '2d' },
  design: { genre: '로그라이트', artStyle: '도트', orientation: 'landscape' },
  features: ['공격', '회피'], assets: { characters: 1, maps: 1, vfx: 1, models: 0 },
  acceptance: ['게임오버'], limits: { maxApiCostUsd: 5 },
};
const preview = {
  template: true, provider: '', model: '', spec, project: 'wuxia-roguelite',
  jobs: [
    { taskId: 'spec-approved', status: 'queued', message: '규칙으로 만든 명세입니다.', approval: 'automatic', deps: [] },
    { taskId: 'android-debug-build', status: 'queued', message: '의존: 헤드리스 검사', approval: 'automatic', deps: ['spec-approved'] },
  ],
  gates: [
    { name: 'android', status: 'not_run', detail: '실행하지 않은 검사는 통과가 아닙니다.', required: true },
    { name: 'asset', status: 'not_run', detail: '에셋 도구를 실행하지 않았습니다.', required: true },
  ],
  verdict: 'incomplete', costUsd: 0, problems: [], notes: ['미리보기는 규칙으로 만든 명세입니다.'],
};
const started = {
  ...preview,
  jobs: preview.jobs.map(job => job.taskId === 'android-debug-build' ? { ...job, status: 'blocked', message: '도구를 실행하지 않았습니다: godot_build_debug' } : { ...job, status: 'passed', message: '명세를 확인했습니다.' }),
  gates: [
    { name: 'plan', status: 'passed', detail: '명세를 확인했습니다.', required: true },
    { name: 'android', status: 'blocked', detail: '도구를 실행하지 않았습니다: godot_build_debug', required: true },
    { name: 'asset', status: 'not_run', detail: '에셋 도구를 실행하지 않았습니다.', required: true },
  ],
};
const server = await createFixtureServer({ server: { port: 0, strictPort: false } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const report = { checks: [], errors: [] };
const calls = [];
try {
  const page = await browser.newPage({ viewport: { width: 1380, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.exposeFunction('__qaInvoke', async (command, args = {}) => {
    calls.push({ command, args });
    if (command === 'get_dashboard') return { channels: [], content: [], trends: [], integrations: [], database: { connected: true, message: 'QA' } };
    if (command === 'factory_preview') return preview;
    if (command === 'factory_start') return { runId: 'run-1', workflow: 'game-factory', project: '', task: '팩토리', phase: 'done', agent: 'supervisor', summary: JSON.stringify(started), approvals: [], events: [], changes: [], createdAt: '', updatedAt: '' };
    if (command === 'factory_jobs') return { jobs: [] };
    if (command === 'factory_status') return null;
    const shared = shellFixture(command, args);
    if (shared !== unhandled) return shared;
    return null;
  });
  await page.addInitScript(() => {
    const callbacks = new Map();
    let next = 1;
    window.__TAURI_INTERNALS__ = { transformCallback: cb => { const id = next++; callbacks.set(id, cb); return id; }, unregisterCallback: id => callbacks.delete(id), invoke: async (command, args) => window.__qaInvoke(command, args) };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  const port = server.httpServer.address().port;
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
  await openSection(page, '제작', '앱·게임');
  const factory = page.getByRole('region', { name: '앱·게임 팩토리' });
  await factory.getByRole('textbox', { name: '제작 요청', exact: true }).waitFor();
  await factory.getByRole('button', { name: '명세 미리보기' }).click();
  await factory.getByRole('button', { name: 'Android 대기' }).click();
  await factory.getByText('의존: 헤드리스 검사').waitFor();
  await factory.locator('.factory-gate.not_run', { hasText: 'Android' }).waitFor();
  assert.equal(await factory.locator('.factory-gate.passed').count(), 0, 'preview must not paint an unrun gate as passed');
  report.checks.push('preview draws the DAG and leaves Android unrun');
  await factory.getByRole('button', { name: '팩토리 시작' }).click();
  await factory.getByRole('button', { name: 'Android 차단' }).click();
  await factory.getByRole('region', { name: '작업 DAG' }).getByText('도구를 실행하지 않았습니다: godot_build_debug').waitFor();
  await factory.locator('.factory-gate.blocked', { hasText: 'Android' }).waitFor();
  assert.equal(await factory.locator('.factory-gate[data-status="blocked"]', { hasText: 'Android' }).count(), 1);
  assert.equal(await factory.locator('.factory-gate.not_run.passed, .factory-gate.blocked.passed').count(), 0);
  report.checks.push('after start, a blocked Android gate is not a pass');
  await factory.getByRole('textbox', { name: '앱 제작 의견', exact: true }).fill('화면은 더 단순하게');
  await factory.getByText('기록만 하기', { exact: true }).click();
  await factory.getByRole('button', { name: '명세 미리보기' }).click();
  const recorded = calls.filter(call => call.command === 'factory_preview').at(-1);
  assert.equal(recorded.args.input.opinion, '화면은 더 단순하게');
  assert.equal(recorded.args.input.applyOpinion, false);
  await factory.getByText('기획에 반영', { exact: true }).click();
  await factory.getByRole('button', { name: '명세 미리보기' }).click();
  const applied = calls.filter(call => call.command === 'factory_preview').at(-1);
  assert.equal(applied.args.input.applyOpinion, true);
  const radio = await factory.getByRole('radio', { name: '기록만 하기' }).evaluate(node => {
    const text = [...node.parentElement.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
    const range = document.createRange();
    range.selectNodeContents(text);
    const textBox = range.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return { width: box.width, height: box.height, gap: textBox.x - box.right };
  });
  assert.ok(radio.width <= 20 && radio.height <= 20 && radio.gap >= 0 && radio.gap < 24, 'the record-only choice sits beside its radio');
  report.checks.push('opinion can be recorded or applied, and the choice is sent with the preview');
  await page.screenshot({ path: resolve(out, 'factory-console.png'), fullPage: true });
  if (report.errors.length) throw new Error(report.errors.join('\n'));
  console.log(report.checks.join('\n'));
} finally {
  await browser.close();
  await server.close();
}
