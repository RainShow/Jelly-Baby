# Optical transport

The jelly's appearance is built from two related but separate optical paths:

1. a synchronous GPU caustic field that follows the current shape and feeds a
   shared scene-wide caustic receiver layer; and
2. an asynchronous worker path that updates directional shadow/contact data and
   view-dependent thickness for the transmissive body material.

This split keeps the bright, shape-sensitive caustic pass on the render device
while moving CPU ray/BVH work off the browser's main thread.

## Shared surface representations

The visible surface is the exact 72,234-vertex body surface. The optical proxy
is generated from the same implicit model at a reduced polygonizer resolution,
currently 10,090 vertices and 20,176 triangles. Both surfaces are embedded in
the same 980-node mechanical cage and can therefore be deformed from the same
particle state with [`deformSurface`](../src/physics/deform-surface.js).

The proxy is not a visual LOD. It is used only for bounded light transport. The
model build records two mappings:

- optical vertices to cage nodes for deformed proxy positions; and
- visible vertices to proxy triangle IDs and barycentric weights for copying
  view thickness back to the full surface.

[`SurfaceBVH`](../src/graphics/optics/refractive-light.js) builds a centroid-split
triangle hierarchy once and refits its node bounds as positions change. It is
used for visible picking, proxy thickness rays, and worker-side tracing without
the cost of a linear scan over every triangle.

## GPU geometric caustics

[`RefractiveLightField`](../src/graphics/optics/gpu-caustics.js) owns GPU
transport independently of the worker's shadow and thickness fields.
[`caustic-kernels.js`](../src/graphics/optics/caustic-kernels.js) contains WGSL
functions composed and bound through TSL; there are no private GPU pipelines,
depth-derived lens normals, CPU caustic readbacks, or temporal accumulation.

Each moving frame uploads cage positions and nodal deformation gradients.
A compute pass reconstructs the optical proxy's positions and smooth normals
with the same embedding/cofactor transform as the visible surface. Positions
are relative to the body's center to preserve precision across worlds.
A static depth-first triangle BVH is refitted bottom-up in ordered GPU dispatches.
Escape links permit stackless traversal with no fixed-size traversal stack.

Caustics use one directional incident field aligned with the measured dominant
light, matching the source model of the original CPU transport before `df52c92`.
All incident power belongs to that field. The distinctive bright rims and folds
come from geometric convergence of connected refracted beams, not from a painted
pattern or a fitted light blob. Sampling bounds tightly enclose the jelly with
a 1 mm guard margin independently of the receiving footprint.

The broad room/window angular covariance is deliberately excluded from this focused
transport. Four separated source directions duplicate the entire pattern; spreading
beam power over broad Gaussian footprints removes its sharp optical structure.
The directional approximation preserves the established appearance while avoiding
both artifacts. `setSourceSpread` and its stored metadata remain compatible with
existing lighting and additional-source setup, but do not affect the caustic field.

The transport traces actual triangles for entry, exit, total internal reflection,
and re-entry, using exact unpolarized Fresnel transmission and Beer–Lambert RGB
absorption. It follows the transmitted branch at partial Fresnel interfaces and
the reflected branch at total internal reflection. Eight boundary events bound
work; paths still trapped at that limit contribute no light. Outgoing rays stop
at the first registered opaque receiver, including raised surfaces. Receiver
interception before re-entry takes precedence over the next jelly boundary.

A 32×32 base grid is refined locally to 64×64. Cell-center
rays measure nonlinear landing displacement, transmission changes, visibility
changes, and optical branch changes. Hysteresis stabilizes refinement decisions;
required edge rays are traced in the same frame. Parent and child bundles are
mutually exclusive and partition the same incident power. Invalid rays and
incompatible path/surface branches never form a bridge.

[`caustic-beams.js`](../src/graphics/optics/caustic-beams.js) rasterizes connected
beam triangles through expanded bounding quads. Fragment-local polygon clipping
integrates exact triangle/pixel overlap, following the original CPU beam rasterizer.
Density comes from transported power divided by actual receiving area, with additive
RGBA16F accumulation. Optical folds may reverse winding and overlap; those overlapping
triangles remain separate contributions, preserving their sharp focusing structure.
Collapsed footprints deposit their power in a containing pixel using measured receiver
pixel area. There is no arbitrary focus cap. The half-float storage ceiling remains
60,000. Antialiasing is limited to pixel coverage and the mild reconstruction below.

There is one 65×65 ray buffer and one set of deposited beams. No angular differential
buffers, footprint-preparation dispatch or broad splat overdraw are needed. Atlas
resolution and the receiver interface are unchanged.

