/**
 * Phone alerts through ntfy when moderation flags a drawing: what it did, why, a link to the place,
 * and the two pictures the moderator saw. Off without NTFY_TOPIC.
 *
 * A topic on ntfy.sh has no password: anyone who knows its name can read it, so it must be long and
 * random, and it's never logged.
 *
 * Env: NTFY_TOPIC, NTFY_URL (default https://ntfy.sh), NTFY_MAX_PER_HOUR (default 20)
 */
import sharp from 'sharp';

const TOPIC = process.env.NTFY_TOPIC ?? '';
const BASE = process.env.NTFY_URL ?? 'https://ntfy.sh';
const MAX_PER_HOUR = Number(process.env.NTFY_MAX_PER_HOUR ?? 20);
const sent: number[] = [];

/** header-safe: printable ASCII, one line (an AI-written reason can contain anything) */
const plain = (s: string, max: number) => s.replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, max);

/** the moderator's two pictures side by side, as one JPEG */
async function sideBySide(a: string, b: string): Promise<Buffer> {
  const [l, r] = await Promise.all([a, b].map(x => sharp(Buffer.from(x, 'base64')).resize({ height: 480 }).toBuffer({ resolveWithObject: true })));
  return sharp({ create: { width: l.info.width + r.info.width + 8, height: 480, channels: 3, background: '#fff' } })
    .composite([{ input: l.data, left: 0, top: 0 }, { input: r.data, left: l.info.width + 8, top: 0 }]).jpeg({ quality: 82 }).toBuffer();
}

let lastProblem = 0;
/** Drawings are going unchecked (no credit, limits, errors): says so at most once an hour. */
export async function alertProblem(what: string): Promise<void> {
  if (!TOPIC || Date.now() - lastProblem < 3_600_000) return;
  lastProblem = Date.now();
  try {
    const res = await fetch(`${BASE}/${TOPIC}`, {
      method: 'POST',
      headers: { Title: 'paintaround.com: some drawings are not being checked', Tags: 'warning' },
      body: plain(what, 300),
      signal: AbortSignal.timeout(20_000),
    });
    await res.body?.cancel();
    if (!res.ok) console.warn(`[alerts] ntfy HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[alerts] not sent: ${(e as Error).name}`);
  }
}

export interface Alert { place: string; did: string; strokes: number; category: string; reason: string; pictures: { paintAlone: string; inContext: string } }

/** Never throws and never holds anything up: an alert that can't be sent is only logged. */
export async function alertFlagged(a: Alert): Promise<void> {
  if (!TOPIC) return;
  const now = Date.now();
  while (sent.length && now - sent[0] > 3_600_000) sent.shift();
  if (sent.length >= MAX_PER_HOUR) return;
  sent.push(now);
  const last = sent.length === MAX_PER_HOUR;
  try {
    const res = await fetch(`${BASE}/${TOPIC}`, {
      method: 'PUT',
      headers: {
        Title: plain(`paintaround.com: ${a.did} (${a.category})`, 120),
        Message: plain(`${a.place}, ${a.strokes} stroke(s). ${a.reason}${last ? ' (Hourly alert limit reached: no more for up to an hour.)' : ''}`, 500),
        Click: `https://paintaround.com/view?imageId=${encodeURIComponent(a.place)}`,
        Tags: 'art',
        Filename: 'drawing.jpg',
      },
      body: new Uint8Array(await sideBySide(a.pictures.paintAlone, a.pictures.inContext)),
      signal: AbortSignal.timeout(20_000),
    });
    await res.body?.cancel();
    if (!res.ok) console.warn(`[alerts] ntfy HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[alerts] not sent: ${(e as Error).name}`);
  }
}
