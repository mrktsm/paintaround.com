"""Trial lighting extraction on a rectilinear view, reprojected to panorama space.

Usage: python refine_view_lighting.py PANORAMA BASE_SHADING_F32 OUTPUT_DIR
Keeps existing layers intact. OUTPUT_DIR contains a separate shading-view.f32.
The original 512px whole-panorama prediction missed the Colosseum cast shadow.
This gives the model a conventional camera image at its recommended 768px size.
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
    up = np.cross(forward, right)
    return forward, right, up


def main():
    source, base_path, output = map(Path, sys.argv[1:4])
    output.mkdir(parents=True, exist_ok=False)
    started = time.perf_counter()
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    width, height = 2048, 1024
    view = dict(u=0.8, v=0.50, horizontal_fov=90, width=1024, height=768)
    f, r, up = basis(view['u'], view['v'])
    scale = np.tan(np.deg2rad(view['horizontal_fov']) / 2)
    xx, yy = np.meshgrid(np.arange(view['width']), np.arange(view['height']))
    rx = ((xx + 0.5) / view['width'] * 2 - 1) * scale
    uy = (1 - (yy + 0.5) / view['height'] * 2) * scale * view['height'] / view['width']
    rays = f + rx[..., None] * r + uy[..., None] * up
    rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
    photo = np.asarray(Image.open(source).convert('RGB'))
    sx = ((np.arctan2(rays[..., 0], rays[..., 2]) / (2 * np.pi) + 0.5) * photo.shape[1] - 0.5) % photo.shape[1]
    sy = (0.5 - np.arcsin(rays[..., 1]) / np.pi) * photo.shape[0] - 0.5
    camera = Image.fromarray(cv2.remap(photo, sx.astype('f4'), sy.astype('f4'), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP))
    camera.save(output / 'input.png')
    print('Loading cached Marigold; view input saved.', flush=True)
    pipe = MarigoldIntrinsicsPipeline.from_pretrained(
        'prs-eth/marigold-iid-lighting-v1-1', variant='fp16',
        torch_dtype=torch.float32, local_files_only=True,
    ).to('cpu')
    inference_started = time.perf_counter()
    with torch.inference_mode():
        result = pipe(camera, num_inference_steps=4, ensemble_size=1,
                      processing_resolution=768, match_input_resolution=True,
                      batch_size=1, generator=torch.Generator().manual_seed(42))
    names = pipe.target_properties['target_names']
    layers = result.prediction
    for name, layer in zip(names, layers):
        np.save(output / f'{name}.npy', layer.astype('f4'))
        visual = np.clip(layer, 0, 1)
        visual = np.where(visual <= 0.0031308, visual * 12.92, 1.055 * visual ** (1 / 2.4) - 0.055)
        Image.fromarray((visual * 255).round().astype('uint8')).save(output / f'{name}.png')
    shade = layers[names.index('shading')].mean(axis=-1)
    shade /= max(float(np.percentile(shade[int(view['height'] * 0.25):], 92)), 1e-5)
    shade = np.clip(shade, 0, 2.5)
    lon, lat = np.meshgrid((np.arange(width) + 0.5) / width * 2 * np.pi - np.pi,
                          np.pi / 2 - (np.arange(height) + 0.5) / height * np.pi)
    dirs = np.stack([np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)], axis=-1)
    z = dirs @ f
    nx = (dirs @ r) / np.maximum(z, 1e-6) / scale
    ny = (dirs @ up) / np.maximum(z, 1e-6) / (scale * view['height'] / view['width'])
    weight = np.clip((1 - np.maximum(np.abs(nx), np.abs(ny))) / 0.12, 0, 1) * (z > 0)
    px = ((nx + 1) * view['width'] / 2 - 0.5).astype('f4')
    py = ((1 - ny) * view['height'] / 2 - 0.5).astype('f4')
    projected = cv2.remap(shade, px, py, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    base = np.fromfile(base_path, dtype='<f4').reshape(height, width)
    refined = base * (1 - weight) + projected * weight
    if not np.isfinite(refined).all() or (refined < 0).any():
        raise ValueError('Invalid refined lighting')
    refined.astype('<f4').tofile(output / 'shading-view.f32')
    metadata = dict(source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(), view=view,
                    model='prs-eth/marigold-iid-lighting-v1-1', resolution=768, steps=4,
                    inference_seconds=round(time.perf_counter() - inference_started, 2),
                    total_seconds=round(time.perf_counter() - started, 2),
                    trial=True, coverage_fraction=round(float((weight > 0).mean()), 4))
    (output / 'meta.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps(metadata), flush=True)


if __name__ == '__main__':
    main()
