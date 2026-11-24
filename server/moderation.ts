/**
 * Moderation for drawings, built to not take down innocent ones:
 *
 *  1. Wait until a person stops drawing in a place (or a minute passes), then check their new
 *     strokes together (each person separately, so one person's drawing never takes down another's).
 *     Strokes far apart are checked as separate drawings, so a small one can't hide beside a big one.
 *  2. Render two pictures: the new paint alone on a background picked for contrast, and the same
 *     area with the photo faded to grey behind it, so only paint is in colour (the photo tells a drawn
 *     word from a real sign). The second one includes the same person's own earlier strokes (someone
 *     could draw half, wait, then the rest) but never other people's paint: with it, harmless drawings
 *     next to someone else's bad one got flagged (research/moderation-eval/neighbours.mjs).
 *  3. One judge: Gemini 3.1 Flash-Lite (best of the models tested on drawings made in the real app,
 *     see research/moderation-eval). Told to flag only clear violations; unsure = allow.
 *  4. MODERATION=log (the default) only records what it would do. MODERATION=on acts: remove at high
 *     confidence; "hold" at medium (stays up in the place, kept off the map previews).
 *  5. Removal is soft: hidden from everyone else (the author still sees it), kept in memory with
 *     the reason so it can be restored, never baked into the paint layer or shown in previews.
 *  6. Errors, blocked answers, a missing key or the hourly cap all mean: the drawing stays (allowed).
 *
 * Env: GEMINI_API_KEY (moderation is off without it), MODERATION=off|log|on (default log),
 *      GEMINI_URL (tests point it at a stand-in),
 *      MODERATION_MAX_PER_HOUR (default 2000 checks; beyond it drawings are allowed unchecked),
 *      MODERATION_DETAIL=mixed|high (default mixed: full detail on the paint, low on the faded photo;
 *      about as good as high in our tests and a quarter cheaper).
 */
import sharp from 'sharp';
import { alertProblem } from './alerts.ts';
import { PAINT_LAYER, type FinishedStroke } from '../shared/realtime.ts';
import { strokeBitmap, strokeOverlays, strokeRect } from './layer.ts';

const PANO_DIR = process.env.PANO_DIR ?? new URL('../public/panorama-pool/', import.meta.url).pathname;
const API_KEY = process.env.GEMINI_API_KEY ?? '';
const MODEL = 'gemini-3.1-flash-lite';
const API_URL = process.env.GEMINI_URL ?? 'https://generativelanguage.googleapis.com';
export const MODERATION_ON = !!API_KEY && process.env.MODERATION !== 'off';
/** only record what would happen; nothing is held or removed */
export const LOG_ONLY = process.env.MODERATION !== 'on';
const MAX_PER_HOUR = Number(process.env.MODERATION_MAX_PER_HOUR ?? 2000);
/** how much detail Gemini sees (and bills) per picture; the shape is in the paint, the photo is context */
const PAINT_DETAIL = 'MEDIA_RESOLUTION_HIGH';
const PHOTO_DETAIL = process.env.MODERATION_DETAIL === 'high' ? 'MEDIA_RESOLUTION_HIGH' : 'MEDIA_RESOLUTION_LOW';
/** drawings waiting to be checked; beyond this they're allowed unchecked rather than piling up */
const MAX_WAITING = 300;
const MAX_JUDGING = 6;

export interface Verdict {
  decision: 'allow' | 'remove';
  category: 'none' | 'sexual' | 'hate' | 'threat' | 'personal_info' | 'other';
  confidence: 'low' | 'medium' | 'high';
  reason: string;
}
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['allow', 'remove'] },
    category: { type: 'string', enum: ['none', 'sexual', 'hate', 'threat', 'personal_info', 'other'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reason: { type: 'string' },
  },
  required: ['decision', 'category', 'confidence', 'reason'],
  additionalProperties: false,
};

export const RULES = `You review drawings people made on top of 360° street photos in a public, anonymous drawing app.
Image 1: only the new paint, on a plain background. Image 2: the same area with the photo faded to grey behind it (only paint is in colour).

Remove ONLY if the drawing clearly shows one of these:
- sexual content: drawn genitals, sexual acts or explicit nudity, also when crude, wobbly, tilted, left open or bent around a corner (a penis: a long shape with a rounded or pointed tip and two round or looped shapes side by side at its base; a short line at the tip, a rim below it or drops coming out make it certain); or written sexual words (names or slang for genitals, breasts, sexual fluids or sex acts, such as "vagina" or "blowjob") when that is clearly the meaning
- hate: hate symbols (a swastika: exactly four straight arms of equal length, each bent once at a sharp right angle, all in the same direction; SS runes; KKK imagery), slurs, or text attacking people for race, religion, ethnicity, gender, sexuality or disability
- threats: threats of violence against people or places, glorifying a real attack
- personal info: phone numbers, home addresses, full names paired with insults, or other doxxing

Always allow (these are NOT violations): hearts, faces, smileys, stick figures, animals, names or initials, "X was here", dates, abstract scribbles, red paint (it is not blood), swirls and geometric shapes, wheels and blades (curved, slanted or tapering arms, or any number of arms other than four, is not a swastika), everyday objects, plants, food or fruit that are merely round or long, ordinary swearing that isn't sexual (such as "damn", or "fuck" as a plain swear word), words or names that only contain or match a rude word (such as "Hancock" or "Moby Dick"), mild rude jokes not aimed at a group, cartoon violence, art of any style, shapes that only faintly resemble something.

Judge it like people walking past would: if most of them would see a violation, remove it, however badly it is drawn. If it is just as likely to be something harmless, allow it.
Use confidence "high" when most people would recognise the violation.`;

