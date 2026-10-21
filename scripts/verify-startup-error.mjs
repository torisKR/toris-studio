import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createFixtureServer } from './ui-fixture-helpers.mjs';

let server, browser;
try {
  server = await createFixtureServer({ server: { port: 0, strictPort: false } });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const kind of ['render', 'module']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const secret = `private-${kind}-fixture-detail`;
    let broken = true;
    await page.route('**/src/App.tsx*', route => route.fulfill({
      contentType: 'application/javascript',
      body: broken
        ? kind === 'render'
          ? `export function App() { throw new Error(${JSON.stringify(secret)}); }`
          : `throw new Error(${JSON.stringify(secret)}); export function App() { return null; }`
        : 'export function App() { return "다시 열린 화면"; }'
    }));
    await page.goto(url);
    const alert = page.getByRole('alert');
    await alert.getByRole('heading', { name: 'Toris Studio 화면을 열지 못했습니다.' }).waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes(secret), `${kind}: raw error must not be displayed`);
    await page.evaluate(() => {
      localStorage.setItem('startup-recovery-fixture', 'saved-project-fixture');
      sessionStorage.setItem('startup-recovery-fixture', 'saved-session-fixture');
    });
    broken = false;
    await alert.getByRole('button', { name: '다시 불러오기', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByText('다시 열린 화면', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem('startup-recovery-fixture'), sessionStorage.getItem('startup-recovery-fixture')]), ['saved-project-fixture', 'saved-session-fixture']);
    await context.close();
    console.log(`${kind} failure: accessible recovery, private error omitted, keyboard reload and storage preservation passed`);
  }
} finally {
  await browser?.close();
  await server?.close();
}
