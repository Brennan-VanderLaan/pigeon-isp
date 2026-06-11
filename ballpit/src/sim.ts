import RAPIER from '@dimforge/rapier3d-compat';
import type { ColliderSpec, ConveyorCell } from './proto';

// The physics simulation core — no worker, no DOM, no SharedArrayBuffer. The
// Web Worker wraps it for the game; tests drive it directly in Node (that's how
// we validate collisions/sinks/conveyors without a browser). Time is passed in
// to step(), so tests are deterministic.
export const TTL_MS = 25_000;
export const OOB_Y = -8;
const CONVEY_GRIP = 0.2;
// Aggressive sleeping: a ball that stays this slow for SLEEP_FRAMES gets parked.
// Rapier re-wakes it the instant another body touches it, so a settled pit costs
// almost nothing while a disturbed one springs back to life. This is what makes
// a huge concurrent pit affordable.
const SLEEP_V2 = 0.14 * 0.14; // linear speed² threshold
const SLEEP_A2 = 0.5 * 0.5;   // angular speed² threshold
const SLEEP_FRAMES = 24;      // ~0.4s below threshold → sleep

export interface SimOpts { cell: number; floorH: number; maxBalls: number }

interface Ball { body: RAPIER.RigidBody; collider: RAPIER.Collider; slot: number; spawnMs: number; slow: number }

export class Sim {
  readonly world: RAPIER.World;
  private events: RAPIER.EventQueue;
  private cell: number;
  private floorH: number;

  readonly balls = new Map<number, Ball>();          // frameId -> ball
  private ballByCollider = new Map<number, number>();  // colliderHandle -> frameId
  private sinkByCollider = new Map<number, number>();  // colliderHandle -> port
  private parts = new Map<string, RAPIER.RigidBody[]>();
  private partSinks = new Map<string, number>();
  private conveyors = new Map<string, ConveyorCell>();
  private free: number[];

  /** Rapier's wasm must be initialised once before any Sim is built. */
  static async create(opts: SimOpts): Promise<Sim> {
    await RAPIER.init();
    return new Sim(opts);
  }

  constructor(opts: SimOpts) {
    this.world = new RAPIER.World({ x: 0, y: -19, z: 0 });
    this.events = new RAPIER.EventQueue(true);
    // A churning ball pit doesn't need a stiff solver — fewer iterations is a
    // big throughput win for a small accuracy cost.
    this.world.integrationParameters.numSolverIterations = 2;
    this.cell = opts.cell;
    this.floorH = opts.floorH;
    this.free = Array.from({ length: opts.maxBalls }, (_, i) => opts.maxBalls - 1 - i);
  }

  // ---- parts ----------------------------------------------------------------

