import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

// Thin wrapper over Rapier. Kept deliberately behind this interface so the
// whole simulation can later move into a Web Worker (the perf path for tens of
// thousands of balls) without touching gameplay code: main would post spawns
// and receive transform buffers instead of calling these methods directly.
export interface BallHandle {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

export class Physics {
  world!: RAPIER.World;
  private gravityY = -19;
  // collider handle -> what it is, for sensor/event resolution
  readonly binByCollider = new Map<number, number>(); // colliderHandle -> portId
  readonly ballByCollider = new Map<number, number>(); // colliderHandle -> frameId
  private events!: RAPIER.EventQueue;

  static async create(): Promise<Physics> {
    await RAPIER.init();
    const p = new Physics();
    p.world = new RAPIER.World({ x: 0, y: p.gravityY, z: 0 });
    p.events = new RAPIER.EventQueue(true);
    return p;
  }

  /** Tilt the world by leaning gravity sideways — the table-tilt control. */
  setTilt(tiltX: number, tiltZ: number): void {
    this.world.gravity = { x: tiltX, y: this.gravityY, z: tiltZ };
  }

  addFixedCuboid(hx: number, hy: number, hz: number, x: number, y: number, z: number, sensor = false): RAPIER.Collider {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.7).setRestitution(0.15);
    if (sensor) desc.setSensor(true).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    return this.world.createCollider(desc, body);
  }

  /** A fixed slab tilted `tilt` radians about its local X then yawed by dir —
   *  matches the chute mesh's Ry*Rx composition, so collider and visual agree. */
  addInclinedSlab(hx: number, hy: number, hz: number, x: number, y: number, z: number, dir: number, tilt: number): RAPIER.Collider {
    const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt);
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dir * Math.PI / 2);
    const q = new THREE.Quaternion().multiplyQuaternions(qy, qx);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setFriction(0.45)
      .setRestitution(0.1);
    return this.world.createCollider(desc, body);
  }

  addBall(radius: number, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): BallHandle {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setLinvel(vx, vy, vz).setLinearDamping(0.05),
    );
    const desc = RAPIER.ColliderDesc.ball(radius)
      .setRestitution(0.35)
      .setFriction(0.5)
      .setDensity(1.2)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = this.world.createCollider(desc, body);
    return { body, collider };
  }

  removeBall(h: BallHandle): void {
    this.ballByCollider.delete(h.collider.handle);
    this.world.removeRigidBody(h.body); // also removes its colliders
  }

  /** Step the sim and return started ball↔bin intersections as [frameId, portId]. */
  step(): Array<[number, number]> {
    this.world.step(this.events);
    const hits: Array<[number, number]> = [];
    this.events.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const a = this.resolve(h1), b = this.resolve(h2);
      if (a && b) {
        if (a.kind === 'ball' && b.kind === 'bin') hits.push([a.id, b.id]);
        else if (a.kind === 'bin' && b.kind === 'ball') hits.push([b.id, a.id]);
      }
    });
    return hits;
  }

  bodyCount(): number { return this.world.bodies.len(); }
  colliderCount(): number { return this.world.colliders.len(); }

  private resolve(handle: number): { kind: 'ball' | 'bin'; id: number } | null {
    const f = this.ballByCollider.get(handle);
    if (f !== undefined) return { kind: 'ball', id: f };
    const p = this.binByCollider.get(handle);
    if (p !== undefined) return { kind: 'bin', id: p };
    return null;
  }
}
