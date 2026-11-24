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
 *      MODERATION_MAX_PER_HOUR (default 2000 checks; beyond it drawings are allowed unchecked),
 *      MODERATION_DETAIL=medium|high (default medium: 40% cheaper, about as good in our tests).
 */
import sharp from 'sharp';
import { alertProblem } from './alerts.ts';
import { PAINT_LAYER, type FinishedStroke } from '../shared/realtime.ts';
import { strokeOverlays, strokeRect } from './layer.ts';

const PANO_DIR = process.env.PANO_DIR ?? new URL('../public/panorama-pool/', import.meta.url).pathname;
const API_KEY = process.env.GEMINI_API_KEY ?? '';
const MODEL = 'gemini-3.1-flash-lite';
export const MODERATION_ON = !!API_KEY && process.env.MODERATION !== 'off';
/** only record what would happen; nothing is held or removed */
export const LOG_ONLY = process.env.MODERATION !== 'on';
const MAX_PER_HOUR = Number(process.env.MODERATION_MAX_PER_HOUR ?? 2000);
/** how much detail Gemini sees per picture (tokens): medium 560, high 1120 */
const DETAIL = process.env.MODERATION_DETAIL === 'high' ? 'MEDIA_RESOLUTION_HIGH' : 'MEDIA_RESOLUTION_MEDIUM';
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
- sexual content: genitals, sexual acts, explicit nudity
- hate: hate symbols (e.g. swastika, SS runes, KKK imagery), slurs, or text attacking people for race, religion, ethnicity, gender, sexuality or disability
- threats: threats of violence against people or places, glorifying a real attack
- personal info: phone numbers, home addresses, full names paired with insults, or other doxxing

Always allow (these are NOT violations): hearts, faces, smileys, stick figures, animals, names or initials, "X was here", dates, abstract scribbles, red paint (it is not blood), swirls and geometric shapes (a swirl or a cross is not a swastika unless it clearly is one), mild rude jokes or swearing not aimed at a group, cartoon violence, art of any style, clumsy shapes that might accidentally resemble something.

If you are not sure, the answer is allow. Wrongly removing a harmless drawing is worse than missing a borderline one.
Only use confidence "high" when the violation is unmistakable to any reasonable viewer.`;

const usage: number[] = []; // check timestamps (hourly cap)
function underCap() {
  const now = Date.now();
  while (usage.length && now - usage[0] > 3_600_000) usage.shift();
  if (usage.length >= MAX_PER_HOUR) return false;
  usage.push(now);
  return true;
}

const { width: W, height: H } = PAINT_LAYER;

/** A stroke's box on the paint layer, its left edge wrapped into [0, W). */
function pixelBox(s: FinishedStroke) {
  const r = strokeRect(s, W, H);
  const left = Math.round(r.u0 * W);
  return { left: ((left % W) + W) % W, top: r.top, w: r.w, h: r.h };
}

/** Strokes closer together than this (on the 4096 px wide layer) count as one drawing. */
const NEAR_PX = 200;
const MAX_GROUPS = 6;

/** Split a batch into separate drawings: strokes far apart on the panorama (across the seam counts as near). */
export function splitDrawings(batch: FinishedStroke[]): FinishedStroke[][] {
  const boxes = batch.map(pixelBox);
  for (let near = NEAR_PX; ; near *= 2) {
    const parent = batch.map((_, i) => i);
    const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    for (let i = 0; i < batch.length; i++) for (let j = 0; j < i; j++) {
      const a = boxes[i], b = boxes[j];
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
    const b = pixelBox(s);
    // the copy of this stroke nearest to the ones so far
    const mid = Number.isFinite(x0) ? (x0 + x1) / 2 : b.left + b.w / 2;
    const left = b.left + W * Math.round((mid - (b.left + b.w / 2)) / W);
    x0 = Math.min(x0, left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, left + b.w); y1 = Math.max(y1, b.top + b.h);
  }
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.25) + 32;
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
  const batchOverlays = await strokeOverlays(batch, W, H);
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
    ...await strokeOverlays(own, W, H),
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

// Gemini's schema dialect has no additionalProperties
const { additionalProperties: _, ...GEMINI_SCHEMA } = VERDICT_SCHEMA;

/** Ask Gemini. Null = no usable answer (treated as allow). */
export async function judge(pair: Pair): Promise<Verdict | null> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: RULES }] },
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: 'image/jpeg', data: pair.paintAlone } },
      { inline_data: { mime_type: 'image/jpeg', data: pair.inContext } },
      { text: 'Judge this drawing. Answer with the JSON verdict only.' },
    ] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA, maxOutputTokens: 1024, mediaResolution: DETAIL },
  });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
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
  try {
    const pair = await rendering(() => renderPair(placeId, batch, own));
    const v = await judging(() => judge(pair));
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
