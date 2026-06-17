import * as THREE from 'three';
import { MeshStandardNodeMaterial, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, instancedArray, instanceIndex, uniform, uniformArray, vec3, float, int, If, Loop,
  positionLocal, max, mix, atomicAdd, atomicStore, atomicLoad,
} from 'three/tsl';
import type { ColliderSpec, ConveyorCell } from '../proto';
import type { PhysicsEvents } from '../physics-client';

// GpuFluid — the MLS-MPM fluid as a loft-game physics backend. Same surface as
// the CPU PhysicsClient, so Arena/Build/loft-game plug in unchanged:
//   spawn(frameId, …)     a loft token becomes fluid poured from its dock
//   addPart/removePart    build parts become oriented-box colliders (grid BC +
//                         nearest-face projection); sensor specs become SINKS
//   sink consumption      a GPU ring buffer records {slot, port}; the CPU reads
//                         it back (~10 Hz), maps slot→frameId, fires
//                         onGone(delivered) → loft deliver(port, frame)
//   TTL                   CPU tracks spawn times; expired slots are killed on
//                         the GPU and reported as drops (loft frees the buffer)
// Particles are pooled: dead slots park far below the grid and are gated out of
// every kernel by an alive flag.
const FP = 1e6;
const DX = 1.0;
const ORIGIN = -32, OY = -2;
const GX = 64, GY = 48, GZ = 64;
const CELLS = GX * GY * GZ;
const LIM = 30;
const MAX_SINK = 32, MAX_CONV = 64;
const MAX_VEH = 8;   // moving kinematic boxes (vehicle hulls/blades)
const MAX_SUCK = 4;  // vehicle suction volumes
const SUCK_PORT = -1000; // ring-buffer port encoding for vacuumed particles
const SPAWN_MAX = 512; // spawns applied per frame (queue carries overflow)
const RING = 2048;     // sink-consumption ring capacity between readbacks
const SDF_FAR = 4;     // clamp distance for the baked solid SDF
const SDF_MARGIN = 0.25; // particles ride this far off solid surfaces
const TTL_MS = 25_000;
const PARK = -200;

type CN = Parameters<WebGPURenderer['computeAsync']>[0];

interface SlotInfo { frameId: number; spawnMs: number; color: number }

export class GpuFluid {
  readonly mesh: THREE.InstancedMesh;
  readonly maxBalls: number;
  ready = true;

  private renderer: WebGPURenderer;
  private events: PhysicsEvents;

  // kernels
  private clearNode: CN; private p2g1Node: CN; private p2g2Node: CN;
  private gridNode: CN; private g2pNode: CN;
  private spawnNode: CN; private killNode: CN; private ringResetNode: CN;

  // sim params
  private dt = uniform(1 / 60);
  private gravity = uniform(-9.8);
  readonly stiffness = uniform(1000);
  private restDensity = uniform(4.0);
  readonly viscosity = uniform(0.6);

  // static colliders: EVERY part bakes into one signed-distance grid — no part
  // limit, O(1) lookups in the kernels (the "grouped collider"). Sinks and
  // conveyors stay as small uniform arrays.
  private sdfBuf: any;
  private bakeTimer: ReturnType<typeof setTimeout> | null = null;
  private sinkCenter = uniformArray(mkV3(MAX_SINK));
  private sinkHalf = uniformArray(mkV3(MAX_SINK));
  private sinkPort = uniformArray(new Array(MAX_SINK).fill(0), 'int');
  private sinkCount = uniform(0);
  private convMin = uniformArray(mkV3(MAX_CONV));
  private convMax = uniformArray(mkV3(MAX_CONV));
  private convVel = uniformArray(mkV3(MAX_CONV));
  private convCount = uniform(0);

  // vehicles: moving oriented boxes (fluid takes their velocity — they push)
  // and suction volumes (particles inside are vacuumed into a hopper)
  private vehCenter = uniformArray(mkV3(MAX_VEH));
  private vehHalf = uniformArray(mkV3(MAX_VEH));
  private vehAx = uniformArray(mkV3(MAX_VEH));
  private vehAy = uniformArray(mkV3(MAX_VEH));
  private vehAz = uniformArray(mkV3(MAX_VEH));
  private vehVel = uniformArray(mkV3(MAX_VEH));
  private vehCount = uniform(0);
  private suckCenter = uniformArray(mkV3(MAX_SUCK));
  private suckHalf = uniformArray(mkV3(MAX_SUCK));
  private suckId = uniformArray(new Array(MAX_SUCK).fill(0), 'int');
  private suckCount = uniform(0);
  /** A particle was vacuumed by vehicle `vehId` — the frame is now CARRIED, not
   *  delivered/dropped. The caller owns its fate (dump → respawn, or TTL drop). */
  onVacuum: ((vehId: number, frameId: number, color: number, spawnMs: number) => void) | null = null;

