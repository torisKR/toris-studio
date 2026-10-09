# Toris Studio desktop design contract

Toris Studio is a local creator workspace. The first screen should answer three questions: what is connected, what needs attention, and which content task can I start now? A strong heading and one useful entry action lead the screen; real work and connection state follow. Visuals support this workflow rather than suggesting results the app has not measured.

## Direction

- Cool charcoal surfaces, clear Korean typography, a restrained blue creative accent, and the user's original sculpted T logo.
- A compact persistent sidebar for frequent workspace destinations. An asymmetric overview pairs the primary task with a local diagram of content moving between channels.
- Content has more visual weight than decoration. Video previews, meaningful titles, source descriptions, account identifiers, and explicit task status remain readable.
- Your.gg informs the hierarchy of a bold entry point followed by useful information. The other references inform spacing, component states, typography, and restrained motion. Their assets, proprietary code, and brand identities are not imported.

## Tokens

| Role | Value | Use |
| --- | --- | --- |
| Canvas | `#0b1017` | Application background |
| Surface | `#111923` | Workspace panels |
| Inset | `#0e151e` | Inputs and secondary work areas |
| Border | `#2c3747` | Quiet separators and panel edges |
| Primary text | `#edf2f7` | Headings, values, labels |
| Secondary text | `#a4b2c4` | Supporting copy and descriptions |
| Creative accent | `#92b8ff` | Primary actions and current workspace |
| Success | `#8ae3bb` | Verified connection and completed actions |
| Attention | `#e6be83` | Pending setup and a required action |
| Error | `#ffc0c6` | Failed actions with a readable explanation |

Use the existing offline system font stack: `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `Apple SD Gothic Neo`, `Malgun Gothic`, `sans-serif`. Avoid remote fonts. Use tabular figures for real counts and dates. Titles use 600–700 weight, tight tracking, and balanced line breaks. Navigation and working text use 13–14px; compact metadata uses 11–12px, and small English utility labels use 10px.

Spacing follows 4, 8, 12, 16, 24, 32, and 48px. Inner controls use an 8px radius, work surfaces 12px, and the overview composition 16px. A radius should distinguish a control from its container. Keep content lines near 65 characters and preserve room for Korean labels.

## Information and interaction

- Derive counts and charts from the local dashboard response. Do not invent growth percentages, reach, revenue, historical curves, or authentication success.
- Counts and search refer to the currently loaded response: up to 200 content rows, 200 channels, and 100 collected results. Do not label these bounded arrays as total database counts. A selected platform must carry through to a new draft, and channel search must display the matching account.
- “발행 계획” and “발행 기록” describe planning and saved records. Do not imply an external post was published without provider confirmation.
- Show connection, loading, empty, error, and saved states as different states. Place an error beside the relevant action and preserve entered values.
- Keep secrets hidden by default. Revealing an existing value must be an explicit action; decoration and analytics never receive credentials.
- Every visible entry action navigates to an implemented task. Channel selection, search, and content filters must use existing application logic.
- Preserve the native update flow, download confirmation, cancellation, signature verification, and protected installation state.

## Accessibility and motion

- Visible keyboard focus: a 2px accent outline with 4px offset. Do not remove the skip link or native dialog focus management.
- Information never depends only on color. Pair state colors with text or an icon, and label icon-only actions.
- The brand atmosphere is decorative and `aria-hidden`; it creates no keyboard stop and communicates no live metrics.
- Pointer tilt is at most 3 degrees on each axis, only for a fine pointer with hover. It uses a single queued animation frame while the pointer moves and no persistent animation loop.
- `prefers-reduced-motion: reduce` disables tilt and visual transition. The composition remains complete as a static local SVG and PNG.
- Avoid scroll capture, autoplaying background video, WebGL dependencies, repeated blur, and infinite animation. Respect the desktop's normal scrolling behavior.

## Asset budget, specified before production

| Asset type | Budget | Import/render rule |
| --- | --- | --- |
| Original brand mark | One 512×512 PNG; ≤270KiB source | Keep original source and transparency; explicit displayed dimensions; no mipmaps needed for UI |
| Workspace diagram | One local SVG; ≤12KiB; ≤120 primitives | No script, external references, filters, raster payloads, or remote fetches |
| Supporting pattern | At most one SVG; ≤2KiB | Static lines only; no additional full-screen texture |
| Decorative compositor | One transformable layer | No continuous animation, particles, shader, canvas, or WebGL |
| Icons | Existing application icon library | Consistent stroke weight; avoid adding a library for the redesign |

This application uses 2D UI assets. Polygon LOD chains, particle systems, texture compression overrides, and game-engine shader variants do not apply. Do not introduce those systems to create a decorative header. The decoded logo occupies approximately 1MiB; use the same cached local resource for the sidebar and diagram.

## Implemented asset contract

- `desktop/public/brand/toris-logo.png`: byte-for-byte copy of `desktop/logo-full.png`; the user's installation icon remains unchanged.
- `desktop/public/brand/workspace-map.svg`: original geometric content-flow illustration, authored for this workspace.
- `BrandAtmosphere({ className? })`: reusable decorative React component. It accepts no account information, token, analytics metric, remote URL, or data prop.
- Assets use relative `./brand/…` paths so both Vite development and the bundled Tauri application can resolve them.

## Finish gate

Verify the integrated native app at its normal desktop size and at a narrow window width. Confirm real connection/content state, working overview entry actions, readable empty/loading/error states, keyboard focus, reduced motion, and no horizontal overflow. Confirm the diagram's assets are bundled locally. Record actual screenshots separately from mocked previews. Build/test success alone is not visual approval.
