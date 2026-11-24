"""Sky mask for an equirect street panorama.

Uses UperNet-ConvNeXt (openmmlab/upernet-convnext-small, ADE20K, class 2 = "sky") on the
panorama, then keeps only sky connected to the upper half so stray "sky" (reflections in car
windows etc.) isn't blocked.

Usage (library): sky_mask(pil_image) -> bool HxW at the image's resolution
"""
import cv2
import numpy as np
import torch
from PIL import Image

_model = None
_proc = None


def _load():
    global _model, _proc
    if _model is None:
        from transformers import AutoImageProcessor, UperNetForSemanticSegmentation
        _proc = AutoImageProcessor.from_pretrained('openmmlab/upernet-convnext-small')
        _model = UperNetForSemanticSegmentation.from_pretrained('openmmlab/upernet-convnext-small').eval()
    return _model, _proc


def sky_mask(img: Image.Image) -> np.ndarray:
    model, proc = _load()
    W, H = img.size
    # run on a 1024x512 version; wrap 128px on each side so the seam is handled
    small = np.asarray(img.convert('RGB').resize((1024, 512)))
    wrapped = np.concatenate([small[:, -128:], small, small[:, :128]], 1)
    with torch.no_grad():
        inp = proc(images=Image.fromarray(wrapped), return_tensors='pt')
        logits = model(**inp).logits
        logits = torch.nn.functional.interpolate(logits, size=wrapped.shape[:2], mode='bilinear', align_corners=False)
    lab = logits.argmax(1)[0].numpy()[:, 128:-128]
    sky = (lab == 2).astype(np.uint8)
    # keep sky connected to the upper half (drop reflections / misc blobs lower down)
    n, comp = cv2.connectedComponents(sky, connectivity=8)
    keep = set(np.unique(comp[: 512 // 2][sky[: 512 // 2] > 0])) - {0}
    sky = np.isin(comp, list(keep)).astype(np.uint8)
    sky = cv2.resize(sky, (W, H), interpolation=cv2.INTER_NEAREST)
    return sky.astype(bool)
