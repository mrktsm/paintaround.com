# Deep Brush for panoramas — step 0 spike

Goal: an Adobe *Project Deep Brush*–style brush for the street-view panoramas. Strokes should
**keep the original shadows / texture** and **wrap onto the real surfaces** (walls, ground, cars).

## Idea

Per panorama, precompute three layers (offline — the curated set is fixed, 3,178 images):

| Layer | Used for | Source tried |
|---|---|---|
| distance (depth) + normals | wrapping, foreshortening, stopping at object edges | DA² (panoramic depth) |
| albedo (surface colour) | — | Intrinsic / Retinex |
| shading (light & shadow) | keep shadows: painted = paint_colour × shading | Intrinsic / Retinex |

Wrap: the stroke is a curve in the surface's tangent plane, snapped to the real surface via the
depth map; a pixel is painted if its 3D point is within the brush radius of that 3D curve. That gives
foreshortening, wrapping and occlusion (stroke stays on the car, doesn't smear onto the road behind).

## Scripts

```
python fetch_panos.py OUT_DIR 5                 # download test panoramas
python run_depth.py DA2_REPO PANO_DIR OUT_DIR   # DA² distance + normals (PYTORCH_ENABLE_MPS_FALLBACK=1 on Mac)
python run_lighting.py PANO_DIR OUT_DIR retinex intrinsic
python paint_test.py PANO_DIR OUT_DIR out.png PANO_ID intrinsic "u,v,scale" ...
```

Setup used: `uv venv --python 3.12`, `pip install -e DA-2/src` (drop xformers/gradio/tensorboard
from its pyproject on macOS), `pip install -e Intrinsic`.

## Results (Nov 2026, Apple M1 8 GB)

- **Depth (DA²)**: ground plane excellent (exactly what the Mapillary mesh misses), cars / trunks /
  building edges clean. Sky gets fake depth → mask sky. Some normal noise on far facades/trees.
  ~22 s/pano on M1 in a fresh process (memory piles up if you loop in one process — run one per process).
- **Mapillary SfM mesh**: metric but coarse (~1.2k verts), no ground. Scale anchor only.
- **Retinex (training-free)**: fails — treats dark materials (red brick) as shadow. Not usable alone.
- **Intrinsic (compphoto)**: good split; tree shade moves into shading, dark car stays dark albedo.
  50–160 s/pano on M1.
- **Paint test** (`results/paint_test_intrinsic_main.png`, columns: original | flat | flat+shading |
  wrap+shading): pavement cracks show through the paint, bus ribs/highlights carry through,
  ground strokes foreshorten correctly. Brick wall paint slightly too dark → tune shading normalisation.

## Licences (free, non-commercial project)

- DA² — Apache-2.0 ✅
- compphoto/Intrinsic — **academic use only** ⚠️ ask authors (Careaga & Aksoy) or replace
- Marigold IID (not yet tried) — OpenRAIL++-M ✅ free use allowed → best licence-clean candidate

## Next

1. Try Marigold IID lighting as the licence-clean alternative; compare with Intrinsic.
2. Sky mask + normal smoothing; tune shading normalisation.
3. In-app prototype: precompute layers for a few panos, load them as textures in the WebGL stroke
   renderer, render strokes as `paint × shading` with the 3D-distance brush footprint.

## Colosseum cast-shadow diagnosis (November 19, 2026)

The exported Marigold whole-panorama trial misses much of the sharp pavement shadow:
it remains in the predicted **albedo**, rather than moving into **shading**. Around
`u=0.77`, shaded paving at `v=0.55` has linear photo luminance about 0.026 and
predicted shading 0.531; nearby sunlit paving at `v=0.62` is about 0.237 and 0.796.
These are small patch averages, not ground-truth material measurements, but the
layer images also visibly show the misplaced shadow. The old `shading^0.3` surface
blend weakens it further. Restoring an exponent of 1 alone cannot recover the
missing shadow boundary.

`refine_view_lighting.py PANORAMA BASE_SHADING_F32 OUTPUT_DIR` tests the same
lighting model on a conventional 90° rectilinear camera view at its recommended
768-pixel processing size. It exports a separate `shading-view.f32` with feathered
coverage in panorama coordinates; it never overwrites the original layers.
Review the output before enabling it. One view covers only part of the panorama;
this is a controlled extraction trial, not a complete panorama-processing pipeline.

The reviewed Colosseum view trial recovered the paving shadow in the lighting
layer. The same shadow/sun patch ratio changed from 0.684 to 0.106. Inference took
379 seconds on the existing CPU worker. Its source SHA-256 matches the panorama;
the refined map is finite, nonnegative, and 2048 × 1024. The separate
`public/deep-layers/ph-colosseum/shading-view.f32` feeds the comparison prototype.
Outside the camera view (about 9.4% of panorama pixels), it retains the original
lighting. Original distance, shading and surface exports remain intact.

The local `/paint-test` route compares opaque strokes on identical geometry. Its
pavement sample crosses from shade into direct sun, so a material that merely
darkens everything cannot pass as correct shadow integration.

### Regular drawing tools

After reviewing a refinement, run `npm run paint:materials -- ph-colosseum`
(Node with native TypeScript support). This validates the source photo hash and
layer dimensions/values, uses the same material formula as the approved test,
and writes a versioned, ready-to-render surface file plus an entry in
`src/data/paint-materials.json`. The large layer files remain ignored like the
original depth assets; include the generated files when packaging the app.

The shared `loadPaintSurface` loader supplies both live GPU/CPU rendering and
finished-stroke baking. No model inference or material reconstruction runs
while drawing. The live GPU shader and CPU bake use the same sRGB conversion.
Depth and materials start loading alongside the panorama; the photo can reveal
immediately, and drawing becomes available once its material is ready.

Only Colosseum currently has a reviewed refinement. Other panoramas continue
using their existing maps, and an unavailable/corrupt refined export falls back
to the old map. Existing finished drawings retain their baked appearance.

### Coloured lighting + bilinear sampling (November 19, 2026)

`color_view_lighting.py PANORAMA VIEW_DIR BASE_SHADING_F32 APPROVED_VIEW_F32 OUT.f32`
reuses the saved Marigold view run (no inference) and keeps its RGB shading as a
blurred, clamped chroma on top of the approved grey lighting. Channel mean equals the
approved map (max difference 2e-7), so brightness and shadow depth are unchanged.
Colosseum check: shaded paving b/r 1.80, sunlit 0.83 — a 2.2x cool/warm shift,
milder than the photo's own 3.3x, so not overdone. `npm run paint:materials` picks up
`shading-view-rgb.f32` automatically and writes an RGB surface (3 floats per pixel).

The app treats every paint surface as interleaved RGB (grey files are expanded on
load) and samples it bilinearly — GPU via an RGB16F LINEAR texture wrapping in u,
CPU via `sampleSurface` — so shadow edges no longer look blocky when zoomed in.
Live (GPU) and finished (CPU bake) strokes agree to ~1/255 on average.

Rejected: guided-filtering lighting with the photo as guide to sharpen shadow edges.
The approved edge was already crisp; the filter only blurred cobble relief.

Open: RGB surfaces are 25 MB (grey: 8 MB). Before rolling out widely, store as
float16 or as grey f32 + low-res chroma.

### Full 360° Colosseum lighting (November 19, 2026)

14 rectilinear views (90° x 4:3, 768 px, 4 steps): the reviewed view plus 5 more
around the horizon (60° apart), 6 pitched 50° down, 2 pitched 45° up toward the
tall facade. Views that would be mostly sky were skipped. `infer_view.py` ran each
on the Oracle ARM box: ~6.5 min per view, of which ~2 min is inference and the
rest is per-process model loading (13 views: 06:29–07:53 UTC). Raw views:
`research/panorama-pool/processing/italy/colosseum-360/`.

`merge_view_lighting.py` solves one brightness gain per view from robust overlap
offsets (Marigold's shading scale varied 0.90–1.80 between views), anchors the
reviewed view's normalisation, and blends in log space weighted by
feather x cos(angle to view centre)^4. Output: `shading-360.f32`,
`shading-360-rgb.f32`, `shading-360.json`. Covers 99.86% of non-sky area (only the
tripod nadir keeps the old map). The reviewed pavement shadow/sun ratio stays
0.112 (approved: 0.109). `generate-paint-materials.mjs` prefers this lighting.

Scaling: on this 2-core CPU box, 14 views per panorama is ~1.5 h, so ~12 days for
200 panoramas (~4 days if the model is loaded once per batch). A rented GPU should
make this hours; not yet measured.
