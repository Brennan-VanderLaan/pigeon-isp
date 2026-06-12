import * as THREE from 'three';
import { MeshStandardNodeMaterial, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, instancedArray, instanceIndex, uniform, vec3, float, int, If,
  positionLocal, hash, max, atomicAdd, atomicStore, atomicLoad,
} from 'three/tsl';

// GPU fluid — MLS-MPM (Moving Least Squares Material Point Method, Hu et al.
// 2018; the real-time formulation from nialltl / WebGPU-Ocean / the official
// three.js r184 webgpu_compute_particles_fluid example). Particles exchange
// momentum through a background grid, so there is NO neighbour search — the
// path to 100k+ in a browser.
//
// Five compute passes per (sub)step:
//   clearGrid  — zero the grid (mass + momentum, fixed-point atomic ints)
//   p2g1       — scatter mass + APIC affine momentum to the 27 nearby nodes
//   p2g2       — gather density, compute pressure/viscosity stress, scatter force
//   gridUpdate — momentum→velocity, gravity, domain boundary conditions
//   g2p        — gather velocity, rebuild affine C, advect, clamp to the box
//
// WebGPU atomics are int-only, so float accumulation uses fixed-point: f*FP as
// int, /FP on read.
const FP = 1e6;              // fixed-point scale for atomic float accumulation
const DX = 1.0;              // grid spacing (world units)
const ORIGIN = -32;         // grid covers [-32, 32] on x/z (arena is ±30)
const OY = -2;              // y from -2
const GX = 64, GY = 48, GZ = 64;
const CELLS = GX * GY * GZ;
const LIM = 30;             // arena half-extent for the box boundary

type CN = Parameters<WebGPURenderer['computeAsync']>[0];

export class GpuParticles {
  readonly mesh: THREE.InstancedMesh;
  readonly count: number;
  readonly positions: any;
  readonly velocities: any;
  readonly overlap: any; // repurposed: per-particle density (for telemetry)
  private renderer: WebGPURenderer;
  private clearNode: CN;
  private p2g1Node: CN;
  private p2g2Node: CN;
  private gridNode: CN;
  private g2pNode: CN;
  private dt = uniform(1 / 60);
  private gravity = uniform(-9.8);
  readonly stiffness = uniform(3.0); // EOS stiffness (exposed as ?press=)
  private restDensity = uniform(4.0);
  readonly viscosity = uniform(0.4); // higher = calmer (the main boil damper)
  // one analytic box collider (grid velocity BC) — proves collider coupling
  private boxCenter = uniform(vec3(0, 7, 0));
  private boxHalf = uniform(vec3(7, 3.5, 7));
  private boxOn = uniform(0);

