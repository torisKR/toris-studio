# SNS workspace implementation

Approved specification: the conversation plan dated 2026-10-21. Native Rust/Tauri, local PostgreSQL and existing user data are retained. No publication, installation replacement, paid X API, revenue/advertising analytics, or cloud service is authorized by this implementation.

## Task 1: Remove coding and preserve creation

Remove coding/Codexify UI, runtime, proxy, commands, packaging and inactive model execution. Preserve shared cloudflared media leases, browser/OAuth, native renderers and creation MCP. Replace creation handoff with Remote Desktop Commander prompts; request saved/copied/actually read/draft received/reviewed are distinct. Add bounded text/video request storage, revision checks, cancellation and idempotent receiving. Preserve existing image/SNS/motion IDs/contracts. Legacy settings must load without enabling removed providers.

## Task 2: Multiple OAuth connections

Stable connectionId per independent authorization, verified remote account identity, isolated credentials/refresh/disconnect. Preserve legacy sessions until safe migration and verification. Pin each publication job to connectionId+platform+accountId; ambiguous legacy jobs need confirmation. Read and publish permissions are separate. No X OAuth. Callback state must bind the intended connection. Local API cache deletion must not delete user-created content.

## Task 3: Analytics and imports

PostgreSQL persistence, bounded CSV/XLSX/table imports with mapping/preview/deduplication/corrections and explicit provenance. Native provider adapters for YouTube Data/Analytics/Reporting, Meta Instagram/Facebook/Threads, TikTok; Naver Blog/Clip and X manual reports. Original metric definitions, period/cumulative type, timezone, dimensions, actual coverage, API version and unavailable states retained. No synthetic cross-platform total/score or invented daily history. Sync on launch/resume and every six hours while running, bounded rate/retries, pause/resume, missing coverage shown. No revenue/ad management.

## Task 4: SNS workspace and application shell

Primary navigation SNS 관리 / 콘텐츠 / 제작 / 게시, settings below. SNS: overall performance, channels, imported reports; channel detail performance/content/connection. Multiple platform accounts, explicit ownership and permissions, contextual diagnostics. Content: planner/trends/keywords. Creation: text/image/video-motion. Publishing: drafts/approved schedule/results, common engine for supported private QA tests. Dark navy consistent design, 820px responsive, keyboard/reduced motion, saved view/filter/draft context, operation tray without focus stealing. X manual channel/report/publish handoff.

## Task 5: Verification and review

Test absence of coding IPC/binaries, data migration and vault failures, independent accounts, immutable approved job target, stale/cancelled/duplicate drafts, import overlap/timezone/zero vs missing, provider failures/retries/restart, actual RDC vs fixtures, existing motion/image/publish/browser regressions. Run full Node/Rust suites, typecheck, frontend production build, browser visual/keyboard checks, package contracts. Record provider approval/credential and platform execution limits honestly. Preserve untracked campaigns/ and pocket-circuit/.

## Ownership / shared interfaces

- Coding backend worker: coding Rust modules, creation bridge and MCP, config compatibility, packaging and coding test removal. Do not edit lib.rs or frontend creation consumers. Shared binary resolver extracted before removal.
- OAuth worker: oauth.rs, publishing/publication binding and native OAuth dispatch; communicates command payloads to root. Do not edit lib.rs or frontend.
- Analytics worker: analytics*.rs, analytics tests and SQL migration 009+, Cargo dependencies as needed. Public async dispatch(config, input) plus sync_due(config). Uses OAuth scoped access from Task 2. Do not edit lib.rs/frontend.
- Root: application frontend, common handoff UI and frontend consumers, social platform additions, lib.rs registrations/lifecycle, integration verification/docs and final integration.

Pre-flight: coding removal/creation and OAuth share integration_native.rs; coding worker removes only coding prefix, OAuth commands stay in lib.rs/root or new oauth_native.rs. OAuth+analytics share scoped token access; OAuth worker publishes the API early. Analytics+UI share a typed dispatch contract; analytics worker supplies response examples early. SQL/platform lists are additive, existing approvals never rewritten.
