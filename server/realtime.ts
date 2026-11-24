/**
 * Live drawing relay. One room per panorama; relays cursors and strokes to everyone else in the
 * room and keeps the room's finished strokes in memory (nothing touches disk) so people who come
 * later see what's been drawn. Drawings stay as long as the server runs (a restart clears them),
 * within a total memory budget. Also serves previews with the drawings on them (server/previews).
 *
 * Run:  node server/realtime.ts           (Node 23.6+, types stripped natively)
 * Settings: .env.example
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { drawingsChanged, getPreview, previewManifest, schedulePreview } from './previews.ts';
import { isPlace, placeNamed, placePage, sharePicture } from './share.ts';
import { PaintLayer } from './layer.ts';
import { alertFlagged } from './alerts.ts';
import { LOG_ONLY, MODERATION_ON, moderate, splitDrawings, type Verdict } from './moderation.ts';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseAt } from '../shared/shareView.ts';
import { LIMITS, PEER_COLORS, type ClientMessage, type FinishedStroke, type Peer, type ServerMessage } from '../shared/realtime.ts';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map(s => s.trim()).filter(Boolean),
);

interface Client {
  ws: WebSocket;
  peer: Peer;
  room: Room | null;
  alive: boolean;
  tokens: number;
  lastRefill: number;
  strokeTimes: number[];
}

interface Drawn { stroke: FinishedStroke; bytes: number; added: number; author: string; mod: 'pending' | 'ok' | 'hold' }

interface Room {
  id: string;
  clients: Set<Client>;
  /**
   * fresh strokes, oldest first (undo / erase still work on these). mod: 'pending' until the
   * author's batch has been checked; only 'ok' strokes get baked into the layer or shown in
   * previews. 'hold' = the moderator wasn't sure: stays up in the place, kept off the map.
   */
  strokes: Map<string, Drawn>;
  /** older strokes, flattened into one tiled image */
  layer: PaintLayer;
  flattening: boolean;
  bytes: number;
  /** last time someone drew or erased here (oldest rooms give way when memory runs short) */
  touched: number;
}

/** Strokes older than this get flattened into the room's paint layer. */
const FLATTEN_AFTER_MS = Number(process.env.FLATTEN_AFTER_MS ?? 3 * 60_000);

/** All rooms' strokes together stay under this (oldest strokes of the least recent rooms go). */
const TOTAL_STROKE_BYTES = Number(process.env.TOTAL_STROKE_BYTES ?? 2 * 1024 ** 3);
let totalBytes = 0;
/** shown in previews (in log-only mode moderation changes nothing, so unchecked strokes show too) */
const shown = (s: { mod: string }) => s.mod === 'ok' || LOG_ONLY;
const roomDrawings = (room: Room) => () => ({ layer: room.layer, strokes: [...room.strokes.values()].filter(shown).map(s => s.stroke) });
function trimMemory(keep: Room) {
  while (totalBytes > TOTAL_STROKE_BYTES) {
    let oldest: Room | null = null;
    for (const r of rooms.values()) if (r !== keep && (r.strokes.size || r.layer.bytes) && (!oldest || r.touched < oldest.touched)) oldest = r;
    const victim = oldest ?? keep;
    const first = victim.strokes.keys().next();
    if (first.done) {
      // only a paint layer left: the least recently drawn place loses it
      if (!victim.layer.bytes) return;
      totalBytes -= victim.layer.bytes;
      victim.bytes -= victim.layer.bytes;
      victim.layer.clear();
      schedulePreview(victim.id, roomDrawings(victim));
      continue;
    }
    const s = victim.strokes.get(first.value)!;
    victim.strokes.delete(first.value);
    victim.bytes -= s.bytes;
    totalBytes -= s.bytes;
    schedulePreview(victim.id, roomDrawings(victim));
  }
}

const rooms = new Map<string, Room>();
const clients = new Set<Client>();

