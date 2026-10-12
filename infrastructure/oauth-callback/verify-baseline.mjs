import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import proposed from './worker.ts';

const baselinePath = process.argv[2];
assert.ok(baselinePath, 'Pass the path to the historical Worker source or read-only live backup.');
const manifest = JSON.parse(await readFile(new URL('./deploy-manifest.json', import.meta.url), 'utf8'));
const baselineSource = await readFile(baselinePath);
const baselineHash = createHash('sha256').update(baselineSource).digest('hex');
const baselineSourceKind = baselineHash === manifest.baselineSourceSha256 ? 'historicalTrackedSource'
  : baselineHash === manifest.historicalDeployment.liveBaseline.sourceSha256 ? 'historicalLiveBackup' : null;
assert.ok(baselineSourceKind, 'Baseline differs from both reviewed historical Worker sources.');
const baseline = (await import(pathToFileURL(resolve(baselinePath)).href)).default;
const originalFetch = globalThis.fetch;

async function execute(worker, url, method = 'GET') {
  const calls = [];
  globalThis.fetch = async (request, init) => {
    calls.push({ url: request.url, method: request.method, headers: [...request.headers], body: method === 'POST' ? await request.text() : null, init });
    if (new URL(request.url).pathname === '/old') {
      return new Response(null, { status: 302, headers: { location: 'https://toris-product-studio.toriskr.chatgpt.site/new?retain=1' } });
    }
    if (new URL(request.url).pathname === '/lookalike-redirect') {
      return new Response(null, { status: 302, headers: { location: 'https://toris-product-studio.toriskr.chatgpt.site.attacker.invalid/new' } });
    }
    return new Response('Original Sites response', { status: 200, headers: { 'content-type': 'text/html', 'x-original-header': 'retained' } });
  };
  try {
    const request = new Request(url, {
      method,
      headers: { 'x-test-header': 'retained', 'user-agent': 'synthetic-verification' },
      ...(method === 'POST' ? { body: 'synthetic body' } : {})
    });
    const response = await worker.fetch(request);
    return { calls, status: response.status, headers: [...response.headers], body: await response.text() };
  } finally { globalThis.fetch = originalFetch; }
}

for (const [url, method] of [
  ['https://toris.kr/', 'GET'],
  ['https://toris.kr/?campaign=desktop', 'GET'],
  ['https://toris.kr/blog/example?preview=1', 'GET'],
  ['https://toris.kr/old', 'GET'],
  ['https://toris.kr/contact', 'POST'],
  ['https://www.toris.kr/', 'GET'],
  ['https://www.toris.kr/blog/example?preview=1', 'GET'],
  ['https://toris.kr/oauth/instagram/callback/', 'GET']
]) {
  assert.deepEqual(await execute(proposed, url, method), await execute(baseline, url, method));
}

const syntheticCallback = 'https://toris.kr/oauth/instagram/callback?code=synthetic-only&state=synthetic-only';
const before = await execute(baseline, syntheticCallback);
const after = await execute(proposed, syntheticCallback);
assert.equal(before.calls.length, 1);
assert.equal(after.calls.length, 0);
assert.ok(!after.body.includes('synthetic-only'));

const networkPath = 'https://toris.kr//attacker.invalid/content?retain=1';
const beforeNetworkPath = await execute(baseline, networkPath, 'POST');
const afterNetworkPath = await execute(proposed, networkPath, 'POST');
assert.equal(new URL(beforeNetworkPath.calls[0].url).origin, 'https://attacker.invalid');
assert.equal(afterNetworkPath.calls[0].url, 'https://toris-product-studio.toriskr.chatgpt.site//attacker.invalid/content?retain=1');
assert.equal(afterNetworkPath.calls[0].method, 'POST');
assert.equal(afterNetworkPath.calls[0].body, 'synthetic body');

const beforeRedirect = await execute(baseline, 'https://toris.kr/lookalike-redirect');
const afterRedirect = await execute(proposed, 'https://toris.kr/lookalike-redirect');
assert.equal(new Headers(beforeRedirect.headers).get('location'), 'https://toris.kr.attacker.invalid/new');
assert.equal(new Headers(afterRedirect.headers).get('location'), 'https://toris-product-studio.toriskr.chatgpt.site.attacker.invalid/new');

console.log(JSON.stringify({ baselineSourceKind, publicDeploymentChecked: false, ordinaryRequestsCompared: 8, ordinaryBehaviorUnchanged: true, callbackUpstreamRequestsBefore: before.calls.length, callbackUpstreamRequestsAfter: after.calls.length, callbackQueryReflected: false, networkPathOriginFixed: true, lookalikeRedirectUnchanged: true }));
