# Asset Studio Implementation Plan

> For agentic workers: use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a local asset creation/import/library workspace to the existing desktop app and expose the same functions to ChatGPT through MCP.
**Architecture:** Rust asset core + headless JSON worker; React native workspace; Node MCP file adapter. Preserve current features and pre-existing uncommitted work.
**Tech Stack:** Tauri 2, React 19, TypeScript, Rust image processing/file locking; Three.js for on-demand model inspection.
**Spec:** docs/superpowers/specs/2026-10-09-asset-studio-design.md

## Global constraints
No Codex/image API/private endpoint usage in the asset path. No unlimited-generation claim. Preserve originals and user edits. Local storage. Do not automatically expose a public tunnel. Keep the existing desktop identity and Korean UI.

## Review focus
Corrupt persistence fails visibly; cancelled/completed jobs do not silently create duplicate output; malformed/oversized media fails before committing output; paths stay in selected roots; delayed UI responses preserve the user's current selection and closed state.

## Task 1: Asset core and worker
- [x] Add contract tests for queue validation, exact resizing, original retention, filenames, idempotency, cancelled jobs, saved folders, transparency previews and GLB output.
- [x] Implement shared Rust dispatch, atomic metadata replacement, cross-process locking, image transforms, native imports and bounded model validation.
- [x] Add credential-free `--asset-command` entry and authorized IPC/file/folder commands.
- [x] Verify core tests, desktop compilation, native application bundle and bundle command execution.

## Task 2: Desktop UI
- [x] Add preset, validation, prompt handoff, CSP and late-selection regression tests.
- [x] Build creation, paginated gallery, inspector, native import/folder actions, durable queue, clipboard handoff and lazy model viewer.
- [x] Integrate navigation while preserving existing desktop screens.
- [x] Verify TypeScript/Vite and browser UI against the actual Rust engine.

## Task 3: MCP adapter
- [x] Test accepted hosts, unsafe URLs, redirects, bounded responses, filenames and complete OpenAI file metadata.
- [x] Register six asset tools; add an asset-only stdio server for least-privilege tunnel connections.
- [x] Add external-bind authentication guard to the pre-existing HTTP MCP server.
- [x] Verify actual MCP initialization, descriptors and representative tool calls against the native worker.

## Task 4: Review and delivery
- [x] Independently validate all four generated GLB shapes with Khronos glTF Validator.
- [x] Inspect desktop-width and narrow screenshots; fix search layout, preview transparency, review-field naming and delayed detail state.
- [x] Run focused/full tests, type checks, build and mechanical UI checks. Preserve and explicitly report skipped external-service tests and build warnings.
- [x] Document commands, file handling, storage, actual verification boundaries and connection prerequisites in `docs/ASSET_STUDIO.md` and `docs/review/asset-studio/VERIFICATION.md`.
- [ ] User-account Secure MCP Tunnel registration/authorization and real ChatGPT image/file-transfer verification. Requires account-level connection setup; no fabricated tunnel or credentials.
- [ ] Manual macOS native dialog/WKWebView end-to-end verification and any production signing/notarization/release requested later.

## Handoff
The local implementation and development `.app` bundle exist in this checkout. No commit/push, public tunnel, installed-app replacement, or production release was performed. The remaining unchecked items are not represented as completed functionality or verification.