const send = (c: Client, msg: ServerMessage) => {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
};
const broadcast = (room: Room, from: Client, msg: ServerMessage) => {
  const data = JSON.stringify(msg);
  for (const c of room.clients) if (c !== from && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
};

function leave(c: Client) {
  const room = c.room;
  if (!room) return;
  room.clients.delete(c);
  c.room = null;
  // the room (and its drawings) stays when the last person leaves; only empty rooms are dropped
  if (room.clients.size === 0 && room.strokes.size === 0 && room.layer.tiles.size === 0) rooms.delete(room.id);
  else if (room.clients.size) broadcast(room, c, { t: 'peer_leave', id: c.peer.id });
}

function join(c: Client, roomId: string, preferred?: string) {
  if (c.room?.id === roomId) return;
  leave(c);
  let room = rooms.get(roomId);
  if (room && room.clients.size >= LIMITS.maxPeersPerRoom) return send(c, { t: 'error', reason: 'room_full' });
  if (!room) rooms.set(roomId, (room = { id: roomId, clients: new Set(), strokes: new Map(), layer: new PaintLayer(), flattening: false, bytes: 0, touched: Date.now() }));
  // keep the person's own colour unless someone in the room already has it
  const taken = new Set([...room.clients].map(o => o.peer.color));
  const wanted = preferred && (PEER_COLORS as readonly string[]).includes(preferred) ? preferred : c.peer.color;
  const start = Math.max(0, PEER_COLORS.indexOf(wanted as (typeof PEER_COLORS)[number]));
  c.peer.color = wanted;
  for (let k = 0; k < PEER_COLORS.length && taken.has(c.peer.color); k++) c.peer.color = PEER_COLORS[(start + 1 + k) % PEER_COLORS.length];
  room.clients.add(c);
  c.room = room;
  send(c, {
    t: 'welcome', you: c.peer.id, room: roomId,
    peers: [...room.clients].filter(o => o !== c).map(o => o.peer),
    strokes: [...room.strokes.values()].map(s => s.stroke),
    ...(room.layer.tiles.size ? { layer: room.layer.manifest() } : {}),
  });
  broadcast(room, c, { t: 'peer_join', peer: c.peer });
}

// ── validation: trust nothing from the wire ──
const isNum = (x: unknown, lo = -Infinity, hi = Infinity): x is number => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const isStr = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;
const isColor = (x: unknown) => isStr(x, 64) && /^(#[0-9a-fA-F]{3,8}|rainbow|hsla?\([\d.,%\s]+\))$/.test(x as string);
const TOOLS = new Set(['pencil', 'marker', 'crayon', 'fountainPen', 'watercolor']);
const isUV = (m: { u?: unknown; v?: unknown }) => isNum(m.u, -2, 3) && isNum(m.v, -0.5, 1.5);

function validStroke(s: unknown): s is FinishedStroke {
  const x = s as FinishedStroke;
  if (!x || !isStr(x.id, 64) || !isStr(x.image, LIMITS.maxMessageBytes)) return false;
  if (!/^data:image\/(webp|png);base64,/.test(x.image)) return false;
  if (!isNum(x.gridRows, 1, 64) || !isNum(x.gridCols, 1, 64)) return false;
  if (!isNum(x.srcWidth, 1, 16384) || !isNum(x.srcHeight, 1, 16384) || !isNum(x.referenceFov, 1, 180)) return false;
  if (!Array.isArray(x.gridBasic) || x.gridBasic.length !== x.gridRows + 1) return false;
  for (const row of x.gridBasic) {
    if (!Array.isArray(row) || row.length !== x.gridCols + 1) return false;
    for (const p of row) if (!Array.isArray(p) || !isNum(p[0], -2, 3) || !isNum(p[1], -0.5, 1.5)) return false;
  }
  if (x.toolType !== undefined && !TOOLS.has(x.toolType)) return false;
  if (x.strokeGroup !== undefined && !isNum(x.strokeGroup)) return false;
  return typeof x.isRainbow === 'boolean';
}

function allow(c: Client): boolean {
  const now = Date.now();
  c.tokens = Math.min(LIMITS.messagesPerSecond, c.tokens + ((now - c.lastRefill) / 1000) * LIMITS.messagesPerSecond);
  c.lastRefill = now;
  if (c.tokens < 1) return false;
  c.tokens -= 1;
  return true;
}

function handle(c: Client, raw: string) {
  let m: ClientMessage;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== 'object' || !allow(c)) return;
  if (m.t === 'join') {
    if (isStr(m.room, 128) && /^[\w.-]+$/.test(m.room)) join(c, m.room, typeof m.color === 'string' ? m.color : undefined);
    return;
  }
  const room = c.room;
  if (!room) return;
  const from = c.peer.id;
  switch (m.t) {
    case 'cursor':
      if (isUV(m) && isNum(m.radius, 0, 1) && (m.paint === null || isColor(m.paint)))
        broadcast(room, c, { t: 'cursor', u: m.u, v: m.v, radius: m.radius, paint: m.paint, from });
      return;
    case 'cursor_hide':
    case 'stroke_end':
      broadcast(room, c, { t: m.t, from });
      return;
    case 'stroke_start':
      if (isUV(m) && isColor(m.color) && isNum(m.lineWidth, 0, 200) && TOOLS.has(m.toolType) && isNum(m.fov, 1, 180))
        broadcast(room, c, {
          t: 'stroke_start', color: m.color, lineWidth: m.lineWidth, toolType: m.toolType, u: m.u, v: m.v, fov: m.fov, from,
          ...(isNum(m.group) ? { group: m.group } : {}),
          ...(Number.isInteger(m.seed) && isNum(m.seed, 0, 2 ** 32) ? { seed: m.seed } : {}),
          ...(isNum(m.wpp, 1e-9, 1e6) ? { wpp: m.wpp } : {}),
        });
      return;
    case 'stroke_point':
      if (isUV(m)) {
        const pts = Array.isArray(m.pts) && m.pts.length <= 4 * 128 && m.pts.length % 4 === 0
          && m.pts.every(x => isNum(x, -1e5, 1e5)) ? m.pts : undefined;
        broadcast(room, c, { t: 'stroke_point', u: m.u, v: m.v, ...(pts ? { pts } : {}), from });
      }
      return;
    case 'stroke_done': {
      if (!validStroke(m.stroke)) return;
      const now = Date.now();
      c.strokeTimes = c.strokeTimes.filter(t => now - t < 60_000);
      if (c.strokeTimes.length >= LIMITS.finishedStrokesPerMinute) return;
      c.strokeTimes.push(now);
      const stroke = m.stroke;
      const bytes = stroke.image.length;
      const old = room.strokes.get(stroke.id);
      if (old) { room.bytes -= old.bytes; totalBytes -= old.bytes; }
      room.strokes.delete(stroke.id); // re-insert = newest (redo)
      room.strokes.set(stroke.id, { stroke, bytes, added: now, author: from, mod: MODERATION_ON ? 'pending' : 'ok' });
      if (MODERATION_ON) scheduleModeration(room, from);
      room.bytes += bytes;
      totalBytes += bytes;
      room.touched = now;
      // drop the oldest strokes beyond the room's memory budget
      for (const [id, s] of room.strokes) {
        if (room.strokes.size <= LIMITS.maxStrokesPerRoom && room.bytes <= LIMITS.maxRoomStrokeBytes) break;
        room.strokes.delete(id);
        room.bytes -= s.bytes;
        totalBytes -= s.bytes;
      }
      trimMemory(room);
      broadcast(room, c, { t: 'stroke_done', stroke, from });
      schedulePreview(room.id, roomDrawings(room));
      return;
    }
    case 'erase': {
      if (!Array.isArray(m.ids)) return;
      const ids = m.ids.filter(id => isStr(id, 64)).slice(0, 500);
      for (const id of ids) {
        const s = room.strokes.get(id);
        if (s) { room.bytes -= s.bytes; totalBytes -= s.bytes; room.strokes.delete(id); }
      }
      if (ids.length) {
        room.touched = Date.now();
        broadcast(room, c, { t: 'erase', ids, from });
        schedulePreview(room.id, roomDrawings(room));
      }
      return;
    }
  }
}

// ── moderation: once a person stops drawing in a place, their new strokes get checked ──
/** wait this long after a person's last stroke in a place before checking their batch */
const QUIET_MS = Number(process.env.MODERATION_QUIET_MS ?? 20_000);
/** but never longer than this after their first unchecked stroke (someone who never pauses) */
const MAX_WAIT_MS = Number(process.env.MODERATION_MAX_WAIT_MS ?? 60_000);
const modTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** when a person's oldest unchecked stroke in a place was drawn */
const modFirst = new Map<string, number>();
const modRunning = new Map<string, Promise<void>>();
interface Held { id: string; room: string; stroke: FinishedStroke; at: number; verdict: Verdict; removed: boolean; picture: string }
/**
 * removed strokes, kept 24 h so a wrong call can be restored (GET /internal/held, GET
 * /internal/held/<id>.jpg, POST /internal/restore/<id>). In log-only mode: what would have been removed.
 */
const held = new Map<string, Held>();
const MAX_HELD = 2000;

function scheduleModeration(room: Room, author: string) {
  const key = `${room.id}\n${author}`;
  const now = Date.now();
  if (!modFirst.has(key)) modFirst.set(key, now);
  // (not pushed back further once the longest wait is reached, however fast they draw)
  const wait = Math.max(0, Math.min(QUIET_MS, modFirst.get(key)! + MAX_WAIT_MS - now));
  clearTimeout(modTimers.get(key));
  modTimers.set(key, setTimeout(() => { modTimers.delete(key); void runModeration(room, author); }, wait));
}

/** Check a person's new strokes in a place (after the check that's running, if one is). */
async function runModeration(room: Room, author: string): Promise<void> {
  const key = `${room.id}\n${author}`;
  for (let running; (running = modRunning.get(key));) await running;
  clearTimeout(modTimers.get(key));
  modTimers.delete(key);
  modFirst.delete(key);
  const batch = [...room.strokes.values()].filter(s => s.author === author && s.mod === 'pending');
  if (!batch.length) return;
  const check = checkBatch(room, author, batch).finally(() => modRunning.delete(key));
  modRunning.set(key, check);
  await check;
}

async function checkBatch(room: Room, author: string, batch: Drawn[]): Promise<void> {
  try {
    // drawings far apart are judged separately, so one can't hide beside (or take down) another
    for (const drawing of await splitDrawings(batch.map(s => s.stroke))) {
      const strokes = new Set(drawing);
      // their own earlier strokes count (half now, half later), unless already flagged; nobody else's do
      const own = [...room.strokes.values()].filter(s => s.author === author && !strokes.has(s.stroke) && !held.has(s.stroke.id)).map(s => s.stroke);
      const outcome = await moderate(room.id, drawing, own);
      const ids: string[] = [];
      for (const s of batch) {
        const id = s.stroke.id;
        if (!strokes.has(s.stroke) || room.strokes.get(id) !== s) continue; // erased (or redone) while checking
        if (outcome.action === 'allow') { s.mod = 'ok'; continue; }
        if (outcome.action === 'hold') { s.mod = LOG_ONLY ? 'ok' : 'hold'; ids.push(id); continue; }
        held.set(id, { id, room: room.id, stroke: s.stroke, at: Date.now(), verdict: outcome.verdict, removed: !LOG_ONLY, picture: outcome.pictures.inContext });
        if (held.size > MAX_HELD) held.delete(held.keys().next().value!);
        ids.push(id);
        if (LOG_ONLY) { s.mod = 'ok'; continue; }
        room.strokes.delete(id);
        room.bytes -= s.bytes;
        totalBytes -= s.bytes;
      }
      if (outcome.action === 'allow' || !ids.length) continue;
      const v = outcome.verdict;
      const did = outcome.action === 'hold' ? (LOG_ONLY ? 'would hold off the map' : 'held off the map') : (LOG_ONLY ? 'would remove' : 'removed');
      console.log(`[moderation] ${room.id}: ${did} ${ids.length} stroke(s) (${v.category}/${v.confidence})`); // the reason can quote what was written: memory and alert only, never the log
      void alertFlagged({ place: room.id, did, strokes: ids.length, category: v.category, reason: v.reason, pictures: outcome.pictures });
      if (outcome.action === 'remove' && !LOG_ONLY) {
        // gone for everyone else; the author still sees it (no fight with the filter)
        const msg = JSON.stringify({ t: 'erase', ids, from: 'moderation' } satisfies ServerMessage);
        for (const c of room.clients) if (c.peer.id !== author && c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
      }
    }
    schedulePreview(room.id, roomDrawings(room));
  } catch (e) {
    // never leave strokes stuck unchecked: anything unexpected means they stay
    console.warn(`[moderation] ${room.id}: ${(e as Error).message}; allowing`);
    for (const s of batch) if (s.mod === 'pending') s.mod = 'ok';
  }
}

/** A shared link's picture waits this long at most for the newest drawings to be checked. */
const SHARE_WAIT_MS = Number(process.env.SHARE_WAIT_MS ?? 5000);
/** Checks for shared pictures: one per place in this time. */
const SHARE_CHECK_EVERY_MS = 10_000;
const shareChecks = new Map<string, { at: number; done: Promise<unknown> }>();

/** Someone shares this place: check what's waiting there now, so the picture can show it. */
function checkNow(room: Room): Promise<unknown> {
  if (!MODERATION_ON || LOG_ONLY) return Promise.resolve(); // (then everything shows anyway)
  const now = Date.now(), last = shareChecks.get(room.id);
  let done = last?.done;
  if (!last || !done || now - last.at >= SHARE_CHECK_EVERY_MS) {
    const authors = new Set([...room.strokes.values()].filter(s => s.mod === 'pending').map(s => s.author));
    if (!authors.size) return Promise.resolve();
    done = Promise.all([...authors].map(author => runModeration(room, author)));
    shareChecks.delete(room.id);
    shareChecks.set(room.id, { at: now, done });
    if (shareChecks.size > 500) shareChecks.delete(shareChecks.keys().next().value!);
  }
  return Promise.race([done, new Promise(r => setTimeout(r, SHARE_WAIT_MS))]);
}
setInterval(() => { const cut = Date.now() - 24 * 3_600_000; for (const [id, h] of held) if (h.at < cut) held.delete(id); }, 600_000);

/** Put a wrongly removed stroke back (approved, so it isn't checked again). */
function restore(id: string): boolean {
  const h = held.get(id);
  if (!h?.removed) return false;
  held.delete(id);
  let room = rooms.get(h.room);
  if (!room) rooms.set(h.room, (room = { id: h.room, clients: new Set(), strokes: new Map(), layer: new PaintLayer(), flattening: false, bytes: 0, touched: Date.now() }));
  const bytes = h.stroke.image.length;
  room.strokes.set(id, { stroke: h.stroke, bytes, added: Date.now(), author: 'restore', mod: 'ok' });
  room.bytes += bytes;
  totalBytes += bytes;
  const msg = JSON.stringify({ t: 'stroke_done', stroke: h.stroke, from: 'moderation' } satisfies ServerMessage);
  for (const c of room.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
  schedulePreview(room.id, roomDrawings(room));
  return true;
}

// ── flattening: strokes older than FLATTEN_AFTER_MS are baked into the room's paint layer ──
async function flatten(room: Room) {
  if (room.flattening) return;
  const cutoff = Date.now() - FLATTEN_AFTER_MS;
  // only checked strokes are baked (pending ones wait for moderation)
  const due = [...room.strokes.entries()].filter(([, s]) => s.added <= cutoff && s.mod === 'ok');
  if (!due.length) return;
  room.flattening = true;
  try {
    const before = room.layer.bytes;
    const tiles = await room.layer.bake(due.map(([, s]) => s.stroke));
    // a stroke erased while baking would wrongly stay in the layer: rare; drop it from the list
    const ids: string[] = [];
    for (const [id, s] of due) {
      if (!room.strokes.has(id)) continue;
      room.strokes.delete(id);
      room.bytes -= s.bytes;
      totalBytes -= s.bytes;
      ids.push(id);
    }
    const grew = room.layer.bytes - before;
    room.bytes += grew;
    totalBytes += grew;
    const msg = JSON.stringify({ t: 'flattened', ids, tiles } satisfies ServerMessage);
    for (const c of room.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
    schedulePreview(room.id, roomDrawings(room));
    trimMemory(room);
  } catch (e) {
    console.warn(`[layer] ${room.id}: ${(e as Error).message}`);
  } finally {
    room.flattening = false;
  }
}
setInterval(() => { for (const room of rooms.values()) void flatten(room); }, Math.min(30_000, Math.max(2_000, FLATTEN_AFTER_MS / 4)));

// HTTP: previews with drawings (the site proxies /api/ here)
//   GET /api/previews                 -> { [placeId]: version } for places whose preview has drawings
//   GET /api/previews/<id>/card|loading -> the JPEG
//   GET /api/layer/<room>/<x_y>         -> a paint-layer tile (WebP)
//   GET /api/share/<id>.jpg?at=u,v,zoom -> a shared link's picture (with &v=: the newest drawings get checked first)
//   GET /<place>?at=u,v,zoom            -> the site's page, telling chat apps about that picture
const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const cors = { 'access-control-allow-origin': '*' };
  // moderation tools, only from the server itself (anything through the site has X-Forwarded-For)
  if (url.pathname.startsWith('/internal/')) {
    if (req.headers['x-forwarded-for'] || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) { res.writeHead(404).end(); return; }
    if (req.method === 'GET' && url.pathname === '/internal/held') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([...held.values()].map(h => ({ id: h.id, place: h.room, at: new Date(h.at).toISOString(), removed: h.removed, ...h.verdict })), null, 2));
      return;
    }
    const pic = url.pathname.match(/^\/internal\/held\/([\w-]{1,64})\.jpg$/);
    if (req.method === 'GET' && pic) {
      const h = held.get(pic[1]);
      if (h) res.writeHead(200, { 'content-type': 'image/jpeg' }).end(Buffer.from(h.picture, 'base64'));
      else res.writeHead(404).end();
      return;
    }
    const r = url.pathname.match(/^\/internal\/restore\/([\w-]{1,64})$/);
    if (req.method === 'POST' && r) { const ok = restore(r[1]); res.writeHead(ok ? 200 : 404).end(ok ? 'restored\n' : 'not found\n'); return; }
    res.writeHead(404).end();
    return;
  }
  if (req.method !== 'GET') { res.writeHead(405, cors).end(); return; }
  if (url.pathname === '/api/previews') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(previewManifest()));
    return;
  }
  // a room's paint-layer tile (versioned URL, cached for good)
  const lt = url.pathname.match(/^\/api\/layer\/([\w.-]{1,128})\/(\d{1,2}_\d{1,2})$/);
  if (lt) {
    const tile = rooms.get(lt[1])?.layer.tiles.get(lt[2]);
    if (!tile) { res.writeHead(404, cors).end(); return; }
    res.writeHead(200, { ...cors, 'content-type': 'image/webp', 'cache-control': 'public, max-age=31536000, immutable' });
    res.end(tile.buf);
    return;
  }
  const shared = url.pathname.match(/^\/api\/share\/([\w.-]{1,128})\.jpg$/);
  if (shared && isPlace(shared[1])) {
    const id = shared[1], room = rooms.get(id);
    const fresh = room && url.searchParams.has('v') ? checkNow(room) : Promise.resolve();
    void fresh.then(() => sharePicture(id, parseAt(url.searchParams.get('at')), drawingsChanged(id), room ? roomDrawings(room) : () => null)).then(jpeg => {
      if (jpeg) res.writeHead(200, { ...cors, 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=60' }).end(jpeg);
      else res.writeHead(302, { location: `/panorama-pool/${id}-card.jpg`, 'cache-control': 'no-store' }).end(); // too busy: the plain photo
    });
    return;
  }
  if (/^\/[\w-]{1,80}$/.test(url.pathname)) {
    const id = url.pathname === '/view' ? url.searchParams.get('imageId') ?? '' : placeNamed(url.pathname.slice(1)), origin = `https://${req.headers.host}`;
    void placePage(id, parseAt(url.searchParams.get('at')), drawingsChanged(id), ALLOWED_ORIGINS.has(origin) ? origin : [...ALLOWED_ORIGINS][0]).then(html => {
      if (html) res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }).end(html);
      else res.writeHead(503).end(); // the web server sends the plain page instead
    });
    return;
  }
  const m = url.pathname.match(/^\/api\/previews\/([\w.-]{1,128})\/(card|loading)$/);
  const p = m && getPreview(m[1]);
  if (!p) { res.writeHead(404, cors).end(); return; }
  // versioned URLs (?v=) never change, so they can be cached for good
  res.writeHead(200, { ...cors, 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' });
  res.end(m![2] === 'card' ? p.card : p.loading);
});
http.listen(PORT, HOST);

const wss = new WebSocketServer({
  server: http,
  path: '/ws',
  maxPayload: LIMITS.maxMessageBytes,
  perMessageDeflate: false,
  verifyClient: ({ origin }: { origin?: string }) => !origin || ALLOWED_ORIGINS.has(origin),
});

let next = 0;
wss.on('connection', ws => {
  const c: Client = {
    ws, room: null, alive: true, tokens: LIMITS.messagesPerSecond, lastRefill: Date.now(), strokeTimes: [],
    peer: { id: randomUUID().slice(0, 8), color: PEER_COLORS[next++ % PEER_COLORS.length] },
  };
  clients.add(c);
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (data, isBinary) => { if (!isBinary) handle(c, data.toString()); });
  ws.on('close', () => { leave(c); clients.delete(c); });
  ws.on('error', () => { leave(c); clients.delete(c); });
});

// drop dead connections (laptop lid closed, network gone) so their cursors disappear
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    c.ws.ping();
  }
}, 30_000);

http.on('listening', () => console.log(`[realtime] listening on http://${HOST}:${PORT} (ws /ws, previews /api/previews)`));
const stop = () => { wss.close(); http.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
