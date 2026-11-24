# How it works

```
client/src/explore   the map page: every place, search, the panel
client/src/view      a place: the camera, the pointer, the toolbar
client/src/drawing   everything drawn over the photo
client/src/deep      3D: surfaces, unwrapping them, the brushes, lighting
client/src/pool      the places and their photos
client/src/realtime  the connection to the drawing server
server               the drawing server: rooms, previews, moderation, alerts
shared               what both use: messages, the catalog of places, panorama projection, shared links
pipeline             adding places: photos and 3D data
tests                server and unit tests (npm test), browser tests (npm run test:browser)
```

## Places

`shared/panorama-pool.json` lists the places. Photos are equirectangular (360° × 180°), 4096 × 2048.
A point on one is `(u, v)`, both from 0 to 1; the code calls these *basic* coordinates, like Mapillary.
[mapillary-js](https://github.com/mapillary/mapillary-js) shows the photo. The few of its internals that
are needed (to turn the camera freely and follow it every frame) are all behind
`client/src/viewer/mapillaryInternals.ts`.

## A stroke

`DrawingOverlay` ties the parts in `client/src/drawing` together. What's on screen right now (the camera, the
depth, the size) is the `Scene` the parts read.

**On a surface** (`SurfacePen`). Where the pointer is, the depth map gives a 3D point and a direction.
From there `GeodesicMap` unfolds the surface around the path into a flat sheet, flooding outwards along
it, so the sheet bends around corners and stops at edges. The brush (`deep/decalTools`) paints on that
sheet; a shader shows it on the photo while you draw. Where the path crosses onto something else, the
stroke goes on there as a new piece. At the end all pieces are baked, lit, into one bitmap with a small
grid saying where it sits on the panorama.

**Flat** (`FlatPen`, `flat/`). Without 3D data the stroke is drawn on screen and then put onto the
panorama the same way.

Finished strokes (`Strokes`) are only such bitmaps, so showing them is cheap: `StrokeRenderer` lets the
GPU project their grids in the same frame as the photo.

**Lighting.** A place's lighting map says how bright, and what colour, the light is everywhere. Paint is
multiplied by it, so shadows fall across it.

## Drawing together

Each place is a room on the server (`server/realtime.ts`). `LiveRoom` is its other end.

- While you draw on a surface, the brush's random seed and samples are sent. Others rebuild the same
  sheet and run the same brush (`Replays`). Flat strokes are shown as simple lines (`PeerPreviews`).
- When you let go, the finished bitmap is sent and replaces that. It's what's kept.
- After a few minutes the server flattens strokes into the room's *paint layer*, a tiled image
  (`server/layer.ts`, `PaintLayer`). A busy place then loads a few tiles instead of hundreds of strokes.
  Those strokes can't be undone any more.

Nothing is stored on disk: restarting the server clears the drawings. When memory runs short, the oldest
strokes of the least recently used rooms go.

`server/previews.ts` draws each place's paint into the photos shown on the map.

## Sharing

A shared link says where to look: `/colosseum?at=<u>,<v>,<zoom>` (`shared/placePath.ts`,
`shared/shareView.ts`). The drawing server (`server/share.ts`) answers with the site's page plus the place's title and picture for chat
apps, and renders that picture on demand from the photo and the moderated drawings. The place then opens with
the same picture as its loading frame. Nothing is stored; the latest pictures are cached in memory, and there
is a limit per minute.

## Moderation

`server/moderation.ts`. About 20 seconds after someone stops drawing, what they drew is rendered as two
pictures, the paint alone and on a faded photo, and a vision model decides: allow, hold (it stays but
isn't shown on the map) or remove. Only that person's paint is in the pictures: with other
people's in them, harmless drawings next to bad ones got flagged. Errors mean allow. Removed drawings can be put back for 24 hours, from the server itself:

```sh
curl localhost:8787/internal/held
curl -X POST localhost:8787/internal/restore/<id>
```

## Deploying

`scripts/deploy.sh` copies the site to a server where Caddy serves it and passes `/ws`, `/api` and the
places' addresses to the drawing server ([docs/Caddyfile](Caddyfile)). `.github/workflows/deploy.yml` does that for pushes to `main`, once the variables
listed at its top are set. The drawing server restarts only if its code changed, since that clears the
drawings.

`main` is protected: a commit gets there only once its checks have passed. Push it to a branch first, or
open a pull request.
