# Design references and asset provenance

Reviewed on 2026-10-08 for the Toris Studio desktop redesign. The references inform composition and interaction decisions; the implementation uses the existing React/Tauri stack and original local artwork. No reference library source code, commercial component, shader, screenshot, font, or brand asset is included in the app.

## References

| Reference | Reviewed material | Applied principle |
| --- | --- | --- |
| [YOUR.GG](https://your.gg/ko/kr/home?region=kr) | Public home and public profile layout | Strong identity, compact metric hierarchy, tabular values, readable rows, distinct grouped sections on charcoal surfaces |
| [Scrolltide](https://www.scrolltide.co/) | Public homepage and preview cards for prompts, templates, components, and shaders | A coherent visual library and controlled graphic depth; express that depth with an original lightweight SVG in this app |
| [Minimal Gallery](https://minimal.gallery/) | Public curated website gallery | Clear hierarchy and enough space around the primary action |
| [Kage](https://kage.design/) | Public design inspiration homepage | Use a concrete visual direction and component decisions rather than a generic style label |
| [Refero Styles](https://styles.refero.design/) | Public product-style and typography reference homepage | Consistent text, surface, spacing, and state choices across the desktop workspace |
| [Component Gallery](https://component.gallery/) | Public component reference homepage | Apply familiar semantic patterns and explicit interaction states to navigation, inputs, and task controls |
| [DesignMD](https://designmd.ai/) | Public design-system homepage | Keep an agent-readable design contract in the repository: [DESIGN.md](../DESIGN.md) |
| [21st](https://21st.dev/) | Public component-registry homepage | Compose reusable local components with a small explicit API; no new registry or MCP dependency is needed for this change |
| [Kinetics](https://kinetics.colorion.co/) | Public motion-reference homepage | Short motion with a purpose, a static fallback, and reduced-motion support |

The user's numeric descriptions of library size are not treated as a verified asset inventory. Only the public material described above was reviewed. Scrolltide's public page displayed a paid unlimited offering; no paid access was purchased and no restricted code was accessed. A failed web fetch of that site was followed by a successful browser review of the public homepage.

## Implementation and provenance

| File | Origin | Usage and limits |
| --- | --- | --- |
| `desktop/public/brand/toris-logo.png` | User-provided `desktop/logo-full.png`, copied without alteration | Original T identity for the sidebar and overview; installation icons remain unchanged |
| `desktop/public/brand/workspace-map.svg` | Original geometric artwork authored in this repository | Decorative content frames and channel paths; no account data or external brand marks |
| `desktop/src/BrandAtmosphere.tsx` | Original implementation authored in this repository | Decorative local component with a bounded pointer response and no continuous animation |
| `desktop/src/BrandAtmosphere.css` | Original component styling authored in this repository | Local layers, explicit proportions, and reduced-motion fallback |

The logo remains subject to its owner's rights. Newly authored illustration and component code follow the repository's applicable licensing terms; this document does not assign rights to the referenced sites or claim that their code is freely reusable. No third-party license is inferred from the ability to view a public preview.

## Runtime constraints

- All brand files resolve from bundled local assets. No remote font, image service, telemetry, or shader library is added.
- The SVG has no script, event handler, external URL, filter, or embedded raster image.
- Pointer movement schedules at most one animation frame at a time and changes only transform variables; leaving the graphic cancels pending work and resets it.
- Touch input and reduced-motion mode use the static artwork. The component is decorative, hidden from accessibility navigation, and has no keyboard stop.
- A 2D SVG composition provides depth without a game-engine texture, mesh, LOD, particle, or shader pipeline. The concrete asset budget is recorded in [DESIGN.md](../DESIGN.md).

## Verification boundaries

File provenance and source-size checks establish that the assets are local and original. Native screenshots, layout checks, and existing data/actions must be verified in the integrated app before the redesign is described as complete. A component preview or build result does not establish native application behavior or measured GPU frame time.
