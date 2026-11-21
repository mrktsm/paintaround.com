"""Measure Marigold IID lighting on one panorama; save research layers.

Usage: python benchmark_lighting.py INPUT_JPG OUTPUT_DIR [RESOLUTION=512]
CPU requirements: diffusers==0.35.2 transformers==4.46.3 accelerate==1.1.1
plus the benchmark_depth.py requirements. Uses the official fp16 checkpoint
converted to float32 for CPU inference, four steps, one ensemble member.
"""
import json
import os
from pathlib import Path
import resource
import sys
import time

import numpy as np
from PIL import Image
import torch
from diffusers import MarigoldIntrinsicsPipeline


source, output = map(Path, sys.argv[1:3])
resolution = int(sys.argv[3]) if len(sys.argv) > 3 else 512
torch.set_num_threads(int(os.environ.get("DEPTH_THREADS", "2")))
torch.set_num_interop_threads(1)
output.mkdir(parents=True, exist_ok=True)
started = time.perf_counter()
print("Loading Marigold IID lighting on CPU", flush=True)
pipe = MarigoldIntrinsicsPipeline.from_pretrained(
    "prs-eth/marigold-iid-lighting-v1-1",
    variant="fp16", torch_dtype=torch.float32,
).to("cpu")
load_seconds = time.perf_counter() - started
print(f"Lighting model loaded in {load_seconds:.1f}s", flush=True)
image = Image.open(source).convert("RGB").resize((2048, 1024), Image.Resampling.LANCZOS)
# Supply wraparound context at the longitude seam, crop it off the predictions.
rgb = np.asarray(image)
pad = 128
wrapped = Image.fromarray(np.concatenate([rgb[:, -pad:], rgb, rgb[:, :pad]], axis=1))
inference_started = time.perf_counter()
with torch.inference_mode():
    result = pipe(
        wrapped, num_inference_steps=4, ensemble_size=1,
        processing_resolution=resolution, match_input_resolution=True,
        batch_size=1, generator=torch.Generator().manual_seed(42),
    )
inference_seconds = time.perf_counter() - inference_started
layers = result.prediction[:, :, pad:-pad, :]
if not np.isfinite(layers).all():
    raise ValueError("Non-finite lighting predictions")
names = pipe.target_properties["target_names"]
for name, layer in zip(names, layers):
    np.save(output / f"{source.stem}_marigold_{name}.npy", layer.astype(np.float16))
    visual = np.clip(layer, 0, 1)
    visual = np.where(visual <= 0.0031308, visual * 12.92, 1.055 * visual ** (1 / 2.4) - 0.055)
    Image.fromarray((visual * 255).round().astype(np.uint8)).save(output / f"{source.stem}_marigold_{name}.png")
shading = layers[names.index("shading")].mean(axis=-1)
# Same single-channel convention as the existing export_layers.py pipeline.
np.save(output / f"{source.stem}_marigold_shading.npy", shading.astype(np.float16))
peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
metrics = {
    "id": source.stem, "model": "prs-eth/marigold-iid-lighting-v1-1",
    "device": "cpu", "steps": 4, "ensemble_size": 1,
    "processing_resolution": resolution, "seam_context_pixels": pad,
    "model_load_seconds": round(load_seconds, 2),
    "inference_seconds": round(inference_seconds, 2),
    "total_seconds": round(time.perf_counter() - started, 2),
    "peak_process_rss_mb": round(peak_mb, 1),
    "research_trial": True,
}
(output / f"{source.stem}_lighting_benchmark.json").write_text(json.dumps(metrics, indent=2) + "\n")
print(json.dumps(metrics), flush=True)
