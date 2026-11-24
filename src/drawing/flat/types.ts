/** Shared by the flat brushes: the ones used where a place has no 3D data. */

export type Projector = (basic: [number, number]) => Promise<[number, number] | null>;

export type Unprojector = (
  screen: [number, number],
) => Promise<[number, number] | null>;

export interface SplashParticle {
  basicX: number;
  basicY: number;
  radius: number;
  life: number;
  color: string;
  strokeId?: string;
}

/** A brush that draws on screen; it follows the pointer by being drawn at it every frame. */
export interface FlatTool {
  setSeed(seed: number): void;
  initialize(): Promise<void>;
  startStroke(id: string): void | Promise<void>;
  updateColor(color: string): void;
  render(ctx: CanvasRenderingContext2D, x: number, y: number, fov: number): Promise<void>;
  getBounds(): { minX: number; minY: number; maxX: number; maxY: number };
  dispose(): void;
}