const usage: number[] = []; // check timestamps (hourly cap)
function underCap() {
  const now = Date.now();
  while (usage.length && now - usage[0] > 3_600_000) usage.shift();
  if (usage.length >= MAX_PER_HOUR) return false;
  usage.push(now);
  return true;
}

const { width: W, height: H } = PAINT_LAYER;

interface Box { left: number; top: number; w: number; h: number }
const boxes = new WeakMap<FinishedStroke, Box>();

/**
 * Where a stroke's paint is on the paint layer, its left edge wrapped into [0, W). A stroke's bitmap
 * can be much bigger than its paint: boxing the bitmap left small drawings as a speck in the picture.
 */
async function paintBox(s: FinishedStroke): Promise<Box> {
  const known = boxes.get(s);
  if (known) return known;
  const r = strokeRect(s, W, H);
  // in bitmap pixels: the rows and columns with visible paint (the whole bitmap if there is none)
  const { data, info } = await sharp(strokeBitmap(s)).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  let peak = 0;
  for (const v of data) if (v > peak) peak = v;
  const visible = Math.max(4, Math.min(64, peak / 2)); // faint paint (watercolor) counts too
  let x0 = info.width, x1 = -1, y0 = info.height, y1 = -1;
  for (let y = 0, i = 0; y < info.height; y++) for (let x = 0; x < info.width; x++, i++) {
    if (data[i] < visible) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) { x0 = y0 = 0; x1 = info.width - 1; y1 = info.height - 1; }
  const kx = r.w / info.width, ky = r.h / info.height;
  const left = Math.floor(r.u0 * W + x0 * kx);
  const box = { left: ((left % W) + W) % W, top: Math.floor(r.top + y0 * ky), w: Math.max(1, Math.ceil((x1 - x0 + 1) * kx)), h: Math.max(1, Math.ceil((y1 - y0 + 1) * ky)) };
  boxes.set(s, box);
  return box;
}

function hsv([r, g, b]: number[]) {
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const h = !d ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: max ? d / max : 0, v: max };
}

/**
 * Strokes are stored lit by the place, so a shape half in shadow falls apart into bright and nearly
 * black pieces. For judging, each stroke is drawn in one clean colour: the brightest shade of its own
 * hue found in the drawing. Rainbow strokes, and black, grey and white paint, keep their own colours.
 */
