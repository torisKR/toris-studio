# Studio browser migration execution

User plan in the 2026-10-20 implementation conversation is the binding spec. Preserve untracked campaigns/ and pocket-circuit/, all accounts, settings, DB and historical release docs. No public release or installed-app replacement.

## Shared contracts (frozen before parallel implementation)

- Rust module `browser`; browser enum serialized `system | playwright`, default `playwright`.
- IPC `open_external({url,browser?})`; `browser_runtime_status()`; `save_browser_preferences({input:{browser}})` returning runtime status. OAuth command has only platform, always explicit system open.
- Runtime status serialized camelCase: `{ preference: 'system'|'playwright', effectiveBrowser: 'system'|'playwright', available: boolean, reason: string|null, phase: 'idle'|'running'|'recovery_required' }`. `available` describes Playwright availability; effectiveBrowser falls back on unsupported OS/missing runtime. Preferences separate atomic browser-settings.json.
- Rust browser API: `BrowserChoice`, `BrowserStatus`, `PreferencesInput`; `status() -> Result<BrowserStatus,String>`; `save_preferences(input) -> Result<BrowserStatus,String>`; `open(url:String, choice:Option<BrowserChoice>, system: impl Fn(String)->Result<(),String> + Send + Sync + 'static) async -> Result<(),String>`; `shutdown() async -> Result<(),String>`. Integration may adjust signatures together if necessary.
- Node worker at `desktop/browser-runtime/worker.mjs`; policy `policy.mjs`. Fixed argv: `--browser <absolute chrome executable> --profile <absolute studio-owned profile>`. JSONL stdin `{id,command:'open',url}` or `{id,command:'shutdown'}`. stdout `{event:'ready'}`, `{id,ok:true}` / `{id,ok:false,error:'fixed code'}`, `{event:'system_open',url}` for auth; `{event:'closed'}` after browser exits. No page contents, cookies, raw errors, console logs, URL echoes beyond native-only system_open auth handoff. 64KiB line bound.
- Files prepared at `desktop/src-tauri/browser-runtime/<target>/`: `node[.exe]`, `worker.mjs`, `policy.mjs`, `node_modules/playwright-core/`, `chromium/` (upstream browser archive tree), notices and manifest. Mac deploys only Node + Chromium under `Contents/Helpers/studio-browser/` via two `macOS.files` mappings; worker, policy, Playwright Library, manifest and notices deploy under `Contents/Resources/studio-browser/` as resource data. Windows retains one `studio-browser/` resource directory. Chromium executable Mac `chromium/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` (x64 uses chrome-mac-x64); Windows `chromium/chrome-win64/chrome.exe` (verify upstream paths).
- Node 24.16.0, playwright-core 1.63.0, chromium revision1243/version153.0.8010.12; only headed Chrome included. OS gate before any Node spawn: macOS>=14, Windows build>=22000; other OS system fallback.
- Launch <=30s; shutdown grace 10s. Unconfirmed shutdown blocks new launches and update. No kill-by-name.

## Ownership

Rust worker: browser.rs only plus its tests, dependencies as needed coordinated. Runtime worker: desktop/browser-runtime/**, scripts/prepare-browser* and runtime manifest/notices, bundle overlays, prepare-codexify integration, workflow runtime additions. UI worker: browser settings card, OAuthPanel, types if needed and UI test script. Root: lib.rs IPC, updater/native OAuth paths, oauth.rs enum removal, dormant opal source removal, registry, integration, full verification and docs.

## Evidence / rulings

- Initial tracked tree clean; campaigns/ and pocket-circuit/ untracked and preserved.
- User explicitly requests parallel lanes and independent review; delegates authorized.
- Current main 0.1.24; use dedicated feature branch; no commit/push/release requested.

- Actual macOS bundle signing rejected Playwright JavaScript inside Helpers as nested code. Native/data split above is the execution ruling: only Node and the actual Google Chrome for Testing.app are Helpers code, JavaScript/package/license data plus outer Chromium ABOUT/resources/PrivacySandbox data belong in Resources. Chromium executable paths stay unchanged; prepared archives remain complete. Keep the upstream Library intact except unused installer/CLI pruning.

- Packaging ruling: macOS Helpers contains native code only; JavaScript, Playwright and notices go in Resources. Actual Tauri top-level codesign rejected JS/shell data in Helpers. The user plan requires the browser in Helpers, which this split preserves; the prepared single-directory layout and Windows layout remain unchanged.
- Final review fixes: failed-exit publication latch rollback; cancellation before spawn; safe stale-owner recovery through boot identity/PID-group absence; surviving descendants; consistent auth policy; successful auth redirect acknowledgment; native Intel CI; extracted-installer checks.
- Full security scan detects a pre-existing untracked campaign bundle pattern; changed migration files scan clean. Do not alter campaigns/pocket-circuit.

## Final local evidence

- Rust full no-default-features: 311 passed, 13 ignored. Desktop default lib+ACL: 288 passed, 12 ignored. Opt-in real Rust+Node/PW fixture: passed.
- Web: 213 passed, 1 skipped; TypeScript and Next production build passed on raw upstream Node24.16.0. Browser UI fixture passed. Runtime/contracts29 passed.
- All three preview installers built and re-extracted. Apple Silicon executes actual headed worker successfully; Intel/Windows static checks only. Mac main minOS12/JITabsent and deep strict signatures verified. See ../BROWSER_RUNTIME_VALIDATION.md for paths, sizes, hashes and remaining acceptance gaps.
- User approved committing/pushing the verified migration files to this feature branch and executing remote CI after local verification. No main merge, public release, installed-app replacement or user-folder cleanup is authorized. Intel/Windows real execution requires matching external runner; CI config alone is not execution proof.
