"""Marigold IID lighting on one rectilinear view of a panorama (inference only).

Usage: python infer_view.py PANORAMA U V OUTPUT_DIR [HFOV]
Same camera, model and settings as refine_view_lighting.py (90° x 4:3, 768 px,
4 steps, seed 42), so views can be merged by merge_view_lighting.py.
Run one view per process (memory), sequentially (RAM ~7 GB per run).
"""
import hashlib
import json
from pathlib import Path
import sys
import time

import cv2
import numpy as np
from PIL import Image
import torch
from diffusers import MarigoldIntrinsicsPipeline


def basis(u, v):
    lon, lat = (u - 0.5) * 2 * np.pi, (0.5 - v) * np.pi
    forward = np.array([np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)])
    right = np.array([np.cos(lon), 0, -np.sin(lon)])
    return forward, right, np.cross(forward, right)


def main():
    source, u, v, output = Path(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3]), Path(sys.argv[4])
    hfov = float(sys.argv[5]) if len(sys.argv) > 5 else 90
    output.mkdir(parents=True, exist_ok=False)
    started = time.perf_counter()
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    view = dict(u=u, v=v, horizontal_fov=hfov, width=1024, height=768)
    f, r, up = basis(u, v)
    scale = np.tan(np.deg2rad(hfov) / 2)
    xx, yy = np.meshgrid(np.arange(view['width']), np.arange(view['height']))
    rx = ((xx + 0.5) / view['width'] * 2 - 1) * scale
    uy = (1 - (yy + 0.5) / view['height'] * 2) * scale * view['height'] / view['width']
    rays = f + rx[..., None] * r + uy[..., None] * up
    rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
    photo = np.asarray(Image.open(source).convert('RGB'))
    sx = ((np.arctan2(rays[..., 0], rays[..., 2]) / (2 * np.pi) + 0.5) * photo.shape[1] - 0.5) % photo.shape[1]
    sy = np.clip((0.5 - np.arcsin(np.clip(rays[..., 1], -1, 1)) / np.pi) * photo.shape[0] - 0.5, 0, photo.shape[0] - 1)
    camera = Image.fromarray(cv2.remap(photo, sx.astype('f4'), sy.astype('f4'), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP))
    camera.save(output / 'input.png')
    pipe = MarigoldIntrinsicsPipeline.from_pretrained(
        'prs-eth/marigold-iid-lighting-v1-1', variant='fp16',
        torch_dtype=torch.float32, local_files_only=True,
    ).to('cpu')
    inference_started = time.perf_counter()
    with torch.inference_mode():
        result = pipe(camera, num_inference_steps=4, ensemble_size=1,
                      processing_resolution=768, match_input_resolution=True,
                      batch_size=1, generator=torch.Generator().manual_seed(42))
    for name, layer in zip(pipe.target_properties['target_names'], result.prediction):
        np.save(output / f'{name}.npy', layer.astype('f4'))
    meta = dict(source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(), view=view,
                model='prs-eth/marigold-iid-lighting-v1-1', resolution=768, steps=4,
                inference_seconds=round(time.perf_counter() - inference_started, 2),
                total_seconds=round(time.perf_counter() - started, 2))
    (output / 'meta.json').write_text(json.dumps(meta, indent=2) + '\n')
    print(json.dumps(meta), flush=True)


if __name__ == '__main__':
    main()
