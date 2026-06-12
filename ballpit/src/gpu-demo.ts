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
const PRESSURE = params.has('press') ? Number(params.get('press')) : undefined;
const GRAVITY = params.has('g') ? Number(params.get('g')) : undefined;

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

const particles = new GpuParticles(view.renderer, COUNT, { stiffness: PRESSURE, gravity: GRAVITY });
view.scene.add(particles.mesh);

// minimal telemetry (top-right)
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;top:12px;right:12px;padding:10px 12px;border-radius:10px;background:rgba(16,22,32,.82);border:1px solid #243044;font:12px/1.5 ui-monospace,monospace;color:#cdd8e6;text-align:right;white-space:pre';
document.body.appendChild(hud);
const hudL = document.getElementById('hud-body');
if (hudL) hudL.textContent = `GPU sim · ${COUNT.toLocaleString()} particles`;

let fps = 60, comp = 0, rend = 0, prev = performance.now(), lastHud = 0, lastTel = 0;
const ewma = (p: number, v: number) => p + 0.1 * (v - p);

// Diagnostic readback: pull positions+velocities off the GPU, summarise health
// (max height, NaN count, max speed), and ship to the local logger so the agent
// can SEE what the sim is doing on real hardware. Off the hot path (~2 Hz).
let dbg: Record<string, unknown> = { phase: 'starting' };
async function sample(): Promise<void> {
  try {
    const pab = await (view.renderer as any).getArrayBufferAsync(particles.positions.value);
    const vab = await (view.renderer as any).getArrayBufferAsync(particles.velocities.value);
    const oab = await (view.renderer as any).getArrayBufferAsync(particles.overlap.value);
    const pf = new Float32Array(pab), vf = new Float32Array(vab);
    const oi = new Int32Array(oab);
    const stride = Math.max(3, Math.round(pf.length / COUNT));
    const n = Math.min(COUNT, Math.floor(pf.length / stride));
    let maxY = -1e9, minY = 1e9, nan = 0, maxSp = 0, escaped = 0, ovSum = 0, ovMax = 0, ovParts = 0;
    const ostride = Math.max(1, Math.round(oi.length / COUNT));
    for (let i = 0; i < n; i++) {
      const x = pf[i * stride], y = pf[i * stride + 1], z = pf[i * stride + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { nan++; continue; }
      if (y > maxY) maxY = y; if (y < minY) minY = y;
      if (y > 55) escaped++;
      const sp = Math.hypot(vf[i * stride], vf[i * stride + 1], vf[i * stride + 2]);
      if (sp > maxSp) maxSp = sp;
      const ov = oi[i * ostride];
      ovSum += ov; if (ov > ovMax) ovMax = ov; if (ov > 0) ovParts++;
    }
    dbg = {
      stride, n, maxY: +maxY.toFixed(1), minY: +minY.toFixed(1), escaped, nan, maxSpeed: +maxSp.toFixed(1),
      ovAvg: +(ovSum / n).toFixed(2), ovMax, ovPct: +(100 * ovParts / n).toFixed(1),
    };
  } catch (e) { dbg = { error: String(e).slice(0, 140) }; }
}
function ship(obj: unknown): void {
  try { fetch('http://localhost:7788', { method: 'POST', mode: 'cors', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(obj) }).catch(() => {}); } catch { /* */ }
}

// Async, self-scheduling loop: AWAIT the compute (one step/frame, sequenced and
// timed) then the render. Awaiting computeAsync forces GPU completion, so
// `comp` is the true per-step GPU cost — the number we're optimizing.
async function frame(): Promise<void> {
  const now = performance.now();
  const dt = now - prev; prev = now;
  controls.update();

  const tc = performance.now();
  await particles.step();
  comp = ewma(comp, performance.now() - tc);

  const tr = performance.now();
  await view.renderer.renderAsync(view.scene, view.camera);
  rend = ewma(rend, performance.now() - tr);

  fps = ewma(fps, 1000 / Math.max(dt, 0.001));

  // ~2 Hz: read GPU state back and ship telemetry to the logger
  if (now - lastTel > 500) {
    lastTel = now;
    await sample();
    ship({ count: COUNT, fps: +fps.toFixed(0), computeMs: +comp.toFixed(2), renderMs: +rend.toFixed(2), stiffness: particles.pressure.value, ...dbg });
  }

  if (now - lastHud > 200) {
    lastHud = now;
    const c = fps >= 55 ? '#6fdc8c' : fps >= 30 ? '#ffd479' : '#ff6b6b';
    const cc = comp > 12 ? '#ff6b6b' : comp > 6 ? '#ffd479' : '#6fdc8c';
    hud.innerHTML =
      `<span style="color:${c}">${fps.toFixed(0)} fps</span>\n` +
      `<span style="color:${cc}">compute ${comp.toFixed(2)} ms</span>\n` +
      `render ${rend.toFixed(2)} ms\n` +
      `<span style="color:#7b8aa0">${COUNT.toLocaleString()} particles (GPU)\n` +
      `stiffness ${particles.pressure.value.toFixed(2)} · grid ${particles.gridCells.toLocaleString()} cells\n` +
      `?n= count · ?press= stiffness(0-1) · ?g= gravity</span>`;
  }
  requestAnimationFrame(() => { void frame(); });
}
void frame();
