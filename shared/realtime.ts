/**
 * Live drawing protocol, shared by the browser (client/src/realtime) and the server (server/realtime.ts).
 * JSON over one WebSocket at /ws. One room per panorama; positions are panorama "basic" coords
 * (u, v in [0, 1]) so every viewer projects them to their own camera.
 * Nothing touches disk: a room's drawings live in server memory while the server runs. Fresh
 * strokes stay separate for a few minutes (undo, erase); then the server flattens them into the
 * room's paint layer (PAINT_LAYER tiles), which clients load as cached images.
 */

export type ToolType = 'pencil' | 'marker' | 'crayon' | 'fountainPen' | 'watercolor';

/** A finished stroke exactly as its author sees it: the baked, lit bitmap + where it sits. */
export interface FinishedStroke {
  id: string;
  /** data:image/webp (or png) URL of the baked stroke bitmap */
  image: string;
  gridBasic: [number, number][][];
  gridRows: number;
  gridCols: number;
  srcWidth: number;
  srcHeight: number;
  referenceFov: number;
  isRainbow: boolean;
  toolType?: ToolType;
  /** pieces of one stroke that crossed surfaces share a group (undone together) */
  strokeGroup?: number;
}

/**
 * Each person's cursor colour: one per person for the whole session (like Figma/Miro),
 * never changed by the paint colour or tool they pick.
 */
/**
 * The flattened paint layer: one panorama-sized image (same scale strokes are baked at), split
 * into tiles; only tiles with paint exist. Tile "x_y" covers pixels [x*tile, (x+1)*tile) etc.
 */
export const PAINT_LAYER = { width: 4096, height: 2048, tile: 512 } as const;
/** tile key -> version (fetch GET /api/layer/<room>/<key>?v=<version>) */
export type LayerTiles = Record<string, number>;

export const PEER_COLORS = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#00C7BE', '#007AFF', '#5856D6', '#AF52DE', '#FF2D55', '#A2845E'] as const;

export interface Peer {
  id: string;
  /** this person's cursor colour (unique within the room while possible) */
  color: string;
}

export interface CursorState {
  u: number;
  v: number;
  /** brush radius as an angle (radians), so it reads the same at any zoom */
  radius: number;
  /** paint colour shown in the cursor; null = outline only */
  paint: string | null;
}

export type ClientMessage =
  /** color: preferred cursor colour (stable per device); the server keeps it unless taken */
  | { t: 'join'; room: string; color?: string }
  | ({ t: 'cursor' } & CursorState)
  | { t: 'cursor_hide' }
  /** group: pieces of one stroke that cross surfaces share it, so the live line continues */
  /** seed + wpp (world units per decal px) are set for strokes painted on a 3D surface: with them
   *  everyone else replays the stroke with the same brush and gets exactly the drawer's pixels */
  | { t: 'stroke_start'; color: string; lineWidth: number; toolType: ToolType; u: number; v: number; fov: number; group?: number; seed?: number; wpp?: number }
  /** pts: the brush's own samples since the last message, flat [u, v, decalX, decalY, ...] */
  | { t: 'stroke_point'; u: number; v: number; pts?: number[] }
  | { t: 'stroke_end' }
  | { t: 'stroke_done'; stroke: FinishedStroke }
  | { t: 'erase'; ids: string[] };

/** Messages from one peer, relayed to the rest of the room with the sender's id. */
export type RelayedMessage = Exclude<ClientMessage, { t: 'join' }> & { from: string };

export type ServerMessage =
  | { t: 'welcome'; you: string; room: string; peers: Peer[]; strokes: FinishedStroke[]; layer?: LayerTiles }
  /** these strokes are now part of the paint layer: these tiles changed (new versions) */
  | { t: 'flattened'; ids: string[]; tiles: LayerTiles }
  | { t: 'peer_join'; peer: Peer }
  | { t: 'peer_leave'; id: string }
  | { t: 'error'; reason: string }
  | RelayedMessage;

export const LIMITS = {
  /** largest single message (a finished stroke bitmap is the big one) */
  maxMessageBytes: 4 * 1024 * 1024,
  maxPeersPerRoom: 50,
  /** finished strokes kept per room for people who join later */
  maxStrokesPerRoom: 400,
  maxRoomStrokeBytes: 64 * 1024 * 1024,
  /** per connection: messages per second (cursor ~20/s + stroke points ~20/s fit easily) */
  messagesPerSecond: 80,
  finishedStrokesPerMinute: 120,
} as const;
