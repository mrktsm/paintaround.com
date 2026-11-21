"""Merge several rectilinear Marigold lighting views into one 360° lighting map.

Usage: python merge_view_lighting.py PANORAMA DISTANCE_F32 BASE_SHADING_F32 OUT_PREFIX ANCHOR_DIR VIEW_DIR...

Each *_DIR holds shading.npy + meta.json from infer_view.py / refine_view_lighting.py.
ANCHOR_DIR is the reviewed view: its brightness normalisation is kept exactly, so
the approved shadows do not change; every other view gets one brightness gain,
solved from the overlaps (Marigold's shading scale varies a little per view).

Writes OUT_PREFIX.f32 (grey, 2048x1024), OUT_PREFIX-rgb.f32 (interleaved RGB,
channel mean == grey) and OUT_PREFIX.json.

Blending is in log space with weights = border feather x cos(angle to view
centre)^4, so each pixel leans on the view that sees it least distorted, and
overlaps cross-fade over ~30°. Pixels no view covers keep BASE_SHADING (grey).
"""
import hashlib
import json
from pathlib import Path
import sys

import cv2
import numpy as np

W, H = 2048, 1024
CHROMA_BLUR_PX = 9
CHROMA_LIMIT = (0.75, 1.35)


def basis(u, v):
    lon, lat = (u - 0.5) * 2 * np.pi, (0.5 - v) * np.pi
    forward = np.array([np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)])
    right = np.array([np.cos(lon), 0, -np.sin(lon)])
    return forward, right, np.cross(forward, right)


LON, LAT = np.meshgrid((np.arange(W) + 0.5) / W * 2 * np.pi - np.pi,
                       np.pi / 2 - (np.arange(H) + 0.5) / H * np.pi)
DIRS = np.stack([np.cos(LAT) * np.sin(LON), np.sin(LAT), np.cos(LAT) * np.cos(LON)], axis=-1)


