"""GPU batch: Marigold IID lighting for the 14 standard views of many panoramas.

Usage: python batch_view_lighting.py PANO_DIR OUT_DIR [--ensemble N] [--ids a,b,c]
  PANO_DIR  holds <id>.jpg
  OUT_DIR   gets <id>/<view>/{shading.npy,meta.json} ready for merge_view_lighting.py
Loads the model once; skips views that already have meta.json (safe to re-run after a crash).
Same camera and settings as the reviewed Colosseum run (90° x 4:3, 768 px, 4 steps, seed 42),
plus optional ensembling (several predictions averaged, less noise; ~N x the time).
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

import cv2
import numpy as np
from PIL import Image
import torch
from diffusers import MarigoldIntrinsicsPipeline

# (name, u, v): horizon ring 60° apart, ground ring pitched 50° down, two up toward tall facades.
# The first is the reviewed Colosseum anchor view (u=0.8); merge_view_lighting.py anchors on it.
VIEWS = (
    [('mid0', 0.8, 0.5)]
    + [(f'mid{k}', (0.8 + k / 6) % 1, 0.5) for k in range(1, 6)]
    + [(f'down{k}', (0.8 + 1 / 12 + k / 6) % 1, 0.5 + 50 / 180) for k in range(6)]
    + [('up0', 0.8, 0.25), ('up1', 0.05, 0.25)]
)


def basis(u, v):
    lon, lat = (u - 0.5) * 2 * np.pi, (0.5 - v) * np.pi
    forward = np.array([np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)])
    right = np.array([np.cos(lon), 0, -np.sin(lon)])
    return forward, right, np.cross(forward, right)


def camera_view(photo, u, v, hfov=90, width=1024, height=768):
    f, r, up = basis(u, v)
    scale = np.tan(np.deg2rad(hfov) / 2)
    xx, yy = np.meshgrid(np.arange(width), np.arange(height))
    rx = ((xx + 0.5) / width * 2 - 1) * scale
    uy = (1 - (yy + 0.5) / height * 2) * scale * height / width
    rays = f + rx[..., None] * r + uy[..., None] * up
    rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
    sx = ((np.arctan2(rays[..., 0], rays[..., 2]) / (2 * np.pi) + 0.5) * photo.shape[1] - 0.5) % photo.shape[1]
    sy = np.clip((0.5 - np.arcsin(np.clip(rays[..., 1], -1, 1)) / np.pi) * photo.shape[0] - 0.5, 0, photo.shape[0] - 1)
    img = cv2.remap(photo, sx.astype('f4'), sy.astype('f4'), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
    return Image.fromarray(img), dict(u=u, v=v, horizontal_fov=hfov, width=width, height=height)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pano_dir', type=Path)
    ap.add_argument('out_dir', type=Path)
    ap.add_argument('--ensemble', type=int, default=1)
    ap.add_argument('--ids', default='')
    args = ap.parse_args()
    ids = [i for i in args.ids.split(',') if i] or sorted(p.stem for p in args.pano_dir.glob('*.jpg'))
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    dtype = torch.float16 if device == 'cuda' else torch.float32
    t0 = time.perf_counter()
    pipe = MarigoldIntrinsicsPipeline.from_pretrained(
        'prs-eth/marigold-iid-lighting-v1-1', variant='fp16', torch_dtype=dtype).to(device)
    pipe.set_progress_bar_config(disable=True)
    print(f'model loaded on {device} in {time.perf_counter() - t0:.1f}s', flush=True)
    for n, pid in enumerate(ids, 1):
        source = args.pano_dir / f'{pid}.jpg'
        sha = hashlib.sha256(source.read_bytes()).hexdigest()
        photo = np.asarray(Image.open(source).convert('RGB'))
        for name, u, v in VIEWS:
            out = args.out_dir / pid / name
            if (out / 'meta.json').exists():
                continue
            out.mkdir(parents=True, exist_ok=True)
            camera, view = camera_view(photo, u, v)
            started = time.perf_counter()
            with torch.inference_mode():
                result = pipe(camera, num_inference_steps=4, ensemble_size=args.ensemble,
                              processing_resolution=768, match_input_resolution=True,
                              batch_size=args.ensemble, generator=torch.Generator(device).manual_seed(42))
            for tname, layer in zip(pipe.target_properties['target_names'], result.prediction):
                if tname == 'shading':  # albedo/residual unused so far; skip to save disk
                    np.save(out / 'shading.npy', layer.astype('f4'))
            meta = dict(source_sha256=sha, view=view, model='prs-eth/marigold-iid-lighting-v1-1',
                        resolution=768, steps=4, ensemble_size=args.ensemble, device=device,
                        inference_seconds=round(time.perf_counter() - started, 2))
            (out / 'meta.json').write_text(json.dumps(meta, indent=2) + '\n')
        print(f'[{n}/{len(ids)}] {pid} done ({time.perf_counter() - t0:.0f}s total)', flush=True)


if __name__ == '__main__':
    main()
