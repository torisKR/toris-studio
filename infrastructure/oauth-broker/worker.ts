// Toris OAuth Broker v1. Exchanges provider codes with server-held secrets and returns tokens to the app.
// Nothing about a request is stored or logged: no console calls, no request/response bodies, queries,
// provider error text, tokens, codes, search terms, or IPs. The only stored data is the daily search count.

type Platform = 'tiktok' | 'threads' | 'instagram' | 'facebook' | 'naver_blog';
type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
type DurableStub = { fetch(url: string, init: RequestInit): Promise<Response> };
type DurableNamespace = { idFromName(name: string): unknown; get(id: unknown): DurableStub };
type DurableStorage = { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> };
type Json = Record<string, unknown>;

export interface Env {
  TIKTOK_CLIENT_KEY?: string; THREADS_APP_ID?: string; INSTAGRAM_APP_ID?: string; FACEBOOK_APP_ID?: string;
  NAVER_LOGIN_CLIENT_ID?: string; NAVER_SEARCH_CLIENT_ID?: string;
  TIKTOK_CLIENT_SECRET?: string; THREADS_APP_SECRET?: string; INSTAGRAM_APP_SECRET?: string; FACEBOOK_APP_SECRET?: string;
  NAVER_LOGIN_CLIENT_SECRET?: string; NAVER_SEARCH_CLIENT_SECRET?: string;
  STATE_SIGNING_KEYS?: string; STATE_KEY_ID?: string; MIN_APP_VERSION?: string; ENABLED_PLATFORMS?: string;
  NAVER_SEARCH_DAILY_BUDGET?: string;
  START_LIMITER?: Limiter; TOKEN_LIMITER?: Limiter; REFRESH_LIMITER?: Limiter; SEARCH_LIMITER?: Limiter;
  SEARCH_BUDGET?: DurableNamespace;
}

const PLATFORMS: readonly Platform[] = ['tiktok', 'threads', 'instagram', 'facebook', 'naver_blog'];
const META: readonly Platform[] = ['threads', 'instagram', 'facebook'];
const REDIRECT: Record<Platform, string> = {
  tiktok: 'http://127.0.0.1:38471/oauth/tiktok/callback',
  naver_blog: 'http://127.0.0.1:38471/oauth/naver_blog/callback',
  threads: 'https://toris.kr/oauth/threads/callback',
  instagram: 'https://toris.kr/oauth/instagram/callback',
  facebook: 'https://toris.kr/oauth/facebook/callback',
};
const CLIENT: Record<Platform, [keyof Env, keyof Env]> = {
  tiktok: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
  threads: ['THREADS_APP_ID', 'THREADS_APP_SECRET'],
  instagram: ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'],
  facebook: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],
  naver_blog: ['NAVER_LOGIN_CLIENT_ID', 'NAVER_LOGIN_CLIENT_SECRET'],
};
const TIKTOK_TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/';
const NAVER_TOKEN = 'https://nid.naver.com/oauth2.0/token';
const FACEBOOK_TOKEN = 'https://graph.facebook.com/v25.0/oauth/access_token';
const NAVER_BLOG_SEARCH = 'https://openapi.naver.com/v1/search/blog.json';
const STATE_TTL_SECONDS = 600;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_PROVIDER_BYTES = 256 * 1024;
const PROVIDER_TIMEOUT_MS = 10_000;
const RATE_LIMIT_RETRY_SECONDS = '60';
const KST_OFFSET_MS = 9 * 3600 * 1000;
const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const PRINTABLE = /^[\x21-\x7e]+$/;
const APP_UA = /^TorisStudio\/(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

type Code = 'bad_request' | 'unsupported_platform' | 'origin_forbidden' | 'state_invalid' | 'state_expired'
  | 'verifier_mismatch' | 'redirect_mismatch' | 'provider_rejected' | 'provider_unavailable' | 'rate_limited'
  | 'quota_exhausted' | 'upgrade_required' | 'internal';
const ERRORS: Record<Code, [number, boolean]> = {
  bad_request: [400, false], unsupported_platform: [404, false], origin_forbidden: [403, false],
  state_invalid: [400, false], state_expired: [400, false], verifier_mismatch: [400, false], redirect_mismatch: [400, false],
  provider_rejected: [401, false], provider_unavailable: [502, true], rate_limited: [429, true],
  quota_exhausted: [429, true], upgrade_required: [426, false], internal: [500, true],
};

class Failure extends Error {
  constructor(readonly code: Code, readonly extra: Json = {}, readonly retryAfter?: string) { super(code); }
}
const fail = (code: Code): never => { throw new Failure(code); };

function reply(body: Json, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ v: 1, ...body }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff', 'toris-broker-version': '1', ...extraHeaders,
    },
  });
}

