import { createHash } from 'node:crypto';
export const MAX_LINE_BYTES = 64 * 1024;
export function classifyUrl(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_LINE_BYTES - 1024 || /[\x00-\x20\x7f\\]/.test(value)) throw new Error('invalid_url');
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('invalid_url');
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new Error('invalid_url');
  const authHost = ['accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com', 'nid.naver.com', 'kauth.kakao.com'].includes(host);
  let decodedPath;
  try { decodedPath = decodeURIComponent(url.pathname); } catch { throw new Error('invalid_url'); }
  const authPath = /(?:^|\/)(?:oauth(?:2(?:\.0)?)?|authorize|authorization|signin|login|auth)(?:\/|$)/i.test(decodedPath) || /(?:^|\/)dialog\/oauth(?:\/|$)/i.test(url.pathname);
  const keys = new Set([...url.searchParams.keys()].map(key => key.toLowerCase()));
  const authParams = ['client_id', 'response_type', 'code_challenge', 'redirect_uri'].some(key => keys.has(key)) || (keys.has('state') && ['code', 'token', 'access_token', 'id_token'].some(key => keys.has(key)));
  return { url: url.href, auth: authHost || authPath || authParams };
}
export function createHandoff(emit, { now = Date.now, ttlMs = 30_000, capacity = 256 } = {}) {
  const sent = new Map();
  return value => {
    const { url, auth } = classifyUrl(value);
    if (!auth) return false;
    const time = now();
    for (const [key, expires] of sent) if (expires <= time) sent.delete(key);
    const key = createHash('sha256').update(url).digest('hex');
    if (sent.has(key)) return false;
    while (sent.size >= capacity) sent.delete(sent.keys().next().value);
    sent.set(key, time + ttlMs);
    emit(url);
    return true;
  };
}
