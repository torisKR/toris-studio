# Studio browser runtime

Rust owns the dedicated worker and browser process lifetime. The worker accepts
only fixed JSONL `open` / `shutdown` commands. It runs Playwright Library with a
headed persistent Chromium context and a Studio-owned profile, with service
workers and downloads disabled. OAuth navigation is handed back to Rust for the
system browser; normal output contains no URLs, page text, cookies, or raw errors.

Playwright's ordinary route handler only sees the first URL in an HTTP redirect
chain. The worker therefore installs Chromium Fetch interception on paused
browser targets before they resume. Playwright 1.63.0's guarded in-process
`CDPSession._connection.toImpl(session)._session.createChildSession` adapter is
required to address flattened CDP targets. The worker fails closed if this
pinned interface changes. No caller supplies CDP commands or JavaScript.

`resources/browser/manifest.json` pins the upstream Node, Playwright Core and
headed Chrome archives, SHA256 values, byte counts, architectures and licensing.
The preparation script validates bounded archives, preserves exactly the five
upstream macOS framework links, signs nested Mach-O components in depth order,
and places only Node and the actual Chrome application under macOS `Contents/Helpers/studio-browser`.
Worker, policy, Playwright Library, notices and outer Chromium auxiliary data are under
`Contents/Resources/studio-browser`; JavaScript is not treated as nested signed code. Only Node
and browser executables receive JIT entitlements; the Studio executable does not.
The app's existing macOS 12 floor is preserved, with runtime OS gating in Rust.

Run packaging/policy contracts with:

```sh
node --test scripts/prepare-browser.test.mjs scripts/prepare-codexify.test.mjs desktop/browser-runtime/policy.test.mjs desktop/browser-runtime/worker.test.mjs
```

Run the headed local fixture after preparing the host runtime:

```sh
node --test desktop/browser-runtime/fixture.test.mjs
```

The same fixture accepts `STUDIO_BROWSER_TEST_RUNTIME` pointing directly at an
extracted installer's `Contents/Resources/studio-browser` (macOS) or `studio-browser`
(Windows), and `STUDIO_BROWSER_TEST_TARGET` to select its target manifest.
The fixture infers macOS native Helpers from the Resources root;
`STUDIO_BROWSER_TEST_NATIVE_RUNTIME` can supply the native directory explicitly.
`prepare-codexify.mjs verify <target> <app-or-stage>` verifies browser sources,
licenses, versions, architecture, relative links and macOS signatures alongside
the pre-existing Codexify/cloudflared checks. Cross-target archive validation is
separate from execution evidence on each supported OS.
