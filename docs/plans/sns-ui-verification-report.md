# SNS workspace UI verification

2026-10-21 · `feat/sns-workspace` · isolated worktree fixtures. All gates below passed locally.

| Gate | Evidence |
|---|---|
| `node scripts/verify-sns-workspace.mjs` | 9 groups: actual React UI, four primary destinations, eight platforms, exact connection/account pair, zero/null, definitions/timezone, X manual-only controls, mapped report preview/provenance, delayed account and import races, context/keyboard/focus preservation, platform/topic stale protection, RDC copy, 1380×900 and 820×620 without horizontal overflow |
| `node scripts/verify-ai-workspace.mjs` | 7 groups: real-shaped discovery, evidence deduplication, manual context preservation, bounded RDC request, editable received fixture, delayed DB disconnect/reconnect, trend brief |
| `node scripts/verify-publication-ui.mjs` | 19 groups: destination consent, subset approval, partial retry, uncertain reconciliation, KST scheduling, revision-bound saved RDC copy, explicit draft apply, manual Naver handoff, TikTok draft/direct distinctions, 820px layout |
| `node scripts/verify-browser-ui.mjs` | 11 groups: preference persistence, serialized save, redacted failure/recovery, 820px layout, system-browser-only OAuth dispatch |
| `node scripts/verify-desktop-interactions.mjs` | 20 menu cycles; one StrictMode dashboard read; stable 3 intervals and 1 shortcut listener; explicit unavailable-template fixture; 820px layout |
| `node scripts/verify-asset-studio.mjs` | 8 groups using actual Rust asset core: 4 GLB shapes pass Khronos validator, request queue and RDC copy, imports preserve original bytes, WebGL inspector, persisted review/tags/favorites, RGB24 1024×500 Play export, valid ICO, error recovery and 820px layout |
| `node scripts/verify-motion-ui.mjs` | 6 groups using actual Rust compositor/inbox: Korean portrait preview, original CSV 18/24, numeric/keyboard editing, duplicate/delete/undo/redo, RDC request, reviewed patch as one undo entry, stale conflict, cancellation, reload, landscape and narrow layout |
| `node scripts/verify-video-templates.mjs` | 10 recipes / 73 pure Rust input cases, 20 stable replacements, latest-topic race, controls/playback cleanup, dirty protection, favorites/recent/save/reload, export/cancel/duplicate. Actual UI-generated closed prompt → isolated compiled MCP request get/receive → native media validation → user review and JSON import dialog. Project save remains a memory IPC fixture. |
| `node scripts/verify-asset-mcp.mjs --native` | 10 groups against compiled stdio: initialize/list/call, 14 registered tools, file descriptor, persistent queue, unsafe URL rejection, actual GLB/PNG/ICO, metadata, filtering and 31 presets |
| `node scripts/verify-motion-mcp.mjs` | Compiled stdio context/privacy, reviewed receipt, duplicate idempotence and wrong-project rejection; no project save |

Native verifiers honor `CARGO_TARGET_DIR`. This run used `/Users/toris/projects/toris_studio/desktop/src-tauri/target`. The video gate builds the native bin and isolated `creation_qa_bridge` example. Existing asset/motion package commands build their helpers. Media staging was copied from the installed bundle only after `verifyMedia` verified pinned manifest SHA, architecture and FFmpeg 9.0.2; the installed app was neither launched nor changed.

## Regressions exercised

- A pending or rejected account-B query immediately hides account-A rows and CSV controls. Recovery exports B only. A late B response after switching to X cannot render or export API rows.
- Three deferred mapped previews separately change target, timezone and metric mapping before resolution. Stale review and save controls never revive. Paste uses `.txt` delimiter detection; comma CSV cannot be forced into TSV.
- Mapped preview shows the actual two reviewed observations, including original definition, `0`, unavailable `—`, timezone and user-report provenance before commit.
- A received text fixture remains user reviewed. Changing platform or topic makes it stale without replacing edited prose; background polling preserves textarea focus after navigation settles.
- Saving and reloading a video catches the StrictMode selection-version race. The source fix resets initialization on cleanup and ignores unmounted responses; the preserved regression passes.
- The actual production Vite policy serves the worktree and returns HTTP 403 for a user-home credential path. The check asserts status only and never reads or logs credential contents.

The shared fixture server uses the actual production Vite config, disables development HMR during deterministic gates and gives parallel gates separate temporary dependency caches. Unsupported IPC is recorded as a test failure; only explicit sanitized read fixtures are shared. Coding-runtime mocks and obsolete navigation selectors were removed while native motion, asset and publishing checks remain.

## Artifacts and limits

Committed SNS captures: [overview](../review/sns/overview-1380.png), [channel](../review/sns/channel-820.png), [mapped import preview](../review/sns/report-preview-820.png), [creation narrow](../review/sns/creation-820.png), [creation wide](../review/sns/creation-1380.png), [machine report](../review/sns/verification.json). Set `TORIS_SNS_UI_ARTIFACTS` to redirect CI output. Captures were inspected visually.

Other local reports/captures: `docs/review/asset-studio/verification.json`, `docs/review/motion/report.json`, `/private/tmp/toris-ai-workspace-ui`, `/private/tmp/toris-publication-ui`, `/private/tmp/toris-desktop-interactions`, `/private/tmp/toris-video-templates`.

Browser SNS/OAuth/provider/publishing values are fixtures. No provider login, analytics network request, upload, publication, user database/vault access, deployment or installed-app execution was performed by these gates. Native asset, motion and creation calls use isolated temporary stores. This report does not claim a real ChatGPT conversation or file receipt; the separately owned `docs/review/sns/rdc-roundtrip.json` records the root agent's actual RDC check and was preserved.

Package/CI changes are owned by the root agent: route `sns:verify:ui` and `integrations:verify:ui` to the new SNS script and upload `TORIS_SNS_UI_ARTIFACTS`. No remaining verification blocker in this scope.
