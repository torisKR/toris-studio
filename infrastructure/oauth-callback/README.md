# Instagram HTTPS callback

This is an isolated, reviewed addition to the existing `toris-site` Cloudflare Worker. It was deployed and verified on 2026-10-08; the deployment version and verification evidence are recorded in `deploy-manifest.json`.

The exact callback is `https://toris.kr/oauth/instagram/callback`. It serves static Korean instructions for importing the browser callback address into Toris Studio. The Rust desktop app validates OAuth state, exchanges the code, and saves tokens in the OS credential store. The Worker never reads a code or token and has no credentials, JavaScript in the page, remote assets, query reflection, proxy request, or console logging on this route.

Callback responses disable caching, referrer transmission, framing, scripts, and MIME sniffing. Only GET and HEAD are allowed; other methods return 405 before reaching the Sites upstream. All existing homepage, ordinary proxy paths, canonical redirects, request forwarding, upstream response headers, and Location rewriting remain unchanged. The trailing-slash path is intentionally not registered as an OAuth callback.

Workers invocation logs contain request URLs, so the isolated Wrangler configuration explicitly disables Workers logs and invocation logs. Before deployment the live settings contained no observability configuration, Logpush was disabled, and no tail consumers were registered. These options control Worker logging, not every account-level Cloudflare data product. The fetched live Worker had no console calls or callback guard. [Cloudflare Workers Logs documentation](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs).

## Review and verification

`deploy-manifest.json` lists the only deployment files, SHA-256 values, live baseline evidence, and preparation status. `toris-site-worker.patch` applies to `worker/index.ts` in toris-site; it does not mutate that working tree automatically.

```sh
node --test infrastructure/oauth-callback/callback.test.mjs
node infrastructure/oauth-callback/verify-baseline.mjs /private/tmp/toris-site-live-before-instagram.js
wrangler deploy --config infrastructure/oauth-callback/wrangler.jsonc --dry-run --outdir /private/tmp/toris-instagram-callback-dry-run
```

The baseline checker accepts only the SHA-256 of the already-reviewed live source. It compares eight ordinary requests with mocked upstream responses, then verifies that a synthetic callback caused one upstream request before the patch and zero afterward. No real authorization code is used in verification.

## Deployment handoff

Before publishing, review the callback and manifest, verify that the live Worker still matches the baseline, and retain the original Worker deployment for rollback. Then use the same config without `--dry-run`. Do not run the site's broad build/deploy command or include unrelated site files in this update.

After publishing, request the callback using an empty or synthetic query only. Confirm its HTTP headers and static body, then check the homepage and existing proxy response marker. Register this exact HTTPS callback in the Instagram app configuration before starting the desktop authorization flow. Never send a real authorization code to the existing unpatched Sites proxy.

Cloudflare authentication was verified with the existing Wrangler OAuth session; no additional token or provider secret is required in this directory. A private live-source backup and account metadata were kept under `/private/tmp` for the operator, not in the public repository. [Cloudflare Download Worker Script API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/get/), [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/).
