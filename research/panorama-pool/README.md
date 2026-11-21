# Free panorama pool

A growing collection of downloadable **360×180° photographs**, starting from ten samples
and expanded through official Poly Haven and Wikimedia Commons catalogs. The current count
and provider breakdown are in `review/verification.json`. No paid or Google imagery is used.

The first expansion contains **200 local panoramas**. Originals are retained at source quality;
the viewer uses separate 4K copies. The local source cache is several GB, so larger subsequent
expansions may require more disk space even though browsing derivatives are much smaller.

## Browse locally

```sh
npm install
npm run pool:sample
npm run dev
```

Open **http://localhost:5173/pool** (use the port printed by Vite). Each card opens a local
360° preview. Drag or use arrow keys to look around; scroll or use +/- to zoom. Keep/Skip
selections are saved in this browser. The shortlist filter and export button produce a
JSON shortlist; exporting from other filters includes the complete pool with review selections.
Scene-type filters and search narrow the collection. The gallery loads 36 cards at a time;
use **Show more places** at the bottom to reveal the next batch. Individual panorama views
reset to the top so their viewer and credits remain reachable.

## App integration

The home map, `/explore`, and `/classic` now use this collection rather than the old Mapillary
location set. The 159 panoramas with source coordinates are mapped; all 200 are searchable in
the main app. Locations with missing coordinates are never pinned to invented positions.
`/view?imageId=<catalog-id>` loads the local full panorama through `PanoramaDataProvider`, retaining
the app's existing painting tools, undo/redo and projection code. The `/deep` research prototype
and its four original examples remain separate. The sampler itself does not run inference.

Three Italian locations now have separately precomputed depth, lighting, and sky masks:
Colosseum, Palermo Square, and Piazza San Marco. Their local `public/deep-layers/<id>/`
exports activate the existing 3D brush automatically; other locations retain flat painting.
See [VPS processing notes](../deep-brush/VPS-processing.md) for measured timings, regeneration,
and the remaining Venice long-stroke limitation. These large generated layers are gitignored.

The existing `LOCAL_MODE` database switch is unchanged: drawings are not persisted while that
mode is enabled. This change does not migrate or delete existing database drawings.
CC0 panoramas have no attribution overlay in the painting view. The six Commons panoramas retain
their required credits and license links. All provenance remains in the catalog.

App cards and map pins use **800×600 rectilinear camera views**, not flattened 360° images:

```sh
npm run pool:thumbnails
```

`scripts/lib/panorama-thumbnail.mjs` projects the source sphere into a normal perspective camera
with bilinear sampling, horizontal seam wrapping, and configurable view centers/FOV.
The sampler creates these automatically for future additions. `thumbnailUrl` and `thumbnailView`
describe the separate card asset; `imageUrl` remains the untouched 360° viewer asset.
The old 800×400 equirectangular previews remain available for contact-sheet review.

## Expand and verify

```sh
npm run pool:discover  # cache official catalog metadata and write the explicit candidate queue
npm run pool:expand    # resume downloading toward 200 total local panoramas
npm run pool:verify    # verify bytes/provenance/dimensions and make visual contact sheets
```

`expanded-candidates.json` retains the bounded discovery queue with original provider metadata.
It ranks architectural squares, city streets, landmarks, transit and cultural interiors first,
excludes skies/studios and ordinary rural roads, and limits closely related variants.
The queue intentionally exceeds the target so inaccessible or unsuitable files can be skipped.
No uncached network requests are made when discovery snapshots already exist.

`curation.json` records visual exclusions and preferred replacements. The first expanded pass
excluded 13 empty lots, airfields and distant scenery after contact-sheet review; those are not
reintroduced on repeat imports. Their generated image files were removed, while metadata snapshots
remain cached. All 200 accepted previews were reviewed in contact sheets; this is an initial visual
screen, not a certification of every full-resolution stitching seam.

Downloads use at most two concurrent candidates and save an atomic catalog checkpoint after
each batch. Existing local images are skipped on expansion. HTTP 429 pauses that host for the
rest of the run instead of hammering it. Deferred candidates remain in the queue for a later run;
`cache/ingestion-report.json` records the run's deferred/rejected candidates. Sources over 64 MB
are skipped, and downloads preserve at least 1.2 GB of free disk space. No images are automatically
deleted to make room. Override the target with:

