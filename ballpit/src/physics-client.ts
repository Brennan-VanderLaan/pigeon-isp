import * as THREE from 'three';
import {
  FLOATS_PER_BALL, META_INTS,
  type ToWorker, type FromWorker, type ColliderSpec, type ConveyorCell,
} from './proto';

// Main-thread proxy to the physics worker. Owns the shared buffers, mirrors the
// build/host API as part messages, and renders all balls from the transform
// buffer into one InstancedMesh. Lifecycle (deliver/drop) comes back via
// onEvents for the caller to relay to the loft.
export interface PhysicsEvents {
  onSpawned(items: { frameId: number; slot: number; color: number }[]): void;
  onGone(delivered: [number, number][], dropped: number[]): void;
}

export class PhysicsClient {
  readonly mesh: THREE.InstancedMesh;
  readonly maxBalls: number;
  private worker: Worker;
  private transforms: Float32Array;
  private meta: Int32Array;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private activeSlots = new Set<number>();
  private frameSlot = new Map<number, number>(); // frameId -> slot
  ready = false;

  constructor(scene: THREE.Scene, events: PhysicsEvents, opts: { maxBalls?: number; cell: number; floorH: number; radius?: number }) {
    this.maxBalls = opts.maxBalls ?? 120_000;
    if (typeof SharedArrayBuffer === 'undefined' || !self.crossOriginIsolated) {
      console.warn('[ballpit] SharedArrayBuffer unavailable (no cross-origin isolation) — physics worker needs COOP/COEP headers.');
    }
    const tBuf = new SharedArrayBuffer(this.maxBalls * FLOATS_PER_BALL * 4);
    const mBuf = new SharedArrayBuffer(META_INTS * 4);
    this.transforms = new Float32Array(tBuf);
    this.meta = new Int32Array(mBuf);

    const geo = new THREE.SphereGeometry(opts.radius ?? 0.35, 12, 8);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.05 });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.maxBalls);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.count = this.maxBalls;
    for (let i = 0; i < this.maxBalls; i++) this.mesh.setMatrixAt(i, this.hidden);
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);

    this.worker = new Worker(new URL('./physics-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.t === 'ready') { this.ready = true; return; }
      if (m.t === 'spawned') {
        for (const it of m.items) {
          this.activeSlots.add(it.slot);
          this.frameSlot.set(it.frameId, it.slot);
          this.color.setHex(it.color);
          this.mesh.setColorAt(it.slot, this.color);
        }
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
        events.onSpawned(m.items);
      } else if (m.t === 'gone') {
        for (const [f] of m.delivered) this.freeFrame(f);
        for (const f of m.dropped) this.freeFrame(f);
        events.onGone(m.delivered, m.dropped);
      }
    };
    this.post({ t: 'init', transforms: tBuf, meta: mBuf, maxBalls: this.maxBalls, cell: opts.cell, floorH: opts.floorH });
  }

  private post(m: ToWorker): void { this.worker.postMessage(m); }

  addPart(id: string, colliders: ColliderSpec[], sinkPort?: number): void { this.post({ t: 'part', id, colliders, sinkPort }); }
  removePart(id: string): void { this.post({ t: 'unpart', id }); }
  setConveyors(cells: ConveyorCell[]): void { this.post({ t: 'conveyors', cells }); }
  spawn(frameId: number, p: THREE.Vector3, v: THREE.Vector3, radius: number, color: number): void {
    this.post({ t: 'spawn', frameId, x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z, radius, color });
  }

  private freeFrame(frameId: number): void {
    const slot = this.frameSlot.get(frameId);
    if (slot === undefined) return;
    this.frameSlot.delete(frameId);
    this.activeSlots.delete(slot);
    this.mesh.setMatrixAt(slot, this.hidden);
  }

  /** Pull the latest transforms into the InstancedMesh (one pass over active
   *  slots — not the whole capacity). */
  render(): void {
    const t = this.transforms;
    for (const s of this.activeSlots) {
      const o = s * FLOATS_PER_BALL;
      if (t[o + 7] === 0) { this.mesh.setMatrixAt(s, this.hidden); continue; }
      this.dummy.position.set(t[o], t[o + 1], t[o + 2]);
      this.dummy.quaternion.set(t[o + 3], t[o + 4], t[o + 5], t[o + 6]);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(s, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  stats(): { active: number; awake: number; stepMs: number } {
    return {
      active: Atomics.load(this.meta, 0),
      awake: Atomics.load(this.meta, 1),
      stepMs: Atomics.load(this.meta, 3) / 1000,
    };
  }
}
