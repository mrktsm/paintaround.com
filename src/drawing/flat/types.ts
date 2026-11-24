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
