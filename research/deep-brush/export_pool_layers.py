"""Export reviewed pool trials to the existing 3D brush's binary format.

Usage: python export_pool_layers.py INPUT_DIR DATA_DIR OUTPUT_ROOT ID [ID...]
Uses DA² depth, Marigold lighting, and the existing UperNet sky mask.
Each output directory is assembled off to the side and renamed when complete.
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

from sky_mask import sky_mask


inputs, data, output = map(Path, sys.argv[1:4])
torch.set_num_threads(2)
torch.set_num_interop_threads(1)
width, height = 2048, 1024
for pid in sys.argv[4:]:
    started = time.perf_counter()
    source = inputs / f"{pid}.jpg"
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    depth_metrics = json.loads((data / f"{pid}_benchmark.json").read_text())
    if source_hash != depth_metrics["source_sha256"]:
        raise ValueError(f"{pid}: panorama changed since depth prediction")
    dist = np.load(data / f"{pid}_distance.npy").astype(np.float32)
    shading = np.load(data / f"{pid}_marigold_shading.npy").astype(np.float32)
    if dist.shape != (height, width) or shading.shape != dist.shape:
        raise ValueError(f"{pid}: incompatible layer dimensions")
    if not np.isfinite(dist).all() or not np.isfinite(shading).all():
        raise ValueError(f"{pid}: non-finite layer values")
    image = Image.open(source).convert("RGB").resize((width, height), Image.Resampling.LANCZOS)
    sky = sky_mask(image)
    dist[sky] = 0
    shading = np.clip(shading / max(float(np.percentile(shading[int(height * 0.35):], 92)), 1e-5), 0, 2.5)
    rgb = np.asarray(image).astype(np.float32) / 255
    linear = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    luminance = linear @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    detail = np.clip(luminance / (cv2.GaussianBlur(luminance, (0, 0), 3) + 1e-4), 0.3, 2)
    surface = shading ** 0.3 * detail ** 0.6
    target = output / pid
    if target.exists():
        raise FileExistsError(f"Refusing to overwrite existing layers: {target}")
    temporary = output / f".{pid}.pending"
    temporary.mkdir(parents=True, exist_ok=True)
    for name, layer in [("distance", dist), ("shading", shading), ("surface", surface)]:
        layer.astype("<f4").tofile(temporary / f"{name}.f32")
    metadata = {
        "width": width, "height": height, "depth": "DA2", "lighting": "marigold-iid-lighting-v1-1",
        "source_sha256": source_hash, "sky_masked": True,
        "sky_fraction": round(float(sky.mean()), 4),
        "depth_benchmark": depth_metrics,
        "lighting_benchmark": json.loads((data / f"{pid}_lighting_benchmark.json").read_text()),
        "sky_and_export_seconds": round(time.perf_counter() - started, 2),
    }
    (temporary / "meta.json").write_text(json.dumps(metadata, indent=2) + "\n")
    temporary.rename(target)
    print(json.dumps({"id": pid, "sky_and_export_seconds": metadata["sky_and_export_seconds"], "sky_fraction": metadata["sky_fraction"]}), flush=True)
