"""Split panoramas into albedo (surface colour) x shading (light/shadow), several methods.

Usage: python run_lighting.py PANO_DIR OUT_DIR [methods...]
methods: retinex (training-free, no licence issues), intrinsic (compphoto, academic-use licence)
Writes <id>_<method>_albedo.png, <id>_<method>_shading.npy (float16, grayscale), <id>_<method>_shadingviz.png
"""
import glob, os, sys, time

import numpy as np
from PIL import Image

pano_dir, out = sys.argv[1:3]
methods = sys.argv[3:] or ['retinex', 'intrinsic']
os.makedirs(out, exist_ok=True)


def srgb_to_linear(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def retinex(img):
    """Multi-scale Retinex-style split: shading = smooth luminance, albedo = img / shading.
    Edge-aware smoothing (guided filter) so shadows keep crisp edges at object borders."""
    import cv2
    lin = srgb_to_linear(img)
    lum = (0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]).astype(np.float32)
    log_l = np.log(lum + 1e-4)
    guide = log_l
    # guided filter at two scales, averaged in log space
    sh = 0
    for r in (8, 32):
        sh = sh + cv2.ximgproc.guidedFilter(guide, log_l, r, 0.02) if hasattr(cv2, 'ximgproc') else \
            sh + cv2.bilateralFilter(log_l, 2 * r + 1, 0.4, r)
    shading = np.exp(sh / 2)
    shading = shading / np.percentile(shading, 90)
    albedo = np.clip(lin / np.maximum(shading[..., None], 1e-3), 0, 1)
    return albedo, shading


_models = None


def intrinsic(img):
    global _models
    import torch
    from intrinsic.pipeline import load_models, run_pipeline
    dev = 'mps' if torch.backends.mps.is_available() else 'cpu'
    if _models is None:
        _models = load_models('v2', device=dev)
    r = run_pipeline(_models, img, device=dev)
    shading = r['dif_shd']
    if shading.ndim == 3:
        shading = shading.mean(-1)
    return r['hr_alb'], shading


for path in sorted(glob.glob(os.path.join(pano_dir, '*.jpg'))):
    pid = os.path.basename(path)[:-4]
    im = Image.open(path).convert('RGB')
    img = np.asarray(im).astype(np.float32) / 255.0
    for m in methods:
        t = time.time()
        alb, shd = {'retinex': retinex, 'intrinsic': intrinsic}[m](img)
        dt = time.time() - t
        alb_srgb = np.clip(alb, 0, 1) ** (1 / 2.2)
        Image.fromarray((alb_srgb * 255).astype(np.uint8)).save(os.path.join(out, f'{pid}_{m}_albedo.png'))
        np.save(os.path.join(out, f'{pid}_{m}_shading.npy'), shd.astype(np.float16))
        viz = np.clip(shd / (np.percentile(shd, 99) + 1e-6), 0, 1) ** (1 / 2.2)
        Image.fromarray((viz * 255).astype(np.uint8)).save(os.path.join(out, f'{pid}_{m}_shadingviz.png'))
        print(f'{pid} {m}: {dt:.1f}s', flush=True)
