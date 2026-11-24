# 3D data

A place with 3D data has a folder `public/deep-layers/<id>/` with

- `distance.f32`: how far away everything is. 2048 × 1024 32-bit floats; 0 is sky.
- `surface-….f16`: the lighting. 2048 × 1024 × 3 16-bit floats (linear RGB) that paint is multiplied by.
  Its file name is in `src/data/paint-materials.json`.

Without the folder, strokes in that place are flat. Everything else works.

The data was made once for all places on a rented GPU, about 25 seconds per place, by
`research/deep-brush`:

- depth with [DA360](https://github.com/Insta360-Research-Team/DA360),
- lighting with [Marigold IID Lighting](https://huggingface.co/prs-eth/marigold-iid-lighting-v1-1),
  for 14 views around the panorama that are then merged,
- a sky mask.

`pod_setup.sh` prepares the GPU machine, `batch_view_lighting.py` makes the lighting for the views and
`build_layers.py` the files above. The models have their own licenses; look at them before using the data
for anything commercial. The notes in that folder are a research log, including what didn't work.
