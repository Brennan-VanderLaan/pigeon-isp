import * as THREE from 'three';
import { Physics, type BallHandle } from './physics';

const RADIUS = 0.35;
const TTL_MS = 25_000;     // under the loft's 30s, so we free buffers in time
const OUT_OF_BOUNDS_Y = -8;

interface BallRec {
  frameId: number;
  port: number;     // ingress port (where it came from)
  handle: BallHandle;
  index: number;    // instance slot
  spawnMs: number;
}

// All balls render as one InstancedMesh (a single draw call), so the count can
// grow huge; the physics step is the real budget. Free instance slots are
// parked at zero scale and recycled.
export class Balls {
  readonly mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private active = new Map<number, BallRec>(); // frameId -> record
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(scene: THREE.Scene, private physics: Physics, readonly max = 30_000) {
    const geo = new THREE.SphereGeometry(RADIUS, 12, 8);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.05 });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.count = max;
    for (let i = max - 1; i >= 0; i--) {
      this.free.push(i);
      this.mesh.setMatrixAt(i, this.hidden);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);
  }

  get count(): number {
    return this.active.size;
  }

  /** Spawn a ball for a token at `nozzle`. Returns false if we're full (caller
   *  should drop the frame so the loft buffer doesn't leak). */
  spawn(frameId: number, port: number, nozzle: THREE.Vector3, colorHex: number, nowMs: number): boolean {
    const index = this.free.pop();
    if (index === undefined) return false;
    // nudge inward + a little spin of randomness so a stream fans out
    const jx = (((frameId * 2654435761) >>> 0) % 1000) / 1000 - 0.5;
    const jz = (((frameId * 40503) >>> 0) % 1000) / 1000 - 0.5;
    const inward = nozzle.clone().multiplyScalar(-0.06);
    const handle = this.physics.addBall(RADIUS, nozzle.x + jx, nozzle.y, nozzle.z + jz, inward.x, -2, inward.z);
    this.physics.ballByCollider.set(handle.collider.handle, frameId);
    this.color.setHex(colorHex);
    this.mesh.setColorAt(index, this.color);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.active.set(frameId, { frameId, port, handle, index, spawnMs: nowMs });
    return true;
  }

  has(frameId: number): boolean {
    return this.active.has(frameId);
  }

  private despawn(rec: BallRec): void {
    this.physics.removeBall(rec.handle);
    this.mesh.setMatrixAt(rec.index, this.hidden);
    this.free.push(rec.index);
    this.active.delete(rec.frameId);
  }

  /** A ball reached a bin: hand it off and remove it. Returns the ingress port
   *  (caller delivers frame → bin's port). No-op if already gone. */
  catch(frameId: number): boolean {
    const rec = this.active.get(frameId);
    if (!rec) return false;
    this.despawn(rec);
    return true;
  }

  /** Sync instance transforms from physics; return frames that aged out or fell
   *  off the world (caller drops them to free the loft buffer). */
  sync(nowMs: number): number[] {
    const expired: number[] = [];
    for (const rec of this.active.values()) {
      const t = rec.handle.body.translation();
      if (t.y < OUT_OF_BOUNDS_Y || nowMs - rec.spawnMs > TTL_MS) {
        expired.push(rec.frameId);
        continue;
      }
      const r = rec.handle.body.rotation();
      this.dummy.position.set(t.x, t.y, t.z);
      this.dummy.quaternion.set(r.x, r.y, r.z, r.w);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(rec.index, this.dummy.matrix);
    }
    for (const id of expired) {
      const rec = this.active.get(id);
      if (rec) this.despawn(rec);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    return expired;
  }
}
