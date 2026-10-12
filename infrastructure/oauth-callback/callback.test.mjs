import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import worker from './worker.ts';

const callback = 'https://toris.kr/oauth/instagram/callback';
const originalFetch = globalThis.fetch;

async function withFetchSpy(run, respond = () => new Response('Sites unchanged', {
  status: 200,
  headers: { 'content-type': 'text/html', 'x-existing-header': 'retained' }
})) {
  const calls = [];
  globalThis.fetch = async (request, init) => {
    calls.push({ request, init });
    return respond(request, init);
  };
  try { await run(calls); } finally { globalThis.fetch = originalFetch; }
}

test('OAuth code, state, and injected HTML never reach the upstream or response', async () => {
  await withFetchSpy(async calls => {
    const sentinel = 'callback-only-sensitive-marker';
    const response = await worker.fetch(new Request(`${callback}?code=${sentinel}&state=${sentinel}&error_description=%3Cscript%3E${sentinel}%3C%2Fscript%3E`));
    assert.equal(response.status, 200);
    assert.equal(calls.length, 0);
    const html = await response.text();
    assert.match(html, /Toris Studio 로그인 확인/);
    assert.match(html, /콜백 주소 입력란/);
    assert.ok(!html.includes(sentinel));
    assert.ok(!/<script\b|<link\b|<iframe\b|<img\b|<form\b|\b(?:src|href)=/i.test(html));
  });
});

test('callback body is identical for success, cancellation, and arbitrary query values', async () => {
  await withFetchSpy(async calls => {
    const bodies = await Promise.all(['', '?code=synthetic-test&state=synthetic-state', '?error=access_denied'].map(async query => (await worker.fetch(new Request(callback + query))).text()));
    assert.equal(new Set(bodies).size, 1);
    assert.equal(calls.length, 0);
  });
});

test('callback disables caching, referrer transmission, scripts, framing, and MIME sniffing', async () => {
  const response = await worker.fetch(new Request(callback));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(response.headers.get('x-toris-origin'), null);
});

test('HEAD returns callback headers without a body or upstream request', async () => {
  await withFetchSpy(async calls => {
    const get = await worker.fetch(new Request(callback));
    const head = await worker.fetch(new Request(`${callback}?code=synthetic-test`, { method: 'HEAD' }));
    assert.equal(head.status, 200);
    assert.deepEqual([...head.headers], [...get.headers]);
    assert.equal(await head.text(), '');
    assert.equal(calls.length, 0);
  });
});

test('methods other than GET and HEAD are rejected before any upstream request', async () => {
  await withFetchSpy(async calls => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const response = await worker.fetch(new Request(`${callback}?code=synthetic-test`, { method }));
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), 'Method Not Allowed');
    }
    assert.equal(calls.length, 0);
  });
});

test('homepage preserves the upstream request and response behavior', async () => {
  await withFetchSpy(async calls => {
    const response = await worker.fetch(new Request('https://toris.kr/?campaign=desktop', { headers: { 'x-test-marker': 'retained' } }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.url, 'https://toris-product-studio.toriskr.chatgpt.site/?campaign=desktop');
    assert.equal(calls[0].request.headers.get('x-test-marker'), 'retained');
    assert.deepEqual(calls[0].init, { redirect: 'manual' });
    assert.equal(await response.text(), 'Sites unchanged');
    assert.equal(response.headers.get('x-existing-header'), 'retained');
    assert.equal(response.headers.get('x-toris-origin'), 'chatgpt-sites');
    assert.equal(response.headers.get('content-security-policy'), null);
  });
});

test('unrelated paths remain proxied and callback matching stays exact', async () => {
  await withFetchSpy(async calls => {
    for (const path of ['/blog/example?preview=1', '/oauth/instagram/callback/']) {
      const response = await worker.fetch(new Request(`https://toris.kr${path}`));
      assert.equal(await response.text(), 'Sites unchanged');
    }
    assert.equal(calls.length, 2);
    assert.equal(calls[0].request.url, 'https://toris-product-studio.toriskr.chatgpt.site/blog/example?preview=1');
    assert.equal(calls[1].request.url, 'https://toris-product-studio.toriskr.chatgpt.site/oauth/instagram/callback/');
  });
});

test('network paths, normalized backslashes, and encoded delimiters cannot replace the upstream origin', async () => {
  await withFetchSpy(async calls => {
    const paths = [
      '//attacker.invalid/content?retain=1',
      '///attacker.invalid/content',
      '/\\attacker.invalid/content',
      '/\\\\attacker.invalid/content',
      '/%2f%2fattacker.invalid/content',
      '/%5c%5cattacker.invalid/content',
      '/%252f%252fattacker.invalid/content',
      '//attacker.invalid@lookalike.invalid/content',
      '//attacker.invalid:8443/content',
    ];
    for (const path of paths) {
      const request = new Request(`https://toris.kr${path}`);
      const incoming = new URL(request.url);
      const response = await worker.fetch(request);
      const forwarded = new URL(calls.at(-1).request.url);
      assert.equal(forwarded.origin, 'https://toris-product-studio.toriskr.chatgpt.site', path);
      assert.equal(forwarded.pathname, incoming.pathname, path);
      assert.equal(forwarded.search, incoming.search, path);
      assert.equal(await response.text(), 'Sites unchanged');
    }
    assert.equal(calls.length, paths.length);
  });
});

test('method, body, and headers are copied only to the fixed upstream host', async () => {
  await withFetchSpy(async calls => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await worker.fetch(new Request('https://toris.kr//attacker.invalid/submit?retain=1', {
        method,
        headers: { 'content-type': 'text/plain', 'x-test-marker': 'retained' },
        body: `synthetic ${method} body`,
      }));
      const { request, init } = calls.at(-1);
      assert.equal(request.url, 'https://toris-product-studio.toriskr.chatgpt.site//attacker.invalid/submit?retain=1');
      assert.equal(request.method, method);
      assert.equal(request.headers.get('x-test-marker'), 'retained');
      assert.equal(request.headers.get('content-type'), 'text/plain');
      assert.equal(await request.text(), `synthetic ${method} body`);
      assert.deepEqual(init, { redirect: 'manual' });
      assert.equal(await response.text(), 'Sites unchanged');
    }
  });
});