```sh
node scripts/sample-panorama-pool.mjs --expanded --limit=250
```

## Files

- `src/data/panorama-pool.json`: checked-in catalog with sources, authors, licenses, original
  download URLs, source dimensions, coordinates, HDR download links where available, and SHA-256
  checksums. Catalog `processing` fields remain pending; the three trial layer exports above
  are generated separately from ingestion.
- `public/panorama-pool/`: generated 4096×2048 viewer images and 800×400 previews.
- `research/panorama-pool/cache/`: downloaded originals and provider metadata snapshots.
- `research/panorama-pool/cache/inputs/`: 2048×1024 JPEGs available for future processing.

The generated images/cache are gitignored, so run the sampler on a new checkout before
building or deploying `/pool` (use `pool:expand` to restore the expanded collection).
Originals are retained locally at their actual download resolution. The first ten include:
8192×4096 for Poly Haven, 7500×3750 for the Paris shopfront, and 13704×6852 for Brompton.
Poly Haven's available **16K HDR** resolution is recorded separately; the downloaded JPGs are 8K.

The sampler uses an explicit shortlist/queue, the public Poly Haven API with an identifying User-Agent,
and the Commons API. It caches metadata and originals, checks source MD5 values when provided,
rejects non-2:1 images, and derives all versions from the same original without cropping or
rotating them. Repeat runs use the cache. Sample one item with:

```sh
npm run pool:sample -- --id=ph-colosseum
```

## First visual review

All ten decoded successfully and their previews were inspected in a contact sheet.
They have full-sphere source descriptions and a 2:1 pixel ratio. That ratio alone is not
proof of perfect stitching: zenith/nadir, ghosts and seams still merit individual inspection.
The Colosseum was also checked in the browser's spherical viewer, including keyboard rotation.

- Colosseum: strong landmark and nearby cobblestones; a useful lead sample.
- Teufelsberg: close graffiti-covered walls and columns; visually rich without crowds.
- Paris shopfront: nearby storefronts and a compact street scene.
- Brompton: particularly detailed architectural interior.
- Potsdamer Platz, Dresden and Palermo: clear geometry, but noticeably quiet and open.
- Hansaplatz and Dresden Station: useful contrasting night lighting.
- Schadowplatz: modern geometry; less immediately recognizable than the landmark samples.

The expansion remains weighted toward Europe and South Africa, reflecting the available
free collections. China and other locations are included where available. A location beginning
with "Near" is an offline nearest-city estimate from the source coordinates; it is not a
reverse-geocoded address. Missing locations remain labeled as unknown. The scene categories
are discovery aids derived from provider categories and descriptions.

`review/sheet-*.jpg` contains a numbered contact sheet for each batch of 30 panoramas. Automated
checks establish file integrity, minimum 6K source resolution, exactly 2:1 dimensions, consistent
derivatives, deduplication by original hash, and recorded licenses. These checks do not certify
every stitching seam, original capture authenticity, nadir or zenith; those need visual review.

Additional Commons candidates, including the Eiffel Tower scene, remain queued while its image
host rate-limits downloads. A catalog entry in the candidate queue does not imply a downloaded
image: only `src/data/panorama-pool.json` lists the actual local pool.

## Attribution and reuse

Poly Haven assets use [CC0](https://polyhaven.com/license). The Commons file pages are the
license evidence for [Au Marché de la Butte](https://commons.wikimedia.org/wiki/File:Au_March%C3%A9_de_la_Butte,_Paris_April_2007.jpg)
(Alexandre Duret-Lutz, CC BY-SA 2.0) and
[Brompton Oratory](https://commons.wikimedia.org/wiki/File:Brompton_Oratory_360x180,_London,_UK_-_Diliff.jpg)
(DAVID ILIFF, CC BY-SA 3.0). The gallery and detail view credit photographers and link to the
source and license. Derived JPEGs retain their source license; their changes are resizing,
JPEG compression, and rectilinear reprojection for card thumbnails. Preserve these credits/licenses
when sharing exported imagery or adaptations.

API use terms: https://github.com/Poly-Haven/Public-API/blob/master/ToS.md
