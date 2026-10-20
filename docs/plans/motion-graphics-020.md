# Toris Studio 0.2.0 execution ledger

Source: user supplied Toris Studio 0.2.0 motion graphics and public release plan, 2026-10-21.

Acceptance: optional versioned graphics data; 12 scenes / 180 sec / 32 elements / 24 chart rows; Korean 5-scene 45-second defaults; title, metric, chart, comparison, steps; safe structured ChatGPT patches with review, conflict detection, idempotency and cancellation; direct keyboard/numeric/canvas editing and undo; Rust deterministic previews and 1080p 24fps H.264/AAC output; pinned bundled FFmpeg 9.0.2/libx264 and Noto CJK; three platform installer verification without system FFmpeg; existing regression checks and Playwright transition; publish main/v0.2.0/GHCR/signed feed only after verification. Preserve user data and untracked directories. Do not replace installed app.

Pre-flight interfaces:
- Graphics contract -> persistence, renderer, editor and MCP all use scene.graphics v1 and project.motionGraphics v1. Legacy scenes without graphics retain their existing limits and renderer.
- Requests -> structured patches use stable IDs and hash the complete editing snapshot; application returns a project without implicitly saving it. Editor makes one undo entry.
- Images -> private native import by ID; AI sees metadata only. Charts reference immutable request table rows; numeric changes require explicit user edits in the table editor or explicit instruction reflected in review.
- Renderer -> same Rust rasterizer for stills and streamed raw frames; no browser or JavaScript runtime in rendering.
- Bundles -> pinned source builds and resource manifest; missing or damaged media resources fail explicitly, never silently use PATH in packaged apps.

Progress:
- Initial tracked tree clean at 2218180 on feat/playwright-browser. campaigns/ and pocket-circuit/ untracked, preserved in original checkout.
- Isolated worktree /tmp/toris-studio-motion-020 on feat/motion-graphics-020; includes prior Playwright commits.
- Reference pages checked: FFmpeg official download lists 9.0.2; Claude Motion help inspected.

Implementation evidence:
- Versioned graphics contract and patch validation passed failure-first tests. Closed data fields; existing legacy limits unchanged.
- Inbox: registered request matching, stable scope, conflict hash, duplicate/cancel/expiry handling; atomic private storage; completed requests archive without losing duplicate-receipt history.
- Renderer: Rust caches element layers, rasterizes Korean text/charts/images, streams raw frames to pinned bundled FFmpeg. Same compositor used for stills and output. Preview work has a bounded permit.
- Independent read-only review found apply-await overwrite, unbound review/request, odd landscape dimensions, lifetime inbox cap, concurrent preview allocation, missing reviewed numeric update, and unconnected installer media gate. Each addressed in the implementation; tests bind review authorization to request+snapshot, permit gating, even dimensions and archive/numeric permission.
- Ruling: a source-number change requires an explicit UI allowDataEdits toggle and a reviewed old-value-aware set-table-value operation. Default remains source preserving. This reconciles numeric-edit requests with the requirement to prevent silent data changes; cost if wrong: one extra opt-in for numeric source edits.
- Native Mac ARM smoke with PATH empty succeeded; actual 1080x1920/24fps H.264/AAC fixture passed begin/middle/end decoded-frame mean RGB difference <3/255. Native Korean/chart/image frame visually inspected.
- Read-only actual saved connection probe reports reachable=false, ownerReady=false. Live ChatGPT validation is outstanding, not replaced by fixture evidence.
- Whole JS suite: 218 pass/1 external DB skip. Whole no-default Rust suite: 321 pass/14 explicit environment skips. Six legacy media/font/template/audio diagnostics run explicitly and pass. Media decoded-frame/cache-source validation passes. Packaging/browser contracts 42 pass; OAuth callback contracts 13 pass. Web and desktop typecheck/build pass.
- Real React + Rust QA passed default preview, CSV/numeric edits, duplicate/delete/undo/redo/keyboard, reviewed apply as one undo, delayed manual-edit conflict, recovery/reopen, landscape and 820px no-overflow. Dialogs and AI replies are fixtures. Browser/OAuth UI regression passed.
- Additional failure-first fixes: canonical client JSON identity (native field ordering must not create false conflicts); validate final merged saved document; source hashes prevent cache hits from concealing missing images; AI request response whitelists context fields and strips unknown/private metadata and local file references.
