// Agent tab UI check in Chromium with explicit IPC fixtures. No model, file write or command runs.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFixtureServer, shellFixture, unhandled, openSection } from './ui-fixture-helpers.mjs';
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
const saved = [], decisions = [], started = [], hubCalls = [];
const run = { runId: 'run-qa', project: 'demo-shop', task: '', phase: 'queued', agent: 'supervisor', createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z', approvals: [], changes: [], summary: '', events: [] };
const approval = { kind: 'write_file', id: 'act-1', agent: 'backend', path: 'src/cart.ts', reason: '합계 계산 버그 수정', diff: '--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1,3 +1,3 @@\n export function total(items) {\n-  return items.length;\n+  return items.reduce((s, i) => s + i.price, 0);\n }\n' };
const ev = (seq, agent, phase, message, extra = {}) => ({ event: 'run', runId: 'run-qa', seq, at: `2026-10-27T00:00:${String(seq).padStart(2, '0')}Z`, agent, phase, message, ...extra });

const server = await createFixtureServer({ server: { port: 0, strictPort: false } }); await server.listen();
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
    if (command === 'hub_start') { hubCalls.push({ command, args }); return { runId: 'run-hub', workflow: args.workflow, project: '', task: '', phase: 'queued', agent: 'supervisor', createdAt: '2026-10-27T00:01:00Z', updatedAt: '2026-10-27T00:01:00Z', approvals: [], changes: [], summary: '', events: [{ event: 'run', runId: 'run-hub', seq: 1, at: '2026-10-27T00:01:01Z', agent: 'supervisor', phase: 'queued', message: '작업을 시작합니다.' }] }; }
    if (command === 'hub_decide') { hubCalls.push({ command, args }); return { runId: args.runId }; }
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
    const shared = shellFixture(command, args); if (shared !== unhandled) return shared;
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
  await openSection(page, '제작', 'Agent');
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
  const office = page.getByRole('region', { name: '에이전트 사무실' });
  assert.equal(await office.getByRole('button', { name: /책상/ }).count(), 4, 'one desk per agent role');
  const scene = office.locator('svg.pixel-office');
  assert.equal(await scene.getAttribute('role'), 'img');
  assert.match(await scene.getAttribute('aria-label'), /픽셀 사무실/);
  assert.deepEqual(await scene.locator('[data-character]').evaluateAll(els => els.map(e => `${e.dataset.character}:${e.dataset.look}`).sort()),
    ['backend:youngMan', 'frontend:youngWoman', 'qa:woman30s', 'supervisor:man30s']);
  assert.equal(await scene.getAttribute('shape-rendering'), 'crispEdges');
  assert.deepEqual(await scene.locator('[data-character]').evaluateAll(els => els.filter(e => getComputedStyle(e).opacity !== '0').map(e => e.dataset.character).sort()),
    ['backend', 'supervisor'], 'only people who have started work are at their desks');
  assert.match(await office.getByRole('button', { name: /Backend Expert 책상/ }).getAttribute('aria-label'), /결재 대기/);
  assert.match(await office.getByRole('button', { name: /Supervisor 책상/ }).getAttribute('aria-label'), /PM/);
  assert.equal(await office.locator('[aria-current="step"]').innerText(), '결재 대기');
  await office.getByRole('list', { name: '서류 이동 기록' }).getByText('Backend Expert → 나 · 결재 요청 · src/cart.ts').waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('[aria-label="에이전트 사무실"]').getAnimations({ subtree: true }).length), 0, 'reduced motion: nothing moves');
  await page.screenshot({ path: resolve(out, 'agent-approval.png'), fullPage: true });
  report.checks.push('Office view: a desk per role, PM desk, procedure step, paper hand-off log, no motion under reduced motion');

  // Clicking a desk shows only that agent's log; clicking again shows everything.
  const timeline = page.getByRole('list', { name: '진행 기록' });
  await office.getByRole('button', { name: /Backend Expert 책상/ }).click();
  assert.equal(await office.getByRole('button', { name: /Backend Expert 책상/ }).getAttribute('aria-pressed'), 'true');
  assert.equal(await timeline.locator('li').count(), 2, 'only backend events');
  await office.getByRole('button', { name: /Backend Expert 책상/ }).click();
  assert.equal(await timeline.locator('li').count(), 4, 'all events again');
  report.checks.push('Desk selection filters the log to that agent and toggles back');

  // With motion allowed, the sender walks over with the paper and back, once.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await emit(ev(5, 'qa', 'reviewing', '결과를 검토하고 있습니다.'));
  await office.locator('.pixel-walker[data-kind="report"][data-walker="backend"]').waitFor({ state: 'attached' });
  assert.ok(await page.evaluate(() => document.querySelector('.pixel-walker').getAnimations({ subtree: true }).length > 0), 'walker animates');
  const walkMs = await page.evaluate(() => document.querySelector('.pixel-walker').getAnimations().find(a => a.animationName === 'pixel-walk').effect.getTiming().duration);
  assert.ok(walkMs >= 5000, `a walk takes at least 5s (got ${walkMs}ms)`);
  assert.equal(await office.locator('[data-character="backend"].is-walking').count(), 1, 'the seat is empty while walking');
  await page.waitForFunction(() => document.querySelector('[aria-label="에이전트 사무실"]').getAnimations({ subtree: true }).length === 0, null, { timeout: 10000 });
  assert.equal(await office.locator('.pixel-walker').count(), 0, 'walker is gone after returning');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  report.checks.push('A hand-off walks the sender to the other desk and back once, then everything stops');
  await emit(ev(6, 'backend', 'awaiting_approval', 'src/cart.ts 변경 승인을 기다립니다.', { approval }));
  await card.waitFor();

  await card.getByLabel('승인 의견').fill('좋아요');
  await card.getByRole('button', { name: '승인하고 실행' }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label^="승인 요청"]'));
  assert.deepEqual(decisions, [{ runId: 'run-qa', actionId: 'act-1', decision: 'approve', feedback: '좋아요' }]);
  await emit(ev(7, 'backend', 'coding', 'src/cart.ts에 변경을 적용했습니다.', { changes: ['src/cart.ts'] }));
  await emit(ev(8, 'qa', 'awaiting_approval', '검증 명령 승인을 기다립니다: pnpm test', { approval: { kind: 'run_command', id: 'act-2', agent: 'qa', command: ['pnpm', 'test'], cwd: 'demo-shop', reason: '변경 사항 검증' } }));
  await page.getByLabel('실행할 명령').getByText('demo-shop$ pnpm test').waitFor();
  await page.getByRole('region', { name: '승인 요청' }).getByRole('button', { name: '거절' }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label^="승인 요청"]'));
  assert.equal(decisions[1].decision, 'reject');

  // Frontend and Backend work at once: two requests are open together and each is decided on its own.
  const uiWrite = { kind: 'write_file', id: 'act-fe', agent: 'frontend', path: 'src/Cart.tsx', reason: '합계 표시', diff: '--- a/src/Cart.tsx\n+++ b/src/Cart.tsx\n@@ -1 +1 @@\n-old\n+new\n' };
  const apiCmd = { kind: 'run_command', id: 'act-be', agent: 'backend', command: ['pnpm', 'run', 'typecheck'], cwd: 'demo-shop', reason: '타입 확인' };
  await emit(ev(10, 'frontend', 'awaiting_approval', 'src/Cart.tsx 변경 승인을 기다립니다.', { approval: uiWrite }));
  await emit(ev(11, 'backend', 'reading', '파일을 읽고 있습니다.', { detail: 'src/api.ts' }));
  await emit(ev(12, 'backend', 'awaiting_approval', '명령 실행 승인을 기다립니다: pnpm run typecheck', { approval: apiCmd }));
  const feCard = page.getByRole('region', { name: '승인 요청 · Frontend Expert' });
  const beCard = page.getByRole('region', { name: '승인 요청 · Backend Expert' });
  await feCard.waitFor(); await beCard.waitFor();
  await page.getByText('승인 요청 2건이 기다립니다.', { exact: false }).waitFor();
  assert.match(await office.getByRole('button', { name: /Frontend Expert 책상/ }).getAttribute('aria-label'), /결재 대기/);
  assert.match(await office.getByRole('button', { name: /Backend Expert 책상/ }).getAttribute('aria-label'), /결재 대기/);
  await beCard.getByRole('button', { name: '승인하고 실행' }).click();
  await beCard.waitFor({ state: 'detached' });
  assert.deepEqual(decisions.at(-1), { runId: 'run-qa', actionId: 'act-be', decision: 'approve', feedback: '' });
  assert.equal(await feCard.getByRole('button', { name: '승인하고 실행' }).isEnabled(), true, 'the other card stays open and usable');
  await emit(ev(13, 'backend', 'testing', '실행 중: pnpm run typecheck', { resolved: 'act-be' }));
  assert.equal(await page.locator('[aria-label^="승인 요청"]').count(), 1, 'backend progress keeps the frontend request');
  await feCard.getByRole('button', { name: '승인하고 실행' }).click();
  await feCard.waitFor({ state: 'detached' });
  assert.equal(decisions.at(-1).actionId, 'act-fe');
  report.checks.push('Two lanes can wait at once: one card per request, deciding one leaves the other open');
  await emit(ev(14, 'supervisor', 'done', '작업을 완료했습니다.', { detail: '합계를 가격 합으로 고쳤습니다.', changes: ['src/cart.ts'] }));
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

  // Hub workflow: started through hub_start, saves decided through hub_decide, template drafts are labelled.
  await page.getByRole('region', { name: '운영 워크플로' }).getByRole('button', { name: '주간 콘텐츠 초안 시작' }).click();
  await page.locator('.agent-run h2', { hasText: '주간 콘텐츠 초안' }).waitFor();
  assert.deepEqual(hubCalls[0], { command: 'hub_start', args: { workflow: 'weekly-content', task: '' } });
  const draft = { kind: 'save_draft', id: 'act-draft', agent: 'supervisor', target: 'social_content', title: '[템플릿] AI: AI 팁', preview: 'threads\n\n템플릿 초안입니다. AI가 쓴 글이 아니니 내용을 직접 채우세요.', template: true, reason: '모델 없이 만든 템플릿 초안' };
  await page.evaluate(p => window.__qaEmit('agent-event', p), { event: 'run', runId: 'run-hub', seq: 2, at: '2026-10-27T00:01:02Z', agent: 'supervisor', phase: 'awaiting_approval', message: '[템플릿] AI: AI 팁 저장 승인을 기다립니다.', approval: draft });
  const draftCard = page.getByRole('region', { name: '승인 요청 · Supervisor' });
  await draftCard.getByText('초안 저장 승인').waitFor();
  await draftCard.getByText('템플릿 · AI 아님').waitFor();
  await draftCard.getByLabel('저장할 내용').getByText('AI가 쓴 글이 아니니', { exact: false }).waitFor();
  await draftCard.getByRole('button', { name: '승인하고 저장' }).click();
  await draftCard.waitFor({ state: 'detached' });
  assert.deepEqual(hubCalls.at(-1), { command: 'hub_decide', args: { runId: 'run-hub', actionId: 'act-draft', decision: 'approve', feedback: '' } });
  assert.equal(decisions.filter(d => d.actionId === 'act-draft').length, 0, 'a hub save never goes to run.resume from the webview');
  report.checks.push('Hub workflow starts via hub_start; a labelled template draft is saved only through hub_decide');

  // Model pickers on one row line up: their first select starts at the same height and has the same size.
  const pickerRows = () => page.evaluate(() => {
    const rows = new Map();
    for (const box of document.querySelectorAll('.agent-grid > .agent-picker')) {
      const top = Math.round(box.getBoundingClientRect().top);
      const select = box.querySelector('select').getBoundingClientRect();
      rows.set(top, [...(rows.get(top) ?? []), { top: Math.round(select.top), height: Math.round(select.height) }]);
    }
    return [...rows.values()].filter(row => row.length > 1);
  });
  const assertAligned = async width => {
    for (const row of await pickerRows()) {
      assert.ok(row.every(s => Math.abs(s.top - row[0].top) <= 1), `select tops differ at ${width}px: ${JSON.stringify(row)}`);
      assert.ok(row.every(s => Math.abs(s.height - row[0].height) <= 1), `select heights differ at ${width}px: ${JSON.stringify(row)}`);
    }
  };
  await assertAligned(1380);
  const [selectHeight, inputHeight] = await page.evaluate(() => {
    const box = document.querySelector('.agent-grid > .agent-picker');
    return [box.querySelector('select'), box.querySelector('input')].map(el => Math.round(el.getBoundingClientRect().height));
  });
  assert.ok(Math.abs(selectHeight - inputHeight) <= 1, `select ${selectHeight}px vs input ${inputHeight}px`);

  await page.setViewportSize({ width: 820, height: 900 });
  await assertAligned(820);
  report.checks.push('Model picker selects on one row share top and height (1380px, 820px)');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no horizontal overflow at 820px');
  await page.screenshot({ path: resolve(out, 'agent-narrow.png'), fullPage: true });
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} finally { await writeFile(resolve(out, 'verification.json'), JSON.stringify(report, null, 2)); await browser.close(); await server.close(); }
