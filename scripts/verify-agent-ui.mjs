// Agent tab UI check in Chromium with explicit IPC fixtures. No model, file write or command runs.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const out = resolve(process.env.TORIS_QA_OUT ?? '/private/tmp/toris-agent-ui'); await mkdir(out, { recursive: true });
const report = { adapter: 'Chromium with explicit IPC fixtures; no model, file write or command execution', checks: [], errors: [] };
const providers = [
  { id: 'codex-cli', label: 'Codex CLI', kind: 'subscription', plan: 'ChatGPT Plus·Pro 구독', available: true, detail: 'codex-cli 0.164.0', suggestedModels: [] },
  { id: 'openai', label: 'OpenAI API', kind: 'api', available: false, detail: 'API 키 미등록', suggestedModels: ['gpt-5'] },
  { id: 'ollama', label: 'Ollama (로컬)', kind: 'local', available: false, detail: '꺼짐', suggestedModels: [] },
];
let settings = { projectsRoot: '/Users/qa/projects', ollamaUrl: 'http://127.0.0.1:11434', agentModel: { provider: 'codex-cli', model: '' }, contentModel: null, image: null, embedding: { provider: 'local', model: '' } };
let keys = { anthropic: false, openai: false, google: false, openrouter: false };
const saved = [], decisions = [], started = [];
const run = { runId: 'run-qa', project: 'demo-shop', task: '', phase: 'queued', agent: 'supervisor', createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z', pending: null, changes: [], summary: '', events: [] };
const approval = { kind: 'write_file', id: 'act-1', agent: 'backend', path: 'src/cart.ts', reason: '합계 계산 버그 수정', diff: '--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1,3 +1,3 @@\n export function total(items) {\n-  return items.length;\n+  return items.reduce((s, i) => s + i.price, 0);\n }\n' };
const ev = (seq, agent, phase, message, extra = {}) => ({ event: 'run', runId: 'run-qa', seq, at: `2026-10-27T00:00:0${seq}Z`, agent, phase, message, ...extra });

const server = await createServer({ configFile: resolve('desktop/vite.config.ts'), server: { port: 0, strictPort: false } }); await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1380, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', e => report.errors.push(e.message));
  const emit = payload => page.evaluate(p => window.__qaEmit('agent-event', p), payload);
  await page.exposeFunction('__qaInvoke', async (command, args = {}) => {
    if (command === 'get_dashboard') return { channels: [], content: [], trends: [], integrations: [], database: { connected: true, message: 'QA' } };
    if (command === 'ai_status') return { providers, contentModel: settings.contentModel, agentModel: settings.agentModel, image: settings.image };
    if (command === 'agent_settings_get') return { settings, keys, chromaUrl: 'http://127.0.0.1:18765' };
    if (command === 'agent_settings_save') { saved.push(args.input); settings = args.input.settings; for (const [k, v] of Object.entries(args.input.keys)) keys[k] = Boolean(v); return { settings, keys, chromaUrl: 'http://127.0.0.1:18765' }; }
    if (command === 'agent_call') {
      const { method, params } = args;
      if (method === 'status') return { version: '0.1.0', providers, chroma: true, projectsRoot: settings.projectsRoot };
      if (method === 'projects.list') return { projects: [{ name: 'demo-shop', path: '/Users/qa/projects/demo-shop', stacks: ['node', 'nextjs'], scripts: { test: 'vitest' }, git: true }, { name: 'rust-cli', path: '/Users/qa/projects/rust-cli', stacks: ['rust'], scripts: {}, git: true }] };
      if (method === 'run.list') return { runs: [] };
      if (method === 'index.status') return { indexed: true, chunks: 128, stale: false, embedder: 'local-hash-v1-768', chroma: true };
      if (method === 'models.list') return { models: [] };
      if (method === 'run.start') {
        started.push(params);
        // The runtime streams events before run.start returns; the panel must not drop them.
        await page.evaluate(p => window.__qaEmit('agent-event', p), ev(2, 'supervisor', 'thinking', 'Backend Expert에게 배정했습니다.'));
        return { ...run, task: params.task, events: [ev(1, 'supervisor', 'queued', '작업을 시작합니다.')] };
      }
      if (method === 'run.resume') { decisions.push(params); return { ...run, task: started[0].task, phase: 'coding', agent: 'backend', events: [] }; }
      if (method === 'run.get') return run;
    }
    if (command.startsWith('plugin:event|')) return 1;
    return null;
  });
  await page.addInitScript(() => {
    const callbacks = new Map(); let next = 1; const listeners = [];
    window.__qaEmit = (event, payload) => { for (const l of listeners) if (l.event === event) callbacks.get(l.handler)?.({ event, id: 1, payload }); };
    window.__TAURI_INTERNALS__ = {
      transformCallback: cb => { const id = next++; callbacks.set(id, cb); return id; },
      unregisterCallback: id => callbacks.delete(id),
      invoke: async (command, args) => { if (command === 'plugin:event|listen') listeners.push({ event: args.event, handler: args.handler }); return window.__qaInvoke(command, args); },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('heading', { name: '에이전트 작업 보드' }).waitFor();
  assert.equal(await page.getByText('코딩', { exact: true }).count(), 0, 'old coding menu removed');
  assert.equal(await page.getByText(/Codexify/).count(), 0);
  report.checks.push('Agent tab replaces the coding menu; no Codexify text remains');

  await page.getByRole('option', { name: /demo-shop/ }).getByRole('button').click();
  await page.getByText('색인됨 · 청크 128개').waitFor();
  await page.getByLabel('에이전트 작업 지시').fill('장바구니 합계 계산을 고쳐줘');
  await page.getByRole('button', { name: '에이전트 시작' }).click();
  await page.getByText('장바구니 합계 계산을 고쳐줘', { exact: true }).first().waitFor();
  assert.deepEqual(started, [{ project: 'demo-shop', task: '장바구니 합계 계산을 고쳐줘' }]);
  await page.locator('.agent-timeline', { hasText: 'Backend Expert에게 배정했습니다.' }).waitFor({ timeout: 3000 });
  report.checks.push('Events streamed before run.start returns are kept, not dropped');
  await emit(ev(3, 'backend', 'reading', '파일을 읽고 있습니다.', { detail: 'src/cart.ts' }));
  await emit(ev(4, 'backend', 'awaiting_approval', 'src/cart.ts 변경 승인을 기다립니다.', { approval }));
  const card = page.getByRole('region', { name: '승인 요청' });
  await card.waitFor();
  assert.equal(await card.locator('.diff-add').count(), 1);
  assert.equal(await card.locator('.diff-del').count(), 1);
  assert.match(await page.locator('.agent-lane.active').innerText(), /Backend Expert[\s\S]*승인 대기/);
  assert.equal(await page.getByRole('progressbar').first().getAttribute('aria-valuenow'), '50');
  await page.screenshot({ path: resolve(out, 'agent-approval.png'), fullPage: true });
  report.checks.push('Events drive lanes, stage progress and a diff approval card before any write');

  await card.getByLabel('승인 의견').fill('좋아요');
  await card.getByRole('button', { name: '승인하고 실행' }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="승인 요청"]'));
  assert.deepEqual(decisions, [{ runId: 'run-qa', actionId: 'act-1', decision: 'approve', feedback: '좋아요' }]);
  await emit(ev(5, 'backend', 'coding', 'src/cart.ts에 변경을 적용했습니다.', { changes: ['src/cart.ts'] }));
  await emit(ev(6, 'qa', 'awaiting_approval', '검증 명령 승인을 기다립니다: pnpm test', { approval: { kind: 'run_command', id: 'act-2', agent: 'qa', command: ['pnpm', 'test'], cwd: 'demo-shop', reason: '변경 사항 검증' } }));
  await page.getByLabel('실행할 명령').getByText('demo-shop$ pnpm test').waitFor();
  await page.getByRole('region', { name: '승인 요청' }).getByRole('button', { name: '거절' }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="승인 요청"]'));
  assert.equal(decisions[1].decision, 'reject');
  await emit(ev(7, 'supervisor', 'done', '작업을 완료했습니다.', { detail: '합계를 가격 합으로 고쳤습니다.', changes: ['src/cart.ts'] }));
  await page.locator('.agent-run .social-notice', { hasText: '합계를 가격 합으로 고쳤습니다.' }).waitFor();
  await page.locator('.agent-changes code', { hasText: 'src/cart.ts' }).waitFor();
  report.checks.push('Approve and reject send the exact action id; done shows summary and changed files');

  await page.getByLabel('OpenAI API 키').fill('sk-qa-secret-value');
  await page.getByRole('region', { name: '모델 설정' }).getByRole('button', { name: '저장' }).click();
  await page.getByText('모델 설정을 저장했습니다.').waitFor();
  assert.deepEqual(saved.at(-1).keys, { openai: 'sk-qa-secret-value' });
  assert.equal(await page.getByLabel('OpenAI API 키').inputValue(), '', 'key input clears after save');
  assert.equal((await page.content()).includes('sk-qa-secret-value'), false, 'saved key is never rendered');
  report.checks.push('API key goes only to agent_settings_save and is not shown again');

  await page.setViewportSize({ width: 820, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no horizontal overflow at 820px');
  await page.screenshot({ path: resolve(out, 'agent-narrow.png'), fullPage: true });
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} finally { await writeFile(resolve(out, 'verification.json'), JSON.stringify(report, null, 2)); await browser.close(); await server.close(); }