  constructor(renderer: WebGPURenderer, count: number, opts: { stiffness?: number; gravity?: number; viscosity?: number } = {}) {
    this.renderer = renderer;
    this.count = count;
    if (opts.stiffness !== undefined) this.stiffness.value = opts.stiffness;
    if (opts.gravity !== undefined) this.gravity.value = opts.gravity;
    if (opts.viscosity !== undefined) this.viscosity.value = opts.viscosity;

    const positions = instancedArray(count, 'vec3');
    const velocities = instancedArray(count, 'vec3');
    const colors = instancedArray(count, 'vec3');
    const C0 = instancedArray(count, 'vec3'); // affine velocity matrix rows
    const C1 = instancedArray(count, 'vec3');
    const C2 = instancedArray(count, 'vec3');
    const density = instancedArray(count, 'int');
    this.positions = positions; this.velocities = velocities; this.overlap = density;

    const gMass = instancedArray(CELLS, 'int').toAtomic();
    const gVx = instancedArray(CELLS, 'int').toAtomic();
    const gVy = instancedArray(CELLS, 'int').toAtomic();
    const gVz = instancedArray(CELLS, 'int').toAtomic();

    const enc = (f: any) => int(f.mul(FP));
    const dec = (i: any) => float(i).div(FP);

    // quadratic B-spline weights → { base (vec3 float node), fx, w:[w0,w1,w2] }
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

    // init: rain particles into a column; mass = 1, C = 0
    const initNode = Fn(() => {
      positions.element(instanceIndex).assign(vec3(
        hash(instanceIndex).sub(0.5).mul(LIM * 1.6),
        hash(instanceIndex.add(7)).mul(40).add(6),
        hash(instanceIndex.add(13)).sub(0.5).mul(LIM * 1.6),
      ));
      velocities.element(instanceIndex).assign(vec3(0, 0, 0));
      C0.element(instanceIndex).assign(vec3(0, 0, 0));
      C1.element(instanceIndex).assign(vec3(0, 0, 0));
      C2.element(instanceIndex).assign(vec3(0, 0, 0));
      colors.element(instanceIndex).assign(vec3(
        hash(instanceIndex.add(3)).mul(0.5).add(0.25),
        hash(instanceIndex.add(5)).mul(0.5).add(0.35),
        hash(instanceIndex.add(9)).mul(0.4).add(0.5),
      ));
    })().compute(count);
    renderer.computeAsync(initNode);

    this.clearNode = Fn(() => {
      atomicStore(gMass.element(instanceIndex), int(0));
      atomicStore(gVx.element(instanceIndex), int(0));
      atomicStore(gVy.element(instanceIndex), int(0));
      atomicStore(gVz.element(instanceIndex), int(0));
    })().compute(CELLS) as CN;

    // P2G pass 1: scatter mass + APIC momentum  m*(v + C*dpos)
    this.p2g1Node = Fn(() => {
      const p = positions.element(instanceIndex) as any;
      const v = velocities.element(instanceIndex) as any;
      const c0 = C0.element(instanceIndex) as any, c1 = C1.element(instanceIndex) as any, c2 = C2.element(instanceIndex) as any;
      const gp = gridPos(p);
      const { base, fx, w } = weights(gp);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
        const wt = (w[i].x as any).mul(w[j].y).mul(w[k].z);
        const dpos = vec3(float(i).sub(fx.x), float(j).sub(fx.y), float(k).sub(fx.z)).mul(DX);
        const idx = nodeIndex(base.add(vec3(i, j, k)));
        const aff = vec3(c0.dot(dpos), c1.dot(dpos), c2.dot(dpos)); // C*dpos
        const mv = v.add(aff); // mass = 1
        atomicAdd(gMass.element(idx), enc(wt));
        atomicAdd(gVx.element(idx), enc(wt.mul(mv.x)));
        atomicAdd(gVy.element(idx), enc(wt.mul(mv.y)));
        atomicAdd(gVz.element(idx), enc(wt.mul(mv.z)));
      }
    })().compute(count) as CN;