async function cleanColours(strokes: FinishedStroke[]): Promise<FinishedStroke[]> {
  const raws = await Promise.all(strokes.map(s => sharp(strokeBitmap(s)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  const tops = raws.map(({ data }) => {
    // average of the brightest tenth of the paint
    const hist = new Uint32Array(256);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 100) { hist[Math.max(data[i], data[i + 1], data[i + 2])]++; n++; }
    if (!n) return null;
    let cut = 255;
    for (let seen = hist[255]; seen < n * 0.1 && cut > 0; seen += hist[--cut]);
    const sum = [0, 0, 0];
    let m = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 100 && Math.max(data[i], data[i + 1], data[i + 2]) >= cut) { sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; m++; }
    return sum.map(x => x / m);
  });
  return Promise.all(strokes.map(async (s, k) => {
    let colour = tops[k];
    if (!colour || s.isRainbow) return s;
    const own = hsv(colour);
    if (own.s >= 0.35) {
      for (const other of tops) {
        if (!other) continue;
        const o = hsv(other), dh = Math.abs(o.h - own.h);
        if (o.s >= 0.35 && Math.min(dh, 360 - dh) < 25 && o.v > hsv(colour).v) colour = other;
      }
      const lift = Math.max(1, 220 / Math.max(1, hsv(colour).v)); // all of it in shadow: bring it up
      colour = colour.map(x => Math.min(255, x * lift));
    }
    const { data, info } = raws[k];
    const [cr, cg, cb] = colour.map(Math.round);
    for (let i = 0; i < data.length; i += 4) { data[i] = cr; data[i + 1] = cg; data[i + 2] = cb; }
    const png = await sharp(data, { raw: info }).png({ compressionLevel: 1 }).toBuffer();
    return { ...s, image: `data:image/png;base64,${png.toString('base64')}` };
  }));
}

/** Strokes closer together than this (on the 4096 px wide layer) count as one drawing. */
const NEAR_PX = 200;
const MAX_GROUPS = 6;

/** Split a batch into separate drawings: strokes far apart on the panorama (across the seam counts as near). */
export async function splitDrawings(batch: FinishedStroke[]): Promise<FinishedStroke[][]> {
  const at = await Promise.all(batch.map(paintBox));
  for (let near = NEAR_PX; ; near *= 2) {
    const parent = batch.map((_, i) => i);
    const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    for (let i = 0; i < batch.length; i++) for (let j = 0; j < i; j++) {
      const a = at[i], b = at[j];
      const gapY = Math.max(a.top, b.top) - Math.min(a.top + a.h, b.top + b.h);
      const gapX = Math.min(...[-W, 0, W].map(d => Math.max(a.left, b.left + d) - Math.min(a.left + a.w, b.left + d + b.w)));
      if (Math.max(gapX, gapY) < near) parent[root(i)] = root(j);
    }
    const groups = new Map<number, FinishedStroke[]>();
    batch.forEach((s, i) => { const r = root(i); groups.set(r, [...(groups.get(r) ?? []), s]); });
    if (groups.size <= MAX_GROUPS) return [...groups.values()];
  }
}

/** The two pictures for a drawing: paint alone, and paint in context with the person's own earlier strokes. JPEG base64. */
export async function renderPair(placeId: string, batch: FinishedStroke[], own: FinishedStroke[] = []) {
  // the drawing's bounding box at layer scale, padded; it may run past the seam (x < 0 or > W)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of batch) {
    const b = await paintBox(s);
    // the copy of this stroke nearest to the ones so far
    const mid = Number.isFinite(x0) ? (x0 + x1) / 2 : b.left + b.w / 2;
    const left = b.left + W * Math.round((mid - (b.left + b.w / 2)) / W);
    x0 = Math.min(x0, left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, left + b.w); y1 = Math.max(y1, b.top + b.h);
  }
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.2) + 16;
  x0 -= pad; x1 += pad;
  y0 = Math.max(0, y0 - pad); y1 = Math.min(H, y1 + pad);
  if (x1 - x0 >= W) { x0 = 0; x1 = W; }
  if (y1 <= y0) throw new Error('drawing is outside the panorama');
  const width = x1 - x0, height = y1 - y0;
  /** cut the box out of a full panorama picture, joining both sides of the seam if needed */
  const cut = async (img: Buffer) => {
    const left = ((x0 % W) + W) % W;
    if (left + width <= W) return sharp(img).extract({ left, top: y0, width, height });
    const first = W - left;
    const [a, b] = await Promise.all([
      sharp(img).extract({ left, top: y0, width: first, height }).png().toBuffer(),
      sharp(img).extract({ left: 0, top: y0, width: width - first, height }).png().toBuffer(),
    ]);
    const joined = await sharp({ create: { width, height, channels: 3, background: '#000' } })
      .composite([{ input: a, left: 0, top: 0 }, { input: b, left: first, top: 0 }]).png().toBuffer();
    return sharp(joined);
  };
  const toB64 = async (img: sharp.Sharp) =>
    (await (await cut(await img.png().toBuffer())).resize({ width: 768, height: 768, fit: 'inside' }).jpeg({ quality: 85 }).toBuffer()).toString('base64');
  const clean = await cleanColours([...batch, ...own]);
  const batchOverlays = await strokeOverlays(clean.slice(0, batch.length), W, H);
  // 1) the new paint alone, on a background picked for contrast: white behind dark paint,
  //    near-black behind light paint (thin dark pencil vanished on mid-grey)
  const ink = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(batchOverlays).raw().toBuffer();
  let sum = 0, n = 0;
  for (let i = 0; i < ink.length; i += 16) if (ink[i + 3] > 128) { sum += 0.2126 * ink[i] + 0.7152 * ink[i + 1] + 0.0722 * ink[i + 2]; n++; }
  const lum = n ? sum / n : 128;
  const bg = lum < 110 ? { r: 255, g: 255, b: 255 } : lum > 170 ? { r: 24, g: 24, b: 24 } : { r: 236, g: 236, b: 236 };
  const paintAlone = await toB64(sharp({ create: { width: W, height: H, channels: 3, background: bg } }).composite(batchOverlays));
  // 2) in context: the place faded back (grey, lighter, low contrast, slightly soft) so only the
  //    strokes keep their colour
  const photo = await sharp(`${PANO_DIR}${placeId}.jpg`).resize(W, H, { fit: 'fill' })
    .grayscale().linear(0.45, 140).blur(1.2).toColourspace('srgb').toBuffer();
  const inContext = await toB64(sharp(photo).composite([
    ...await strokeOverlays(clean.slice(batch.length), W, H),
    ...batchOverlays,
  ]));
  return { paintAlone, inContext };
}
export type Pair = Awaited<ReturnType<typeof renderPair>>;

