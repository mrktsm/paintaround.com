"""Offline paint test: same stroke rendered flat vs shading-preserving vs surface-wrapped.

Usage: python paint_test.py PANO_DIR DATA_DIR OUT_PNG PANO_ID METHOD "u,v[,scale]" ["u,v[,scale]" ...]
  u,v   seed pixel in the 2048x1024 equirect where the stroke is centred
  scale stroke size relative to the surface distance at the seed (default 0.6)
METHOD = lighting method whose <id>_<method>_albedo.png / _shading.npy to use.

How the variants work (I = image, A = albedo, S = shading, all linear RGB, I ~ A*S):
  flat         : stroke drawn in image space with constant pixel width, paint colour pasted on top.
  flat+shading : same footprint, but painted pixel = paint_albedo * S  (keeps shadows / folds).
  wrap+shading : stroke defined as a curve in the surface's tangent plane in 3D, then snapped onto
                 the actual surface via the depth map; a pixel is painted if its 3D point lies within
                 the brush radius of that 3D curve -> foreshortening, wrapping, occlusion for free.
"""
import os, sys

import numpy as np
from PIL import Image, ImageDraw

pano_dir, data_dir, out_png, pid, method = sys.argv[1:6]
seeds = sys.argv[6:]

PAINT = np.array([0.92, 0.12, 0.45])  # hot pink, sRGB
BRUSH = 0.035  # brush radius relative to seed distance


