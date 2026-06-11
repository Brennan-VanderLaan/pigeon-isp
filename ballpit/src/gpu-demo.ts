// GPU sim demo (milestone 2): N particles on the GPU in an arena box. Proves
// the WebGPU compute → instanced-render path at 100k+. No loft wiring or
// inter-particle collision yet (milestones 3-4).
//
//   ?gpu=1        run this instead of the loft game
//   ?n=250000     particle count (default 100k)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Scene } from './scene';
import { GpuParticles } from './gpu/particles';

const FLOOR = 30, WALL_H = 2.4;
const params = new URLSearchParams(location.search);
const COUNT = Math.max(1, Math.min(Number(params.get('n') ?? 100_000), 2_000_000));

const view = await Scene.create(document.getElementById('app')!);

// arena visual (matches GpuParticles' collision bounds)
const floor = new THREE.Mesh(
  new THREE.BoxGeometry(FLOOR * 2, 1, FLOOR * 2),
  new THREE.MeshStandardMaterial({ color: 0x161d28, roughness: 0.95 }),
);
floor.position.y = -0.5; floor.receiveShadow = true;
view.scene.add(floor);
const wallMat = new THREE.MeshStandardMaterial({ color: 0x222c3c, roughness: 0.9, transparent: true, opacity: 0.4 });
for (const [x, z, sx, sz] of [[0, FLOOR, FLOOR, 0.3], [0, -FLOOR, FLOOR, 0.3], [FLOOR, 0, 0.3, FLOOR], [-FLOOR, 0, 0.3, FLOOR]] as const) {
  const w = new THREE.Mesh(new THREE.BoxGeometry(sx * 2, WALL_H, sz * 2), wallMat);
  w.position.set(x, WALL_H / 2, z);
  view.scene.add(w);
}
const grid = new THREE.GridHelper(FLOOR * 2, 24, 0x2c3848, 0x1d2632);
grid.position.y = 0.01; view.scene.add(grid);

const controls = new OrbitControls(view.camera, view.renderer.domElement);
controls.target.set(0, 4, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 8;
controls.maxDistance = 160;
controls.update();

const particles = new GpuParticles(view.renderer, COUNT);
view.scene.add(particles.mesh);

// minimal telemetry (top-right)
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;top:12px;right:12px;padding:10px 12px;border-radius:10px;background:rgba(16,22,32,.82);border:1px solid #243044;font:12px/1.5 ui-monospace,monospace;color:#cdd8e6;text-align:right;white-space:pre';
document.body.appendChild(hud);
const hudL = document.getElementById('hud-body');
if (hudL) hudL.textContent = `GPU sim · ${COUNT.toLocaleString()} particles`;

let fps = 60, rend = 0, prev = performance.now(), lastHud = 0;
const ewma = (p: number, v: number) => p + 0.1 * (v - p);

function frame(now: number): void {
  const dt = now - prev; prev = now;
  controls.update();
  particles.step();          // GPU compute pass
  const t = performance.now();
  view.render();             // reads particle positions from the GPU buffer
  rend = ewma(rend, performance.now() - t);
  fps = ewma(fps, 1000 / Math.max(dt, 0.001));

  if (now - lastHud > 200) {
    lastHud = now;
    const c = fps >= 55 ? '#6fdc8c' : fps >= 30 ? '#ffd479' : '#ff6b6b';
    hud.innerHTML =
      `<span style="color:${c}">${fps.toFixed(0)} fps</span>\n` +
      `${(1000 / Math.max(fps, 1)).toFixed(1)} ms frame\n` +
      `render ${rend.toFixed(1)} ms\n` +
      `<span style="color:#7b8aa0">${COUNT.toLocaleString()} particles (GPU)</span>`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