Three 384² targets form a cropped camera atlas: RGBA32F receiver position/identity
with depth, raw RGBA16F irradiance, and reconstructed RGBA16F irradiance exposed
as `lightTexture`. The crop keeps the established local X/Z transport footprint but
fits its vertical extent to the actual nearby receiver bounds instead of a body-sized
empty volume. This preserves the same target sizes and passes while allocating more
atlas area to real receiver surfaces. Receiver identity and plane-distance checks
prevent deposits from bleeding onto unrelated surfaces. Camera movement
rerasterizes the atlas but does not retrace unchanged transport.

Before material lookup, `caustic-reconstruction.js` applies the established mild
3×3 positive kernel with separable [1, 4, 1] weights (sigma approximately 0.58
atlas texels). Identity, world-distance, and local plane checks reject taps on
unrelated surfaces. Weights include unlit neighbors and are normalized after
surface rejection; there is no brightness threshold or temporal history. The
extra RGBA16F target costs about 1.13 MiB per source. Reconstruction runs only
when the atlas is rerendered.

Material lookup uses four integer taps for bilinear reconstruction and therefore
does not require float32 texture filtering. Its continuity test is based on the
actual atlas-to-world footprint at the shaded fragment. The footprint is derived
from screen-space derivatives of receiver position and atlas UV, i.e. the local
Jacobian of the same cropped camera projection used to build the atlas. This keeps
the original tight world-distance rejection at normal viewing angles while
expanding it only as required by foreshortening. A grazing horizontal receiver
therefore no longer rejects valid neighboring atlas rows and produces stripe-like
sampling gaps, while disconnected portions of a batched mesh still fail the
world-distance continuity test.

## Receiver interface

The public opt-in remains:

```typescript
mesh.receiveCaustics = true;
caustics.register(mesh);
```

For a hierarchy, mark the intended meshes and call `caustics.add(root)`.
`FacilityShadows.add(...)` continues to opt in and register descendant meshes
automatically unless `receiveCaustics = false` is explicit. New worlds use this
same interface. The receiver layer handles PBR node-material albedo and preserves
existing emissive nodes; registration is deduplicated per material.

[`CausticSurfaces`](../src/graphics/optics/caustic-surfaces.js) caches triangle
hierarchies per receiver geometry. Per-source fields select visible nearby mesh
instances, update affine transforms and bounds, and share their geometry with
the receiver-position pass. Instanced meshes are expanded into individual
instance transforms. CPU-updated position attributes invalidate geometry data;
their existing BVH partition is refitted rather than rebuilt. Storage capacity
is reused across updates. Hidden world roots do not intercept light.

Receiver geometry must exist in its BufferGeometry attributes, as with the
facility shadow system. Shader-only displacement needs a matching transport
representation; this is not inferred from arbitrary material code.

Caustics are injected as albedo × irradiance / pi, scaled by the same measured
window color/irradiance as the environment correction. Surface incidence and
opaque visibility are already accounted for by geometric beam landing. Ground
receivers also reuse the existing filtered facility-shadow visibility for the
refracted direct-light term. The filtered facility-mask node is shared with the
ground shader, so this adds no shadow pass, caustic target, or facility-shadow
texture taps. Full source occlusion suppresses the caustic, while antialiased/
tent-filtered partial coverage attenuates and reshapes it smoothly. The optical jelly shadow channel is
intentionally excluded from this caustic visibility so a jelly does not erase its
own refracted light. Ground shadow/contact shading otherwise retains its established
coefficients.

Additional jellies use independent optical transport with a shared receiver
registry. `CausticReceivers.addSource` binds their additive irradiance to existing
and future materials and inherits camera and source spread. Ground receivers
continue to use `groundReceiver` for worker shadow/contact data and facility
shadow masks at the actual floor height.

The scene rule remains: every plausible opaque surface should participate.
The transmitting jelly and non-surface effects deliberately stay outside this
receiver registry.

## Worker-backed shadow and thickness transport

[`OpticalTransport`](../src/graphics/optics/transport.ts) starts
[`transport.worker.ts`](../src/graphics/optics/transport.worker.ts) as a module worker.
The initialization message sends the optical proxy topology, rest normals, cage
bindings, and the measured light direction. At most one frame request is in
flight, and requests are limited to 30 per second.

When the body surface revision changes, the main thread sends copies of cage
particles and nodal deformation gradients using transferable buffers. The worker
deforms and refits the proxy, updates its `OpticalShadowField`, and posts the
shadow/contact texture first. The main thread installs those bytes into the
256² RGBA shadow texture, updates its receiver coordinates, and records the
traced center/origin. The worker then performs view-thickness tracing and posts
a second message.

