# Toris Studio Asset Studio

## Intent
Extend the existing Tauri desktop app in this checkout, preserving all pre-existing uncommitted work. Toris needs reusable image and 3D assets for video production and other projects, exact output dimensions, selectable local output folders, and a visual library. Generation uses ChatGPT Chat as the host, not Codex subscriptions, private ChatGPT endpoints, or API-key billing.

## Product contract
A new 이미지 생성기 navigation entry opens three views: creation, library, and jobs. Creation records image requests with title, prompt, purpose (video/project), project, quantity, width, height, output format (PNG/JPEG/WebP), and contain/cover fit. A queued request is not a generated image. ChatGPT consumes requests via MCP and returns actual files. Native imports are always available. ChatGPT limits remain in force and no unlimited or unattended-generation claim is made.

The library displays actual thumbnails, metadata, favorites, review state, search, purpose/type filters, original file paths, and output paths. Existing assets are imported explicitly using a native multiple-file picker; the app must not silently scan unrelated folders. Originals are copied, never overwritten. Each operation uses a UUID directory under the selected output root / purpose / project. Output folder changes affect future exports only.

3D assets support self-contained GLB, OBJ, and STL import and preview. Parametric primitives can create actual GLB files locally; they are not image-to-3D reconstruction or a general text-to-3D AI backend. Optional 3D preview is loaded only when a model is selected, not used as background decoration.

## Architecture
Rust owns validation, image processing, persistence, and native commands. A headless --asset-command JSON stdin interface shares the same core with the desktop and the existing Node MCP server. Asset commands never load API/OAuth credentials. The local store uses a cross-process lock, atomic JSON replacement, and rollback on failed imports. Metadata persists under ~/.toris-studio/asset-library (TORIS_STUDIO_ASSET_HOME override for tests). No database or Next.js server is needed for this feature.

MCP tools list jobs, create requests, accept a top-level OpenAI file parameter, list assets, and generate bounded procedural geometry. File downloads accept only HTTPS approved file delivery hosts, reject redirects, bound response size and time, and do not accept arbitrary local paths. MCP delegates processing to the locally built desktop binary, without shell interpolation. Existing video MCP tools remain unchanged.

## Safety and limits
Image inputs and 3D files are capped at 32 MiB; decoded images and target images are bounded. Filenames are sanitized while retaining Korean characters. No source file deletion. The selected storage root is canonicalized. JSON corruption must surface an error, not silently reset data. No credential reads, browser automation, Codex CLI calls, or automatic public tunnel creation. Remote MCP use requires appropriate authentication/tunnel configuration.

## Verification
Tests cover presets, invalid dimensions, path traversal, safe names, exact image dimensions, original preservation, persistent jobs, idempotent job completion, format validation, GLB header/chunks, and MCP download restrictions. Run native core tests, desktop typecheck/build, MCP tests, and existing tests. Report native UI and real ChatGPT file-transfer validation separately from compilation.
