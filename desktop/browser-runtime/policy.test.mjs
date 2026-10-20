import test from 'node:test';
import assert from 'node:assert/strict';

test('link policy rejects malformed, credentials, scripts and oversize input', async () => {
  const policy = await import('./policy.mjs').catch(() => ({}));
  assert.equal(typeof policy.classifyUrl, 'function');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://a:b@example.com/', ' https://example.com', 'https://example.com\n', 'https://', 'a'.repeat(65537)]) assert.throws(() => policy.classifyUrl(url));
  assert.deepEqual(policy.classifyUrl('https://example.com/news'), { url: 'https://example.com/news', auth: false });
});
test('OAuth providers and generic authorization endpoints always hand off, without lookalike host matches', async () => {
  const { classifyUrl } = await import('./policy.mjs');
  for (const url of ['https://accounts.google.com/o/oauth2/v2/auth?state=secret', 'https://nid.naver.com/oauth2.0/authorize', 'https://www.threads.net/oauth/authorize', 'https://www.facebook.com/v25.0/dialog/oauth', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', 'https://example.com/connect/authorize?client_id=a&response_type=code', 'https://accounts.google.com/signin/v2/identifier', 'https://github.com/login/oauth/authorize']) assert.equal(classifyUrl(url).auth, true, url);
  assert.equal(classifyUrl('https://accounts.google.com.evil.test/news').auth, false);
});
test('handoff deduplicates only identical auth URLs, bounds memory and expires entries', async () => {
  const { createHandoff } = await import('./policy.mjs');
  let now = 0; const seen = []; const handoff = createHandoff(url => seen.push(url), { now: () => now, ttlMs: 10, capacity: 2 });
  assert.equal(handoff('https://accounts.google.com/o/oauth2/auth?state=secret'), true);
  assert.equal(handoff('https://accounts.google.com/o/oauth2/auth?state=secret'), false);
  assert.equal(handoff('https://accounts.google.com/o/oauth2/auth?state=other'), true);
  now = 11; assert.equal(handoff('https://accounts.google.com/o/oauth2/auth?state=secret'), true);
  assert.equal(seen.length, 3);
});
test('encoded auth path, case-insensitive query, callbacks and login pages use system', async () => {
 const {classifyUrl}=await import('./policy.mjs');
 for(const url of ['https://example.com/%6f%61uth/authorize','https://example.com/path?CLIENT_ID=a','https://example.com/cb?state=s&code=c','https://example.com/cb?STATE=s&ACCESS_TOKEN=t','https://example.com/login','https://example.com/auth'])assert.equal(classifyUrl(url).auth,true,url);
});
test('public HTTP links and insecure redirects are rejected; local fixtures remain supported', async () => {
 const {classifyUrl}=await import('./policy.mjs');
 assert.throws(()=>classifyUrl('http://example.com/news'),/invalid_url/);
 for(const url of ['http://localhost:5000/page','http://127.0.0.1:5000/page','http://[::1]:5000/page'])assert.equal(classifyUrl(url).auth,false);
});
