#!/usr/bin/env bash
# One-time setup on a RunPod GPU pod (PyTorch template). Run from /workspace.
# Usage: bash pod_setup.sh
# Lighting: Marigold IID Lighting v1.1 (diffusers). Depth pilot: DA² (current), DA360, DAP, MoGe-2.
set -euo pipefail
cd /workspace
mkdir -p panos out repos

# Ubuntu 24.04 images block system-wide pip (PEP 668): use a venv that keeps the image's torch
[ -d /workspace/venv ] || python -m venv --system-site-packages /workspace/venv
source /workspace/venv/bin/activate
pip install -q "diffusers==0.35.2" transformers accelerate safetensors einops \
  "huggingface-hub>=0.36" opencv-python-headless pillow numpy

# Lighting weights (cached for the batch)
python - <<'EOF'
from diffusers import MarigoldIntrinsicsPipeline
MarigoldIntrinsicsPipeline.from_pretrained('prs-eth/marigold-iid-lighting-v1-1', variant='fp16')
print('marigold cached')
EOF

# Depth candidates for the pilot (code only; each pulls its own weights on first run)
cd repos
[ -d DA-2 ] || { git clone -q https://github.com/EnVision-Research/DA-2 && git -C DA-2 checkout -q d659838585f2bc9967c7e9367af573795271dbbb; }
[ -d DA360 ] || git clone -q https://github.com/Insta360-Research-Team/DA360
[ -d DAP ] || git clone -q https://github.com/Insta360-Research-Team/DAP
[ -d MoGe ] || git clone -q https://github.com/microsoft/MoGe
for r in DA360 DAP MoGe; do echo "== $r license:"; head -3 "$r/LICENSE" 2>/dev/null || echo "(no LICENSE file)"; done
nvidia-smi --query-gpu=name,memory.total --format=csv
echo "setup done"
