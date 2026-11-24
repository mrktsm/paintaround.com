/** A relay to test against: the real server with a stand-in for Gemini and ntfy, and people who connect to it. */
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import WebSocket from 'ws';
import type { FinishedStroke, ServerMessage } from '../../shared/realtime.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
export const PLACE = 'test-place';
export const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Wait until something is true (or fail with its name). */
export async function until(what: string, test: () => unknown, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (await test()) return;
  throw new Error(`timed out waiting until ${what}`);
}

/** A folder with one small plain panorama, so tests need no photos. */
export async function panoDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'panos-'));
  await sharp({ create: { width: 1024, height: 512, channels: 3, background: '#8899aa' } }).jpeg().toFile(join(dir, `${PLACE}.jpg`));
  return `${dir}/`;
}

let made = 0;
/** A round dab of paint at a place on the panorama (u, v in 0..1; u may run past the seam). */
export async function dab(u: number, v: number, colour: string, size = 120): Promise<FinishedStroke> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.4}" fill="${colour}"/></svg>`;
  const image = `data:image/png;base64,${(await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64')}`;
  const w = size / 4096, h = size / 2048;
  return { id: `stroke-${++made}`, image, gridBasic: [[[u, v], [u + w, v]], [[u, v + h], [u + w, v + h]]], gridRows: 1, gridCols: 1, srcWidth: size, srcHeight: size, referenceFov: 76, isRainbow: false, toolType: 'marker' };
}

const readBody = (req: IncomingMessage) => new Promise<Buffer>(r => { const parts: Buffer[] = []; req.on('data', d => parts.push(d)); req.on('end', () => r(Buffer.concat(parts))); });
const listen = (handler: Parameters<typeof createServer>[1]) => new Promise<{ port: number; close(): void }>(r => {
  const s = createServer(handler).listen(0, '127.0.0.1', () => r({ port: (s.address() as { port: number }).port, close: () => s.close() }));
});

/** Stands in for Gemini: anything with red paint in it is "bad". `down` makes it fail. */
export async function fakeGemini() {
  const state = { down: false, slowMs: 0, calls: [] as { pictures: Buffer[] }[] };
  const server = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString());
    if (state.down) { res.writeHead(500).end('{}'); return; }
    if (state.slowMs) await wait(state.slowMs);
    const pictures = body.contents[0].parts.filter((p: { inline_data?: unknown }) => p.inline_data).map((p: { inline_data: { data: string } }) => Buffer.from(p.inline_data.data, 'base64'));
    state.calls.push({ pictures });
    const raw = await sharp(pictures[0]).removeAlpha().raw().toBuffer();
    let red = 0;
    for (let i = 0; i < raw.length; i += 3) if (raw[i] > 180 && raw[i + 1] < 90 && raw[i + 2] < 90) red++;
    const bad = red > 50;
    const verdict = { looks_like: ['a dab'], decision: bad ? 'remove' : 'allow', category: bad ? 'other' : 'none', confidence: 'high', reason: bad ? 'red paint' : 'fine' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdict) }] }, finishReason: 'STOP' }] }));
  });
  return Object.assign(state, { url: `http://127.0.0.1:${server.port}`, close: server.close });
}

/** Stands in for ntfy: remembers what was sent. */
export async function fakeNtfy() {
  const sent: { title: string; message: string; bytes: number }[] = [];
  const server = await listen(async (req, res) => {
    const body = await readBody(req);
    sent.push({ title: String(req.headers.title ?? ''), message: String(req.headers.message ?? body), bytes: body.length });
    res.end('{}');
  });
  return { sent, url: `http://127.0.0.1:${server.port}`, close: server.close };
}

const ORIGIN = 'http://test.local';
/** The real relay on a free port. */
export async function relay(env: Record<string, string> = {}) {
  const free = await listen(() => {});
  free.close();
  const proc = spawn(process.execPath, ['server/realtime.ts'], { cwd: ROOT, env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1', PORT: String(free.port), ALLOWED_ORIGINS: ORIGIN, FLATTEN_AFTER_MS: '600000', ...env } });
  const out = { log: '' };
  proc.stdout.on('data', d => { out.log += d; });
  proc.stderr.on('data', d => { out.log += d; });
  await until('the relay listens', () => { if (proc.exitCode !== null) throw new Error(out.log); return out.log.includes('listening'); });
  const base = `http://127.0.0.1:${free.port}`;
  return {
    get log() { return out.log; },
    get: (path: string, init?: RequestInit) => fetch(base + path, init),
    stop: async () => { proc.kill('SIGTERM'); await until('the relay stops', () => proc.exitCode !== null || proc.signalCode !== null); },
    /** Someone who opens a place. */
    async person(room = PLACE, origin = ORIGIN) {
      const ws = new WebSocket(`ws://127.0.0.1:${free.port}/ws`, { origin });
      const p = {
        ws,
        /** what they see: strokes by id */
        seen: new Set<string>(),
        messages: [] as ServerMessage[],
        welcome: null as Extract<ServerMessage, { t: 'welcome' }> | null,
        send: (m: unknown) => ws.send(JSON.stringify(m)),
        draw: (...strokes: FinishedStroke[]) => { for (const stroke of strokes) ws.send(JSON.stringify({ t: 'stroke_done', stroke })); },
        leave: () => ws.close(),
      };
      ws.on('message', d => {
        const m = JSON.parse(String(d)) as ServerMessage;
        p.messages.push(m);
        if (m.t === 'welcome') { p.welcome = m; for (const s of m.strokes) p.seen.add(s.id); }
        if (m.t === 'stroke_done') p.seen.add(m.stroke.id);
        if (m.t === 'erase') for (const id of m.ids) p.seen.delete(id);
      });
      await new Promise((ok, fail) => { ws.on('open', ok); ws.on('error', fail); });
      p.send({ t: 'join', room });
      await until('they are in', () => p.welcome);
      return p;
    },
  };
}
