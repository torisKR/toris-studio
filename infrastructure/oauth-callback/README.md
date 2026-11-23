# Sites proxy and Meta HTTPS callback relay

The local `toris-site` Cloudflare Worker now fixes the Sites upstream origin for every forwarded request. The security update passes offline Worker tests and historical-source regression checks; public deployment is pending. The Instagram callback deployment verified on 2026-10-08 is historical evidence, preserved under `historicalDeployment` in `deploy-manifest.json`. Its version and checks do not establish that the current local security update is publicly deployed.

The proxy constructs its URL from the trusted Sites origin and assigns pathname and search separately. Leading double slashes, normalized backslashes, and encoded delimiters remain path data. Request methods, bodies, and headers still reach the same Sites server. Upstream `Location` values are parsed and rewritten only when their origin exactly matches Sites and contains no username or password. Relative redirects resolve against the requested upstream page and become absolute public URLs. Default HTTPS port 443 is equivalent; other ports, schemes, suffix/lookalike hosts, credential-bearing URLs, and malformed URLs remain unchanged.

The exact callback `https://toris.kr/oauth/instagram/callback` still serves static Korean instructions for importing the browser callback address into Toris Studio, unless the request carries a Toris broker state (next section). The Rust desktop app validates OAuth state, exchanges the code (directly or through the Toris broker), and saves tokens in the OS credential store. The Worker never exchanges a code and has no credentials, JavaScript in the page, remote assets, proxy request, or console logging on this route; the static page never reflects the query.

Callback responses disable caching, referrer transmission, framing, scripts, and MIME sniffing. Only GET and HEAD are allowed; other methods return 405 before reaching the Sites upstream. Homepage and ordinary proxy paths, canonical redirects, forwarded requests, upstream response headers, and legitimate absolute Location rewriting retain their behavior. The trailing-slash path is intentionally not registered as an OAuth callback.

Workers invocation logs contain request URLs, so the isolated Wrangler configuration explicitly disables Workers logs and invocation logs. Historical checks before the 2026-10-08 deployment found no observability configuration, Logpush, or tail consumers. Current account settings were not inspected during the local security update. These options control Worker logging, not every account-level Cloudflare data product. [Cloudflare Workers Logs documentation](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs).

## Meta HTTPS callback relay for broker logins (security review required)

**This change makes an exception to the earlier rule that callback queries are never reflected, so it needs a security review before deployment.** When `https://toris.kr/oauth/{threads|instagram|facebook}/callback` receives a GET or HEAD whose `state` has the shape of a Toris OAuth Broker state, the Worker answers `302` to the desktop app's loopback listener at `http://127.0.0.1:38471/oauth/{platform}/callback`. Meta accepts only HTTPS redirect URIs, and the relay removes the paste step for broker logins.

- Broker shape: exactly one `state` of the form `base64url(payload).base64url(signature)`. The payload part must be at most 512 characters and decode to a JSON object whose `p` equals the path's platform, with a string `k` and an integer `e`. The Worker has no signing key and checks the shape only. **This chooses a route; it is not a security control.** A forged broker-shaped state gains nothing: the broker verifies the HMAC, and its PKCE verifier binding makes an intercepted code useless.
- Any other state keeps the earlier behavior unchanged: Instagram serves the static, non-reflecting page above (405 for other methods), and Threads and Facebook stay on the Sites proxy. So users whose own developer app registers a `toris.kr` callback, and older app versions, keep the paste flow. A broken base64 or JSON payload, a platform mismatch, a duplicated `state`, or an oversized payload also falls back.
- For broker-shaped requests, only `code`, `state`, `error`, and `error_reason` are copied, in that fixed order. Every other key is dropped. Each copied value must be 1–2048 characters of `A-Z a-z 0-9 . _ ~ -`. A duplicated key, a bad or oversized value, or a response with neither `code` nor `error` returns a static `400` page that echoes nothing.
- Relay responses keep the callback security headers (`no-store`, `no-referrer`, CSP, `nosniff`, `DENY`, `noindex`), add `Location`, and have an empty body. Nothing reaches the Sites upstream and nothing is logged. Path matching is exact.

Risk: if the app is not running, another local process listening on port 38471 could receive the code. Without the PKCE verifier, held only in the app's memory, the broker refuses that code (see `infrastructure/oauth-broker/README.md`).

`deploy-manifest.json` and `toris-site-worker.patch` describe the previous `worker.ts` and must be regenerated at deployment time.

## Review and verification

`deploy-manifest.json` lists the current deployment files, SHA-256 values, local verification results, pending deployment status, and separately labeled historical evidence. `toris-site-worker.patch` applies the complete callback and proxy security behavior to the reviewed original `worker/index.ts` in toris-site; it does not mutate that working tree automatically.

```sh
node --import tsx --test infrastructure/oauth-callback/callback.test.mjs
node --import tsx infrastructure/oauth-callback/verify-baseline.mjs /path/to/reviewed-historical-worker.ts
```

All tests invoke the actual local Worker with mocked fetch. They cover fixed-host path variants, method/body copying, callback isolation, normal requests, canonical redirects, exact-origin redirect rewriting, and unchanged lookalike or credential-bearing redirects. The patch matched the previous `worker.ts` byte for byte; it does not include the Meta relay and must be regenerated.

The baseline checker accepts only the SHA-256 of the reviewed original tracked source or historical live backup. It compares eight ordinary requests with mocked upstream responses, verifies callback isolation, and demonstrates the repaired network-path forwarding and lookalike-redirect behavior. The local run used the original tracked source reconstructed from repository history, rather than inspecting a public Worker. No network request or real authorization code is used in these checks. No Wrangler dry run or deployment was performed for this security update; the manifest retains the earlier dry run as historical evidence.

## Deployment handoff

Before publishing, review the fixed Worker and manifest, compare the current public Worker with the historical deployment evidence, and retain its deployment for rollback. Run an isolated Wrangler dry run and then deploy this directory's config when authorized. Do not run the site's broad build/deploy command or include unrelated site files in this update.

After publishing, request the callback using an empty or synthetic query only. Confirm its HTTP headers and static body, then check the homepage and existing proxy response marker. Register this exact HTTPS callback in the Instagram app configuration before starting the desktop authorization flow. Never send a real authorization code to the existing unpatched Sites proxy.

Cloudflare authentication was verified with an existing Wrangler OAuth session for the historical deployment. Authentication and private backups were not accessed during this local update. No token or provider secret belongs in this directory. [Cloudflare Download Worker Script API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/get/), [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/).
