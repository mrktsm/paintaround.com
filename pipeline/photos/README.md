# The photos

How the 200 places were chosen. All photos are 360° × 180°, at least 6000 px wide, and free to use: from
[Poly Haven](https://polyhaven.com) (CC0) and Wikimedia Commons (CC0, CC BY or CC BY-SA). The catalog,
`client/src/data/panorama-pool.json`, has each one's author, source and license, and the checksum of the
original. Positions are the source's; places without one aren't on the map.

- `candidates.json`: the candidates with the sources' own metadata, best first. Squares, streets,
  landmarks, transit and interiors rank high; skies, studios and ordinary rural roads are left out.
- `curation.json`: what was left out or preferred after looking at them.

To get the photos for running the app, use `npm run photos`. These are for changing the collection:

```sh
npm run photos:add -- --expanded --limit=200   # download candidates until there are 200, and add them to the catalog
npm run photos:verify                          # check files, provenance and dimensions; make contact sheets to look through
npm run photos:thumbnails                      # the map's card photos
npm run photos:loading-previews                # the wide photo shown while a place loads
```
