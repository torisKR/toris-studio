# Task 1 implementation record

Backend and packaging owner; frontend, lib.rs lifecycle/registrations, OAuth/publications, Cargo dependencies and analytics belong to other agents. No settings, credentials, source DB, installed app, cloud resources or external conversations were opened or modified by this task.

## Implemented

- Removed the Codexify connection, runtime and proxy modules, coding native command prefix, three coding probes, bundled manifest/notices/license, coding client tests and standalone coding verification scripts.
- `shared_binary.rs` retains the packaged cloudflared resolver used by the unchanged shared media lease. Release builds resolve the sibling binary; development retains existing supported fallback paths.
- `creation.rs` persists bounded text/video requests under `creation-requests/requests.json`, atomic writes with private permissions and cross-process locking. Native commands create/list/get/cancel and expose the current executable's `--studio-mcp` stdio configuration. Pure `*_at` APIs support isolated tests without user data.
- Saving/copying an instruction does not imply reading or generating. Only the actual `studio_creation_request_get` MCP call records `readAt`; receiving requires this read, the exact immutable revision, a non-cancelled current source request and a closed draft schema. Exact stored repeats return the original receipt; late/changed drafts do not overwrite. No draft automatically saves a video project, approves, renders or publishes.
- Video receipt schema is native JSON only: `{project:{id?:UUID,title,format,template,language,scenes:[{id,headline,body,narration,durationSec,motion?:{preset,intensity}}]}}`; 1–12 scenes, 3–30 seconds each, total <=180 seconds; native preset and media validation remain enforced. No supplied URLs, file/media paths, HTML, scripts or arbitrary project fields enter this schema. Text is retained as literal review text.
- Existing 12 image/motion/SNS MCP tools remain, with two generic creation tools added. Existing asset, motion and SNS IDs and stores remain. SNS receipts echo a saved numeric revision and reject first late results after a newer request for the same publication; applying still requires the UI's current publication revision check.
- `ai.rs` contains only a pure legacy URL validator. HTTP model transport, CLI/model subprocesses, probes and automatic execution are removed. Legacy video idea entry point saves an RDC request; research creates deterministic excerpts and preserves its source validators.
- Legacy provider fields still deserialize from existing settings, but are omitted from serialized/public settings and cannot be updated/re-enabled. Provider environment values and provider credential vault reads/writes are removed. Collection/database credentials and scheduler settings retain their contracts. No legacy keychain entries are deleted.
- Neutral `prepare-desktop.mjs` and `tauri.runtime.conf.json` package only the shared cloudflared sidecar while retaining pinned source/toolchain/architecture/license checks, browser preparation and media preparation. Package scripts, installer helper and CI references use the neutral entry point.

## Integration required from root

`lib.rs`: register `creation`, desktop-gated `creation_native`, `shared_binary`; remove the three coding modules, managed runtime/proxy state and shutdown hooks. `ipc_commands.rs`: remove six connection/chat + five runtime + three proxy commands, add the five creation native commands. Replace old AI status/generate behavior and frontend coding consumers. MCP tool count is now 14, not 12. Root owns the UI verification script rewrites.

## Verification

- RED first: `cargo test --no-default-features --test creation_contract` failed with the expected unresolved `creation` import before implementation/registration.
- Packaging/browser/media/release contracts: 44 Node tests pass. Release test console messages are fixture output; no release or deployment happened.
- Seven creation contracts cover saved-vs-read evidence, duplicate receipt, stale source, cancellation, closed bounded video/no automatic project save, corrupt/symlink store preservation, capacity overflow without record loss, and actual compiled stdio read/receive under isolated fixture homes.
- Rust focused integration: `--no-default-features --test creation_contract` passes all 7 tests, including the compiled executable stdio fixture. Full no-default library suite passes 252 tests, with 11 explicitly ignored OS/runtime/DB tests. `cargo check --all-targets` with default desktop features passes; remaining warnings belong to parallel OAuth/root code (the removed integration prefix import was cleaned).
- `git diff --check` passes. All successful checks used the shared target directory required by the plan.
- The video receipt test initially caught integer-to-float JSON normalization during typed reserialization; validation now retains the exact original JSON values after the closed typed checks.

## Limits

The inbox keeps at most 200 requests and 16 MiB; overflow is rejected without dropping existing user records. This task has no automatic archive/delete behavior. Real ChatGPT/RDC interaction, provider OAuth and physical packaging/install verification are not claimed. Debug builds alone can select an absolute isolated `TORIS_STUDIO_CREATION_TEST_HOME` for actual native stdio fixtures; release builds ignore it.
