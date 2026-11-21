"""Panoramic depth (DA², ICLR 2026, Apache-2.0) + surface normals for equirect panoramas.

Usage: python run_depth.py DA2_REPO_DIR PANO_DIR OUT_DIR
Writes per pano:
  <id>_distance.npy   float16 HxW, scale-invariant distance from camera
  <id>_normals.npy    float16 HxWx3, unit world-space normals (x right, y up, z forward)
  <id>_depthviz.png   colourised distance
  <id>_normalviz.png  normals as RGB
"""
import glob, json, os, sys, time

import numpy as np
import torch
from PIL import Image

repo, pano_dir, out = sys.argv[1:4]
sys.path.insert(0, os.path.join(repo, 'src'))
from da2.model.spherevit import SphereViT  # noqa: E402

os.makedirs(out, exist_ok=True)
config = json.load(open(os.path.join(repo, 'configs/infer.json')))
device = 'mps' if torch.backends.mps.is_available() else 'cpu'

t = time.time()
model = SphereViT.from_pretrained('haodongli/DA-2', config=config).to(device).eval()
config['spherevit']['dtype'] = next(model.parameters()).dtype
print(f'model loaded on {device} in {time.time() - t:.1f}s')


def equirect_dirs(h, w):
    """Unit view directions per pixel. lon 0 = image centre = forward (+z), y up."""
    lon = (np.arange(w) + 0.5) / w * 2 * np.pi - np.pi
    lat = np.pi / 2 - (np.arange(h) + 0.5) / h * np.pi
    lon, lat = np.meshgrid(lon, lat)
    return np.stack([np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)], -1)


def normals_from_distance(dist):
    """Normals from the 3D point map via central differences (wrapping horizontally)."""
    h, w = dist.shape
    p = equirect_dirs(h, w) * dist[..., None]
    du = np.roll(p, -1, 1) - np.roll(p, 1, 1)
    dv = np.zeros_like(p)
    dv[1:-1] = p[2:] - p[:-2]
    n = np.cross(dv, du)
    n /= np.linalg.norm(n, axis=-1, keepdims=True) + 1e-8
    # orient towards the camera
    flip = (n * p).sum(-1) > 0
    n[flip] *= -1
    return n


def colorize(d):
    import matplotlib
    ld = np.log(d)
    lo, hi = np.percentile(ld, 2), np.percentile(ld, 98)
    x = np.clip((ld - lo) / (hi - lo + 1e-8), 0, 1)
    return (matplotlib.colormaps['Spectral'](x)[..., :3] * 255).astype(np.uint8)


for path in sorted(glob.glob(os.path.join(pano_dir, '*.jpg'))):
    pid = os.path.basename(path)[:-4]
    img = np.asarray(Image.open(path).convert('RGB')).astype(np.float32) / 255.0
    x = torch.from_numpy(img.transpose(2, 0, 1)).unsqueeze(0).to(device)
    t = time.time()
    with torch.no_grad():
        dist = model(x)
    dist = dist.squeeze().float().cpu().numpy()
    dt = time.time() - t
    n = normals_from_distance(dist.astype(np.float64))
    np.save(os.path.join(out, f'{pid}_distance.npy'), dist.astype(np.float16))
    np.save(os.path.join(out, f'{pid}_normals.npy'), n.astype(np.float16))
    Image.fromarray(colorize(dist)).save(os.path.join(out, f'{pid}_depthviz.png'))
    Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8)).save(os.path.join(out, f'{pid}_normalviz.png'))
    print(f'{pid}: {dist.shape[1]}x{dist.shape[0]} in {dt:.1f}s  (dist range {dist.min():.2f}..{dist.max():.2f})')