function errorReply(failure: Failure): Response {
  const [status, retryable] = ERRORS[failure.code];
  return reply({ error: { code: failure.code, retryable }, ...failure.extra }, status, failure.retryAfter ? { 'retry-after': failure.retryAfter } : {});
}

// ---- encoding and constant-time helpers ----
const encoder = new TextEncoder();
function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}
/** Compares without an early exit so timing does not reveal the matching prefix. */
function sameText(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
async function sha256(value: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

// ---- configuration ----
function signingKeys(env: Env): Record<string, Uint8Array<ArrayBuffer>> {
  let parsed: unknown;
  try { parsed = JSON.parse(env.STATE_SIGNING_KEYS ?? ''); } catch { return fail('internal'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('internal');
  const entries = Object.entries(parsed as Json);
  if (entries.length < 1 || entries.length > 2) return fail('internal');
  const keys: Record<string, Uint8Array<ArrayBuffer>> = Object.create(null);
  for (const [kid, value] of entries) {
    if (typeof value !== 'string') return fail('internal');
    let key: Uint8Array<ArrayBuffer>;
    try { key = fromBase64(value); } catch { return fail('internal'); }
    if (key.length !== 32) return fail('internal');
    keys[kid] = key;
  }
  if (!env.STATE_KEY_ID || !keys[env.STATE_KEY_ID]) return fail('internal');
  return keys;
}

function checkAppVersion(request: Request, env: Env): void {
  const min = SEMVER.exec(env.MIN_APP_VERSION ?? '')?.slice(1).map(Number) ?? fail('internal');
  const app = APP_UA.exec(request.headers.get('user-agent') ?? '')?.slice(1).map(Number);
  // Pre-release suffixes are ignored: 0.8.0-rc.1 counts as 0.8.0.
  const order = app ? app.map((part, i) => part - min[i]).find(d => d !== 0) ?? 0 : -1;
  if (order < 0) throw new Failure('upgrade_required', { minAppVersion: env.MIN_APP_VERSION });
}

function platformEnabled(env: Env, platform: Platform): boolean {
  const enabled = (env.ENABLED_PLATFORMS ?? '').split(',').map(p => p.trim());
  const [id, secret] = CLIENT[platform];
  return enabled.includes(platform) && Boolean(env[id]) && Boolean(env[secret]);
}

function dailyBudget(env: Env): number {
  const budget = Number(env.NAVER_SEARCH_DAILY_BUDGET ?? '');
  return Number.isSafeInteger(budget) && budget > 0 && env.NAVER_SEARCH_CLIENT_ID && env.NAVER_SEARCH_CLIENT_SECRET ? budget : 0;
}

async function rateLimit(request: Request, limiter: Limiter | undefined): Promise<void> {
  if (!limiter) return fail('internal');
  // The IP is only a limiter key; this Worker never stores or returns it.
  const { success } = await limiter.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unknown' });
  if (!success) throw new Failure('rate_limited', {}, RATE_LIMIT_RETRY_SECONDS);
}

// ---- request body ----
async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<string | null> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(all); } catch { return null; }
}

async function readJson(request: Request, allowed: readonly string[]): Promise<Json> {
  if (request.method !== 'POST') return fail('bad_request');
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return fail('bad_request');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return fail('bad_request');
  const raw = await readCapped(request.body, MAX_BODY_BYTES);
  if (raw === null) return fail('bad_request');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail('bad_request'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('bad_request');
  if (Object.keys(value).some(key => !allowed.includes(key))) return fail('bad_request');
  return value as Json;
}

function field(value: unknown, pattern: RegExp, max: number): string {
  return typeof value === 'string' && value.length <= max && pattern.test(value) ? value : fail('bad_request');
}

// ---- state ----
function hmacKey(key: Uint8Array<ArrayBuffer>, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

async function signState(env: Env, platform: Platform, purpose: string, challenge: string): Promise<{ state: string; expires: number }> {
  const keys = signingKeys(env);
  const kid = env.STATE_KEY_ID as string;
  const expires = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const payload = b64url(encoder.encode(JSON.stringify({ k: kid, p: platform, u: purpose, c: challenge, n: nonce, e: expires })));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(keys[kid], 'sign'), encoder.encode(payload));
  return { state: `${payload}.${b64url(new Uint8Array(signature))}`, expires };
}

type StatePayload = { k: string; p: string; c: string; e: number };
async function verifyState(env: Env, state: string): Promise<StatePayload> {
  const keys = signingKeys(env);
  const parts = state.split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return fail('state_invalid');
  let payload: Partial<StatePayload> | null;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromBase64(parts[0])));
    signature = fromBase64(parts[1]);
  } catch { return fail('state_invalid'); }
  if (!payload || typeof payload !== 'object' || typeof payload.k !== 'string' || !Object.hasOwn(keys, payload.k)) return fail('state_invalid');
  const signed = await crypto.subtle.verify('HMAC', await hmacKey(keys[payload.k], 'verify'), signature, encoder.encode(parts[0]));
  if (!signed) return fail('state_invalid');
  if (typeof payload.p !== 'string' || typeof payload.c !== 'string' || !Number.isSafeInteger(payload.e)) return fail('state_invalid');
  if ((payload.e as number) < Math.floor(Date.now() / 1000)) return fail('state_expired');
  return payload as StatePayload;
}

