# Rendering and materials

The renderer is deliberately WebGPU-only and TSL-first. The project imports
Three from `three/webgpu`, builds materials with `Mesh*NodeMaterial` and TSL
nodes, and treats a missing or unstable WebGPU device as a visible fatal error.

## Renderer creation and failure policy

[`src/graphics/scene/renderer.ts`](../src/graphics/scene/renderer.ts) requires a secure
context (`HTTPS` or `localhost`) and `navigator.gpu` before constructing
`THREE.WebGPURenderer`. It requests antialiasing and the high-performance power
preference, then explicitly disables Three r185's fallback factory. No WebGL
renderer is substituted.

The project wraps Three's existing `onDeviceLost` and `onError` callbacks rather
than replacing them. The wrappers preserve Three's internal bookkeeping, then
send a diagnostic error to the app and stop the animation loop. An unexpected
device destruction outside normal disposal is also fatal. `runtime.ts` adds a
first-frame queue fence after compilation, so errors raised while submitting
the first GPU work are still part of startup.

The renderer uses sRGB output and AgX tone mapping with exposure `1.05`. Its
canvas receives a descriptive ARIA label that covers walking, jumping,
facility interaction, orbiting, and dragging.

## Loading-time pipeline warmup

[`render-warmup.ts`](../src/graphics/scene/render-warmup.ts) wraps the main-scene
`compileAsync` call. During that call only, it exposes hidden objects and disables
frustum culling for the world being warmed, then restores the exact original
flags in `finally`. This ensures rear-room facilities and later-visible effects
receive their WebGPU pipelines while the loading UI is still active rather than
on the first gameplay frame that brings them into view. Lazy destinations compile
once on first entry. Already-warmed inactive world roots remain hidden during a
new destination compile, while the root scene is still used so fog/environment
shader context matches gameplay. Every transition still performs a hidden render
and GPU queue fence before the loading overlay closes. The helper does not alter
normal render culling, visibility, materials, or collision behavior.

The moving caustic receiver field also avoids per-frame transient packing work: its
proxy list, geometry list, instance records, matrices, vectors, and upload buffers are
reused across frames. Geometry buffers are repacked only when the active geometry set
changes; unchanged receiver instances do not trigger a storage-buffer upload. This is
a CPU/GC optimization only and does not change ray count, atlas resolution, filtering,
or receiver selection.

## Drawing-buffer and camera sizing

[`resizeView`](../src/graphics/scene/renderer.ts) is called after startup and through a
resize-observer callback coalesced to one animation frame. It computes:

```text
width  = max(1, innerWidth)
height = max(1, innerHeight)
dpr    = min(devicePixelRatio, 1.7, sqrt(4,000,000 / (width × height)))
```

The drawing buffer is set once with the resulting DPR. DPR is allowed to fall
below 1 on a very large CSS viewport; there is no final `max(1, dpr)` floor that
would break the four-million-pixel cap. Zero-sized transient viewports are
ignored.

The camera starts near the 7 cm character and uses a 36-degree base framing.
The field of view widens for a narrow aspect ratio, the mobile view is shifted
slightly downward, and the orbit polar limit is recomputed so the horizon does
not enter the tabletop composition.

## Scene and lighting

Day mode is the default. The scene uses a warm beige background and matching fog. The authored day and night HDR images live under `dev-assets/environment/`, outside the runtime asset graph. `npm run build:environment` decodes both offline. The day source receives the exact studio-light shaping pass before its half-float pixels are written to [`src/assets/bg_room_studio.rgba16f`](../src/assets/bg_room_studio.rgba16f); the night source is copied losslessly into [`src/assets/night.rgba16f`](../src/assets/night.rgba16f). Their measured direction/color/spread/irradiance constants are emitted into `studio-environment.generated.ts` and `night-environment.generated.ts`. Runtime fetches those exact RGBA16F pixels directly and converts them into PMREM environment textures, so neither mode performs EXR decoding or HDR source analysis in the browser.

[`src/graphics/scene/studio-light.ts`](../src/graphics/scene/studio-light.ts) is still the
single source of truth for the edit: it reorients the photographed window to the
project's elevated key direction, applies a broad gain to the key and a reduced fill
to the rest of the room, and writes the half-float HDR image. `measureWindow` then
integrates that edited image to derive the values used by the table, shadow, and
optical systems. The lighting verification regenerates the studio image from the
authored EXR and requires byte-for-byte parity with the runtime file, so moving this
work out of startup does not change visual quality or transport values.

The environment contributes general illumination through PMREM. The table's
window occlusion and transmitted flux are added as a measured local correction,
not as a second point or directional light that would double the window.

Raised surfaces use separate light-space depth maps for facilities and the
deformed jelly. Hidden lazy-world roots are skipped by shadow world-matrix and
caster synchronization; their complete subtree is synchronized on the first
visible update after travel. Visibility enters the physical material's `aoNode` as a
normal-weighted approximation of the blocked window contribution. Three applies
this to indirect diffuse, specular, and clearcoat lighting; the final output and
transmitted background are not multiplied by a shadow mask. This preserves the
jelly's refraction and avoids a dark painted-on layer. No second light is added.
The jelly receives only the facility map, keeping its existing self-shading intact.

## Night mode

The sun/moon control uses the prebaked night RGBA16F environment and its generated lighting metadata. Day keeps its original studio shaping, environment intensity, exposure, and post process. Night uses the supplied HDR pixels without studio rotation or window gain, at environment intensity `.45`, with a dark blue background/fog and a readable evening UI palette. Both PMREM targets are generated during the initial loading screen and retained, so the first night toggle performs only the already-prepared lighting/environment state swap. Exposure and the post process stay fixed.

