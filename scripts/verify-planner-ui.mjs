// Planner tab check in Chromium with explicit IPC fixtures. No DB, Google account or network.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFixtureServer, shellFixture, unhandled, openSection } from './ui-fixture-helpers.mjs';
import { chromium } from 'playwright';

const out = resolve(process.env.TORIS_QA_OUT ?? '/private/tmp/toris-planner-ui'); await mkdir(out, { recursive: true });
const report = { adapter: 'Chromium with explicit IPC fixtures; no database, Google account or network', checks: [], errors: [] };
const day = (offset, hour) => { const d = new Date(); d.setHours(hour, 0, 0, 0); d.setDate(d.getDate() + offset); return d.toISOString(); };
let events = [
  { id: 'e1', title: '촬영 준비', notes: '', startsAt: day(0, 15), endsAt: day(0, 16), allDay: false, link: 'none', linkId: null, synced: true, studioOwned: false },
  { id: 'e2', title: '게시 예약 · youtube · 신제품', notes: '', startsAt: day(1, 19), endsAt: day(1, 19), allDay: false, link: 'publication_job', linkId: 'j1', synced: true, studioOwned: true },
];
let work = [
  { id: 'w1', title: '스토어 스크린샷 교체', notes: '', status: 'todo', dueAt: day(-1, 18), productId: null, source: 'manual', updatedAt: day(0, 9) },
  { id: 'w2', title: 'CI 실패 확인', notes: '', status: 'doing', dueAt: null, productId: null, source: 'ops', updatedAt: day(0, 9) },
];
const calls = [];
const server = await createFixtureServer({ server: { port: 0, strictPort: false } }); await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1380, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', e => report.errors.push(e.message));
  await page.exposeFunction('__qaInvoke', async (command, args = {}) => {
    calls.push({ command, args });
    if (command === 'get_dashboard') return { channels: [], content: [], trends: [], integrations: [], database: { connected: true, message: 'QA' } };
    if (command === 'planner_today') return { events, work: work.filter(w => w.status === 'todo' || w.status === 'doing'), openConflicts: 1, calendar: { linked: true, lastSyncedAt: day(0, 8), lastError: null } };
    if (command === 'planner_save_event') { const e = { id: args.input.id ?? 'e-new', notes: '', link: 'none', linkId: null, synced: false, studioOwned: false, ...args.input }; events = [...events.filter(x => x.id !== e.id), e]; return e; }
    if (command === 'planner_delete_event') { events = events.filter(e => e.id !== args.id); return null; }
    if (command === 'planner_save_work_item') { const w = { id: args.input.id ?? 'w-new', productId: null, source: 'manual', updatedAt: day(0, 10), ...args.input }; work = [...work.filter(x => x.id !== w.id), w]; return w; }
    if (command === 'planner_sync_calendar') return { pushed: 1, pulled: 0, imported: 2, conflicts: 0, reverted: 1, deleted: 0, fullResync: false };
    if (command.startsWith('plugin:event|')) return 1;
    const shared = shellFixture(command, args); if (shared !== unhandled) return shared;
    return null;
  });
  await page.addInitScript(() => {
    const callbacks = new Map(); let next = 1;
    window.__TAURI_INTERNALS__ = { transformCallback: cb => { const id = next++; callbacks.set(id, cb); return id; }, unregisterCallback: id => callbacks.delete(id), invoke: async (command, args) => window.__qaInvoke(command, args) };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'networkidle' });
  await openSection(page, '운영', '일정·작업');
  const planner = page.getByRole('region', { name: '일정과 작업' });
  await planner.getByText('촬영 준비').waitFor();
  await planner.getByText('Google Calendar 연결됨', { exact: false }).waitFor();
  await planner.getByText('확인할 동기화 충돌 1건').waitFor();
  await planner.getByText('마감 지남 1').waitFor();
  assert.equal(await planner.locator('li[data-owned]').count(), 1, 'the publication event is marked as Studio-owned');
  assert.equal(await planner.locator('li[data-owned]').getByRole('button', { name: '편집' }).count(), 0, 'a publication event cannot be edited here');
  assert.equal(await planner.locator('li[data-late]').count(), 1);
  report.checks.push('Upcoming days, the Studio-owned publication event, overdue work and sync status render from planner_today');

  await planner.getByRole('button', { name: '일정 추가' }).click();
  const dialog = page.getByRole('dialog', { name: '일정 추가' });
  await dialog.getByLabel('제목').fill('고객 미팅');
  await dialog.getByRole('button', { name: '저장' }).click();
  await planner.getByText('고객 미팅').waitFor();
  const saved = calls.findLast(c => c.command === 'planner_save_event');
  assert.deepEqual(Object.keys(saved.args.input).sort(), ['allDay', 'endsAt', 'notes', 'startsAt', 'title'], 'only editable fields are sent');
  assert.ok(new Date(saved.args.input.endsAt) > new Date(saved.args.input.startsAt));
  await planner.locator('li', { hasText: '고객 미팅' }).getByText('동기화 대기').waitFor();
  report.checks.push('Adding an event sends only editable fields and shows it as waiting for sync');

  await planner.getByRole('button', { name: '촬영 준비 삭제' }).click();
  await planner.getByText('촬영 준비', { exact: true }).waitFor({ state: 'detached' });
  assert.deepEqual(calls.findLast(c => c.command === 'planner_delete_event').args, { id: 'e1' });
  await planner.getByLabel('새 작업').fill('릴리스 노트 작성');
  await planner.getByRole('button', { name: '추가', exact: true }).click();
  await planner.getByText('릴리스 노트 작성', { exact: true }).waitFor();
  await planner.getByLabel('스토어 스크린샷 교체 상태').selectOption('done');
  await planner.getByText('스토어 스크린샷 교체', { exact: true }).waitFor({ state: 'detached' });
  assert.equal(calls.findLast(c => c.command === 'planner_save_work_item').args.input.status, 'done');
  report.checks.push('Delete event, add work and complete work round-trip through IPC');

  await planner.getByRole('button', { name: '지금 동기화' }).click();
  await planner.getByText('1건 보냄 · 2건 새로 가져옴 · 게시 예약 1건 되돌림').waitFor();
  report.checks.push('Manual sync reports pushed, imported and reverted counts');
  await page.screenshot({ path: resolve(out, 'planner.png'), fullPage: true });
  await page.setViewportSize({ width: 820, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no horizontal overflow at 820px');
  report.checks.push('No horizontal overflow at 820px');
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} finally { await writeFile(resolve(out, 'verification.json'), JSON.stringify(report, null, 2)); await browser.close(); await server.close(); }
