"""Build the app's deep layers for many panoramas (GPU pod): DA360 depth + 360° colour lighting.

Usage: python build_layers.py PANO_DIR LIGHT_DIR OUT_DIR REPOS_DIR [--ids a,b] [--wait]
  LIGHT_DIR  batch_view_lighting.py output (<id>/<view>/shading.npy)
  OUT_DIR    gets <id>/{distance.f32, surface-<hash>.f16, meta.json}
             distance.f32  2048x1024 float32, sky = 0 (what loadDeepData reads)
             surface-*.f16 2048x1024x3 float16, interleaved linear RGB paint multiplier
                           (= 360° colour lighting x photo detail^0.25)
--wait: process panoramas as their 14 lighting views appear (run beside the lighting batch).
Skips panoramas whose meta.json exists, so it is safe to re-run.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import cv2
import numpy as np
from PIL import Image
import torch

W, H = 2048, 1024
HERE = Path(__file__).resolve().parent
VIEW_ORDER = ['mid0', 'mid1', 'mid2', 'mid3', 'mid4', 'mid5',
              'down0', 'down1', 'down2', 'down3', 'down4', 'down5', 'up0', 'up1']


def load_da360(repo: Path):
    repo = repo.resolve()
    sys.path.insert(0, str(repo))
    cwd = os.getcwd(); os.chdir(repo)
    import networks
    from checkpoint import checkpoint_meta, load_checkpoint, state_dict_from_checkpoint
    md = load_checkpoint('./checkpoints/DA360_large.pth', map_location='cpu')
    meta = checkpoint_meta(md)
    model = getattr(networks, meta['net'])(meta['height'], meta['width'], dinov2_encoder=meta['dinov2_encoder']).cuda()
    missing = model.load_state_dict(state_dict_from_checkpoint(md, model.state_dict()), strict=False)
    if missing.missing_keys:
        raise RuntimeError(f'DA360 checkpoint is missing {len(missing.missing_keys)} weights')
    os.chdir(cwd)
    return model.eval(), meta


def depth(model, meta, rgb: np.ndarray) -> np.ndarray:
    from torchvision import transforms
    norm = transforms.Compose([transforms.ToTensor(), transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
    x = norm(cv2.resize(rgb, (meta['width'], meta['height']), interpolation=cv2.INTER_CUBIC)).unsqueeze(0).cuda()
    with torch.no_grad():
        disp = model(x)['pred_disp'].float().cpu().numpy()[0, 0]
    d = cv2.resize(1 / np.maximum(disp, 1e-6), (W, H), interpolation=cv2.INTER_LINEAR)
    return (d / np.median(d)).astype('f4')  # scale-free; median 1 keeps values well inside float range


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pano_dir', type=Path); ap.add_argument('light_dir', type=Path)
    ap.add_argument('out_dir', type=Path); ap.add_argument('repos', type=Path)
    ap.add_argument('--ids', default=''); ap.add_argument('--wait', action='store_true')
    args = ap.parse_args()
    ids = [i for i in args.ids.split(',') if i] or sorted(p.stem for p in args.pano_dir.glob('*.jpg'))
    sys.path.insert(0, str(HERE))
    from sky_mask import sky_mask
    model, meta = load_da360(args.repos / 'DA360')
    pending = [i for i in ids if not (args.out_dir / i / 'meta.json').exists()]
    print(f'{len(pending)} to build', flush=True)
    while pending:
        progressed = False
        for pid in list(pending):
            views = [args.light_dir / pid / v for v in VIEW_ORDER]
            if not all((v / 'meta.json').exists() for v in views):
                continue
            t0 = time.perf_counter()
            source = args.pano_dir / f'{pid}.jpg'
            sha = hashlib.sha256(source.read_bytes()).hexdigest()
            image = Image.open(source).convert('RGB').resize((W, H), Image.Resampling.LANCZOS)
            rgb = np.asarray(image)
            dist = depth(model, meta, rgb)
            sky = sky_mask(image)
            dist[sky] = 0
            with tempfile.TemporaryDirectory() as tmp:
                tmp = Path(tmp)
                np.ones((H, W), '<f4').tofile(tmp / 'base.f32')  # neutral where no view reaches (nadir)
                dist.astype('<f4').tofile(tmp / 'distance.f32')
                r = subprocess.run([sys.executable, str(HERE / 'merge_view_lighting.py'), str(source),
                                    str(tmp / 'distance.f32'), str(tmp / 'base.f32'), str(tmp / 'light'), *map(str, views)],
                                   capture_output=True, text=True)
                if r.returncode:
                    print(f'!! {pid}: merge failed\n{r.stderr[-2000:]}', flush=True)
                    pending.remove(pid); continue
                light = np.fromfile(tmp / 'light-rgb.f32', '<f4').reshape(H, W, 3)
                merge_stats = json.loads((tmp / 'light.json').read_text())
            lin = np.where(rgb / 255 <= 0.04045, rgb / 255 / 12.92, ((rgb / 255 + 0.055) / 1.055) ** 2.4).astype('f4')
            lum = lin @ np.array([0.2126, 0.7152, 0.0722], 'f4')
            detail = np.clip(lum / (cv2.GaussianBlur(lum, (0, 0), 3) + 1e-4), 0.3, 2)
            material = np.clip(light * (detail ** 0.25)[..., None], 0, 60000).astype('<f2')
            if not np.isfinite(material).all():
                print(f'!! {pid}: non-finite material', flush=True); pending.remove(pid); continue
            out = args.out_dir / pid
            out.mkdir(parents=True, exist_ok=True)
            dist.astype('<f4').tofile(out / 'distance.f32')
            mbytes = material.tobytes()
            surface = f'surface-{hashlib.sha256(mbytes).hexdigest()[:12]}.f16'
            (out / surface).write_bytes(mbytes)
            (out / 'meta.json').write_text(json.dumps(dict(
                id=pid, width=W, height=H, source_sha256=sha, depth='DA360_large', sky_masked=True,
                sky_fraction=round(float(sky.mean()), 4), lighting='marigold-iid-lighting-v1-1 x14 views, merged',
                surface=surface, surface_format='float16 interleaved linear RGB',
                coverage_fraction=merge_stats['solid_covered_fraction'],
                view_gains=[v['gain'] for v in merge_stats['views']],
                seconds=round(time.perf_counter() - t0, 1)), indent=2) + '\n')
            pending.remove(pid)
            progressed = True
            print(f'built {pid} ({time.perf_counter() - t0:.1f}s), {len(pending)} left', flush=True)
        if pending and not progressed:
            if not args.wait:
                print(f'missing lighting views for: {pending}', flush=True); break
            time.sleep(10)
    print('BUILD_DONE', flush=True)


if __name__ == '__main__':
    main()
