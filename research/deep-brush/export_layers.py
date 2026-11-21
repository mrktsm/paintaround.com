"""Export precomputed layers for the in-app /deep prototype.

Usage: python export_layers.py DATA_DIR PANO_ID METHOD OUT_ROOT [PANO_DIR]
Writes OUT_ROOT/<id>/distance.f32  (Float32, 2048x1024, row-major, top row first)
       OUT_ROOT/<id>/shading.f32   (Float32, 2048x1024, normalised so lit surfaces ~ 1)
       OUT_ROOT/<id>/surface.f32   (Float32, 2048x1024) paint multiplier = shading^0.3 * detail^0.6
                                   detail = image luminance / its local average (mortar, cracks, texture)
                                   -> what the app multiplies finished strokes by (needs PANO_DIR)
       OUT_ROOT/<id>/meta.json
With PANO_DIR, sky pixels get distance 0 ("no surface") via sky_mask.py (UperNet ADE20K).
"""
import json, os, sys

import numpy as np
from PIL import Image

data_dir, pid, method, out_root = sys.argv[1:5]
pano_dir = sys.argv[5] if len(sys.argv) > 5 else None
SHADING_POW, DETAIL_POW = 0.3, 0.6  # tuned on the brick wall, see README
W, H = 2048, 1024


def fit(a):
    a = a.astype(np.float32)
    if a.shape == (H, W):
        return a
    return np.asarray(Image.fromarray(a).resize((W, H), Image.BILINEAR))


dist = fit(np.load(os.path.join(data_dir, f'{pid}_distance.npy')))
shd = fit(np.load(os.path.join(data_dir, f'{pid}_{method}_shading.npy')))
shd = np.clip(shd / np.percentile(shd[int(H * 0.35):], 92), 0, 2.5)  # ignore sky for the reference

out = os.path.join(out_root, pid)
os.makedirs(out, exist_ok=True)
if pano_dir:
    # Sky is not a surface: distance 0 = "no surface" (strokes can't start or spread there)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from sky_mask import sky_mask
    sky = sky_mask(Image.open(os.path.join(pano_dir, f'{pid}.jpg')).convert('RGB').resize((W, H)))
    dist = dist.copy()
    dist[sky] = 0
dist.astype('<f4').tofile(os.path.join(out, 'distance.f32'))
if pano_dir:
    import cv2
    img = np.asarray(Image.open(os.path.join(pano_dir, f'{pid}.jpg')).convert('RGB').resize((W, H))).astype(np.float32) / 255
    lin = np.where(img <= 0.04045, img / 12.92, ((img + 0.055) / 1.055) ** 2.4)
    lum = lin @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    detail = np.clip(lum / (cv2.GaussianBlur(lum, (0, 0), 3) + 1e-4), 0.3, 2.0)
    surface = (shd ** SHADING_POW) * (detail ** DETAIL_POW)
    surface.astype('<f4').tofile(os.path.join(out, 'surface.f32'))
shd.astype('<f4').tofile(os.path.join(out, 'shading.f32'))
json.dump({'width': W, 'height': H, 'lighting': method, 'depth': 'DA2'}, open(os.path.join(out, 'meta.json'), 'w'))
print('exported', out)