def project(view_dir, sha):
    meta = json.loads((view_dir / 'meta.json').read_text())
    if meta['source_sha256'] != sha:
        raise ValueError(f'{view_dir}: different photo')
    if meta.get('resolution') != 768 or meta.get('steps') != 4:
        raise ValueError(f'{view_dir}: different model settings')
    view = meta['view']
    vh, vw = view['height'], view['width']
    shading = np.load(view_dir / 'shading.npy').astype('f4')
    if shading.shape != (vh, vw, 3):
        raise ValueError(f'{view_dir}: unexpected shape {shading.shape}')
    mean = shading.mean(axis=-1)
    chroma = shading / np.maximum(mean, 1e-4)[..., None]
    chroma = np.clip(cv2.GaussianBlur(chroma, (0, 0), CHROMA_BLUR_PX), *CHROMA_LIMIT)

    f, r, up = basis(view['u'], view['v'])
    scale = np.tan(np.deg2rad(view['horizontal_fov']) / 2)
    z = DIRS @ f
    nx = (DIRS @ r) / np.maximum(z, 1e-6) / scale
    ny = (DIRS @ up) / np.maximum(z, 1e-6) / (scale * vh / vw)
    feather = np.clip((1 - np.maximum(np.abs(nx), np.abs(ny))) / 0.12, 0, 1) * (z > 0)
    weight = (feather * np.clip(z, 0, 1) ** 4).astype('f4')
    px = ((nx + 1) * vw / 2 - 0.5).astype('f4')
    py = ((1 - ny) * vh / 2 - 0.5).astype('f4')
    remap = lambda img: cv2.remap(np.ascontiguousarray(img), px, py, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    norm = max(float(np.percentile(mean[int(vh * 0.25):], 92)), 1e-5)  # refine_view_lighting.py's
    return dict(name=view_dir.name, view=view, weight=weight, norm=norm,
                log=np.log(np.maximum(remap(mean), 1e-4)),
                chroma=np.stack([remap(chroma[..., c]) for c in range(3)], axis=-1))


def main():
    source, dist_path, base_path, out = map(Path, sys.argv[1:5])
    dirs = [Path(p) for p in sys.argv[5:]]
    sha = hashlib.sha256(source.read_bytes()).hexdigest()
    solid = np.fromfile(dist_path, dtype='<f4').reshape(H, W) > 0  # sky has no depth
    base = np.fromfile(base_path, dtype='<f4').reshape(H, W)
    views = [project(d, sha) for d in dirs]
    n = len(views)

    # --- brightness gains: robust pairwise log offsets in overlaps, then least squares ---
    rows, rhs, pairs = [], [], []
    for i in range(n):
        for j in range(i + 1, n):
            m = (views[i]['weight'] > 0.05) & (views[j]['weight'] > 0.05) & solid
            if m.sum() < 2000:
                continue
            offset = float(np.median(views[j]['log'][m] - views[i]['log'][m]))  # log_i + g_i = log_j + g_j
            strength = float(np.sqrt(m.sum()))
            row = np.zeros(n); row[i], row[j] = strength, -strength
            rows.append(row); rhs.append(offset * strength)
            pairs.append((views[i]['name'], views[j]['name'], int(m.sum()), round(offset, 4)))
    anchor = np.zeros(n); anchor[0] = 1e4
    rows.append(anchor); rhs.append(-np.log(views[0]['norm']) * 1e4)
    gains, *_ = np.linalg.lstsq(np.array(rows), np.array(rhs), rcond=None)
    index = {v['name']: k for k, v in enumerate(views)}
    residuals = [round(float(o - (gains[index[a]] - gains[index[b]])), 4) for a, b, _, o in pairs]

    # --- blend ---
    wsum = np.zeros((H, W), 'f4'); lsum = np.zeros((H, W), 'f4'); csum = np.zeros((H, W, 3), 'f4')
    for v, g in zip(views, gains):
        wsum += v['weight']
        lsum += v['weight'] * (v['log'] + g)
        csum += v['weight'][..., None] * v['chroma']
    has = wsum > 1e-6
    merged = np.where(has, np.exp(lsum / np.maximum(wsum, 1e-6)), 0)
    merged = np.clip(merged, 0, 2.5)
    # Inside the anchor's own core, keep the approved values exactly.
    anchor_only = views[0]['weight'] / np.maximum(wsum, 1e-6) > 0.999
    approved = np.clip(np.exp(views[0]['log']) / views[0]['norm'], 0, 2.5)
    merged = np.where(anchor_only, approved, merged)
    cover = np.clip(wsum / 0.05, 0, 1)  # fade to base only where coverage is negligible
    grey = (base * (1 - cover) + merged * cover).astype('<f4')
    chroma = np.where(has[..., None], csum / np.maximum(wsum, 1e-6)[..., None], 1)
    chroma = chroma * cover[..., None] + (1 - cover[..., None])
    chroma /= chroma.mean(axis=-1, keepdims=True)
    rgb = (grey[..., None] * chroma).astype('<f4')
    for a in (grey, rgb):
        if not np.isfinite(a).all() or (a < 0).any():
            raise ValueError('Invalid merged lighting')
    grey.tofile(f'{out}.f32')
    rgb.tofile(f'{out}-rgb.f32')

    area = np.cos(LAT)
    stats = dict(
        source_sha256=sha, model='prs-eth/marigold-iid-lighting-v1-1', resolution=768, steps=4,
        layout={'grey': f'{out.name}.f32', 'rgb': f'{out.name}-rgb.f32 (interleaved, channel mean == grey)'},
        anchor=views[0]['name'], views=[dict(name=v['name'], u=v['view']['u'], v=v['view']['v'],
                                             gain=round(float(np.exp(g)), 4)) for v, g in zip(views, gains)],
        pair_offsets=pairs, pair_residuals=residuals,
        solid_covered_fraction=round(float(((cover > 0.99) & solid).astype('f4').__mul__(area).sum() / (solid * area).sum()), 4),
        chroma_blur_px=CHROMA_BLUR_PX, chroma_limit=CHROMA_LIMIT,
    )
    Path(f'{out}.json').write_text(json.dumps(stats, indent=2) + '\n')
    print(json.dumps({k: stats[k] for k in ('views', 'pair_residuals', 'solid_covered_fraction')}))


if __name__ == '__main__':
    main()
