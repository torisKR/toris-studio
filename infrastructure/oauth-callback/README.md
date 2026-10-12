# Sites proxy and Instagram HTTPS callback

The local `toris-site` Cloudflare Worker now fixes the Sites upstream origin for every forwarded request. The security update passes offline Worker tests and historical-source regression checks; public deployment is pending. The Instagram callback deployment verified on 2026-10-08 is historical evidence, preserved under `historicalDeployment` in `deploy-manifest.json`. Its version and checks do not establish that the current local security update is publicly deployed.

The proxy constructs its URL from the trusted Sites origin and assigns pathname and search separately. Leading double slashes, normalized backslashes, and encoded delimiters remain path data. Request methods, bodies, and headers still reach the same Sites server. Upstream `Location` values are parsed and rewritten only when their origin exactly matches Sites and contains no username or password. Relative redirects resolve against the requested upstream page and become absolute public URLs. Default HTTPS port 443 is equivalent; other ports, schemes, suffix/lookalike hosts, credential-bearing URLs, and malformed URLs remain unchanged.

The exact callback is `https://toris.kr/oauth/instagram/callback`. It serves static Korean instructions for importing the browser callback address into Toris Studio. The Rust desktop app validates OAuth state, exchanges the code, and saves tokens in the OS credential store. The Worker never reads a code or token and has no credentials, JavaScript in the page, remote assets, query reflection, proxy request, or console logging on this route.

Callback responses disable caching, referrer transmission, framing, scripts, and MIME sniffing. Only GET and HEAD are allowed; other methods return 405 before reaching the Sites upstream. Homepage and ordinary proxy paths, canonical redirects, forwarded requests, upstream response headers, and legitimate absolute Location rewriting retain their behavior. The trailing-slash path is intentionally not registered as an OAuth callback.

Workers invocation logs contain request URLs, so the isolated Wrangler configuration explicitly disables Workers logs and invocation logs. Historical checks before the 2026-10-08 deployment found no observability configuration, Logpush, or tail consumers. Current account settings were not inspected during the local security update. These options control Worker logging, not every account-level Cloudflare data product. [Cloudflare Workers Logs documentation](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs).

## Review and verification

`deploy-manifest.json` lists the current deployment files, SHA-256 values, local verification results, pending deployment status, and separately labeled historical evidence. `toris-site-worker.patch` applies the complete callback and proxy security behavior to the reviewed original `worker/index.ts` in toris-site; it does not mutate that working tree automatically.

```sh
node --import tsx --test infrastructure/oauth-callback/callback.test.mjs
node --import tsx infrastructure/oauth-callback/verify-baseline.mjs /path/to/reviewed-historical-worker.ts
```

All 13 tests invoke the actual local Worker with mocked fetch. They cover fixed-host path variants, method/body copying, callback isolation, normal requests, canonical redirects, exact-origin redirect rewriting, and unchanged lookalike or credential-bearing redirects. The patch was applied to a temporary copy of the original tracked source and matched `worker.ts` byte for byte.

The baseline checker accepts only the SHA-256 of the reviewed original tracked source or historical live backup. It compares eight ordinary requests with mocked upstream responses, verifies callback isolation, and demonstrates the repaired network-path forwarding and lookalike-redirect behavior. The local run used the original tracked source reconstructed from repository history, rather than inspecting a public Worker. No network request or real authorization code is used in these checks. No Wrangler dry run or deployment was performed for this security update; the manifest retains the earlier dry run as historical evidence.

## Deployment handoff

Before publishing, review the fixed Worker and manifest, compare the current public Worker with the historical deployment evidence, and retain its deployment for rollback. Run an isolated Wrangler dry run and then deploy this directory's config when authorized. Do not run the site's broad build/deploy command or include unrelated site files in this update.

After publishing, request the callback using an empty or synthetic query only. Confirm its HTTP headers and static body, then check the homepage and existing proxy response marker. Register this exact HTTPS callback in the Instagram app configuration before starting the desktop authorization flow. Never send a real authorization code to the existing unpatched Sites proxy.

Cloudflare authentication was verified with an existing Wrangler OAuth session for the historical deployment. Authentication and private backups were not accessed during this local update. No token or provider secret belongs in this directory. [Cloudflare Download Worker Script API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/get/), [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/).
