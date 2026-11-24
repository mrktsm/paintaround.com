#!/usr/bin/env bash
# One-time setup on a rented GPU machine with PyTorch. Run from /workspace.
# Usage: bash pod_setup.sh
# Lighting: Marigold IID Lighting v1.1 (diffusers). Depth: DA360.
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

# Depth: code and weights
cd repos
[ -d DA360 ] || git clone -q https://github.com/Insta360-Research-Team/DA360
python -c "from huggingface_hub import hf_hub_download; hf_hub_download('hljiang/DA360', 'DA360_large.pth', local_dir='DA360/checkpoints')"
nvidia-smi --query-gpu=name,memory.total --format=csv
echo "setup done"
