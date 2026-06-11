import * as THREE from 'three';
import { MeshStandardNodeMaterial, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, instancedArray, instanceIndex, uniform, vec3, float, int, If,
  positionLocal, hash, clamp, atomicAdd, atomicStore, atomicLoad,
} from 'three/tsl';

// GPU particle sim (milestone 3): a granular FLUID, entirely on the GPU.
//
// Each frame, three compute passes:
//   clear   — zero a uniform density grid (atomic int per cell)
//   scatter — every particle atomicAdd's 1 into its grid cell
//   update  — gravity + a PRESSURE push down the density gradient (crowded
//             cells expand → particles separate, incompressible-ish), then
//             integrate and bounce off the arena box.
// No CPU round-trip: the instanced mesh reads the position buffer directly.
//
// Density-gradient pressure (vs storing neighbour index lists) needs only atomic
// COUNTS — the simplest, most portable atomic use — and reads as a fluid, which
// is the goal at 100k+.
const FLOOR = 30;     // arena half-extent
const CG = 1.0;       // grid cell size (~ interaction radius)
const OX = -FLOOR, OY = -2, OZ = -FLOOR;
const GX = Math.ceil((FLOOR * 2) / CG);     // 60
const GY = Math.ceil(52 / CG);              // 52 (covers the spawn column)
const GZ = Math.ceil((FLOOR * 2) / CG);     // 60
const CELLS = GX * GY * GZ;

export class GpuParticles {
  readonly mesh: THREE.InstancedMesh;
  readonly count: number;
  private renderer: WebGPURenderer;
  private clearNode: Parameters<WebGPURenderer['computeAsync']>[0];
  private scatterNode: Parameters<WebGPURenderer['computeAsync']>[0];
  private updateNode: Parameters<WebGPURenderer['computeAsync']>[0];
  private dt = uniform(1 / 60);
  private gravity = uniform(-19);
  readonly pressure = uniform(1.6);

  constructor(renderer: WebGPURenderer, count: number, opts: { radius?: number; pressure?: number; gravity?: number } = {}) {
    this.renderer = renderer;
    this.count = count;
    const radius = opts.radius ?? 0.35;
    if (opts.pressure !== undefined) this.pressure.value = opts.pressure;
    if (opts.gravity !== undefined) this.gravity.value = opts.gravity;

    const positions = instancedArray(count, 'vec3');
    const velocities = instancedArray(count, 'vec3');
    const colors = instancedArray(count, 'vec3');
    const density = instancedArray(CELLS, 'int').toAtomic();
    const r = float(radius);
    const lim = float(FLOOR - radius);

    // TSL is dynamically typed; its TS types don't expose node swizzles/atomic
    // conversions, so these helpers work in `any` space (runtime is correct).
    // grid-cell index for a world position (clamped into the grid)
    const cellId = (p: any) => {
      const gx = clamp(p.x.sub(OX).div(CG), 0, GX - 1).floor();
      const gy = clamp(p.y.sub(OY).div(CG), 0, GY - 1).floor();
      const gz = clamp(p.z.sub(OZ).div(CG), 0, GZ - 1).floor();
      return gx.add(gy.mul(GX)).add(gz.mul(GX * GY)).toInt();
    };
    // density at integer grid coords (clamped)
    const densAt = (gx: any, gy: any, gz: any) => {
      const idx = clamp(gx, 0, GX - 1).add(clamp(gy, 0, GY - 1).mul(GX)).add(clamp(gz, 0, GZ - 1).mul(GX * GY)).toInt();
      return float(atomicLoad(density.element(idx)) as any);
    };

    // init: rain particles in from a tall column
    const initNode = Fn(() => {
      const pos = positions.element(instanceIndex);
      pos.assign(vec3(
        hash(instanceIndex).sub(0.5).mul(FLOOR * 1.7),
        hash(instanceIndex.add(7)).mul(45).add(8),
        hash(instanceIndex.add(13)).sub(0.5).mul(FLOOR * 1.7),
      ));
      velocities.element(instanceIndex).assign(vec3(0, 0, 0));
      colors.element(instanceIndex).assign(vec3(
        hash(instanceIndex.add(3)).mul(0.6).add(0.3),
        hash(instanceIndex.add(5)).mul(0.6).add(0.3),
        hash(instanceIndex.add(9)).mul(0.6).add(0.4),
      ));
    })().compute(count);
    renderer.computeAsync(initNode);

    this.clearNode = Fn(() => {
      atomicStore(density.element(instanceIndex), int(0));
    })().compute(CELLS) as Parameters<WebGPURenderer['computeAsync']>[0];

    this.scatterNode = Fn(() => {
      atomicAdd(density.element(cellId(positions.element(instanceIndex))), int(1));
    })().compute(count) as Parameters<WebGPURenderer['computeAsync']>[0];

    this.updateNode = Fn(() => {
      const pos = positions.element(instanceIndex) as any;
      const vel = velocities.element(instanceIndex) as any;
      const gx = clamp(pos.x.sub(OX).div(CG), 0, GX - 1).floor();
      const gy = clamp(pos.y.sub(OY).div(CG), 0, GY - 1).floor();
      const gz = clamp(pos.z.sub(OZ).div(CG), 0, GZ - 1).floor();
      // push down the density gradient (toward less-crowded space)
      const grad = vec3(
        densAt(gx.add(1), gy, gz).sub(densAt(gx.sub(1), gy, gz)),
        densAt(gx, gy.add(1), gz).sub(densAt(gx, gy.sub(1), gz)),
        densAt(gx, gy, gz.add(1)).sub(densAt(gx, gy, gz.sub(1))),
      );
      vel.addAssign(grad.mul(this.pressure.negate()).mul(this.dt));
      vel.y.addAssign(this.gravity.mul(this.dt));
      pos.addAssign(vel.mul(this.dt));
      // arena box
      If(pos.y.lessThan(r), () => { pos.y.assign(r); vel.y.assign(vel.y.mul(-0.3)); vel.x.mulAssign(0.85); vel.z.mulAssign(0.85); });
      If(pos.x.greaterThan(lim), () => { pos.x.assign(lim); vel.x.assign(vel.x.mul(-0.4)); });
      If(pos.x.lessThan(lim.negate()), () => { pos.x.assign(lim.negate()); vel.x.assign(vel.x.mul(-0.4)); });
      If(pos.z.greaterThan(lim), () => { pos.z.assign(lim); vel.z.assign(vel.z.mul(-0.4)); });
      If(pos.z.lessThan(lim.negate()), () => { pos.z.assign(lim.negate()); vel.z.assign(vel.z.mul(-0.4)); });
      vel.mulAssign(0.992); // gentle damping so the pile settles
    })().compute(count) as Parameters<WebGPURenderer['computeAsync']>[0];

    const geo = new THREE.IcosahedronGeometry(radius, 0);
    const mat = new MeshStandardNodeMaterial();
    mat.positionNode = positionLocal.add(positions.element(instanceIndex));
    mat.colorNode = colors.element(instanceIndex);
    mat.roughness = 0.5;
    mat.metalness = 0.0;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
    mesh.instanceMatrix.needsUpdate = true;
    this.mesh = mesh;
  }

  /** One sim step: clear grid → scatter densities → integrate + pressure.
   *  Await the returned promise (the last pass) to time the full step. */
  step(): Promise<void> {
    this.renderer.computeAsync(this.clearNode);
    this.renderer.computeAsync(this.scatterNode);
    return this.renderer.computeAsync(this.updateNode);
  }

  get gridCells(): number { return CELLS; }
}
