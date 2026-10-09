import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import proposed from './worker.ts';

const baselinePath = process.argv[2];
assert.ok(baselinePath, 'Pass the path to the read-only Cloudflare Worker source backup.');
const manifest = JSON.parse(await readFile(new URL('./deploy-manifest.json', import.meta.url), 'utf8'));
const baselineSource = await readFile(baselinePath);
assert.equal(createHash('sha256').update(baselineSource).digest('hex'), manifest.liveBaseline.sourceSha256, 'Baseline differs from the reviewed live Worker backup.');
const baseline = (await import(pathToFileURL(resolve(baselinePath)).href)).default;
const originalFetch = globalThis.fetch;

async function execute(worker, url, method = 'GET') {
  const calls = [];
  globalThis.fetch = async (request, init) => {
    calls.push({ url: request.url, method: request.method, headers: [...request.headers], body: method === 'POST' ? await request.text() : null, init });
    if (new URL(request.url).pathname === '/old') {
      return new Response(null, { status: 302, headers: { location: 'https://toris-product-studio.toriskr.chatgpt.site/new?retain=1' } });
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
console.log(JSON.stringify({ ordinaryRequestsCompared: 8, ordinaryBehaviorUnchanged: true, callbackUpstreamRequestsBefore: before.calls.length, callbackUpstreamRequestsAfter: after.calls.length, callbackQueryReflected: false }));