// ---- provider calls ----
async function provider(url: string, init: RequestInit = {}): Promise<{ status: number; body: Json | null }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch { return fail('provider_unavailable'); }
  const raw = await readCapped(response.body, MAX_PROVIDER_BYTES).catch(() => null);
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return { status: response.status, body: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : null };
  } catch { return { status: response.status, body: null }; }
}

const postForm = (url: string, fields: Record<string, string>) => provider(url, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(fields),
});
const getQuery = (url: string, fields: Record<string, string>) => provider(`${url}?${new URLSearchParams(fields)}`, { headers: { accept: 'application/json' } });

/** Provider 5xx, 429, or non-JSON is transient; any other answer without a token is a rejection. */
function tokenFrom({ status, body }: { status: number; body: Json | null }): Json {
  if (status >= 500 || status === 429 || !body) return fail('provider_unavailable');
  // Instagram wraps the short-lived token as {data:[{...}]}.
  const token = Array.isArray(body.data) && body.data[0] && typeof body.data[0] === 'object' ? body.data[0] as Json : body;
  if (status >= 300 || 'error' in token || typeof token.access_token !== 'string' || !token.access_token) return fail('provider_rejected');
  return token;
}

function seconds(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Only standard OAuth fields leave the broker, so the app can reuse its session parser. */
function normalized(token: Json, longLived: boolean): Json {
  const expires = seconds(token.expires_in) ?? fail('provider_rejected');
  const out: Json = { access_token: token.access_token, token_type: 'bearer', expires_in: expires };
  if (typeof token.refresh_token === 'string' && token.refresh_token) out.refresh_token = token.refresh_token;
  const refreshExpires = seconds(token.refresh_expires_in);
  if (refreshExpires !== undefined) out.refresh_expires_in = refreshExpires;
  if (typeof token.scope === 'string' && token.scope.length <= 8192) out.scope = token.scope;
  out.long_lived = longLived;
  return out;
}

function client(env: Env, platform: Platform): [string, string] {
  const [id, secret] = CLIENT[platform];
  return [env[id] as string, env[secret] as string];
}

async function facebookLongLived(id: string, secret: string, accessToken: string): Promise<Json> {
  return tokenFrom(await getQuery(FACEBOOK_TOKEN, { grant_type: 'fb_exchange_token', client_id: id, client_secret: secret, fb_exchange_token: accessToken }));
}

async function exchange(env: Env, platform: Platform, code: string, verifier: string, state: string): Promise<Json> {
  const [id, secret] = client(env, platform);
  const redirect = REDIRECT[platform];
  switch (platform) {
    case 'tiktok':
      return tokenFrom(await postForm(TIKTOK_TOKEN, { client_key: id, client_secret: secret, code, grant_type: 'authorization_code', redirect_uri: redirect, code_verifier: verifier }));
    case 'naver_blog':
      return tokenFrom(await postForm(NAVER_TOKEN, { grant_type: 'authorization_code', client_id: id, client_secret: secret, code, state }));
    case 'threads': {
      const short = tokenFrom(await postForm('https://graph.threads.net/oauth/access_token', { client_id: id, client_secret: secret, code, grant_type: 'authorization_code', redirect_uri: redirect }));
      return tokenFrom(await getQuery('https://graph.threads.net/access_token', { grant_type: 'th_exchange_token', client_secret: secret, access_token: short.access_token as string }));
    }
    case 'instagram': {
      const short = tokenFrom(await postForm('https://api.instagram.com/oauth/access_token', { client_id: id, client_secret: secret, grant_type: 'authorization_code', redirect_uri: redirect, code }));
      return tokenFrom(await getQuery('https://graph.instagram.com/access_token', { grant_type: 'ig_exchange_token', client_secret: secret, access_token: short.access_token as string }));
    }
    case 'facebook': {
      const short = tokenFrom(await getQuery(FACEBOOK_TOKEN, { client_id: id, redirect_uri: redirect, client_secret: secret, code }));
      return facebookLongLived(id, secret, short.access_token as string);
    }
  }
}

// ---- endpoints ----
function config(env: Env): Response {
  const platforms = Object.fromEntries(PLATFORMS.map(p => [p, { enabled: platformEnabled(env, p) }]));
  return reply({ minAppVersion: env.MIN_APP_VERSION, platforms, naverSearch: { enabled: dailyBudget(env) > 0 } });
}

async function start(request: Request, env: Env, platform: Platform): Promise<Response> {
  await rateLimit(request, env.START_LIMITER);
  const body = await readJson(request, ['purpose', 'challenge']);
  const purpose = body.purpose === 'read' || body.purpose === 'publish' ? body.purpose : fail('bad_request');
  const challenge = field(body.challenge, B64URL_43, 43);
  const { state, expires } = await signState(env, platform, purpose, challenge);
  const expiresAt = new Date(expires * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return reply({ state, clientId: client(env, platform)[0], redirectUri: REDIRECT[platform], expiresAt });
}

async function token(request: Request, env: Env, platform: Platform): Promise<Response> {
  await rateLimit(request, env.TOKEN_LIMITER);
  const body = await readJson(request, ['state', 'code', 'verifier', 'redirectUri']);
  const state = field(body.state, PRINTABLE, 1024);
  const code = field(body.code, PRINTABLE, 2048);
  const verifier = field(body.verifier, VERIFIER, 128);
  const redirectUri = field(body.redirectUri, PRINTABLE, 2048);
  // Order is part of the protocol: signature, expiry, platform, redirect, verifier, then the provider.
  const payload = await verifyState(env, state);
  if (!sameText(payload.p, platform)) return fail('state_invalid');
  if (!sameText(redirectUri, REDIRECT[platform])) return fail('redirect_mismatch');
  if (!sameText(await sha256(verifier), payload.c)) return fail('verifier_mismatch');
  return reply(normalized(await exchange(env, platform, code, verifier, state), META.includes(platform)));
}

async function refresh(request: Request, env: Env, platform: Platform): Promise<Response> {
  // Threads and Instagram refresh without a secret; the app calls them directly.
  if (platform === 'threads' || platform === 'instagram') return fail('unsupported_platform');
  await rateLimit(request, env.REFRESH_LIMITER);
  const [id, secret] = client(env, platform);
  if (platform === 'facebook') {
    const body = await readJson(request, ['accessToken']);
    return reply(normalized(await facebookLongLived(id, secret, field(body.accessToken, PRINTABLE, 4096)), true));
  }
  const body = await readJson(request, ['refreshToken']);
  const refreshToken = field(body.refreshToken, PRINTABLE, 4096);
  const result = platform === 'tiktok'
    ? await postForm(TIKTOK_TOKEN, { grant_type: 'refresh_token', refresh_token: refreshToken, client_key: id, client_secret: secret })
    : await postForm(NAVER_TOKEN, { grant_type: 'refresh_token', client_id: id, client_secret: secret, refresh_token: refreshToken });
  return reply(normalized(tokenFrom(result), false));
}

const SEARCH_ITEM_FIELDS = ['title', 'link', 'description', 'bloggername', 'bloggerlink', 'postdate'] as const;

function integerIn(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fail('bad_request');
}

async function consumeBudget(namespace: DurableNamespace, limit: number): Promise<boolean> {
  const day = new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
  const counter = namespace.get(namespace.idFromName('naver-search'));
  const response = await counter.fetch('https://budget/consume', { method: 'POST', body: JSON.stringify({ day, limit }) });
  return response.ok && (await response.json() as { allowed?: unknown }).allowed === true;
}

function searchItems(items: unknown[], display: number): Json[] {
  return items.slice(0, display).map(item => Object.fromEntries(SEARCH_ITEM_FIELDS.map(name => {
    const value = item && typeof item === 'object' ? (item as Json)[name] : undefined;
    return [name, typeof value === 'string' ? value : ''];
  })));
}

async function searchBlog(request: Request, env: Env): Promise<Response> {
  const budget = dailyBudget(env);
  if (!budget || !env.SEARCH_BUDGET) return fail('unsupported_platform');
  await rateLimit(request, env.SEARCH_LIMITER);
  const body = await readJson(request, ['query', 'display', 'start', 'sort']);
  const query = typeof body.query === 'string' ? body.query.trim() : fail('bad_request');
  if (!query || [...query].length > 100 || /\p{Cc}/u.test(query)) return fail('bad_request');
  const display = integerIn(body.display, 1, 100, 20);
  const startAt = integerIn(body.start, 1, 1000, 1);
  const sort = body.sort === undefined ? 'sim' : body.sort === 'sim' || body.sort === 'date' ? body.sort : fail('bad_request');
  if (!await consumeBudget(env.SEARCH_BUDGET, budget)) return fail('quota_exhausted');
  const params = new URLSearchParams({ query, display: String(display), start: String(startAt), sort });
  const { status, body: result } = await provider(`${NAVER_BLOG_SEARCH}?${params}`, {
    headers: { 'x-naver-client-id': env.NAVER_SEARCH_CLIENT_ID as string, 'x-naver-client-secret': env.NAVER_SEARCH_CLIENT_SECRET as string, accept: 'application/json' },
  });
  if (status === 429) return fail('quota_exhausted');
  if (status !== 200 || !result || !Array.isArray(result.items)) return fail('provider_unavailable');
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return reply({ total: count(result.total), start: count(result.start), display: count(result.display), items: searchItems(result.items, display) });
}

async function route(request: Request, env: Env): Promise<Response> {
  // Native apps never send Origin; refusing it keeps web pages from using the broker through a browser.
  if (request.headers.has('origin')) return fail('origin_forbidden');
  checkAppVersion(request, env);
  const { pathname } = new URL(request.url);
  if (pathname === '/v1/config') return request.method === 'GET' ? config(env) : fail('bad_request');
  if (pathname === '/v1/naver/search/blog') return searchBlog(request, env);
  const match = /^\/v1\/oauth\/([^/]+)\/(start|token|refresh)$/.exec(pathname);
  if (!match) return fail('bad_request');
  const platform = PLATFORMS.find(p => p === match[1]);
  if (!platform || !platformEnabled(env, platform)) return fail('unsupported_platform');
  if (match[2] === 'start') return start(request, env, platform);
  if (match[2] === 'token') return token(request, env, platform);
  return refresh(request, env, platform);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      // Unexpected exceptions become a bare code; their messages may contain request data.
      return errorReply(error instanceof Failure ? error : new Failure('internal'));
    }
  },
};

/** Durable Object holding the shared Naver search count: one record of {day, count}, nothing else. */
export class SearchBudget {
  constructor(private readonly state: { storage: DurableStorage }) {}

  async fetch(request: Request): Promise<Response> {
    const { day, limit } = await request.json() as { day?: unknown; limit?: unknown };
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof limit !== 'number' || !Number.isSafeInteger(limit)) {
      return new Response(null, { status: 400 });
    }
    const usage = await this.state.storage.get('usage') as { day: string; count: number } | undefined;
    const used = usage?.day === day ? usage.count : 0;
    if (used >= limit) return Response.json({ allowed: false });
    await this.state.storage.put('usage', { day, count: used + 1 });
    return Response.json({ allowed: true });
  }
}