test('www canonical redirects preserve the existing behavior without an upstream call', async () => {
  await withFetchSpy(async calls => {
    const response = await worker.fetch(new Request('https://www.toris.kr/blog/example?preview=1'));
    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), 'https://toris.kr/blog/example?preview=1');
    assert.equal(calls.length, 0);
  });
});

test('exact-origin absolute and relative Locations are rewritten with path, query, and fragment retained', async () => {
  const locations = [
    ['https://toris-product-studio.toriskr.chatgpt.site/blog/example?preview=1#section', '/blog/example?preview=1#section'],
    ['https://toris-product-studio.toriskr.chatgpt.site:443/blog/example', '/blog/example'],
    ['HTTPS://TORIS-PRODUCT-STUDIO.TORISKR.CHATGPT.SITE/blog/example', '/blog/example'],
    ['//toris-product-studio.toriskr.chatgpt.site/blog/example', '/blog/example'],
    ['/blog/example?preview=1#section', '/blog/example?preview=1#section'],
    ['../next?preview=1#section', '/next?preview=1#section'],
    ['?preview=1', '/blog/current?preview=1'],
    ['#section', '/blog/current?existing=1#section'],
  ];
  for (const [location, expected] of locations) {
    await withFetchSpy(async () => {
      const response = await worker.fetch(new Request('https://toris.kr/blog/current?existing=1'));
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), `https://toris.kr${expected}`, location);
      assert.equal(response.headers.get('x-toris-origin'), 'chatgpt-sites');
    }, () => new Response(null, { status: 302, headers: { location } }));
  }
});

test('other-origin, lookalike, non-default-port, and credential-bearing Locations stay unchanged', async () => {
  const locations = [
    'https://attacker.invalid/blog',
    'https://toris-product-studio.toriskr.chatgpt.site.attacker.invalid/blog',
    'https://toris-product-studio.toriskr.chatgpt.site-attacker.invalid/blog',
    'https://toris-product-studio.toriskr.chatgpt.site@attacker.invalid/blog',
    'https://toris-product-studio.toriskr.chatgpt.site:8443/blog',
    'http://toris-product-studio.toriskr.chatgpt.site/blog',
    'https://toris-product-studio.toriskr.chatgpt.site./blog',
    '//attacker.invalid/blog',
    'https://user@toris-product-studio.toriskr.chatgpt.site/blog',
    'https://user:synthetic-password@toris-product-studio.toriskr.chatgpt.site/blog',
    'https://[invalid-host/blog',
  ];
  for (const location of locations) {
    await withFetchSpy(async () => {
      const response = await worker.fetch(new Request('https://toris.kr/blog'));
      assert.equal(response.headers.get('location'), location);
    }, () => new Response(null, { status: 302, headers: { location } }));
  }
});

test('Worker has no console calls and invocation URL logging is disabled in the deploy config', async () => {
  const source = await readFile(new URL('./worker.ts', import.meta.url), 'utf8');
  const config = JSON.parse(await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
  assert.ok(!/\bconsole\s*\./.test(source));
  assert.equal(config.observability.logs.enabled, false);
  assert.equal(config.observability.logs.invocation_logs, false);
  assert.equal(config.name, 'toris-site');
  assert.deepEqual(config.routes, [{ pattern: 'toris.kr', custom_domain: true }, { pattern: 'www.toris.kr', custom_domain: true }]);
});