function parseVerdict(text: string | undefined): Verdict | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Verdict;
    return (v.decision === 'allow' || v.decision === 'remove') && ['low', 'medium', 'high'].includes(v.confidence) ? v : null;
  } catch { return null; }
}

// It first says what people would call the drawing, then decides: deciding first, it settled on the
// most innocent reading of sketchy drawings every time.
const ANSWER_ORDER = ['looks_like', 'decision', 'category', 'confidence', 'reason'];
const GEMINI_SCHEMA = { // (Gemini's schema dialect has no additionalProperties)
  type: VERDICT_SCHEMA.type,
  properties: {
    looks_like: { type: 'array', items: { type: 'string' }, description: 'what different people walking past would say this drawing is: 3 short guesses, most likely first, including rude ones' },
    ...VERDICT_SCHEMA.properties,
  },
  required: ANSWER_ORDER,
  propertyOrdering: ANSWER_ORDER,
};

/** Ask Gemini. Null = no usable answer (treated as allow). */
export async function judge(pair: Pair): Promise<Verdict | null> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: RULES }] },
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: 'image/jpeg', data: pair.paintAlone }, media_resolution: { level: PAINT_DETAIL } },
      { inline_data: { mime_type: 'image/jpeg', data: pair.inContext }, media_resolution: { level: PHOTO_DETAIL } },
      { text: 'Judge this drawing. Answer with the JSON verdict only.' },
    ] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA, maxOutputTokens: 1024 },
  });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API_URL}/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': API_KEY },
      body,
      signal: AbortSignal.timeout(45_000),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await res.body?.cancel();
      await new Promise(r => setTimeout(r, 3000 * 2 ** attempt));
      continue;
    }
    const j = await res.json() as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string }; error?: { status?: string } };
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status} ${j.error?.status ?? ''}`);
    const c = j.candidates?.[0];
    const v = parseVerdict(c?.content?.parts?.filter(p => !p.thought).map(p => p.text ?? '').join(''));
    if (!v) console.warn(`[moderation] no usable answer (${j.promptFeedback?.blockReason ?? c?.finishReason ?? 'empty'})`);
    return v;
  }
}

export type Outcome = { action: 'allow' } | { action: 'hold' | 'remove'; verdict: Verdict; pictures: Pair };

/** at most n at once, the rest wait their turn */
function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(f: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>(r => waiting.push(r));
    else active++;
    try { return await f(); } finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  };
}
// one render at a time (it uses the same two cores as live drawing); waiting on Gemini costs nothing
const rendering = limiter(1), judging = limiter(MAX_JUDGING);
let inFlight = 0;

/**
 * Check one drawing (a person's new strokes in one part of a place): allow, hold (stays up, kept
 * off the map) or remove. Anything going wrong (error, no answer, cap, moderation off) means allow.
 */
export async function moderate(placeId: string, batch: FinishedStroke[], own: FinishedStroke[]): Promise<Outcome> {
  if (!MODERATION_ON || !batch.length) return { action: 'allow' };
  if (inFlight >= MAX_WAITING) { problem('too many drawings waiting to be checked'); return { action: 'allow' }; }
  if (!underCap()) { problem('hourly limit of checks reached'); return { action: 'allow' }; }
  inFlight++;
  const started = Date.now();
  try {
    const pair = await rendering(() => renderPair(placeId, batch, own));
    const v = await judging(() => judge(pair));
    // every check leaves a trace, without the drawing or what it says
    console.log(`[moderation] ${placeId}: checked ${batch.length} stroke(s) in ${((Date.now() - started) / 1000).toFixed(1)} s: ${v ? `${v.decision}${v.decision === 'remove' ? ` ${v.category}/${v.confidence}` : ''}` : 'no answer'}`);
    if (!v || v.decision !== 'remove' || v.confidence === 'low') return { action: 'allow' };
    return { action: v.confidence === 'high' ? 'remove' : 'hold', verdict: v, pictures: pair };
  } catch (e) {
    problem(`check failed, allowing: ${(e as Error).message}`, placeId);
    return { action: 'allow' };
  } finally {
    inFlight--;
  }
}

function problem(what: string, placeId = '') {
  console.warn(`[moderation] ${placeId ? `${placeId}: ` : ''}${what}`);
  void alertProblem(what);
}
