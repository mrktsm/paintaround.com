# 3D data

A place with 3D data has a folder `client/public/deep-layers/<id>/` with

- `distance.f32`: how far away everything is. 2048 × 1024 32-bit floats; 0 is sky.
- `surface-….f16`: the lighting. 2048 × 1024 × 3 16-bit floats (linear RGB) that paint is multiplied by.
  Its file name is in `client/src/data/paint-materials.json`.

Without the folder, strokes in that place are flat. Everything else works.

## Making it

On a machine with an NVIDIA GPU, about 25 seconds per place plus the lighting. The photos are the 4096 px
ones from `client/public/panorama-pool`.

```sh
bash pod_setup.sh                                        # once: libraries and models
python batch_view_lighting.py PHOTOS LIGHT               # the lighting of 14 views per place
python build_layers.py PHOTOS LIGHT OUT REPOS            # depth, sky, and everything put together
```

Then copy `OUT` to `client/public/deep-layers` and run `node pipeline/3d/add-to-catalog.mjs OUT`.

- Depth comes from [DA360](https://github.com/Insta360-Research-Team/DA360).
- Lighting comes from [Marigold IID Lighting](https://huggingface.co/prs-eth/marigold-iid-lighting-v1-1).
  It works on normal camera views, so `merge_view_lighting.py` evens out their brightness and blends them.
- `sky_mask.py` finds the sky.

The models have their own licenses; look at them before using the data for anything commercial.
