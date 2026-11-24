import { PEER_COLORS, type ClientMessage, type ServerMessage } from '../../shared/realtime';
import { deviceId } from '../deviceId';

/** This device's cursor colour: the same every visit (hash of the device id). */
const MY_COLOR = (() => {
  let h = 0;
  for (const ch of deviceId) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return PEER_COLORS[Math.abs(h) % PEER_COLORS.length];
})();

type Listener = (msg: ServerMessage) => void;

/**
 * One WebSocket per tab to the live drawing server (same origin, /ws). Reconnects with backoff
 * and re-joins the current room, so a dropped connection heals on its own. Messages sent while
 * disconnected are dropped (cursors/stroke points are only meaningful live), except the room join.
 */
class RealtimeClient {
  private ws: WebSocket | null = null;
  private room: string | null = null;
  private listeners = new Set<Listener>();
  private retry = 0;
  private joins = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Our id in the current room (from the server's welcome). */
  me: string | null = null;

  private url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  private connect(): void {
    if (this.ws || typeof WebSocket === 'undefined') return;
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      if (this.room) ws.send(JSON.stringify({ t: 'join', room: this.room, color: MY_COLOR } satisfies ClientMessage));
    };
    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.t === 'welcome') this.me = msg.you;
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      this.me = null;
      if (!this.room) return;
      const delay = Math.min(15000, 500 * 2 ** this.retry++) * (0.75 + Math.random() * 0.5);
      this.timer = setTimeout(() => { this.timer = null; this.connect(); }, delay);
    };
  }

  /** Enter a panorama's room (leaves the previous one). */
  join(room: string): void {
    this.joins++;
    this.room = room;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'join', room, color: MY_COLOR } satisfies ClientMessage));
    else this.connect();
  }

  /** Leave entirely (closes the socket; no reconnect). */
  leave(): void {
    this.room = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.ws?.close();
    this.ws = null;
  }

  /** Leave once this is done (the last strokes are still being encoded), unless another room is joined first. */
  leaveAfter(done: Promise<unknown>): void {
    const joins = this.joins;
    void done.finally(() => { if (this.joins === joins) this.leave(); });
  }

  /** The room we're in. */
  get current(): string | null { return this.room; }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.room) this.ws.send(JSON.stringify(msg));
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const realtime = new RealtimeClient();
