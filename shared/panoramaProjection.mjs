/**
 * Panorama -> normal camera view projection, shared by the photo scripts (pipeline/photos) and the
 * live-drawing server (server/previews.ts, which re-renders previews with drawings on them), so
 * both produce exactly the same framing: card view, field of view and the viewer's start zoom.
 */
import sharp from 'sharp';
import { START_ZOOM } from './startView.ts';

// Normal camera views, expressed in the original panorama's basic coordinates.
// Pixels in the full panorama are never changed; these are separate card images.
const views = {
  'ph-colosseum': { u: 0.8, v: 0.47, horizontalFov: 80 },
  'ph-vatican_road': { u: 0.5, v: 0.5, horizontalFov: 85 },
  'ph-castel_st_angelo_roof': { u: 0.5, v: 0.46, horizontalFov: 85 },
  'ph-piazza_san_marco': { u: 0.52, v: 0.46, horizontalFov: 90 },
  'ph-zhengyang_gate': { u: 0.5, v: 0.47, horizontalFov: 80 },
  'ph-shanghai_bund': { u: 0.72, v: 0.46, horizontalFov: 90 },
};
export const thumbnailViewFor = id => ({ u: 0.75, v: 0.5, horizontalFov: 85, ...views[id], width: 800, height: 600, projection: 'rectilinear' });
const projections = new Map();

function projection(sourceWidth, sourceHeight, view) {
  const key = JSON.stringify([sourceWidth, sourceHeight, view]);
  if (projections.has(key)) return projections.get(key);
  const { width, height, u, v, horizontalFov } = view;
  const count = width * height;
  const result = { i00: new Uint32Array(count), i01: new Uint32Array(count), i10: new Uint32Array(count), i11: new Uint32Array(count), fx: new Float32Array(count), fy: new Float32Array(count) };
  const lon = (u-0.5)*Math.PI*2, lat = (0.5-v)*Math.PI;
  const sl = Math.sin(lon), cl = Math.cos(lon), sp = Math.sin(lat), cp = Math.cos(lat);
  const scale = Math.tan(horizontalFov*Math.PI/360);
  for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
    const rx = ((x+0.5)/width*2-1)*scale;
    const uy = (1-(y+0.5)/height*2)*scale*height/width;
    const dx = cp*sl + rx*cl - uy*sp*sl;
    const dy = sp + uy*cp;
    const dz = cp*cl - rx*sl - uy*sp*cl;
    const sx = ((Math.atan2(dx,dz)/(2*Math.PI)+0.5)*sourceWidth-0.5+sourceWidth)%sourceWidth;
    const sy = Math.max(0, Math.min(sourceHeight-1, (0.5-Math.asin(dy/Math.hypot(dx,dy,dz))/Math.PI)*sourceHeight-0.5));
    const x0=Math.floor(sx), x1=(x0+1)%sourceWidth, y0=Math.floor(sy), y1=Math.min(sourceHeight-1,y0+1), q=y*width+x;
    result.i00[q]=(y0*sourceWidth+x0)*3; result.i01[q]=(y0*sourceWidth+x1)*3;
    result.i10[q]=(y1*sourceWidth+x0)*3; result.i11[q]=(y1*sourceWidth+x1)*3;
    result.fx[q]=sx-x0; result.fy[q]=sy-y0;
  }
  if (projections.size >= 6) projections.delete(projections.keys().next().value);
  projections.set(key,result);
  return result;
}

/** Project raw RGB panorama pixels into a camera view (bilinear), returning raw RGB. */
export function projectRaw(data, info, view) {
  const map=projection(info.width,info.height,view);
  const ch=info.channels ?? 3;
  const target=Buffer.alloc(view.width*view.height*3);
  for (let i=0; i<view.width*view.height; i++) {
    const wx=map.fx[i], wy=map.fy[i];
    const a=map.i00[i]/3*ch, b=map.i01[i]/3*ch, c2=map.i10[i]/3*ch, d=map.i11[i]/3*ch;
    for (let c=0;c<3;c++) {
      const top=data[a+c]*(1-wx)+data[b+c]*wx;
      const bottom=data[c2+c]*(1-wx)+data[d+c]*wx;
      target[i*3+c]=Math.round(top*(1-wy)+bottom*wy);
    }
  }
  return target;
}

async function renderPanoramaProjection(input, output, view) {
  const {data,info}=await sharp(input).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
  const target=projectRaw(data,info,view);
  await sharp(target,{raw:{width:view.width,height:view.height,channels:3}}).jpeg({quality:88}).toFile(output);
  return view;
}

// Mapillary's default spherical view has a 90° vertical FOV at zoom zero.
// A wide loading frame preserves that vertical coverage when cropped to a
// desktop or phone viewport. The regular card composition stays unchanged.
/** The wide loading frame's view: same centre as the card, at the viewer's start zoom. */
export function loadingViewFor(id, center = {}) {
  const width = 1920, height = 480;
  // The viewer opens at START_ZOOM: tan(fov / 2) shrinks by 2^zoom from the widest view.
  const scale = 2 ** START_ZOOM;
  return { ...thumbnailViewFor(id), u: center.u ?? thumbnailViewFor(id).u, v: center.v ?? thumbnailViewFor(id).v, width, height, horizontalFov: 2 * Math.atan(width / height / scale) * 180 / Math.PI };
}

export async function renderPanoramaLoadingPreview(input, output, id, center = {}) {
  return renderPanoramaProjection(input, output, loadingViewFor(id, center));
}

export async function renderPanoramaThumbnail(input, output, id) {
  const view = await renderPanoramaProjection(input, output, thumbnailViewFor(id));
  if (output.endsWith('-card.jpg')) await renderPanoramaLoadingPreview(input, output.replace(/-card\.jpg$/, '-loading.jpg'), id, view);
  return view;
}
