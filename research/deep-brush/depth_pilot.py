"""Depth pilot: compare panoramic depth models on a few panoramas (GPU).

Usage: python depth_pilot.py PANO_DIR OUT_DIR REPOS_DIR id1,id2,...
Variants (each writes OUT_DIR/<variant>/<id>_distance.f32 at 2048x1024, plus PNG previews):
  da2        DA² as shipped (~620k px inference, sphere 1092x546) — what the app uses today
  da2_full   DA² with its sphere/inference size raised to 2048x1024
  da360_l    DA360 large (Insta360, MIT code; weights hljiang/DA360)
Previews: <id>_depth.png (log distance) and <id>_normals.png (surface directions from the
distance map, the same way the app derives them), so edges and noise compare side by side.
"""
import json
import os
from pathlib import Path
import sys
import time
import types

import cv2
import numpy as np
from PIL import Image
import torch

W, H = 2048, 1024


def save(out: Path, pid: str, dist: np.ndarray, seconds: float, extra: dict):
    out.mkdir(parents=True, exist_ok=True)
    if dist.shape != (H, W):
        dist = cv2.resize(dist.astype('f4'), (W, H), interpolation=cv2.INTER_LINEAR)
    dist = np.maximum(dist.astype('f4'), 1e-6)
    dist.astype('<f4').tofile(out / f'{pid}_distance.f32')
    ld = np.log(dist)
    lo, hi = np.percentile(ld, [2, 98])
    Image.fromarray((np.clip((ld - lo) / max(hi - lo, 1e-6), 0, 1) * 255).astype('u1')).save(out / f'{pid}_depth.png')
    # normals from the distance map (sphere -> 3D points -> cross product of neighbours)
    lon, lat = np.meshgrid((np.arange(W) + 0.5) / W * 2 * np.pi - np.pi, np.pi / 2 - (np.arange(H) + 0.5) / H * np.pi)
    P = np.stack([np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)], -1) * dist[..., None]
    dx = np.roll(P, -1, 1) - np.roll(P, 1, 1)
    dy = np.roll(P, -1, 0) - np.roll(P, 1, 0)
    n = np.cross(dx, dy)
    n /= np.linalg.norm(n, axis=-1, keepdims=True) + 1e-9
    Image.fromarray(((n * 0.5 + 0.5) * 255).astype('u1')).save(out / f'{pid}_normals.png')
    (out / f'{pid}.json').write_text(json.dumps(dict(id=pid, seconds=round(seconds, 2), **extra)) + '\n')
    print(f'  {out.name}/{pid}: {seconds:.2f}s', flush=True)


def load_rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert('RGB').resize((W, H), Image.Resampling.LANCZOS))


def run_da2(repo: Path, panos, ids, out: Path, full: bool):
    package = types.ModuleType('da2')
    package.__path__ = [str(repo / 'src' / 'da2')]
    sys.modules['da2'] = package
    from da2.model.spherevit import SphereViT
    config = json.loads((repo / 'configs' / 'infer.json').read_text())
    if full:
        config['spherevit']['sphere']['width'], config['spherevit']['sphere']['height'] = W, H
        config['inference']['min_pixels'] = config['inference']['max_pixels'] = W * H
    model = SphereViT.from_pretrained('haodongli/DA-2', config=config).to('cuda').eval()
    config['spherevit']['dtype'] = next(model.parameters()).dtype
    for pid in ids:
        rgb = load_rgb(panos / f'{pid}.jpg').astype('f4') / 255
        x = torch.from_numpy(rgb.transpose(2, 0, 1)).unsqueeze(0).cuda()
        torch.cuda.synchronize(); t = time.perf_counter()
        with torch.inference_mode():
            d = model(x).squeeze().float().cpu().numpy()
        torch.cuda.synchronize()
        save(out, pid, d, time.perf_counter() - t, dict(model='DA2', sphere=config['spherevit']['sphere']))
    del model; torch.cuda.empty_cache()


def run_da360(repo: Path, panos, ids, out: Path, size='large'):
    repo = repo.resolve()
    sys.path.insert(0, str(repo))
    cwd = os.getcwd(); os.chdir(repo)
    import networks
    from checkpoint import checkpoint_meta, load_checkpoint, state_dict_from_checkpoint
    from torchvision import transforms
    path = f'./checkpoints/DA360_{size}.pth'
    if not os.path.exists(path):
        from huggingface_hub import hf_hub_download
        hf_hub_download('hljiang/DA360', f'DA360_{size}.pth', local_dir='checkpoints')
    md = load_checkpoint(path, map_location='cpu')
    meta = checkpoint_meta(md)
    model = getattr(networks, meta['net'])(meta['height'], meta['width'], dinov2_encoder=meta['dinov2_encoder']).cuda()
    model.load_state_dict(state_dict_from_checkpoint(md, model.state_dict()), strict=False)
    model.eval()
    os.chdir(cwd)
    norm = transforms.Compose([transforms.ToTensor(), transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
    for pid in ids:
        rgb = load_rgb(panos / f'{pid}.jpg')
        x = norm(cv2.resize(rgb, (meta['width'], meta['height']), interpolation=cv2.INTER_CUBIC)).unsqueeze(0).cuda()
        torch.cuda.synchronize(); t = time.perf_counter()
        with torch.no_grad():
            disp = model(x)['pred_disp'].float().cpu().numpy()[0, 0]
        torch.cuda.synchronize()
        d = 1 / np.maximum(disp, 1e-6)
        save(out, pid, d, time.perf_counter() - t, dict(model=f'DA360_{size}', input=[meta['width'], meta['height']]))


def main():
    panos, out, repos = map(Path, sys.argv[1:4])
    ids = sys.argv[4].split(',')
    variants = (os.environ.get('VARIANTS') or 'da2,da2_full,da360_l').split(',')
    for v in variants:
        print(f'== {v}', flush=True)
        try:
            if v == 'da2': run_da2(repos / 'DA-2', panos, ids, out / v, full=False)
            elif v == 'da2_full': run_da2(repos / 'DA-2', panos, ids, out / v, full=True)
            elif v == 'da360_l': run_da360(repos / 'DA360', panos, ids, out / v)
        except Exception as e:  # keep going: one variant failing shouldn't sink the pilot
            import traceback; traceback.print_exc()
            print(f'!! {v} failed: {e}', flush=True)
    print('DEPTH_PILOT_DONE', flush=True)


if __name__ == '__main__':
    main()
