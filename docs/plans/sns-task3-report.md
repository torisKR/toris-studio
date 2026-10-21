# Task 3: analytics backend delivery

Implemented native analytics dispatch and due-sync lifecycle with additive SQL010. Root owns IPC registration, backups/migration application, lifecycle cadence and frontend. `applySchema` calls the existing owned-local migration path rather than issuing app-role DDL. No user database migration or provider-account collection was performed during this task.

## Delivered behavior

- PostgreSQL sources, metric observations, import previews and account-scoped jobs. Filters support account/platform/connection/source-kind/source/metric/overlapping date periods and bounded pagination. Original dimensions, source definitions, provider API version, unit, timezone, period/snapshot semantics and source values remain attached to every observation. No composite totals, revenue/ad management or interpolated daily history.
- CSV/TSV/table text and XLSX bytes: 5 MiB input, 10,000 rows, 100 columns, 20,000 observations. XLSX zip expansion and sparse coordinates are preflighted before worksheet allocation. Formulas, VBA, embedded objects and external workbook links are rejected; no formula or macro engine runs.
- Durable 24-hour mapping preview, original columns/row provenance, explicit commit, semantic deduplication under a transaction/advisory lock, and overlap rejection until the user selects a matching import to replace. Imported corrections cannot overwrite API data. Import removal deletes its observations and retains source audit metadata. API cache deletion is exact-connection scoped and leaves imports/user-authored content intact.
- YouTube Data current statistics; Analytics fixed summary/daily/content/traffic/country/device/demographics/retention reports; asynchronous Reporting reach-job creation/list/download for original thumbnail impressions and CTR. Job IDs, report IDs, cursors and coverage survive restart. No signed download URLs are persisted.
- Instagram professional-account summary, audience breakdowns and owned Reel watch-time fields; Facebook Page v26 media-view replacements and owned post-video watch fields; Threads profile/post insights and current audience breakdowns; TikTok Display profile/video current statistics with real POST cursors. Naver Blog/Clip and X remain manual reports.
- Fixed report types and typed date ranges (7/28/90/custom), never arbitrary endpoint/metric/filter forwarding. Demographics preserve provider rolling timeframe/current snapshot semantics and privacy-threshold missing states. `reportQuery` results are persisted and can be read offline later.
- Bounded 3-page loops, 45 HTTP requests / 180-second request-start budget, 15-second per-request timeout, read-only retries (max3), server Retry-After, 6-hour successful sync, persisted pause, per-account leases and stale/deleted-job fencing. Manual requests cannot bypass rate-limit waiting. POST report-job creation is not automatically retried; restart first looks for the existing app-owned job.
- OAuth tokens stay in native memory and bearer headers. Exact connection/platform/account/scopes are resolved through Task2's scoped access API. Redirects are disabled; fixed provider origins are allowed and Meta pagination URLs are never followed.

## Verification

- Rust `cargo check --no-default-features` passed during implementation.
- 32 analytics unit/fixture tests: zeros vs missing, mapping/duplicate/timezone/date validation, inert XLSX values, formula/macro/external-link/sparse-allocation rejection, units/dimensions/privacy coverage, Pacific dates, retention/demographic decoding, fixed report whitelist, retry classification and token-forwarding rejection.
- Loopback HTTP fixtures exercise the actual native transport: TikTok profile + POST video pagination, YouTube Reporting async wait/restart/download/report deduplication, bounded transient GET retries and non-retried job creation. These calls use fabricated fixture credentials and data only.
- Three opt-in PostgreSQL integration cases run against a new disposable local cluster on a random separate loopback port with random credentials. They cover concurrent commit idempotency, correction/source filters/history/remove, import/API cache isolation, persistent pause, preview expiry and persisted Retry-After/manual-refresh blocking. Test credentials are never printed or written to the repository. The cluster is stopped after verification.

## Provider execution boundaries

The code paths and fixture behavior are implemented. No real connected account or app-review status was exercised, so this report does not claim provider approval, real-account scopes, live freshness, or complete historical coverage. Instagram/Page reference fetches were partly rate limited; unsupported fields for a particular v26 account/media return metric-level unavailable status while other results are retained. The current source list and precise frontend payload/response contract are in [sns-analytics-contract.md](sns-analytics-contract.md).
