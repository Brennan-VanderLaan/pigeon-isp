// Wire protocol between the main thread and the physics Web Worker.
//
// Physics (Rapier) runs entirely in the worker so the render thread never
// stalls. Ball transforms stream back through a SharedArrayBuffer (zero-copy,
// no per-frame serialization) — the path to huge ball counts. Lifecycle
// results (a ball reached a sink, or aged out) come back as small messages the
// main thread relays to the loft as deliver/drop.
//
// SharedArrayBuffer requires cross-origin isolation (COOP/COEP headers — set in
// vite.config.ts for dev; the in-cluster serving will need the same).

export const FLOATS_PER_BALL = 8; // x,y,z, qx,qy,qz,qw, active(1/0)
export const META_INTS = 4;       // [activeCount, awakeCount, stepSeq, stepMicros]

export interface ColliderSpec {
  hx: number; hy: number; hz: number;
  x: number; y: number; z: number;
  sensor?: boolean;
  rot?: [number, number, number, number]; // quaternion for inclined slabs
}

export interface ConveyorCell {
  cx: number; cz: number; level: number;
  dx: number; dz: number; speed: number;
}

export type ToWorker =
  | { t: 'init'; transforms: SharedArrayBuffer; meta: SharedArrayBuffer; maxBalls: number; cell: number; floorH: number }
  | { t: 'part'; id: string; colliders: ColliderSpec[]; sinkPort?: number }
  | { t: 'unpart'; id: string }
  | { t: 'conveyors'; cells: ConveyorCell[] }
  | { t: 'spawn'; frameId: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; radius: number; color: number };

export type FromWorker =
  | { t: 'ready' }
  | { t: 'spawned'; items: { frameId: number; slot: number; color: number }[] }
  | { t: 'gone'; delivered: [number, number][]; dropped: number[] };

/** What Arena/Build need from a physics backend — satisfied by both the CPU
 *  worker client (PhysicsClient) and the GPU fluid (GpuFluid). */
export interface PartsHost {
  addPart(id: string, colliders: ColliderSpec[], sinkPort?: number): void;
  removePart(id: string): void;
  setConveyors(cells: ConveyorCell[]): void;
}