    // P2G pass 2: gather density → pressure/viscosity stress → scatter force
    this.p2g2Node = Fn(() => {
      const p = positions.element(instanceIndex) as any;
      const c0 = C0.element(instanceIndex) as any, c1 = C1.element(instanceIndex) as any, c2 = C2.element(instanceIndex) as any;
      const gp = gridPos(p);
      const { base, fx, w } = weights(gp);
      const dens = float(0).toVar();
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
        const wt = (w[i].x as any).mul(w[j].y).mul(w[k].z);
        const idx = nodeIndex(base.add(vec3(i, j, k)));
        dens.addAssign(wt.mul(dec(atomicLoad(gMass.element(idx)) as any)));
      }
      density.element(instanceIndex).assign(int(dens.mul(100))); // telemetry (×100)
      const volume = float(1).div((max as any)(dens, float(0.0001)));
      const ratio = dens.div(this.restDensity);
      const pressure = (max as any)(float(-0.2), this.stiffness.mul(ratio.mul(ratio).mul(ratio).mul(ratio).sub(1)));
      // stress = -pressure*I + viscosity*(C + C^T)  (rows s0,s1,s2)
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
    })().compute(count) as CN;

    // grid update: momentum→velocity, gravity, boundary; store velocity back
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
        // analytic box collider: a node inside the box is "stuck" (zero velocity)
        If(this.boxOn.greaterThan(0.5), () => {
          const wx = float(ORIGIN).add(cx.mul(DX));
          const wy = float(OY).add(cy.mul(DX));
          const wz = float(ORIGIN).add(cz.mul(DX));
          const inside = wx.sub((this.boxCenter as any).x).abs().lessThan((this.boxHalf as any).x)
            .and(wy.sub((this.boxCenter as any).y).abs().lessThan((this.boxHalf as any).y))
            .and(wz.sub((this.boxCenter as any).z).abs().lessThan((this.boxHalf as any).z));
          If(inside, () => { vx.assign(0); vy.assign(0); vz.assign(0); });
        });
        atomicStore(gVx.element(instanceIndex), enc(vx));
        atomicStore(gVy.element(instanceIndex), enc(vy));
        atomicStore(gVz.element(instanceIndex), enc(vz));
      });
    })().compute(CELLS) as CN;

    // G2P: gather velocity, rebuild affine C, advect, clamp to the arena box
    this.g2pNode = Fn(() => {
      const p = positions.element(instanceIndex) as any;
      const gp = gridPos(p);
      const { base, fx, w } = weights(gp);
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
        nc0.addAssign(dpos.mul(gv.x).mul(f)); // C += 4/dx² w * outer(gv,dpos)
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
      // Box collider, particle side: the grid BC only kills momentum inside the
      // box — it does NOT stop slow creep through the surface, and a particle
      // that gets in freezes (all-zero stencil). Project any particle found
      // inside back out through its nearest face.
      If(this.boxOn.greaterThan(0.5), () => {
        const bc = this.boxCenter as any, bh = this.boxHalf as any;
        const rel = np.sub(bc);
        const penX = bh.x.sub(rel.x.abs());
        const penY = bh.y.sub(rel.y.abs());
        const penZ = bh.z.sub(rel.z.abs());
        If(penX.greaterThan(0).and(penY.greaterThan(0)).and(penZ.greaterThan(0)), () => {
          If(penX.lessThanEqual(penY).and(penX.lessThanEqual(penZ)), () => {
            np.x.assign(bc.x.add(rel.x.sign().mul(bh.x)));
          }).ElseIf(penY.lessThanEqual(penZ), () => {
            np.y.assign(bc.y.add(rel.y.sign().mul(bh.y)));
          }).Else(() => {
            np.z.assign(bc.z.add(rel.z.sign().mul(bh.z)));
          });
        });
      });
      positions.element(instanceIndex).assign(np);
    })().compute(count) as CN;

    const geo = new THREE.IcosahedronGeometry(0.4, 0);
    const mat = new MeshStandardNodeMaterial();
    mat.positionNode = positionLocal.add(positions.element(instanceIndex));
    mat.colorNode = colors.element(instanceIndex);
    mat.roughness = 0.5;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false; mesh.castShadow = false;
    const id = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, id);
    mesh.instanceMatrix.needsUpdate = true;
    this.mesh = mesh;
  }

  step(): Promise<void> {
    const c = this.renderer;
    c.computeAsync(this.clearNode);
    c.computeAsync(this.p2g1Node);
    c.computeAsync(this.p2g2Node);
    c.computeAsync(this.gridNode);
    return c.computeAsync(this.g2pNode);
  }

  /** Place the test box collider (world center + half-extents). */
  setBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void {
    (this.boxCenter.value as THREE.Vector3).set(cx, cy, cz);
    (this.boxHalf.value as THREE.Vector3).set(hx, hy, hz);
    this.boxOn.value = 1;
  }

  get gridCells(): number { return CELLS; }
  get pressure() { return this.stiffness; }
}
