"""Run one panorama through DA² and record real time and peak memory.

Usage: python benchmark_depth.py DA2_REPO INPUT_JPG OUTPUT_DIR [cpu|mps|cuda]
Only the model dependencies are needed: torch, torchvision, huggingface-hub,
numpy, pillow, einops and safetensors. The model is loaded once per process.
"""
import hashlib
import json
import os
from pathlib import Path
import resource
import sys
import time
import types

import numpy as np
from PIL import Image
import torch


repo, source, output = map(Path, sys.argv[1:4])
device = sys.argv[4] if len(sys.argv) > 4 else "cpu"
threads = int(os.environ.get("DEPTH_THREADS", "2"))
torch.set_num_threads(threads)
torch.set_num_interop_threads(1)

# Avoid DA²'s CLI-only imports (training, point clouds, Gradio, etc.).
# The actual model code and checkpoint are unchanged.
package = types.ModuleType("da2")
package.__path__ = [str(repo / "src" / "da2")]
sys.modules["da2"] = package
from da2.model.spherevit import SphereViT  # noqa: E402

output.mkdir(parents=True, exist_ok=True)
started = time.perf_counter()
config = json.loads((repo / "configs" / "infer.json").read_text())
print(f"Loading DA² on {device}, {threads} CPU threads", flush=True)
model = SphereViT.from_pretrained("haodongli/DA-2", config=config).to(device).eval()
config["spherevit"]["dtype"] = next(model.parameters()).dtype
if device == "mps":
    torch.mps.synchronize()
elif device == "cuda":
    torch.cuda.synchronize()
load_seconds = time.perf_counter() - started
print(f"Model loaded in {load_seconds:.1f}s", flush=True)

image = Image.open(source).convert("RGB")
if image.width != image.height * 2:
    raise ValueError("Expected a full 2:1 equirectangular panorama")
# The app's depth maps are 2048x1024. DA² internally infers at ~620k pixels.
image = image.resize((2048, 1024), Image.Resampling.LANCZOS)
rgb = np.asarray(image).astype(np.float32) / 255
tensor = torch.from_numpy(rgb.transpose(2, 0, 1)).unsqueeze(0).to(device)
inference_started = time.perf_counter()
with torch.inference_mode():
    distance = model(tensor).squeeze().float().cpu().numpy()
inference_seconds = time.perf_counter() - inference_started
if not np.isfinite(distance).all() or np.any(distance <= 0):
    raise ValueError("Invalid predicted distances")
np.save(output / f"{source.stem}_distance.npy", distance.astype(np.float16))
distance.astype("<f4").tofile(output / f"{source.stem}_distance.f32")
# Logarithmic view preserves nearby/faraway detail for a quick quality review.
log_distance = np.log(distance)
lo, hi = np.percentile(log_distance, [2, 98])
visual = np.clip((log_distance - lo) / max(float(hi - lo), 1e-6), 0, 1)
Image.fromarray((visual * 255).astype(np.uint8)).save(output / f"{source.stem}_depth.png")
peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
peak_mb = peak_rss / (1024 * 1024 if sys.platform == "darwin" else 1024)
metrics = {
    "id": source.stem,
    "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "device": device,
    "cpu_threads": threads,
    "torch": torch.__version__,
    "output_width": 2048,
    "output_height": 1024,
    "inference_max_pixels": config["inference"]["max_pixels"],
    "model_load_seconds": round(load_seconds, 2),
    "inference_seconds": round(inference_seconds, 2),
    "total_seconds": round(time.perf_counter() - started, 2),
    "peak_process_rss_mb": round(peak_mb, 1),
    "depth_only": True,
    "sky_masked": False,
}
(output / f"{source.stem}_benchmark.json").write_text(json.dumps(metrics, indent=2) + "\n")
print(json.dumps(metrics), flush=True)
