/**
 * Live drawing relay. One room per panorama; relays cursors and strokes to everyone else in the
 * room and keeps the room's finished strokes in memory (nothing touches disk) so people who come
 * later see what's been drawn. Drawings stay as long as the server runs (a restart clears them),
 * within a total memory budget. Also serves previews with the drawings on them (server/previews).
 *
 * Run:  node server/realtime.ts           (Node 23.6+, types stripped natively)
 * Env:  PORT (8787), HOST (127.0.0.1), ALLOWED_ORIGINS (comma list; default: the site + localhost),
 *       PANO_DIR (panorama images for previews; default ../public/panorama-pool/)
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { getPreview, previewManifest, schedulePreview } from './previews.ts';
import { WebSocketServer, type WebSocket } from 'ws';
import { LIMITS, PEER_COLORS, type ClientMessage, type FinishedStroke, type Peer, type ServerMessage } from '../shared/realtime.ts';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ??
    'https://paintaround.com,https://www.paintaround.com,https://draw.markotsymbaluk.com,https://washere.live,https://www.washere.live,http://server.example,http://localhost:5173,http://127.0.0.1:5173')
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

interface Room {
  id: string;
  clients: Set<Client>;
  strokes: Map<string, { stroke: FinishedStroke; bytes: number }>;
  bytes: number;
  /** last time someone drew or erased here (oldest rooms give way when memory runs short) */
  touched: number;
}

/** All rooms' strokes together stay under this (oldest strokes of the least recent rooms go). */
const TOTAL_STROKE_BYTES = Number(process.env.TOTAL_STROKE_BYTES ?? 2 * 1024 ** 3);
let totalBytes = 0;
const roomStrokes = (room: Room) => () => [...room.strokes.values()].map(s => s.stroke);
function trimMemory(keep: Room) {
  while (totalBytes > TOTAL_STROKE_BYTES) {
    let oldest: Room | null = null;
    for (const r of rooms.values()) if (r !== keep && r.strokes.size && (!oldest || r.touched < oldest.touched)) oldest = r;
    const victim = oldest ?? keep;
    const first = victim.strokes.keys().next();
    if (first.done) return;
    const s = victim.strokes.get(first.value)!;
    victim.strokes.delete(first.value);
    victim.bytes -= s.bytes;
    totalBytes -= s.bytes;
    schedulePreview(victim.id, roomStrokes(victim));
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
  if (room.clients.size === 0 && room.strokes.size === 0) rooms.delete(room.id);
  else if (room.clients.size) broadcast(room, c, { t: 'peer_leave', id: c.peer.id });
}

function join(c: Client, roomId: string, preferred?: string) {
  if (c.room?.id === roomId) return;
  leave(c);
  let room = rooms.get(roomId);
  if (room && room.clients.size >= LIMITS.maxPeersPerRoom) return send(c, { t: 'error', reason: 'room_full' });
  if (!room) rooms.set(roomId, (room = { id: roomId, clients: new Set(), strokes: new Map(), bytes: 0, touched: Date.now() }));
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
      room.strokes.set(stroke.id, { stroke, bytes });
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
      schedulePreview(room.id, roomStrokes(room));
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
        schedulePreview(room.id, roomStrokes(room));
      }
      return;
    }
  }
}

// HTTP: previews with drawings (the site proxies /api/ here)
//   GET /api/previews                 -> { [placeId]: version } for places whose preview has drawings
//   GET /api/previews/<id>/card|loading -> the JPEG
const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const cors = { 'access-control-allow-origin': '*' };
  if (req.method !== 'GET') { res.writeHead(405, cors).end(); return; }
  if (url.pathname === '/api/previews') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(previewManifest()));
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
