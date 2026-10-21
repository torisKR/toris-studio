# SNS workspace implementation evidence

Implementation branch: `feat/sns-workspace`, isolated from the original `feat/playwright-browser` checkout. The original checkout's `campaigns/` and `pocket-circuit/`, installed application, existing DB and credential store were preserved. This branch has not been published or installed over the user's application.

## Result

- Removed the coding screen, internal coding execution, Codexify bridge/proxy/runtime/commands/bundling. Creation uses Remote Desktop Commander with native stdio MCP and explicit review.
- Unified navigation: SNS 관리 / 콘텐츠 / 제작 / 게시, with settings below. SNS combines owned channels, public YouTube reference lookup, OAuth accounts, analytics/report imports and connection diagnostics. Publishing uses account-pinned approvals and the same queue engine.
- Added isolated multiple OAuth connections and separate read/publish permissions. Disconnect preserves a durable cleanup request and holds affected queued approvals. X and Naver Blog/Clip use manual reports and explicit human publishing handoffs.
- Added native provider adapters and PostgreSQL analytics, with original metric definitions/timezones/coverage and zero distinct from unavailable. Imports require mapping and a preview; replacements preserve audit history. App/tray collection respects pause, account rate limits and verification deadlines.
- Preserved the Rust media compositor, motion editor, asset flows, dedicated Playwright browser, system-browser-only OAuth and bundled-runtime release gates.

## Evidence boundaries

`docs/review/sns/rdc-roundtrip.json` records an actual ChatGPT → Remote Desktop Commander → compiled native MCP request/read/draft roundtrip using an isolated development store. The returned Korean text preserved the supplied value 18. No user project was changed and no publication was made. This establishes actual RDC transport, separately from browser IPC fixtures.

Browser regression scripts operate the actual React application in Chromium with explicit sanitized native fixtures. They verify account/filter isolation, delayed responses, mapped values, immutable preview metadata, keyboard focus, responsive layouts at 1380×900 and 820×620, manual X handling, creation review and reload. Native video receipt and motion compositor checks are separately recorded; fixture saving is not presented as user-data or provider proof. See [UI verification report](sns-ui-verification-report.md).

PostgreSQL tests create separate temporary loopback clusters and use the restricted `toris_app` role. Migration upgrades preserve legacy snapshots, hold old unbound approvals once and retain X/Clip rows on rerun. Analytics persistence, correction/reactivation, data expiry, rate-limit and cleanup checks run against this disposable DB. The user's database is not used for these tests.

[Analytics contract](sns-analytics-contract.md) and [adapter verification](sns-task3-report.md) distinguish deterministic provider-response fixtures from actual account approval or live provider execution. Real provider analytics/OAuth accounts were not exercised. Mac Intel and Windows execution, three-platform CI/installers and public release/download verification require a subsequent authorized release run; local compilation and packaging contracts do not establish those results.

## Verification record

Final JavaScript verification uses Node 24.16.0: 194 tests passed, one environment-dependent test skipped. Runtime/packaging contracts: 34 passed, one platform-dependent test skipped. OAuth callback contracts: 13 passed. Root and desktop TypeScript checks and the production Vite build passed. SNS Chromium verification passed 12 groups. Native asset/motion/video/publishing/browser regressions are listed in the UI report.

Actual native media regression passed: a 1080×1920, 24fps H.264/AAC MP4 was generated using bundled tools. Decoded start/middle/end frames matched the common still compositor with mean channel difference below 3; Korean text, chart values12/18, yellow image and animation were visually inspected. The missing-image/cache guard also passed. [MP4](../review/sns/native-media/fixture.mp4), [frame/hash evidence](../review/sns/native-media/verification.json). No system FFmpeg was used.

Final native verification: 343 Rust tests passed across the no-default-features suite; 20 environment/provider/desktop-specific tests were explicitly ignored there. Desktop all-target compilation and rustfmt checks passed with no warnings. Separate desktop tests passed for cleanup overlap and DB fingerprint guards (2), OAuth fixtures (45), and disposable PostgreSQL cleanup outage/lock/recovery (1). The restricted-role runner passed both queue tests and all seven analytics contracts, including DDL denial and early-schema/grant repair.

Independent reviews found no remaining Important issues in the reviewed UI, report ownership, account isolation and cleanup boundaries. The final cleanup patch is `9928bb8`; root integration is `034e6d1`, analytics ownership is `a9b13d6`, and final SNS browser regressions are `e72715c`. The branch remains a local implementation; main, public downloads and the installed application were not changed.