def lin(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


img = np.asarray(Image.open(os.path.join(pano_dir, f'{pid}.jpg')).convert('RGB')).astype(np.float32) / 255
H, W = img.shape[:2]
D = np.load(os.path.join(data_dir, f'{pid}_distance.npy')).astype(np.float32)
N = np.load(os.path.join(data_dir, f'{pid}_normals.npy')).astype(np.float32)
S = np.load(os.path.join(data_dir, f'{pid}_{method}_shading.npy')).astype(np.float32)
A = lin(np.asarray(Image.open(os.path.join(data_dir, f'{pid}_{method}_albedo.png')).convert('RGB')).astype(np.float32) / 255)


def fit(x):
    if x.shape[:2] == (H, W):
        return x
    im = Image.fromarray(x.astype(np.float32)) if x.ndim == 2 else None
    if im is not None:
        return np.asarray(im.resize((W, H), Image.BILINEAR))
    return np.stack([np.asarray(Image.fromarray(x[..., c]).resize((W, H), Image.BILINEAR)) for c in range(x.shape[2])], -1)


D, N, S, A = fit(D), fit(N), fit(S), fit(A)
N /= np.linalg.norm(N, axis=-1, keepdims=True) + 1e-8
I_lin = lin(img)
# Normalise shading so directly-lit surfaces ~ 1 (methods differ in absolute scale).
# Ignore the sky (top 35% of rows) so it doesn't skew the reference.
k = 1.0 / np.percentile(S[int(H * 0.35):], 92)

lon = (np.arange(W) + 0.5) / W * 2 * np.pi - np.pi
lat = np.pi / 2 - (np.arange(H) + 0.5) / H * np.pi
LON, LAT = np.meshgrid(lon, lat)
DIRS = np.stack([np.cos(LAT) * np.sin(LON), np.sin(LAT), np.cos(LAT) * np.cos(LON)], -1)
P = DIRS * D[..., None]


def to_px(X):
    r = np.linalg.norm(X, axis=-1)
    lo = np.arctan2(X[..., 0], X[..., 2])
    la = np.arcsin(np.clip(X[..., 1] / r, -1, 1))
    return (lo + np.pi) / (2 * np.pi) * W - 0.5, (np.pi / 2 - la) / np.pi * H - 0.5


def shape(t):
    """Graffiti-ish squiggle in tangent-plane coords (-1..1): a sine wave plus a loop."""
    x = np.where(t < 0.7, -1 + t / 0.7 * 2, 0.75 + 0.25 * np.cos((t - 0.7) / 0.3 * 2 * np.pi))
    y = np.where(t < 0.7, 0.35 * np.sin(t / 0.7 * 3 * np.pi), 0.25 * np.sin((t - 0.7) / 0.3 * 2 * np.pi))
    return x, y


def render(u0, v0, scale):
    u0, v0 = int(u0), int(v0)
    win = N[max(v0 - 6, 0):v0 + 7, max(u0 - 6, 0):u0 + 7].reshape(-1, 3).mean(0)
    n0 = win / np.linalg.norm(win)
    p0 = P[v0, u0]
    d0 = D[v0, u0]
    up = np.array([0, 1.0, 0])
    t1 = np.cross(up, n0)
    if np.linalg.norm(t1) < 0.2:  # ground / ceiling: use view direction for orientation
        t1 = np.cross(p0 / np.linalg.norm(p0), n0)
    t1 /= np.linalg.norm(t1)
    t2 = np.cross(n0, t1)

    ts = np.linspace(0, 1, 600)
    sx, sy = shape(ts)
    curve = p0 + (sx[:, None] * t1 + sy[:, None] * t2) * scale * d0
    cu, cv = to_px(curve)

    # --- flat footprint: polyline in image space, width = brush at seed, constant in pixels
    px_per_unit = W / (2 * np.pi) / d0
    width = max(2, int(2 * BRUSH * d0 * px_per_unit))
    m = Image.new('L', (W, H), 0)
    dr = ImageDraw.Draw(m)
    pts = list(zip(cu, cv))
    dr.line(pts, fill=255, width=width, joint='curve')
    for x, y in (pts[0], pts[-1]):
        dr.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=255)
    flat_mask = np.asarray(m).astype(np.float32) / 255

    # --- wrapped footprint: snap curve to the real surface, then 3D distance per pixel
    ci = np.clip(np.round(cv).astype(int), 0, H - 1)
    cj = np.round(cu).astype(int) % W
    surf = DIRS[ci, cj] * D[ci, cj][:, None]
    pad = int(width * 3 + 20)
    v_lo, v_hi = max(int(cv.min()) - pad, 0), min(int(cv.max()) + pad, H)
    u_lo, u_hi = int(cu.min()) - pad, int(cu.max()) + pad
    cols = np.arange(u_lo, u_hi) % W
    X = P[v_lo:v_hi][:, cols]
    r = BRUSH * d0
    best = np.full(X.shape[:2], np.inf, dtype=np.float32)
    for a, b in zip(surf[:-1:2], surf[2::2]):  # segment distances
        ab = b - a
        t = np.clip(((X - a) @ ab) / (ab @ ab + 1e-12), 0, 1)
        dist = np.linalg.norm(X - (a + t[..., None] * ab), axis=-1)
        np.minimum(best, dist, out=best)
    soft = np.clip((r - best) / (0.25 * r) + 0.5, 0, 1)
    wrap_mask = np.zeros((H, W), np.float32)
    wrap_mask[v_lo:v_hi][:, cols] = soft
    return flat_mask, wrap_mask, (u_lo, v_lo, u_hi, v_hi)


paint_lin = lin(PAINT)
rows = []
for spec in seeds:
    parts = [float(x) for x in spec.split(',')]
    u, v = parts[:2]
    scale = parts[2] if len(parts) > 2 else 0.6
    flat_m, wrap_m, (u0, v0, u1, v1) = render(u, v, scale)
    shaded = paint_lin * S[..., None] * k
    out_flat = I_lin * (1 - flat_m[..., None]) + paint_lin * flat_m[..., None]
    out_fs = I_lin * (1 - flat_m[..., None]) + shaded * flat_m[..., None]
    out_ws = I_lin * (1 - wrap_m[..., None]) + shaded * wrap_m[..., None]
    cols = np.arange(u0, u1) % W
    crops = [srgb(x[v0:v1][:, cols]) for x in (I_lin, out_flat, out_fs, out_ws)]
    row = np.concatenate([np.pad(c, ((4, 4), (4, 4), (0, 0)), constant_values=1) for c in crops], 1)
    rows.append(row)

wmax = max(r.shape[1] for r in rows)
rows = [np.pad(r, ((0, 0), (0, wmax - r.shape[1]), (0, 0)), constant_values=1) for r in rows]
Image.fromarray((np.concatenate(rows, 0) * 255).astype(np.uint8)).save(out_png)
print('saved', out_png, '(columns: original | flat | flat+shading | wrap+shading)')