  // spawn / kill queues (CPU → GPU each frame)
  private spawnSlot = uniformArray(new Array(SPAWN_MAX).fill(0), 'int');
  private spawnPos = uniformArray(mkV3(SPAWN_MAX));
  private spawnVel = uniformArray(mkV3(SPAWN_MAX));
  private spawnCol = uniformArray(mkV3(SPAWN_MAX));
  private spawnCount = uniform(0);
  private killSlot = uniformArray(new Array(SPAWN_MAX).fill(0), 'int');
  private killCount = uniform(0);

  // GPU buffers exposed for readback
  private ringSlotBuf: any; private ringPortBuf: any; private ringCountBuf: any;

  // CPU bookkeeping
  private free: number[] = [];
  private slots = new Map<number, SlotInfo>();   // slot -> frame
  private pendingSpawn: { slot: number; pos: THREE.Vector3; vel: THREE.Vector3; color: number }[] = [];
  private parts = new Map<string, { boxes: { c: THREE.Vector3; h: THREE.Vector3; ax: THREE.Vector3; ay: THREE.Vector3; az: THREE.Vector3 }[]; sink?: { c: THREE.Vector3; h: THREE.Vector3; port: number } }>();
  private reading = false;
  private lastTtlSweep = 0;
  private lastStepMs = 0;
  private color = new THREE.Color();

