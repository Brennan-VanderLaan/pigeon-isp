import * as THREE from 'three';
import { MeshStandardNodeMaterial, type WebGPURenderer } from 'three/webgpu';
import { Fn, instancedArray, instanceIndex, uniform, vec3, float, If, positionLocal, hash } from 'three/tsl';

// GPU particle sim (milestone 2): N particles live entirely in GPU storage
// buffers. A compute pass integrates gravity + bounces them inside the arena
// box; the instanced mesh reads the same buffer for its position — no CPU
// round-trip. NO inter-particle collision yet (milestone 3 adds the spatial
// hash) — particles overlap, which is expected at this step.
const FLOOR = 30; // arena half-extent (matches the visual)

export class GpuParticles {
  readonly mesh: THREE.InstancedMesh;
  readonly count: number;
  private renderer: WebGPURenderer;
  private updateNode: Parameters<WebGPURenderer['computeAsync']>[0];
  private dt = uniform(1 / 60);
  private gravity = uniform(-19);

  constructor(renderer: WebGPURenderer, count: number, radius = 0.35) {
    this.renderer = renderer;
    this.count = count;

    const positions = instancedArray(count, 'vec3');
    const velocities = instancedArray(count, 'vec3');
    const colors = instancedArray(count, 'vec3');
    const r = float(radius);
    const lim = float(FLOOR - radius);

    // one-time init: rain them in from a tall column above the floor
    const initNode = Fn(() => {
      const pos = positions.element(instanceIndex);
      const vel = velocities.element(instanceIndex);
      const col = colors.element(instanceIndex);
      pos.assign(vec3(
        hash(instanceIndex).sub(0.5).mul(FLOOR * 1.7),
        hash(instanceIndex.add(7)).mul(60).add(8),
        hash(instanceIndex.add(13)).sub(0.5).mul(FLOOR * 1.7),
      ));
      vel.assign(vec3(0, 0, 0));
      col.assign(vec3(
        hash(instanceIndex.add(3)).mul(0.6).add(0.3),
        hash(instanceIndex.add(5)).mul(0.6).add(0.3),
        hash(instanceIndex.add(9)).mul(0.6).add(0.4),
      ));
    })().compute(count);
    renderer.computeAsync(initNode);

    // per-frame integrate + arena-box collision (floor + 4 walls)
    this.updateNode = Fn(() => {
      const pos = positions.element(instanceIndex);
      const vel = velocities.element(instanceIndex);
      vel.y.addAssign(this.gravity.mul(this.dt));
      pos.addAssign(vel.mul(this.dt));
      If(pos.y.lessThan(r), () => {
        pos.y.assign(r);
        vel.y.assign(vel.y.mul(-0.3));
        vel.x.mulAssign(0.85); vel.z.mulAssign(0.85);
      });
      If(pos.x.greaterThan(lim), () => { pos.x.assign(lim); vel.x.assign(vel.x.mul(-0.4)); });
      If(pos.x.lessThan(lim.negate()), () => { pos.x.assign(lim.negate()); vel.x.assign(vel.x.mul(-0.4)); });
      If(pos.z.greaterThan(lim), () => { pos.z.assign(lim); vel.z.assign(vel.z.mul(-0.4)); });
      If(pos.z.lessThan(lim.negate()), () => { pos.z.assign(lim.negate()); vel.z.assign(vel.z.mul(-0.4)); });
    })().compute(count) as Parameters<WebGPURenderer['computeAsync']>[0];

    // render: low-poly spheres, instanced; position comes from the GPU buffer
    const geo = new THREE.IcosahedronGeometry(radius, 0); // 20 tris is plenty
    const mat = new MeshStandardNodeMaterial();
    mat.positionNode = positionLocal.add(positions.element(instanceIndex));
    mat.colorNode = colors.element(instanceIndex);
    mat.roughness = 0.5;
    mat.metalness = 0.0;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false; // positions live on the GPU; CPU bounds are wrong
    mesh.castShadow = false;    // custom positionNode + shadow depth = M5 concern
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
    mesh.instanceMatrix.needsUpdate = true;
    this.mesh = mesh;
  }

  /** Run one sim step. AWAIT it so exactly one step happens per frame, properly
   *  sequenced before the render — and so timing it gives the true GPU cost
   *  (computeAsync resolves when the GPU work completes). */
  step(): Promise<void> {
    return this.renderer.computeAsync(this.updateNode);
  }
}