  addPart(id: string, specs: ColliderSpec[], sinkPort?: number): void {
    this.removePart(id);
    const bodies: RAPIER.RigidBody[] = [];
    for (const spec of specs) {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(spec.x, spec.y, spec.z));
      const desc = RAPIER.ColliderDesc.cuboid(spec.hx, spec.hy, spec.hz).setFriction(0.6).setRestitution(0.12);
      if (spec.rot) desc.setRotation({ x: spec.rot[0], y: spec.rot[1], z: spec.rot[2], w: spec.rot[3] });
      if (spec.sensor) desc.setSensor(true).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const col = this.world.createCollider(desc, body);
      bodies.push(body);
      if (sinkPort !== undefined && spec.sensor) {
        this.sinkByCollider.set(col.handle, sinkPort);
        this.partSinks.set(id, col.handle);
      }
    }
    this.parts.set(id, bodies);
  }

  removePart(id: string): void {
    for (const b of this.parts.get(id) ?? []) this.world.removeRigidBody(b);
    this.parts.delete(id);
    const h = this.partSinks.get(id);
    if (h !== undefined) { this.sinkByCollider.delete(h); this.partSinks.delete(id); }
  }

  setConveyors(cells: ConveyorCell[]): void {
    this.conveyors.clear();
    for (const c of cells) this.conveyors.set(`${c.cx},${c.cz},${c.level}`, c);
  }

  // ---- balls ----------------------------------------------------------------

  /** Returns the assigned instance slot, or -1 if at capacity. */
  spawn(frameId: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, radius: number, nowMs: number): number {
    const slot = this.free.pop();
    if (slot === undefined) return -1;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setLinvel(vx, vy, vz).setLinearDamping(0.05),
    );
    // NO COLLISION_EVENTS on balls: we only care about ball↔sink, and the sink
    // sensor carries the flag. Setting it on every ball made Rapier emit (and us
    // drain) an event for every ball-ball / ball-floor contact — the dominant
    // cost in a dense pit. Sink intersections still fire via the sensor's flag.
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.ball(radius).setRestitution(0.35).setFriction(0.5).setDensity(1.2),
      body,
    );
    this.balls.set(frameId, { body, collider, slot, spawnMs: nowMs, slow: 0 });
    this.ballByCollider.set(collider.handle, frameId);
    return slot;
  }

  private despawn(frameId: number): void {
    const b = this.balls.get(frameId);
    if (!b) return;
    this.ballByCollider.delete(b.collider.handle);
    this.free.push(b.slot);
    this.world.removeRigidBody(b.body);
    this.balls.delete(frameId);
  }

  private applyConveyors(): void {
    if (!this.conveyors.size) return;
    for (const b of this.balls.values()) {
      if (b.body.isSleeping()) continue;
      const t = b.body.translation();
      const level = Math.round(t.y / this.floorH);
      if (Math.abs(t.y - level * this.floorH) > 1.2) continue;
      const c = this.conveyors.get(`${Math.round(t.x / this.cell)},${Math.round(t.z / this.cell)},${level}`);
      if (!c) continue;
      const lv = b.body.linvel();
      const m = b.body.mass() || 1;
      b.body.applyImpulse({ x: (c.dx * c.speed - lv.x) * m * CONVEY_GRIP, y: 0, z: (c.dz * c.speed - lv.z) * m * CONVEY_GRIP }, true);
    }
  }

  /** Advance one tick. Returns deliveries (ball reached a sink) and losses
   *  (TTL / fell out of the world); both are despawned. */
  step(nowMs: number): { delivered: [number, number][]; dropped: number[] } {
    this.applyConveyors();
    this.world.step(this.events);

    const delivered: [number, number][] = [];
    this.events.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const f1 = this.ballByCollider.get(h1), f2 = this.ballByCollider.get(h2);
      const p1 = this.sinkByCollider.get(h1), p2 = this.sinkByCollider.get(h2);
      if (f1 !== undefined && p2 !== undefined) delivered.push([f1, p2]);
      else if (f2 !== undefined && p1 !== undefined) delivered.push([f2, p1]);
    });

    const dropped: number[] = [];
    for (const [frameId, b] of this.balls) {
      const body = b.body;
      if (!body.isSleeping()) {
        const lv = body.linvel(), av = body.angvel();
        if (lv.x * lv.x + lv.y * lv.y + lv.z * lv.z < SLEEP_V2 && av.x * av.x + av.y * av.y + av.z * av.z < SLEEP_A2) {
          if (++b.slow >= SLEEP_FRAMES) body.sleep();
        } else { b.slow = 0; }
      }
      const t = body.translation();
      if (t.y < OOB_Y || nowMs - b.spawnMs > TTL_MS) dropped.push(frameId);
    }
    for (const [frameId] of delivered) this.despawn(frameId);
    for (const frameId of dropped) this.despawn(frameId);
    return { delivered, dropped };
  }

  ballPos(frameId: number): { x: number; y: number; z: number } | null {
    const b = this.balls.get(frameId);
    return b ? b.body.translation() : null;
  }
  awakeCount(): number {
    let n = 0;
    for (const b of this.balls.values()) if (!b.body.isSleeping()) n++;
    return n;
  }
  forEach(cb: (frameId: number, slot: number, b: RAPIER.RigidBody) => void): void {
    for (const [frameId, b] of this.balls) cb(frameId, b.slot, b.body);
  }
}