  constructor(scene: THREE.Scene, renderer: WebGPURenderer, events: PhysicsEvents, opts: { maxBalls?: number } = {}) {
    this.renderer = renderer;
    this.events = events;
    this.maxBalls = opts.maxBalls ?? 100_000;
    const count = this.maxBalls;
    for (let i = count - 1; i >= 0; i--) this.free.push(i);

    const positions = instancedArray(count, 'vec3');
    const velocities = instancedArray(count, 'vec3');
    const colors = instancedArray(count, 'vec3');
    const alive = instancedArray(count, 'int');
    const C0 = instancedArray(count, 'vec3');
    const C1 = instancedArray(count, 'vec3');
    const C2 = instancedArray(count, 'vec3');
    const gMass = instancedArray(CELLS, 'int').toAtomic();
    const gVx = instancedArray(CELLS, 'int').toAtomic();
    const gVy = instancedArray(CELLS, 'int').toAtomic();
    const gVz = instancedArray(CELLS, 'int').toAtomic();
    const ringSlot = instancedArray(RING, 'int');
    const ringPort = instancedArray(RING, 'int');
    const ringCount = instancedArray(1, 'int').toAtomic();
    this.ringSlotBuf = ringSlot; this.ringPortBuf = ringPort; this.ringCountBuf = ringCount;
    const sdf = instancedArray(new Float32Array(CELLS).fill(SDF_FAR), 'float');
    this.sdfBuf = sdf;

    // trilinear SDF sampling (cell centers sit on integer world coords)
    const sdfCell = (ix: any, iy: any, iz: any) =>
      sdf.element(
        (ix as any).clamp(0, GX - 1)
          .add((iy as any).clamp(0, GY - 1).mul(GX))
          .add((iz as any).clamp(0, GZ - 1).mul(GX * GY)).toInt(),
      ) as any;
    const sampleSdf = (p: any): any => {
      const u = p.x.sub(ORIGIN), v = p.y.sub(OY), w2 = p.z.sub(ORIGIN);
      const i0 = u.floor(), j0 = v.floor(), k0 = w2.floor();
      const tx = u.sub(i0), ty = v.sub(j0), tz = w2.sub(k0);
      const c00 = mix(sdfCell(i0, j0, k0), sdfCell(i0.add(1), j0, k0), tx);
      const c10 = mix(sdfCell(i0, j0.add(1), k0), sdfCell(i0.add(1), j0.add(1), k0), tx);
      const c01 = mix(sdfCell(i0, j0, k0.add(1)), sdfCell(i0.add(1), j0, k0.add(1)), tx);
      const c11 = mix(sdfCell(i0, j0.add(1), k0.add(1)), sdfCell(i0.add(1), j0.add(1), k0.add(1)), tx);
      return mix(mix(c00, c10, ty), mix(c01, c11, ty), tz);
    };

    const enc = (f: any) => int(f.mul(FP));
    const dec = (i: any) => float(i).div(FP);
    const weights = (gp: any) => {
      const base = gp.sub(0.5).floor();
      const fx = gp.sub(base);
      const a = float(1.5).sub(fx); const w0 = a.mul(a).mul(0.5);
      const b = fx.sub(1.0); const w1 = float(0.75).sub(b.mul(b));
      const c = fx.sub(0.5); const w2 = c.mul(c).mul(0.5);
      return { base, fx, w: [w0, w1, w2] as any[] };
    };
    const nodeIndex = (n: any) => n.x.add(n.y.mul(GX)).add(n.z.mul(GX * GY)).toInt();
    const gridPos = (p: any) => vec3(p.x.sub(ORIGIN), p.y.sub(OY), p.z.sub(ORIGIN)).div(DX);

    // park everything dead
    const initNode = Fn(() => {
      positions.element(instanceIndex).assign(vec3(0, PARK, 0));
      velocities.element(instanceIndex).assign(vec3(0, 0, 0));
      alive.element(instanceIndex).assign(int(0));
      C0.element(instanceIndex).assign(vec3(0, 0, 0));
      C1.element(instanceIndex).assign(vec3(0, 0, 0));
      C2.element(instanceIndex).assign(vec3(0, 0, 0));
    })().compute(count);
    renderer.computeAsync(initNode);

    this.clearNode = Fn(() => {
      atomicStore(gMass.element(instanceIndex), int(0));
      atomicStore(gVx.element(instanceIndex), int(0));
      atomicStore(gVy.element(instanceIndex), int(0));
      atomicStore(gVz.element(instanceIndex), int(0));
    })().compute(CELLS) as CN;

    this.ringResetNode = Fn(() => {
      atomicStore(ringCount.element(0), int(0));
    })().compute(1) as CN;

    this.spawnNode = Fn(() => {
      If(float(instanceIndex).lessThan(float(this.spawnCount as any)), () => {
        const s = (this.spawnSlot as any).element(instanceIndex);
        positions.element(s).assign((this.spawnPos as any).element(instanceIndex));
        velocities.element(s).assign((this.spawnVel as any).element(instanceIndex));
        colors.element(s).assign((this.spawnCol as any).element(instanceIndex));
        alive.element(s).assign(int(1));
        C0.element(s).assign(vec3(0, 0, 0));
        C1.element(s).assign(vec3(0, 0, 0));
        C2.element(s).assign(vec3(0, 0, 0));
      });
    })().compute(SPAWN_MAX) as CN;

    this.killNode = Fn(() => {
      If(float(instanceIndex).lessThan(float(this.killCount as any)), () => {
        const s = (this.killSlot as any).element(instanceIndex);
        alive.element(s).assign(int(0));
        positions.element(s).assign(vec3(0, PARK, 0));
        velocities.element(s).assign(vec3(0, 0, 0));
      });
    })().compute(SPAWN_MAX) as CN;

    this.p2g1Node = Fn(() => {
      If((alive.element(instanceIndex) as any).equal(int(1)), () => {
        const p = positions.element(instanceIndex) as any;
        const v = velocities.element(instanceIndex) as any;
        const c0 = C0.element(instanceIndex) as any, c1 = C1.element(instanceIndex) as any, c2 = C2.element(instanceIndex) as any;
        const { base, fx, w } = weights(gridPos(p));
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
          const wt = (w[i].x as any).mul(w[j].y).mul(w[k].z);
          const dpos = vec3(float(i).sub(fx.x), float(j).sub(fx.y), float(k).sub(fx.z)).mul(DX);
          const idx = nodeIndex(base.add(vec3(i, j, k)));
          const mv = v.add(vec3(c0.dot(dpos), c1.dot(dpos), c2.dot(dpos)));
          atomicAdd(gMass.element(idx), enc(wt));
          atomicAdd(gVx.element(idx), enc(wt.mul(mv.x)));
          atomicAdd(gVy.element(idx), enc(wt.mul(mv.y)));
          atomicAdd(gVz.element(idx), enc(wt.mul(mv.z)));
        }
      });
    })().compute(count) as CN;

