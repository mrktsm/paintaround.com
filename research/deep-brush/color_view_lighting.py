"""Colour lighting from a saved rectilinear Marigold run (no inference).

Usage: python color_view_lighting.py PANORAMA VIEW_DIR BASE_SHADING_F32 APPROVED_VIEW_F32 OUTPUT_F32

VIEW_DIR is the output of refine_view_lighting.py (shading.npy + meta.json).
Writes OUTPUT_F32 as interleaved RGB float32 (2048 x 1024 x 3) plus OUTPUT_F32.json.

The model's RGB shading is kept as a low-frequency chroma (shading / its mean),
so sky-lit shadow turns slightly blue and sun warm. Brightness is unchanged: the
mean of the three channels equals the approved grey map, which the script first
rebuilds and checks, so colour is the only difference.

Tried and rejected (Nov 19, 2026): guided-filtering the lighting with the photo
as guide. The approved map's shadow edge is already crisp at 2048 px; the filter
only blurred cobble relief. Blockiness when zoomed in came from nearest-texel
sampling in the app, now bilinear.
"""
import hashlib
import json
from pathlib import Path
import sys

import cv2
import numpy as np

W, H = 2048, 1024
CHROMA_BLUR_PX = 9      # chroma is low-frequency; this hides per-pixel model noise
CHROMA_LIMIT = (0.75, 1.35)


def basis(u, v):
    lon, lat = (u - 0.5) * 2 * np.pi, (0.5 - v) * np.pi
    forward = np.array([np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)])
    right = np.array([np.cos(lon), 0, -np.sin(lon)])
    return forward, right, np.cross(forward, right)



def main():
    source, view_dir, base_path, approved_path, output = map(Path, sys.argv[1:6])
    meta = json.loads((view_dir / 'meta.json').read_text())
    if hashlib.sha256(source.read_bytes()).hexdigest() != meta['source_sha256']:
        raise ValueError('View lighting belongs to a different photo.')
    view = meta['view']
    shading = np.load(view_dir / 'shading.npy').astype('f4')  # linear RGB, view space
    vh, vw = view['height'], view['width']
    if shading.shape != (vh, vw, 3):
        raise ValueError(f'Unexpected shading shape {shading.shape}')

    # --- grey, exactly as refine_view_lighting.py ---
    mean = shading.mean(axis=-1)
    norm = max(float(np.percentile(mean[int(vh * 0.25):], 92)), 1e-5)
    grey = np.clip(mean / norm, 0, 2.5)

    # --- chroma: per-channel ratio to the mean, smoothed and limited ---
    chroma = shading / np.maximum(mean, 1e-4)[..., None]
    chroma = cv2.GaussianBlur(chroma, (0, 0), CHROMA_BLUR_PX)
    chroma = np.clip(chroma, *CHROMA_LIMIT)
    chroma /= chroma.mean(axis=-1, keepdims=True)  # keep brightness identical

    # --- reproject to panorama space ---
    f, r, up = basis(view['u'], view['v'])
    scale = np.tan(np.deg2rad(view['horizontal_fov']) / 2)
    lon, lat = np.meshgrid((np.arange(W) + 0.5) / W * 2 * np.pi - np.pi,
                           np.pi / 2 - (np.arange(H) + 0.5) / H * np.pi)
    dirs = np.stack([np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)], axis=-1)
    z = dirs @ f
    nx = (dirs @ r) / np.maximum(z, 1e-6) / scale
    ny = (dirs @ up) / np.maximum(z, 1e-6) / (scale * vh / vw)
    weight = (np.clip((1 - np.maximum(np.abs(nx), np.abs(ny))) / 0.12, 0, 1) * (z > 0)).astype('f4')
    px = ((nx + 1) * vw / 2 - 0.5).astype('f4')
    py = ((1 - ny) * vh / 2 - 0.5).astype('f4')
    remap = lambda img: cv2.remap(img, px, py, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    base = np.fromfile(base_path, dtype='<f4').reshape(H, W)
    refined = base * (1 - weight) + remap(grey) * weight

    approved = np.fromfile(approved_path, dtype='<f4').reshape(H, W)
    # cv2.remap's fixed-point bilinear weights give ~0.05% noise vs the original run;
    # a wrong view, normalisation or file gives errors orders of magnitude larger.
    rel = np.abs(refined - approved) / np.maximum(approved, 1e-3)
    drift = float(rel[weight > 0].mean())
    if drift > 2e-3 or float(np.abs(refined - approved).max()) > 0.05:
        raise ValueError(f'Rebuilt grey lighting differs from the approved map (mean rel {drift:.4f}).')
    refined = approved  # build on the exact approved values

    lighting = refined

    # --- colour (outside the view: neutral) ---
    chroma_p = np.stack([remap(np.ascontiguousarray(chroma[..., c])) for c in range(3)], axis=-1)
    chroma_p = chroma_p * weight[..., None] + (1 - weight[..., None])
    rgb = (lighting[..., None] * chroma_p).astype('<f4')
    if not np.isfinite(rgb).all() or (rgb < 0).any():
        raise ValueError('Invalid colour lighting')
    rgb.tofile(output)

    inside = weight > 0.99
    stats = dict(
        source_sha256=meta['source_sha256'], view=view, model=meta['model'],
        channels=3, layout='interleaved-rgb', width=W, height=H,
        chroma_blur_px=CHROMA_BLUR_PX, chroma_limit=CHROMA_LIMIT,
        coverage_fraction=meta['coverage_fraction'],
        grey_rebuild_mean_rel_drift=round(drift, 6),
        chroma_range_in_view=[[round(float(np.percentile(chroma_p[inside][:, c], q)), 3) for q in (1, 99)] for c in range(3)],
    )
    Path(str(output) + '.json').write_text(json.dumps(stats, indent=2) + '\n')
    print(json.dumps(stats))


if __name__ == '__main__':
    main()
