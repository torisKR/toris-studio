import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import worker, { SearchBudget } from './worker.ts';

// All provider traffic is faked; every value below is synthetic test data.
const KEY_CURRENT = Buffer.alloc(32, 1);
const KEY_PREVIOUS = Buffer.alloc(32, 2);
const BASE = 'https://oauth.toris.kr';
const UA = 'TorisStudio/0.8.0';
const VERIFIER = 'synthetic-verifier-'.padEnd(64, 'v');
const CHALLENGE = b64url(createHash('sha256').update(VERIFIER).digest());
const REDIRECTS = {
  tiktok: 'http://127.0.0.1:38471/oauth/tiktok/callback',
  naver_blog: 'http://127.0.0.1:38471/oauth/naver_blog/callback',
  threads: 'https://toris.kr/oauth/threads/callback',
  instagram: 'https://toris.kr/oauth/instagram/callback',
  facebook: 'https://toris.kr/oauth/facebook/callback',
};

function b64url(bytes) { return Buffer.from(bytes).toString('base64url'); }

function signState(payload, key = KEY_CURRENT) {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${b64url(createHmac('sha256', key).update(body).digest())}`;
}

function payloadFor(platform, overrides = {}) {
  return { k: 'k2', p: platform, u: 'read', c: CHALLENGE, n: b64url(randomBytes(16)), e: Math.floor(Date.now() / 1000) + 600, ...overrides };
}

class MemoryStorage {
  constructor() { this.map = new Map(); }
  async get(key) { return structuredClone(this.map.get(key)); }
  async put(key, value) { this.map.set(key, structuredClone(value)); }
}

function makeEnv(overrides = {}) {
  const limiterCalls = [];
  const limiter = (name, allow = true) => ({ limit: async ({ key }) => { limiterCalls.push({ name, key }); return { success: allow }; } });
  const storage = new MemoryStorage();
  const budget = new SearchBudget({ storage });
  const env = {
    TIKTOK_CLIENT_KEY: 'tiktok-client-key', THREADS_APP_ID: 'threads-app-id', INSTAGRAM_APP_ID: 'instagram-app-id',
    FACEBOOK_APP_ID: 'facebook-app-id', NAVER_LOGIN_CLIENT_ID: 'naver-login-id', NAVER_SEARCH_CLIENT_ID: 'naver-search-id',
    TIKTOK_CLIENT_SECRET: 'tiktok-secret', THREADS_APP_SECRET: 'threads-secret', INSTAGRAM_APP_SECRET: 'instagram-secret',
    FACEBOOK_APP_SECRET: 'facebook-secret', NAVER_LOGIN_CLIENT_SECRET: 'naver-login-secret', NAVER_SEARCH_CLIENT_SECRET: 'naver-search-secret',
    STATE_SIGNING_KEYS: JSON.stringify({ k2: KEY_CURRENT.toString('base64'), k1: KEY_PREVIOUS.toString('base64') }),
    STATE_KEY_ID: 'k2', MIN_APP_VERSION: '0.8.0', ENABLED_PLATFORMS: 'tiktok,threads,instagram,facebook,naver_blog',
    NAVER_SEARCH_DAILY_BUDGET: '20000',
    START_LIMITER: limiter('start'), TOKEN_LIMITER: limiter('token'), REFRESH_LIMITER: limiter('refresh'), SEARCH_LIMITER: limiter('search'),
    SEARCH_BUDGET: { idFromName: name => name, get: () => ({ fetch: (url, init) => budget.fetch(new Request(url, init)) }) },
    ...overrides,
  };
  return { env, limiterCalls, storage, limiter };
}

// Real network is blocked for the whole file; tests install their own fake fetch.
const originalFetch = async () => { throw new Error('real network access is blocked in tests'); };
globalThis.fetch = originalFetch;
async function withProvider(respond, run) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.method === 'GET' ? null : await request.text();
    calls.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body, redirect: request.redirect });
    return respond(request, calls.length);
  };
  try { return await run(calls); } finally { globalThis.fetch = originalFetch; }
}
const noProvider = () => { throw new Error('provider must not be called'); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function call(env, path, { body, method = 'POST', headers = {}, raw } = {}) {
  const init = { method, headers: { 'user-agent': UA, 'cf-connecting-ip': '203.0.113.7', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers } };
  if (method === 'POST') init.body = raw ?? JSON.stringify(body ?? {});
  return worker.fetch(new Request(`${BASE}${path}`, init), env);
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const value = await response.json();
  assert.equal(value.v, 1);
  assert.equal(value.error.code, code);
  return value;
}

function tokenBody(platform, overrides = {}) {
  return { state: signState(payloadFor(platform)), code: 'synthetic-code', verifier: VERIFIER, redirectUri: REDIRECTS[platform], ...overrides };
}

const form = text => Object.fromEntries(new URLSearchParams(text));
const query = url => Object.fromEntries(new URL(url).searchParams);
const noConsole = t => {
  const seen = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) t.mock.method(console, method, () => seen.push(method));
  return seen;
};

test('config lists enabled platforms without secrets or client IDs, with version headers', async t => {
  const seen = noConsole(t);
  const { env } = makeEnv({ ENABLED_PLATFORMS: 'tiktok,threads,instagram,naver_blog' });
  const response = await call(env, '/v1/config', { method: 'GET' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('toris-broker-version'), '1');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), {
    v: 1, minAppVersion: '0.8.0',
    platforms: { tiktok: { enabled: true }, threads: { enabled: true }, instagram: { enabled: true }, facebook: { enabled: false }, naver_blog: { enabled: true } },
    naverSearch: { enabled: true },
  });
  for (const value of Object.values(env)) if (typeof value === 'string' && /secret|-id|key/.test(value)) assert.ok(!text.includes(value), value);
  assert.equal(seen.length, 0);
});

test('config reports a platform disabled when its client secret is missing', async () => {
  const { env } = makeEnv({ TIKTOK_CLIENT_SECRET: undefined, NAVER_SEARCH_DAILY_BUDGET: '0' });
  const value = await (await call(env, '/v1/config', { method: 'GET' })).json();
  assert.equal(value.platforms.tiktok.enabled, false);
  assert.equal(value.naverSearch.enabled, false);
});

test('any request with an Origin header is refused before work', async () => {
  const { env, limiterCalls } = makeEnv();
  await withProvider(noProvider, async calls => {
    await expectError(await call(env, '/v1/config', { method: 'GET', headers: { origin: 'https://attacker.invalid' } }), 403, 'origin_forbidden');
    await expectError(await call(env, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok'), headers: { origin: 'null' } }), 403, 'origin_forbidden');
    assert.equal(calls.length, 0);
  });
  assert.equal(limiterCalls.length, 0);
});

test('apps older than MIN_APP_VERSION or without the app User-Agent get 426', async () => {
  const { env } = makeEnv();
  for (const ua of ['TorisStudio/0.7.9', 'TorisStudio/0.7.12-beta.1', 'Mozilla/5.0', '']) {
    const value = await expectError(await call(env, '/v1/oauth/tiktok/start', { body: { purpose: 'read', challenge: CHALLENGE }, headers: { 'user-agent': ua } }), 426, 'upgrade_required');
    assert.equal(value.minAppVersion, '0.8.0');
    assert.equal(value.error.retryable, false);
  }
  for (const ua of ['TorisStudio/0.8.0', 'TorisStudio/0.10.0 (macOS)', 'TorisStudio/1.0.0-rc.1']) {
    assert.equal((await call(env, '/v1/oauth/tiktok/start', { body: { purpose: 'read', challenge: CHALLENGE }, headers: { 'user-agent': ua } })).status, 200, ua);
  }
});

test('start returns a signed, expiring state bound to platform, purpose, and challenge', async () => {
  const { env, limiterCalls } = makeEnv();
  const before = Math.floor(Date.now() / 1000);
  const response = await call(env, '/v1/oauth/threads/start', { body: { purpose: 'publish', challenge: CHALLENGE } });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.v, 1);
  assert.equal(value.clientId, 'threads-app-id');
  assert.equal(value.redirectUri, REDIRECTS.threads);
  const [body, signature] = value.state.split('.');
  assert.equal(signature, b64url(createHmac('sha256', KEY_CURRENT).update(body).digest()));
  const payload = JSON.parse(Buffer.from(body, 'base64url'));
  assert.deepEqual(Object.keys(payload).sort(), ['c', 'e', 'k', 'n', 'p', 'u']);
  assert.equal(payload.k, 'k2');
  assert.equal(payload.p, 'threads');
  assert.equal(payload.u, 'publish');
  assert.equal(payload.c, CHALLENGE);
  assert.equal(Buffer.from(payload.n, 'base64url').length, 16);
  assert.ok(payload.e >= before + 600 && payload.e <= before + 601);
  assert.equal(value.expiresAt, new Date(payload.e * 1000).toISOString().replace('.000Z', 'Z'));
  assert.deepEqual(limiterCalls, [{ name: 'start', key: '203.0.113.7' }]);
  const second = await (await call(env, '/v1/oauth/threads/start', { body: { purpose: 'publish', challenge: CHALLENGE } })).json();
  assert.notEqual(second.state, value.state);
});

test('a state issued by start is accepted by token', async () => {
  const { env } = makeEnv();
  const started = await (await call(env, '/v1/oauth/tiktok/start', { body: { purpose: 'read', challenge: CHALLENGE } })).json();
  await withProvider(() => json({ access_token: 'at', expires_in: 86400, token_type: 'Bearer' }), async () => {
    const response = await call(env, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok', { state: started.state }) });
    assert.equal(response.status, 200);
  });
});

test('start validates platform, purpose, challenge, size, content type, and unknown fields', async () => {
  const { env } = makeEnv();
  await expectError(await call(env, '/v1/oauth/google/start', { body: { purpose: 'read', challenge: CHALLENGE } }), 404, 'unsupported_platform');
  await expectError(await call(env, '/v1/oauth/__proto__/start', { body: { purpose: 'read', challenge: CHALLENGE } }), 404, 'unsupported_platform');
  await expectError(await call(env, '/v1/oauth/toString/start', { body: { purpose: 'read', challenge: CHALLENGE } }), 404, 'unsupported_platform');
  const disabled = makeEnv({ ENABLED_PLATFORMS: 'tiktok' }).env;
  await expectError(await call(disabled, '/v1/oauth/threads/start', { body: { purpose: 'read', challenge: CHALLENGE } }), 404, 'unsupported_platform');
  for (const body of [
    { purpose: 'admin', challenge: CHALLENGE },
    { purpose: 'read', challenge: CHALLENGE.slice(1) },
    { purpose: 'read', challenge: `${CHALLENGE.slice(1)}=` },
    { purpose: 'read' },
    { purpose: 'read', challenge: CHALLENGE, extra: 1 },
    [],
  ]) await expectError(await call(env, '/v1/oauth/tiktok/start', { body }), 400, 'bad_request');
  await expectError(await call(env, '/v1/oauth/tiktok/start', { raw: '{"purpose":' }), 400, 'bad_request');
  await expectError(await call(env, '/v1/oauth/tiktok/start', { raw: JSON.stringify({ purpose: 'read', challenge: CHALLENGE, pad: 'x'.repeat(8200) }) }), 400, 'bad_request');
  await expectError(await call(env, '/v1/oauth/tiktok/start', { body: { purpose: 'read', challenge: CHALLENGE }, headers: { 'content-type': 'text/plain' } }), 400, 'bad_request');
  await expectError(await call(env, '/v1/oauth/tiktok/start', { method: 'GET' }), 400, 'bad_request');
  await expectError(await call(env, '/v1/unknown', { body: {} }), 400, 'bad_request');
});

test('bodies over 8 KiB are refused even without Content-Length', async () => {
  const { env } = makeEnv();
  const valid = JSON.stringify({ purpose: 'read', challenge: CHALLENGE });
  const send = padding => {
    const bytes = new TextEncoder().encode(valid + ' '.repeat(padding));
    const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    return worker.fetch(new Request(`${BASE}/v1/oauth/tiktok/start`, { method: 'POST', body, duplex: 'half', headers: { 'user-agent': UA, 'content-type': 'application/json' } }), env);
  };
  assert.equal((await send(8192 - valid.length)).status, 200);
  await expectError(await send(8193 - valid.length), 400, 'bad_request');
});

test('per-IP rate limit answers 429 with Retry-After and never calls the provider', async () => {
  const { env, limiter } = makeEnv();
  env.TOKEN_LIMITER = limiter('token', false);
  await withProvider(noProvider, async calls => {
    const response = await call(env, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok') });
    const value = await expectError(response, 429, 'rate_limited');
    assert.equal(value.error.retryable, true);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal(calls.length, 0);
  });
});

test('token rejects a forged signature, an unknown key ID, and a retired key', async () => {
  const { env } = makeEnv();
  await withProvider(noProvider, async () => {
    const good = signState(payloadFor('tiktok'));
    const [body, signature] = good.split('.');
    const flipped = `${body}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    await expectError(await call(env, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok', { state: flipped }) }), 400, 'state_invalid');
    await expectError(await call(env, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok', { state: signState(payloadFor('tiktok'), Buffer.alloc(32, 9)) }) }), 400, 'state_invalid');
    await expectError(await call(env, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok', { state: signState(payloadFor('tiktok', { k: 'k9' })) }) }), 400, 'state_invalid');
    await expectError(await call(env, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok', { state: 'not-a-state' }) }), 400, 'state_invalid');
    const retired = makeEnv({ STATE_SIGNING_KEYS: JSON.stringify({ k2: KEY_CURRENT.toString('base64') }) }).env;
    await expectError(await call(retired, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok', { state: signState(payloadFor('tiktok', { k: 'k1' }), KEY_PREVIOUS) }) }), 400, 'state_invalid');
  });
});

test('token accepts the previous signing key during rotation', async () => {
  const { env } = makeEnv();
  await withProvider(() => json({ access_token: 'at', expires_in: 86400, refresh_token: 'rt', refresh_expires_in: 100, scope: 'user.info.basic', token_type: 'Bearer', open_id: 'oid' }), async calls => {
    const response = await call(env, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok', { state: signState(payloadFor('tiktok', { k: 'k1' }), KEY_PREVIOUS) }) });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
  });
});

test('token rejects an expired state, a platform swap, a wrong redirect, and a wrong verifier', async () => {
  const { env } = makeEnv();
  await withProvider(noProvider, async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectError(await call(env, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok', { state: signState(payloadFor('tiktok', { e: now - 1 })) }) }), 400, 'state_expired');
    await expectError(await call(env, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok', { state: signState(payloadFor('naver_blog')) }) }), 400, 'state_invalid');
    await expectError(await call(env, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok', { redirectUri: 'http://127.0.0.1:38471/oauth/tiktok/callback/' }) }), 400, 'redirect_mismatch');
    await expectError(await call(env, '/v1/oauth/threads/token', { body: tokenBody('threads', { redirectUri: REDIRECTS.instagram }) }), 400, 'redirect_mismatch');
    await expectError(await call(env, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok', { verifier: 'other-verifier-'.padEnd(64, 'x') }) }), 400, 'verifier_mismatch');
    for (const verifier of ['short', 'x'.repeat(129), `${'x'.repeat(50)} `]) {
      await expectError(await call(env, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok', { verifier }) }), 400, 'bad_request');
    }
    for (const code of ['', 'x'.repeat(2049), 'a\u0000b', 'a b']) {
      await expectError(await call(env, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok', { code }) }), 400, 'bad_request');
    }
  });
});

test('a valid state remains accepted until its expiry second', async () => {
  const { env } = makeEnv();
  await withProvider(() => json({ access_token: 'at', expires_in: 3600, token_type: 'bearer', refresh_token: 'rt', refresh_expires_in: 10 }), async () => {
    const state = signState(payloadFor('naver_blog', { e: Math.floor(Date.now() / 1000) + 5 }));
    assert.equal((await call(env, '/v1/oauth/naver_blog/token', { body: tokenBody('naver_blog', { state }) })).status, 200);
  });
});

test('TikTok exchange sends PKCE verifier and secret to the official endpoint and normalizes the token', async t => {
  const seen = noConsole(t);
  const { env } = makeEnv();
  await withProvider(() => json({ access_token: 'tiktok-at', expires_in: 86400, open_id: 'oid', refresh_expires_in: 31536000, refresh_token: 'tiktok-rt', scope: 'user.info.basic,video.list', token_type: 'Bearer' }), async calls => {
    const response = await call(env, '/v1/oauth/tiktok/token', { body: tokenBody('tiktok', { code: 'code*!1234' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { v: 1, access_token: 'tiktok-at', token_type: 'bearer', expires_in: 86400, refresh_token: 'tiktok-rt', refresh_expires_in: 31536000, scope: 'user.info.basic,video.list', long_lived: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].redirect, 'manual');
    assert.equal(calls[0].url, 'https://open.tiktokapis.com/v2/oauth/token/');
    assert.equal(calls[0].headers['content-type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(form(calls[0].body), { client_key: 'tiktok-client-key', client_secret: 'tiktok-secret', code: 'code*!1234', grant_type: 'authorization_code', redirect_uri: REDIRECTS.tiktok, code_verifier: VERIFIER });
  });
  assert.equal(seen.length, 0);
});

test('Naver exchange sends the signed state, and string expires_in becomes a number', async () => {
  const { env } = makeEnv();
  const body = tokenBody('naver_blog');
  await withProvider(() => json({ access_token: 'naver-at', refresh_token: 'naver-rt', token_type: 'bearer', expires_in: '3600' }), async calls => {
    const response = await call(env, '/v1/oauth/naver_blog/token', { body });
    assert.deepEqual(await response.json(), { v: 1, access_token: 'naver-at', token_type: 'bearer', expires_in: 3600, refresh_token: 'naver-rt', long_lived: false });
    assert.equal(calls[0].url, 'https://nid.naver.com/oauth2.0/token');
    assert.deepEqual(form(calls[0].body), { grant_type: 'authorization_code', client_id: 'naver-login-id', client_secret: 'naver-login-secret', code: 'synthetic-code', state: body.state });
  });
});

test('Threads exchange performs short and long-lived exchange and returns only the long-lived token', async () => {
  const { env } = makeEnv();
  await withProvider((request, n) => n === 1 ? json({ access_token: 'short-at', user_id: 1 }) : json({ access_token: 'long-at', token_type: 'bearer', expires_in: 5183944 }), async calls => {
    const response = await call(env, '/v1/oauth/threads/token', { body: tokenBody('threads') });
    const value = await response.json();
    assert.deepEqual(value, { v: 1, access_token: 'long-at', token_type: 'bearer', expires_in: 5183944, long_lived: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://graph.threads.net/oauth/access_token');
    assert.deepEqual(form(calls[0].body), { client_id: 'threads-app-id', client_secret: 'threads-secret', code: 'synthetic-code', grant_type: 'authorization_code', redirect_uri: REDIRECTS.threads });
    assert.equal(calls[1].method, 'GET');
    assert.ok(calls[1].url.startsWith('https://graph.threads.net/access_token?'));
    assert.deepEqual(query(calls[1].url), { grant_type: 'th_exchange_token', client_secret: 'threads-secret', access_token: 'short-at' });
  });
});

test('Instagram exchange unwraps data[0] before the long-lived exchange', async () => {
  const { env } = makeEnv();
  await withProvider((request, n) => n === 1 ? json({ data: [{ access_token: 'ig-short', user_id: '1', permissions: 'instagram_business_basic' }] }) : json({ access_token: 'ig-long', token_type: 'bearer', expires_in: 5184000 }), async calls => {
    const value = await (await call(env, '/v1/oauth/instagram/token', { body: tokenBody('instagram') })).json();
    assert.deepEqual(value, { v: 1, access_token: 'ig-long', token_type: 'bearer', expires_in: 5184000, long_lived: true });
    assert.equal(calls[0].url, 'https://api.instagram.com/oauth/access_token');
    assert.deepEqual(form(calls[0].body), { client_id: 'instagram-app-id', client_secret: 'instagram-secret', grant_type: 'authorization_code', redirect_uri: REDIRECTS.instagram, code: 'synthetic-code' });
    assert.ok(calls[1].url.startsWith('https://graph.instagram.com/access_token?'));
    assert.deepEqual(query(calls[1].url), { grant_type: 'ig_exchange_token', client_secret: 'instagram-secret', access_token: 'ig-short' });
  });
});

test('Facebook exchange uses code then fb_exchange_token on Graph v25.0', async () => {
  const { env } = makeEnv();
  await withProvider((request, n) => n === 1 ? json({ access_token: 'fb-short', token_type: 'bearer', expires_in: 3600 }) : json({ access_token: 'fb-long', token_type: 'bearer', expires_in: 5183000 }), async calls => {
    const value = await (await call(env, '/v1/oauth/facebook/token', { body: tokenBody('facebook') })).json();
    assert.deepEqual(value, { v: 1, access_token: 'fb-long', token_type: 'bearer', expires_in: 5183000, long_lived: true });
    assert.ok(calls.every(c => c.method === 'GET' && c.url.startsWith('https://graph.facebook.com/v25.0/oauth/access_token?')));
    assert.deepEqual(query(calls[0].url), { client_id: 'facebook-app-id', redirect_uri: REDIRECTS.facebook, client_secret: 'facebook-secret', code: 'synthetic-code' });
    assert.deepEqual(query(calls[1].url), { grant_type: 'fb_exchange_token', client_id: 'facebook-app-id', client_secret: 'facebook-secret', fb_exchange_token: 'fb-short' });
  });
});

test('provider errors map to provider_rejected or provider_unavailable without echoing provider text', async t => {
  const seen = noConsole(t);
  const { env } = makeEnv();
  const marker = 'provider-raw-error-marker';
  const cases = [
    [() => json({ error: 'invalid_grant', error_description: marker }, 400), 401, 'provider_rejected', false],
    [() => json({ error: 'invalid_request', error_description: marker }), 401, 'provider_rejected', false],
    [() => json({ access_token: '', expires_in: 10 }), 401, 'provider_rejected', false],
    [() => json({ access_token: 'at' }), 401, 'provider_rejected', false],
    [() => new Response(marker, { status: 503 }), 502, 'provider_unavailable', true],
    [() => new Response(`<html>${marker}`, { status: 200 }), 502, 'provider_unavailable', true],
    [() => { throw new TypeError(marker); }, 502, 'provider_unavailable', true],
  ];
  for (const [respond, status, code, retryable] of cases) {
    await withProvider(respond, async () => {
      const response = await call(env, '/v1/oauth/naver_blog/token', { body: tokenBody('naver_blog') });
      const text = await response.text();
      assert.ok(!text.includes(marker));
      assert.equal(response.status, status);
      assert.deepEqual(JSON.parse(text), { v: 1, error: { code, retryable } });
    });
  }
  await withProvider((request, n) => n === 1 ? json({ access_token: 'short' }) : json({ error: { message: marker } }, 400), async () => {
    await expectError(await call(env, '/v1/oauth/threads/token', { body: tokenBody('threads') }), 401, 'provider_rejected');
  });
  assert.equal(seen.length, 0);
});

test('refresh routes TikTok, Naver, and Facebook through the provider and refuses Threads and Instagram', async () => {
  const { env, limiterCalls } = makeEnv();
  await withProvider(() => json({ access_token: 'new-at', expires_in: '7200', refresh_token: 'new-rt', refresh_expires_in: 999, token_type: 'Bearer', scope: 'user.info.basic' }), async calls => {
    const tiktok = await (await call(env, '/v1/oauth/tiktok/refresh', { body: { refreshToken: 'old-rt' } })).json();
    assert.deepEqual(tiktok, { v: 1, access_token: 'new-at', token_type: 'bearer', expires_in: 7200, refresh_token: 'new-rt', refresh_expires_in: 999, scope: 'user.info.basic', long_lived: false });
    assert.equal(calls[0].url, 'https://open.tiktokapis.com/v2/oauth/token/');
    assert.deepEqual(form(calls[0].body), { grant_type: 'refresh_token', refresh_token: 'old-rt', client_key: 'tiktok-client-key', client_secret: 'tiktok-secret' });
    await call(env, '/v1/oauth/naver_blog/refresh', { body: { refreshToken: 'naver-old' } });
    assert.equal(calls[1].url, 'https://nid.naver.com/oauth2.0/token');
    assert.deepEqual(form(calls[1].body), { grant_type: 'refresh_token', client_id: 'naver-login-id', client_secret: 'naver-login-secret', refresh_token: 'naver-old' });
    const facebook = await (await call(env, '/v1/oauth/facebook/refresh', { body: { accessToken: 'fb-old' } })).json();
    assert.equal(facebook.long_lived, true);
    assert.deepEqual(query(calls[2].url), { grant_type: 'fb_exchange_token', client_id: 'facebook-app-id', client_secret: 'facebook-secret', fb_exchange_token: 'fb-old' });
    assert.equal(calls.length, 3);
    for (const platform of ['threads', 'instagram']) {
      await expectError(await call(env, `/v1/oauth/${platform}/refresh`, { body: { accessToken: 'x' } }), 404, 'unsupported_platform');
    }
    await expectError(await call(env, '/v1/oauth/tiktok/refresh', { body: { accessToken: 'wrong-field' } }), 400, 'bad_request');
    await expectError(await call(env, '/v1/oauth/facebook/refresh', { body: { refreshToken: 'wrong-field' } }), 400, 'bad_request');
    await expectError(await call(env, '/v1/oauth/tiktok/refresh', { body: { refreshToken: 'x'.repeat(4097) } }), 400, 'bad_request');
    assert.equal(calls.length, 3);
  });
  assert.ok(limiterCalls.every(c => c.name === 'refresh'));
});

const SEARCH_RESPONSE = {
  lastBuildDate: 'synthetic', total: 1234, start: 1, display: 2,
  items: [
    { title: '<b>요가</b> 일기', link: 'https://blog.naver.com/a/1', description: '설명', bloggername: '작성자', bloggerlink: 'blog.naver.com/a', postdate: '20261119', extra: 'drop-me' },
    { title: 't2', link: 'https://blog.naver.com/b/2', description: 'd2', bloggername: 'b', bloggerlink: 'blog.naver.com/b', postdate: '20261118', tracking: 'drop' },
  ],
};

test('blog search calls Naver with fixed headers and passes only allowed fields', async t => {
  const seen = noConsole(t);
  const { env, limiterCalls } = makeEnv();
  await withProvider(() => json(SEARCH_RESPONSE), async calls => {
    const response = await call(env, '/v1/naver/search/blog', { body: { query: '요가 & 필라테스', display: 2, start: 1, sort: 'date' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      v: 1, total: 1234, start: 1, display: 2,
      items: SEARCH_RESPONSE.items.map(({ title, link, description, bloggername, bloggerlink, postdate }) => ({ title, link, description, bloggername, bloggerlink, postdate })),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.ok(calls[0].url.startsWith('https://openapi.naver.com/v1/search/blog.json?'));
    assert.deepEqual(query(calls[0].url), { query: '요가 & 필라테스', display: '2', start: '1', sort: 'date' });
    assert.equal(calls[0].headers['x-naver-client-id'], 'naver-search-id');
    assert.equal(calls[0].headers['x-naver-client-secret'], 'naver-search-secret');
  });
  assert.deepEqual(limiterCalls, [{ name: 'search', key: '203.0.113.7' }]);
  assert.equal(seen.length, 0);
});

test('blog search applies defaults and validates input', async () => {
  const { env } = makeEnv();
  await withProvider(() => json(SEARCH_RESPONSE), async calls => {
    await call(env, '/v1/naver/search/blog', { body: { query: 'q' } });
    assert.deepEqual(query(calls[0].url), { query: 'q', display: '20', start: '1', sort: 'sim' });
    for (const body of [{ query: '' }, { query: '   ' }, { query: 'x'.repeat(101) }, { query: 'a\nb' }, { query: 'q', display: 0 }, { query: 'q', display: 101 }, { query: 'q', start: 1001 }, { query: 'q', start: 1.5 }, { query: 'q', sort: 'rank' }, { query: 'q', extra: true }, { query: 7 }]) {
      await expectError(await call(env, '/v1/naver/search/blog', { body }), 400, 'bad_request');
    }
    assert.equal(calls.length, 1);
  });
});

test('blog search stops at the daily budget with 429 quota_exhausted and stores only day and count', async () => {
  const { env, storage } = makeEnv({ NAVER_SEARCH_DAILY_BUDGET: '2' });
  await withProvider(() => json(SEARCH_RESPONSE), async calls => {
    assert.equal((await call(env, '/v1/naver/search/blog', { body: { query: 'secret-query-a' } })).status, 200);
    assert.equal((await call(env, '/v1/naver/search/blog', { body: { query: 'secret-query-b' } })).status, 200);
    const value = await expectError(await call(env, '/v1/naver/search/blog', { body: { query: 'secret-query-c' } }), 429, 'quota_exhausted');
    assert.equal(value.error.retryable, true);
    assert.equal(calls.length, 2);
  });
  assert.deepEqual([...storage.map.keys()], ['usage']);
  const usage = storage.map.get('usage');
  assert.deepEqual(Object.keys(usage).sort(), ['count', 'day']);
  assert.equal(usage.count, 2);
  assert.match(usage.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!JSON.stringify([...storage.map]).includes('secret-query'));
});

test('budget counter resets on a new day', async () => {
  const storage = new MemoryStorage();
  const budget = new SearchBudget({ storage });
  const consume = day => budget.fetch(new Request('https://budget/consume', { method: 'POST', body: JSON.stringify({ day, limit: 1 }) })).then(r => r.json());
  assert.deepEqual(await consume('2026-11-20'), { allowed: true });
  assert.deepEqual(await consume('2026-11-20'), { allowed: false });
  assert.deepEqual(await consume('2026-11-21'), { allowed: true });
  assert.deepEqual(storage.map.get('usage'), { day: '2026-11-21', count: 1 });
});

test('Naver search 429 maps to quota_exhausted and other failures to provider_unavailable', async () => {
  const { env } = makeEnv();
  await withProvider(() => json({ errorCode: '010' }, 429), async () => {
    await expectError(await call(env, '/v1/naver/search/blog', { body: { query: 'q' } }), 429, 'quota_exhausted');
  });
  await withProvider(() => json({ errorCode: '024' }, 401), async () => {
    await expectError(await call(env, '/v1/naver/search/blog', { body: { query: 'q' } }), 502, 'provider_unavailable');
  });
});

test('missing server configuration fails closed as internal without leaking details', async () => {
  for (const overrides of [{ STATE_SIGNING_KEYS: 'not json' }, { STATE_KEY_ID: 'absent' }, { START_LIMITER: undefined }, { MIN_APP_VERSION: 'x' }]) {
    const { env } = makeEnv(overrides);
    const response = await call(env, '/v1/oauth/tiktok/start', { body: { purpose: 'read', challenge: CHALLENGE } });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { v: 1, error: { code: 'internal', retryable: true } });
  }
});

test('Worker source has no console calls; deploy config disables logs and declares bindings', async () => {
  const source = await readFile(new URL('./worker.ts', import.meta.url), 'utf8');
  assert.ok(!/\bconsole\s*\./.test(source));
  const config = JSON.parse((await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.name, 'toris-oauth-broker');
  assert.equal(config.observability.logs.enabled, false);
  assert.equal(config.observability.logs.invocation_logs, false);
  assert.equal(config.logpush, undefined);
  assert.equal(config.tail_consumers, undefined);
  // The zone route is needed because toris-site owns a wildcard route that would otherwise answer first.
  assert.deepEqual(config.routes, [
    { pattern: 'oauth.toris.kr', custom_domain: true },
    { pattern: 'oauth.toris.kr/*', zone_name: 'toris.kr' },
  ]);
  assert.deepEqual(Object.fromEntries(config.ratelimits.map(r => [r.name, r.simple])), {
    START_LIMITER: { limit: 20, period: 60 }, TOKEN_LIMITER: { limit: 10, period: 60 },
    REFRESH_LIMITER: { limit: 30, period: 60 }, SEARCH_LIMITER: { limit: 30, period: 60 },
  });
  assert.deepEqual(config.durable_objects.bindings, [{ name: 'SEARCH_BUDGET', class_name: 'SearchBudget' }]);
  for (const secret of ['TIKTOK_CLIENT_SECRET', 'THREADS_APP_SECRET', 'INSTAGRAM_APP_SECRET', 'FACEBOOK_APP_SECRET', 'NAVER_LOGIN_CLIENT_SECRET', 'NAVER_SEARCH_CLIENT_SECRET', 'STATE_SIGNING_KEYS']) {
    assert.equal(config.vars[secret], undefined, secret);
  }
});