The night image's strongest patch is below the horizon. Its shadow-source
threshold therefore uses the upper hemisphere's peak, so that lower patch
cannot hide the weaker overhead emitter. The resulting warm, low source drives
direction, color, shadow fraction, and transmitted irradiance; PMREM still
includes the entire image. This remains a dominant-source approximation: ambient
fill and other emitters contribute illumination without separate shadow maps.

Switching updates table uniforms, shared caustic receiver irradiance/color, GPU
caustic direction and flux correction, facility ground projection, and
raised-surface depth cameras together. Swept
bounds are refitted for the longer night shadows and all shadow caches are
invalidated. The worker receives a lighting revision; old directional results
are discarded and its shadow texture is cleared until the fresh field arrives.
Returning to day reapplies the cached original environment and measurements. Because both modes are loaded before gameplay, the toggle has no lazy asset decode, analysis, or PMREM-generation path. Failures during either environment preparation remain part of the observed startup promise chain and reach the existing fatal UI.

## Table material

[`src/graphics/scene/table.ts`](../src/graphics/scene/table.ts) loads three wood maps:

- `wood_base.jpg` for albedo;
- `wood_normal.png` for micro-relief; and
- `wood_roughness.jpg` for roughness.

All maps repeat and use anisotropy 8. The world-space UV scale repeats the wood
every 2.5 metres. The table is a 200 m plane placed just below the simulation
floor so its visible surface meets the contact and receiver conventions.

The physical node material combines the wood with:

- optical shadow and near-floor contact from the RGBA shadow texture;
- facility shadow/contact from the separate facility target, 512² at the main
  playroom footprint and resized for larger active-world footprints to preserve
  its world-space texel density;
- the shared GPU caustic receiver term, multiplied by measured window
  irradiance/color and the already-filtered facility-source visibility so caustics
  fade/deform under facility shadows without an extra render pass or
  facility-shadow texture sampling;
- a small reduction in albedo under the window's occluded diffuse contribution;
  and
- roughness in the range produced by the source roughness map.

A deterministic 3×3 tent sample softens facility masks. The material does not
use transparent ground overlays or nearly coplanar shadow geometry.

The tabletop is no longer a one-off caustic consumer. It sets
`receiveCaustics = true` and registers with the same `CausticReceivers` layer as
scene facilities, while retaining its existing wood-albedo and facility-shadow
overrides. Facility PBR materials receive geometric caustic irradiance through
their own albedo nodes. Outgoing rays intersect the actual registered receiver
geometry; raised surfaces no longer sample a back-projected floor field. The
receiver atlas checks object identity and position during reconstruction.

## Baby material and render order

[`src/graphics/character/baby.ts`](../src/graphics/character/baby.ts) uses a
`MeshPhysicalNodeMaterial` with full transmission, IOR `1.35`, small dispersion,
clearcoat, and attenuation. The player body uses a 128² local cube reflection
probe from [`local-reflections.ts`](../src/graphics/scene/local-reflections.ts).
Open probe directions retain the current authored HDR environment, while actual
visible scene geometry replaces it where walls, furniture, stadium structure, or
other opaque scenery blocks the distant environment. The probe is fully captured
under the loading card on startup/world travel. During gameplay it refreshes after
about 1.5 mm of player translation and renders at most four 128² cube faces per
frame. Faces are staged into a scratch cube; only a completed six-face capture is
GPU-copied into the stable cube used by the jelly material and then marked for
PMREM refresh. This lets the next capture begin in the same frame without exposing
a partially updated cube. Removing the previous per-face wall-clock throttle keeps
local reflection parallax responsive while still avoiding a six-view spike in one
frame. The player itself is hidden from the probe to avoid recursive self-reflection.
Its `thicknessNode` reads the dynamic
`opticalThickness` vertex attribute, which is filled asynchronously by the
optical transport path. The flavor picker updates the surface color and
attenuation color together; the attenuation color is derived from the selected
flavor's RGB absorption coefficients at the material's `.035 m` attenuation
distance.

The body mesh is render order 1 and is never replaced with a lower-resolution
visual mesh. The face artwork is generated in separate dynamic meshes at render
order 2. It is transparent and depth-tested, so it renders after the
transmissive shell and cannot be captured into the opaque refraction background
and then appear a second time through the body.

## Final image pipeline

[`src/graphics/scene/composite.ts`](../src/graphics/scene/composite.ts) builds a TSL
`RenderPipeline` around the scene pass. In linear HDR order it:

1. reads the scene output;
2. adds restrained bloom with threshold `.075`, strength `.18`, and radius
   `1.6`;
3. applies a slight cool/bright channel balance;
4. applies a cheap high-contrast pre-grade around linear 18% middle gray, with
   highlights left in HDR for the renderer's AgX shoulder instead of being
   clipped in the composite;
5. applies a subtle radial vignette; and
6. hands the result to the renderer's one AgX/output transform.

The contrast grade is arithmetic inside the existing full-screen composite, so
it does not add another render target, texture sample, or post-processing pass.
The composite owns and disposes its scene pass, bloom node, and pipeline. There
is no second tone-map stage hidden in the post process.

## Geometry and TSL conventions

The visible body, table, swing, trampoline, and optical depth meshes all use
Three's WebGPU-compatible geometry/material classes. Procedural wood grain in
the swing is a TSL node over `positionLocal`; table, baby, facility, and
composite shading is likewise expressed as nodes rather than raw WebGL shader
strings.

Dynamic geometry marks its position/normal attributes for update and recomputes
bounds only where the subsystem needs them. The body updates bounds from the
solver's metadata; the trampoline recomputes its bed normals and bounding sphere
when compression changes; optical targets own their own fixed render sizes.