When only the camera moved, the request contains no particles or gradients. The
worker reuses the most recent shadow/contact field and sends only new thickness.
This is why camera orbit remains responsive without repeatedly rebuilding the
directional field.

The worker's directional raster and view-thickness loops reuse triangle/ray/intersection
scratch storage rather than allocating arrays and hit records per triangle or vertex.
The arithmetic and resulting shadow/contact bytes and thickness values are unchanged;
the change only removes worker CPU/GC overhead from startup and later 30 Hz updates.

`follow()` compensates for body translation between the worker's traced center
and the current center. It shifts the contact origin horizontally and reprojects
the directional shadow origin for the current vertical offset, so a delayed
worker result stays attached to the moving body.

Lighting-mode changes send the new direction separately and force the next
shape request even for a sleeping body. Shadow replies carry a lighting revision
so an in-flight day result cannot overwrite a night field (or vice versa).
View thickness is independent of this revision and can still complete normally.

## View thickness

For each proxy vertex facing the camera, the worker refracts the camera ray from
air into the jelly and intersects the internal ray against the proxy BVH. The
distance is clamped to a small useful range and stored in the proxy's
`opticalThickness` attribute. The main thread interpolates the proxy values onto
the full visible surface with the generated three-vertex mappings. The baby
material reads that attribute as its physical transmission thickness.

The thickness calculation is deliberately view-dependent. It is not a costly
per-pixel volume integration and it does not alter the mechanical or visible
surface geometry.

## Directional shadow/contact field

The worker's [`OpticalShadowField`](../src/graphics/optics/refractive-light.js)
projects every proxy triangle along the measured incoming light direction onto a
256² receiver. It stores two channels:

- red: directional body shadow;
- green: a height-faded contact contribution from low body triangles.

Both channels receive a small separable blur before being packed into RGBA
bytes. The table samples them with separate coordinate transforms. The field is
kept independent from the GPU caustic targets so caustic changes cannot alter
the established opaque shadow/contact behavior.

## Facility shadows are separate

Opaque facility geometry is handled by
[`FacilityShadows`](../src/facilities/shadows.ts), not by the optical
worker. It renders complete facility geometry into a 512² main-world target,
resizing that target for larger active-world footprints so ground texel density
does not fall when the toy track is active. It stores red directional shadow and
green near-floor contact channels. The table combines this target with the
optical field using a deterministic tent filter. See [Facilities](facilities.md)
for its invalidation and swept-bounds rules.

## Current helper status

[`src/graphics/optics/beam-raster.js`](../src/graphics/optics/beam-raster.js) contains a
conservative CPU triangle-to-pixel flux integrator with reusable clipping
scratch buffers. It is retained as a standalone optical utility, but it is not
imported by the current runtime. The live caustic path is the GPU render-target
pipeline above; the worker currently publishes shadow/contact and thickness, not
CPU caustic photons.

## Approximation budget and verification

Transport uses the optical proxy, a dominant-direction light approximation,
bounded adaptive sampling, and eight boundary events. It does not integrate the
full extended window. A deformed or lobed jelly can still generate multiple physical
folds within its caustic; a single source does not imply a featureless spot.
RGB shares a geometric path; absorption is
channel-specific, but spectral dispersion and partially reflected Fresnel
branches are not traced. The receiver atlas samples the camera-visible surface
at finite resolution; hidden layers are not represented in that atlas. There is
no floor-projected approximation for raised surfaces.

Outgoing transport has a finite distance bound derived from the receiver span.
Highly divergent rays beyond that distance are discarded. Adaptive cells that
remain discontinuous at the finest grid are rejected rather than inventing
connections. These limits bound work without introducing asynchronously stale
caustic patterns.

`scripts/verify-caustic-gpu.mjs` checks hierarchy topology in the normal suite.
With `JELLY_WEBGPU_MODULE` pointing to the native `webgpu/index.js` runtime it
also executes the production TSL compute and render paths on Metal, checks
deformation and entry intersections against CPU geometry, verifies nonzero beam
deposition with normal studio lighting setup, compiles receiver materials, and
checks raised/hidden receiver interception. `verify-caustic-reference.mjs` compares
sampled GPU landing positions and transmitted power with the original CPU optical
equations, then compares the actual jelly's beam field texel by texel with the
original conservative CPU beam integrator on a planar atlas. This guards focused
shape and flux rather than merely checking for a nonzero or single-peaked output.
GPU readback is confined to that audit. Live visual assessment and
whole-game frame timing remain separate from these numerical checks.