    this.p2g2Node = Fn(() => {
      If((alive.element(instanceIndex) as any).equal(int(1)), () => {
        const p = positions.element(instanceIndex) as any;
        const c0 = C0.element(instanceIndex) as any, c1 = C1.element(instanceIndex) as any, c2 = C2.element(instanceIndex) as any;
        const { base, fx, w } = weights(gridPos(p));
        const dens = float(0).toVar();
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
          const wt = (w[i].x as any).mul(w[j].y).mul(w[k].z);
          dens.addAssign(wt.mul(dec(atomicLoad(gMass.element(nodeIndex(base.add(vec3(i, j, k))))) as any)));
        }
        const volume = float(1).div((max as any)(dens, float(0.0001)));
        const ratio = dens.div(this.restDensity);
        const pressure = (max as any)(float(-0.2), this.stiffness.mul(ratio.mul(ratio).mul(ratio).mul(ratio).sub(1)));
        const vis = this.viscosity;
        const s0 = vec3(pressure.negate().add(c0.x.mul(2).mul(vis)), c0.y.add(c1.x).mul(vis), c0.z.add(c2.x).mul(vis));
        const s1 = vec3(c1.x.add(c0.y).mul(vis), pressure.negate().add(c1.y.mul(2).mul(vis)), c1.z.add(c2.y).mul(vis));
        const s2 = vec3(c2.x.add(c0.z).mul(vis), c2.y.add(c1.z).mul(vis), pressure.negate().add(c2.z.mul(2).mul(vis)));
        const coef = volume.mul(-4).div(DX * DX).mul(this.dt);
        const e0 = s0.mul(coef), e1 = s1.mul(coef), e2 = s2.mul(coef);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
          const wt = (w[i].x as any).mul(w[j].y).mul(w[k].z);
          const dpos = vec3(float(i).sub(fx.x), float(j).sub(fx.y), float(k).sub(fx.z)).mul(DX);
          const idx = nodeIndex(base.add(vec3(i, j, k)));
          const force = vec3(e0.dot(dpos), e1.dot(dpos), e2.dot(dpos)).mul(wt);
          atomicAdd(gVx.element(idx), enc(force.x));
          atomicAdd(gVy.element(idx), enc(force.y));
          atomicAdd(gVz.element(idx), enc(force.z));
        }
      });
    })().compute(count) as CN;

    this.gridNode = Fn(() => {
      const m = dec(atomicLoad(gMass.element(instanceIndex)) as any);
      If(m.greaterThan(0.0001), () => {
        const inv = float(1).div(m);
        const vx = dec(atomicLoad(gVx.element(instanceIndex)) as any).mul(inv).toVar();
        const vy = dec(atomicLoad(gVy.element(instanceIndex)) as any).mul(inv).add(this.gravity.mul(this.dt)).toVar();
        const vz = dec(atomicLoad(gVz.element(instanceIndex)) as any).mul(inv).toVar();
        const fi = float(instanceIndex);
        const cz = fi.div(GX * GY).floor();
        const cy = fi.sub(cz.mul(GX * GY)).div(GX).floor();
        const cx = fi.sub(cz.mul(GX * GY)).sub(cy.mul(GX));
        If(cx.lessThan(2).and(vx.lessThan(0)), () => { vx.assign(0); });
        If(cx.greaterThan(GX - 3).and(vx.greaterThan(0)), () => { vx.assign(0); });
        If(cy.lessThan(3).and(vy.lessThan(0)), () => { vy.assign(0); });
        If(cy.greaterThan(GY - 3).and(vy.greaterThan(0)), () => { vy.assign(0); });
        If(cz.lessThan(2).and(vz.lessThan(0)), () => { vz.assign(0); });
        If(cz.greaterThan(GZ - 3).and(vz.greaterThan(0)), () => { vz.assign(0); });
        const wx = float(ORIGIN).add(cx.mul(DX));
        const wy = float(OY).add(cy.mul(DX));
        const wz = float(ORIGIN).add(cz.mul(DX));
        // build-part colliders: a node inside the baked solid SDF is stuck
        If((sdf.element(instanceIndex) as any).lessThan(float(0)), () => {
          vx.assign(0); vy.assign(0); vz.assign(0);
        });
        // conveyors: blend node velocity toward the belt's surface velocity
        Loop(MAX_CONV, ({ i: j }: any) => {
          If(j.lessThan(int(this.convCount as any)), () => {
            const mn = (this.convMin as any).element(j);
            const mx = (this.convMax as any).element(j);
            const inB = wx.greaterThanEqual(mn.x).and(wx.lessThanEqual(mx.x))
              .and(wy.greaterThanEqual(mn.y)).and(wy.lessThanEqual(mx.y))
              .and(wz.greaterThanEqual(mn.z)).and(wz.lessThanEqual(mx.z));
            If(inB, () => {
              const bv = (this.convVel as any).element(j);
              vx.assign(vx.mul(0.7).add(bv.x.mul(0.3)));
              vz.assign(vz.mul(0.7).add(bv.z.mul(0.3)));
            });
          });
        });
        // vehicles: nodes inside a moving hull take ITS velocity — the hull
        // pushes fluid like a blade (and blocks it when parked)
        Loop(MAX_VEH, ({ i: j }: any) => {
          If(j.lessThan(int(this.vehCount as any)), () => {
            const c = (this.vehCenter as any).element(j);
            const h = (this.vehHalf as any).element(j);
            const rel = vec3(wx.sub(c.x), wy.sub(c.y), wz.sub(c.z));
            const l = vec3(
              (this.vehAx as any).element(j).dot(rel),
              (this.vehAy as any).element(j).dot(rel),
              (this.vehAz as any).element(j).dot(rel),
            );
            If(l.x.abs().lessThan(h.x).and(l.y.abs().lessThan(h.y)).and(l.z.abs().lessThan(h.z)), () => {
              const bv = (this.vehVel as any).element(j);
              vx.assign(bv.x); vy.assign(bv.y); vz.assign(bv.z);
            });
          });
        });
        atomicStore(gVx.element(instanceIndex), enc(vx));
        atomicStore(gVy.element(instanceIndex), enc(vy));
        atomicStore(gVz.element(instanceIndex), enc(vz));
      });
    })().compute(CELLS) as CN;

    this.g2pNode = Fn(() => {
      If((alive.element(instanceIndex) as any).equal(int(1)), () => {
        const p = positions.element(instanceIndex) as any;
        const { base, fx, w } = weights(gridPos(p));
        const nv = vec3(0, 0, 0).toVar();
        const nc0 = vec3(0, 0, 0).toVar(), nc1 = vec3(0, 0, 0).toVar(), nc2 = vec3(0, 0, 0).toVar();
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
          const wt = (w[i].x as any).mul(w[j].y).mul(w[k].z);
          const dpos = vec3(float(i).sub(fx.x), float(j).sub(fx.y), float(k).sub(fx.z)).mul(DX);
          const idx = nodeIndex(base.add(vec3(i, j, k)));
          const gv = vec3(
            dec(atomicLoad(gVx.element(idx)) as any),
            dec(atomicLoad(gVy.element(idx)) as any),
            dec(atomicLoad(gVz.element(idx)) as any),
          );
          nv.addAssign(gv.mul(wt));
          const f = float(4).div(DX * DX).mul(wt);
          nc0.addAssign(dpos.mul(gv.x).mul(f));
          nc1.addAssign(dpos.mul(gv.y).mul(f));
          nc2.addAssign(dpos.mul(gv.z).mul(f));
        }
        velocities.element(instanceIndex).assign(nv);
        C0.element(instanceIndex).assign(nc0);
        C1.element(instanceIndex).assign(nc1);
        C2.element(instanceIndex).assign(nc2);
        const adv = p.add(nv.mul(this.dt));
        const np = vec3(
          adv.x.clamp(-LIM, LIM), adv.y.clamp(0.3, OY + GY * DX - 2), adv.z.clamp(-LIM, LIM),
        ).toVar() as any;
        // build-part colliders, particle side: sample the baked SDF (trilinear)
        // and push out along its gradient — one mechanism for ALL parts.
        const sv = sampleSdf(np).toVar();
        If(sv.lessThan(float(SDF_MARGIN)), () => {
          const e = float(0.5);
          const grad = vec3(
            sampleSdf(np.add(vec3(e, 0, 0))).sub(sampleSdf(np.sub(vec3(e, 0, 0)))),
            sampleSdf(np.add(vec3(0, e, 0))).sub(sampleSdf(np.sub(vec3(0, e, 0)))),
            sampleSdf(np.add(vec3(0, 0, e))).sub(sampleSdf(np.sub(vec3(0, 0, e)))),
          );
          const gl = (max as any)(grad.length(), float(1e-4));
          np.addAssign(grad.div(gl).mul(float(SDF_MARGIN).sub(sv)));
        });
        // vehicles, particle side: project out of the moving hulls through the
        // nearest local face (same pattern as the validated box collider)
        Loop(MAX_VEH, ({ i: j }: any) => {
          If(j.lessThan(int(this.vehCount as any)), () => {
            const c = (this.vehCenter as any).element(j);
            const h = (this.vehHalf as any).element(j);
            const ax = (this.vehAx as any).element(j), ay = (this.vehAy as any).element(j), az = (this.vehAz as any).element(j);
            const rel = np.sub(c);
            const l = vec3(ax.dot(rel), ay.dot(rel), az.dot(rel)).toVar();
            const pen = vec3(h.x.sub(l.x.abs()), h.y.sub(l.y.abs()), h.z.sub(l.z.abs()));
            If(pen.x.greaterThan(0).and(pen.y.greaterThan(0)).and(pen.z.greaterThan(0)), () => {
              (If(pen.x.lessThanEqual(pen.y).and(pen.x.lessThanEqual(pen.z)), () => {
                l.x.assign(l.x.sign().mul(h.x));
              }) as any).ElseIf(pen.y.lessThanEqual(pen.z), () => {
                l.y.assign(l.y.sign().mul(h.y));
              }).Else(() => {
                l.z.assign(l.z.sign().mul(h.z));
              });
              np.assign(c.add(ax.mul(l.x)).add(ay.mul(l.y)).add(az.mul(l.z)));
            });
          });
        });
        positions.element(instanceIndex).assign(np);
        // sinks: a particle inside a sink volume is consumed → ring buffer
        Loop(MAX_SINK, ({ i: j }: any) => {
          If(j.lessThan(int(this.sinkCount as any)).and((alive.element(instanceIndex) as any).equal(int(1))), () => {
            const c = (this.sinkCenter as any).element(j);
            const h = (this.sinkHalf as any).element(j);
            const rel = np.sub(c);
            If(rel.x.abs().lessThan(h.x).and(rel.y.abs().lessThan(h.y)).and(rel.z.abs().lessThan(h.z)), () => {
              alive.element(instanceIndex).assign(int(0));
              positions.element(instanceIndex).assign(vec3(0, PARK, 0));
              const idx = atomicAdd(ringCount.element(0), int(1)) as any;
              If(idx.lessThan(int(RING)), () => {
                ringSlot.element(idx).assign(instanceIndex);
                ringPort.element(idx).assign((this.sinkPort as any).element(j));
              });
            });
          });
        });
        // suction: a particle inside a vehicle's vacuum volume is CARRIED —
        // consumed off the field, reported with a negative port encoding
        Loop(MAX_SUCK, ({ i: j }: any) => {
          If(j.lessThan(int(this.suckCount as any)).and((alive.element(instanceIndex) as any).equal(int(1))), () => {
            const c = (this.suckCenter as any).element(j);
            const h = (this.suckHalf as any).element(j);
            const rel = np.sub(c);
            If(rel.x.abs().lessThan(h.x).and(rel.y.abs().lessThan(h.y)).and(rel.z.abs().lessThan(h.z)), () => {
              alive.element(instanceIndex).assign(int(0));
              positions.element(instanceIndex).assign(vec3(0, PARK, 0));
              const idx = atomicAdd(ringCount.element(0), int(1)) as any;
              If(idx.lessThan(int(RING)), () => {
                ringSlot.element(idx).assign(instanceIndex);
                ringPort.element(idx).assign(int(SUCK_PORT).sub((this.suckId as any).element(j)));
              });
            });
          });
        });
      });
    })().compute(count) as CN;

    // render: instanced low-poly spheres positioned straight from the GPU buffer
    const geo = new THREE.IcosahedronGeometry(0.4, 0);
    const mat = new MeshStandardNodeMaterial();
    mat.positionNode = positionLocal.add(positions.element(instanceIndex));
    mat.colorNode = colors.element(instanceIndex);
    mat.roughness = 0.5;
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.frustumCulled = false;
    const id = new THREE.Matrix4();
    for (let i = 0; i < count; i++) this.mesh.setMatrixAt(i, id);
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);
  }

  // ---- PhysicsClient-compatible surface ---------------------------------------

  spawn(frameId: number, p: THREE.Vector3, v: THREE.Vector3, _radius: number, color: number, spawnMs = performance.now()): void {
    const slot = this.free.pop();
    if (slot === undefined) { this.events.onGone([], [frameId]); return; }
    this.slots.set(slot, { frameId, spawnMs, color });
    this.pendingSpawn.push({ slot, pos: p.clone(), vel: v.clone(), color });
    this.events.onSpawned([{ frameId, slot, color }]);
  }

  /** Per-frame vehicle state: hulls become moving boundaries. */
  setVehicles(boxes: { c: THREE.Vector3; h: THREE.Vector3; q: THREE.Quaternion; vel: THREE.Vector3 }[]): void {
    const n = Math.min(boxes.length, MAX_VEH);
    for (let i = 0; i < n; i++) {
      const b = boxes[i];
      ((this.vehCenter as any).array[i] as THREE.Vector3).copy(b.c);
      ((this.vehHalf as any).array[i] as THREE.Vector3).copy(b.h);
      ((this.vehAx as any).array[i] as THREE.Vector3).set(1, 0, 0).applyQuaternion(b.q);
      ((this.vehAy as any).array[i] as THREE.Vector3).set(0, 1, 0).applyQuaternion(b.q);
      ((this.vehAz as any).array[i] as THREE.Vector3).set(0, 0, 1).applyQuaternion(b.q);
      ((this.vehVel as any).array[i] as THREE.Vector3).copy(b.vel);
    }
    (this.vehCount as any).value = n;
  }

  /** Per-frame suction volumes (id keys onVacuum to the owning vehicle). */
  setSuction(zones: { c: THREE.Vector3; h: THREE.Vector3; id: number }[]): void {
    const n = Math.min(zones.length, MAX_SUCK);
    for (let i = 0; i < n; i++) {
      ((this.suckCenter as any).array[i] as THREE.Vector3).copy(zones[i].c);
      ((this.suckHalf as any).array[i] as THREE.Vector3).copy(zones[i].h);
      (this.suckId as any).array[i] = zones[i].id;
    }
    (this.suckCount as any).value = n;
  }

  addPart(id: string, colliders: ColliderSpec[], sinkPort?: number): void {
    const boxes: { c: THREE.Vector3; h: THREE.Vector3; ax: THREE.Vector3; ay: THREE.Vector3; az: THREE.Vector3 }[] = [];
    let sink: { c: THREE.Vector3; h: THREE.Vector3; port: number } | undefined;
    for (const s of colliders) {
      if (s.sensor && sinkPort !== undefined) {
        sink = { c: new THREE.Vector3(s.x, s.y, s.z), h: new THREE.Vector3(s.hx, s.hy, s.hz), port: sinkPort };
        continue;
      }
      if (s.sensor) continue;
      const q = s.rot ? new THREE.Quaternion(s.rot[0], s.rot[1], s.rot[2], s.rot[3]) : new THREE.Quaternion();
      boxes.push({
        c: new THREE.Vector3(s.x, s.y, s.z),
        h: new THREE.Vector3(s.hx, s.hy, s.hz),
        ax: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
        ay: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
        az: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
      });
    }
    this.parts.set(id, { boxes, sink });
    this.rebuildSinks();
    this.scheduleBake();
  }

  removePart(id: string): void {
    this.parts.delete(id);
    this.rebuildSinks();
    this.scheduleBake();
  }

  setConveyors(cells: ConveyorCell[]): void {
    const BUILD_CELL = 4, BUILD_FLOOR_H = 6;
    let n = 0;
    for (const c of cells) {
      if (n >= MAX_CONV) break;
      const x = c.cx * BUILD_CELL, y = c.level * BUILD_FLOOR_H, z = c.cz * BUILD_CELL;
      ((this.convMin as any).array[n] as THREE.Vector3).set(x - 2, y + 0.05, z - 2);
      ((this.convMax as any).array[n] as THREE.Vector3).set(x + 2, y + 1.6, z + 2);
      ((this.convVel as any).array[n] as THREE.Vector3).set(c.dx * c.speed, 0, c.dz * c.speed);
      n++;
    }
    (this.convCount as any).value = n;
  }

  /** Per-frame: apply queued spawns/kills, run the MPM passes, schedule the
   *  sink readback. Called from the game loop (in place of PhysicsClient.render). */
  render(): void {
    const now = performance.now();

    // TTL sweep (~2 Hz): expired slots die on the GPU and drop in the loft
    if (now - this.lastTtlSweep > 500) {
      this.lastTtlSweep = now;
      const dead: number[] = [];
      const drops: number[] = [];
      for (const [slot, info] of this.slots) {
        if (now - info.spawnMs > TTL_MS) { dead.push(slot); drops.push(info.frameId); }
      }
      if (dead.length) {
        let n = 0;
        for (const slot of dead) {
          if (n >= SPAWN_MAX) break;
          (this.killSlot as any).array[n] = slot;
          this.slots.delete(slot);
          this.free.push(slot);
          n++;
        }
        (this.killCount as any).value = n;
        this.renderer.computeAsync(this.killNode);
        (this.killCount as any).value = 0;
        this.events.onGone([], drops.slice(0, n));
      }
    }

    // queued spawns (≤ SPAWN_MAX per frame; rest carries over)
    if (this.pendingSpawn.length) {
      const batch = this.pendingSpawn.splice(0, SPAWN_MAX);
      batch.forEach((s, i) => {
        (this.spawnSlot as any).array[i] = s.slot;
        ((this.spawnPos as any).array[i] as THREE.Vector3).copy(s.pos);
        ((this.spawnVel as any).array[i] as THREE.Vector3).copy(s.vel);
        this.color.setHex(s.color);
        ((this.spawnCol as any).array[i] as THREE.Vector3).set(this.color.r, this.color.g, this.color.b);
      });
      (this.spawnCount as any).value = batch.length;
      this.renderer.computeAsync(this.spawnNode);
      (this.spawnCount as any).value = 0;
    }

    const t0 = performance.now();
    this.renderer.computeAsync(this.clearNode);
    this.renderer.computeAsync(this.p2g1Node);
    this.renderer.computeAsync(this.p2g2Node);
    this.renderer.computeAsync(this.gridNode);
    this.renderer.computeAsync(this.g2pNode).then(() => { this.lastStepMs = performance.now() - t0; });

    void this.pumpSinks();
  }

  stats(): { active: number; awake: number; stepMs: number } {
    return { active: this.slots.size, awake: this.slots.size, stepMs: this.lastStepMs };
  }

  // ---- internals ---------------------------------------------------------------

  private rebuildSinks(): void {
    let s = 0;
    for (const part of this.parts.values()) {
      if (part.sink && s < MAX_SINK) {
        ((this.sinkCenter as any).array[s] as THREE.Vector3).copy(part.sink.c);
        ((this.sinkHalf as any).array[s] as THREE.Vector3).copy(part.sink.h);
        (this.sinkPort as any).array[s] = part.sink.port;
        s++;
      }
    }
    (this.sinkCount as any).value = s;
  }

  private scheduleBake(): void {
    if (this.bakeTimer !== null) clearTimeout(this.bakeTimer);
    this.bakeTimer = setTimeout(() => { this.bakeTimer = null; this.bake(); }, 30);
  }

  /** Rasterize every part's oriented boxes into the solid SDF grid (the
   *  combined static collider). Thin decks are inflated to ≥1 cell — downward
   *  for y-thin slabs so top surfaces stay true — so fluid can't tunnel between
   *  cell centers. Only each box's AABB neighbourhood is touched, so rebakes
   *  are cheap even with hundreds of parts. */
  private bake(): void {
    const arr = this.sdfBuf.value.array as Float32Array;
    arr.fill(SDF_FAR);
    const rel = new THREE.Vector3();
    for (const part of this.parts.values()) {
      for (const b of part.boxes) {
        const hx = Math.max(b.h.x, 0.5) + 0.05, hy = Math.max(b.h.y, 0.5) + 0.05, hz = Math.max(b.h.z, 0.5) + 0.05;
        const c = b.c.clone();
        if (b.h.y < 0.5) c.addScaledVector(b.ay, -(0.5 - b.h.y)); // keep the top surface true
        const ex = Math.abs(b.ax.x) * hx + Math.abs(b.ay.x) * hy + Math.abs(b.az.x) * hz;
        const ey = Math.abs(b.ax.y) * hx + Math.abs(b.ay.y) * hy + Math.abs(b.az.y) * hz;
        const ez = Math.abs(b.ax.z) * hx + Math.abs(b.ay.z) * hy + Math.abs(b.az.z) * hz;
        const i0 = Math.max(0, Math.floor(c.x - ex - ORIGIN) - 1), i1 = Math.min(GX - 1, Math.ceil(c.x + ex - ORIGIN) + 1);
        const j0 = Math.max(0, Math.floor(c.y - ey - OY) - 1), j1 = Math.min(GY - 1, Math.ceil(c.y + ey - OY) + 1);
        const k0 = Math.max(0, Math.floor(c.z - ez - ORIGIN) - 1), k1 = Math.min(GZ - 1, Math.ceil(c.z + ez - ORIGIN) + 1);
        for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          rel.set(ORIGIN + i - c.x, OY + j - c.y, ORIGIN + k - c.z);
          const lx = Math.abs(rel.dot(b.ax)) - hx;
          const ly = Math.abs(rel.dot(b.ay)) - hy;
          const lz = Math.abs(rel.dot(b.az)) - hz;
          const ox = Math.max(lx, 0), oy = Math.max(ly, 0), oz = Math.max(lz, 0);
          const d = Math.hypot(ox, oy, oz) + Math.min(Math.max(lx, Math.max(ly, lz)), 0);
          const idx = i + j * GX + k * GX * GY;
          if (d < arr[idx]) arr[idx] = d;
        }
      }
    }
    this.sdfBuf.value.needsUpdate = true;
  }

  /** Read the sink-consumption ring back (~10 Hz), deliver, reset the ring. */
  private async pumpSinks(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const cntBuf = await (this.renderer as any).getArrayBufferAsync(this.ringCountBuf.value);
      const n = Math.min(new Int32Array(cntBuf)[0] ?? 0, RING);
      if (n > 0) {
        const slotBuf = new Int32Array(await (this.renderer as any).getArrayBufferAsync(this.ringSlotBuf.value));
        const portBuf = new Int32Array(await (this.renderer as any).getArrayBufferAsync(this.ringPortBuf.value));
        const stride = Math.max(1, Math.round(slotBuf.length / RING));
        const delivered: [number, number][] = [];
        for (let i = 0; i < n; i++) {
          const slot = slotBuf[i * stride];
          const port = portBuf[i * stride];
          const info = this.slots.get(slot);
          if (info) {
            if (port <= SUCK_PORT) {
              // vacuumed by a vehicle: the frame is carried, not delivered
              this.onVacuum?.(SUCK_PORT - port, info.frameId, info.color, info.spawnMs);
            } else {
              delivered.push([info.frameId, port]);
            }
            this.slots.delete(slot);
            this.free.push(slot);
          }
        }
        await this.renderer.computeAsync(this.ringResetNode);
        if (delivered.length) this.events.onGone(delivered, []);
      }
    } catch { /* readback can fail during teardown; next pump retries */ }
    // throttle to ~10 Hz
    setTimeout(() => { this.reading = false; }, 100);
  }
}

function mkV3(n: number): THREE.Vector3[] {
  return Array.from({ length: n }, () => new THREE.Vector3());
}
