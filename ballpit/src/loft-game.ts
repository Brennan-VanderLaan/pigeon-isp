// Pigeon Ballpit — a second visualizer on the same engine.
//
// Every loft token becomes a BALL dropped from its ingress port's dock. You
// route packets by routing balls (conveyors, ramps, chutes, gravity) into a
// destination port's sink: a ball in a sink = deliver(port, frame); a ball that
// falls out or ages past the loft TTL = drop(frame). Same Pigeon API the belt
// game speaks (@pigeon/protocol). Physics runs in a Web Worker; this thread only
// builds, renders, and relays deliveries to the loft.
//
//   ?sim=1          force the offline sim (two fake pods, no cluster)
//   ?storm=2000     sim + a UDP storm at N pps (stress the ball factory)
//   ?bridge=ws://…  explicit loft URL
import {
  SimBridge, WsBridge, defaultBridgeUrl, decodeFrame, KIND_COLORS,
  type Bridge, type BridgeEvents, type FrameToken, type LoftStats, type PortInfo,
} from '@pigeon/protocol';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Scene } from './scene';
import { PhysicsClient, type PhysicsEvents } from './physics-client';
import { GpuFluid } from './gpu/fluid';
import { Sweeper, HOPPER_CAP } from './vehicles';
import { Arena, portColor } from './arena';
import { Build, CELL, FLOOR_H, type Tool } from './build';
import { Perf } from './perf';

// ---- settings: in-app controls, persisted. URL params still work as optional
// overrides/deep-links, but nothing REQUIRES typing in the address bar. -------
interface Settings {
  backend: 'fluid' | 'cpu';
  source: 'loft' | 'sim' | 'storm';
  storm: number;
  pressure: number;
  viscosity: number;
}
const SETTINGS_KEY = 'pigeon-ballpit-settings-v1';
function loadSettings(): Settings {
  const def: Settings = { backend: 'fluid', source: 'loft', storm: 500, pressure: 1000, viscosity: 0.6 };
  try { return { ...def, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }; } catch { return def; }
}
function saveSettings(s: Settings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* */ }
}
const settings = loadSettings();
const params = new URLSearchParams(location.search);
if (params.has('fluid')) settings.backend = 'fluid';
if (params.has('cpu')) settings.backend = 'cpu';
if (params.has('sim')) settings.source = 'sim';
if (Number(params.get('storm') ?? 0) > 0) { settings.source = 'storm'; settings.storm = Number(params.get('storm')); }

const stormPps = settings.source === 'storm' ? settings.storm : 0;
const forceSim = settings.source !== 'loft';

const hudBody = document.getElementById('hud-body')!;
const logEl = document.getElementById('log')!;
function log(who: string, line: string): void {
  const d = document.createElement('div');
  d.textContent = `${who}  ${line}`;
  logEl.prepend(d);
  while (logEl.childElementCount > 14) logEl.lastChild!.remove();
}

const view = await Scene.create(document.getElementById('app')!);
const perf = new Perf();

const ports = new Map<number, PortInfo>();
let state = 'connecting';
let spawned = 0;
let delivered = 0;
let dropped = 0;

// Physics + ball rendering live behind a backend. Deliveries/losses come back
// as events we relay to the loft. Two backends, same surface:
//   default  — CPU rigid bodies in a Web Worker (Rapier; ~5k ball ceiling)
//   ?fluid   — the GPU MLS-MPM fluid (100k+; packets pour as liquid)
const BALL_RADIUS = 0.35;
const physEvents: PhysicsEvents = {
  onSpawned(items) { spawned += items.length; },
  onGone(deliveredList, droppedList) {
    for (const [frameId, port] of deliveredList) {
      bridge.deliver(port, frameId);
      delivered++;
    }
    for (const frameId of droppedList) { bridge.drop(frameId); dropped++; }
  },
};
const fluid = settings.backend === 'fluid'
  ? new GpuFluid(view.scene, view.renderer, physEvents, { maxBalls: 100_000 })
  : null;
if (fluid) {
  fluid.stiffness.value = settings.pressure;
  fluid.viscosity.value = settings.viscosity;
  log('sim', 'engine: GPU fluid (MLS-MPM) — packets pour as liquid');
}
const physics = fluid ?? new PhysicsClient(view.scene, physEvents, { cell: CELL, floorH: FLOOR_H, radius: BALL_RADIUS });

// ---- vehicles (GPU fluid only): the street sweeper ---------------------------
let sweeper: Sweeper | null = null;
let followCam = true;
let wantDump = false;
const held = new Set<string>();
if (fluid) {
  fluid.onVacuum = (_vehId, frameId, color, spawnMs) => {
    if (sweeper && sweeper.hopper.length < HOPPER_CAP) {
      sweeper.hopper.push({ frameId, color, spawnMs });
    } else {
      bridge.drop(frameId); // hopper gone/full mid-flight: counted loss
      dropped++;
    }
  };
}

new Arena(view.scene, physics); // floor + walls
const build = new Build(view.scene, physics);

function syncPorts(): void {
  build.syncPorts([...ports.values()].map((p) => ({ id: p.id, label: p.pod })));
}

const events: BridgeEvents = {
  onHello(list) {
    ports.clear();
    for (const p of list) ports.set(p.id, p);
    syncPorts();
    log('loft', `hello: ${list.length} port(s)`);
  },
  onPortAdded(p) { ports.set(p.id, p); syncPorts(); log('loft', `port up: ${p.pod}`); },
  onPortRemoved(id) { ports.delete(id); syncPorts(); log('loft', `port down: ${id}`); },
  onToken(token: FrameToken) {
    const nozzle = build.spawnPosFor(token.port);
    if (!nozzle) { bridge.drop(token.id); return; } // no dock placed for it: free it
    const d = decodeFrame(token.snapshot, token.fullLen);
    const color = KIND_COLORS[d.kind] ?? 0xffffff;
    // a little deterministic jitter so a stream fans out instead of stacking
    const jx = (((token.id * 2654435761) >>> 0) % 1000) / 1000 - 0.5;
    const jz = (((token.id * 40503) >>> 0) % 1000) / 1000 - 0.5;
    physics.spawn(token.id, nozzle, new THREE.Vector3(jx, -2, jz), BALL_RADIUS, color);
    // spawned/dropped(full) are confirmed by the worker via onSpawned/onGone.
  },
  onStats(_stats: LoftStats) { /* counters surfaced via our own tallies for now */ },
  onLog: (who, line) => log(who, line),
  onState(s) {
    state = s;
    if (s === 'live') { everLive = true; log('net', 'loft live'); }
    if (s === 'down' && !everLive && !triedSim) { triedSim = true; ws?.close(); startSim(); }
  },
};

// ---- bridge selection (live loft, sim fallback) -----------------------------
let bridge: Bridge;
let ws: WsBridge | null = null;
let everLive = false;
let triedSim = false;
function startSim(): void {
  log('net', 'sim mode: two fake pods');
  const sim = new SimBridge(events, stormPps);
  bridge = sim;
  sim.start();
}
if (forceSim) {
  triedSim = true;
  startSim();
} else {
  ws = new WsBridge(defaultBridgeUrl(), events);
  bridge = ws;
  ws.connect();
  // A hanging connect never fires onclose, so guarantee a fallback: if no loft
  // has answered in 3s, switch to the offline sim so there's always a factory.
  setTimeout(() => {
    if (!everLive && !triedSim) { triedSim = true; ws?.close(); log('net', 'no loft — falling back to sim'); startSim(); }
  }, 3000);
}

// ---- camera: real OrbitControls (orbit / zoom / pan) ------------------------
const canvas = view.renderer.domElement;
const controls = new OrbitControls(view.camera, canvas);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495; // never under the floor
controls.minDistance = 8;
controls.maxDistance = 120;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
controls.update();

// ---- build input: left-CLICK places (a left-DRAG orbits the camera) ---------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downX = 0, downY = 0, downBtn = -1;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; downBtn = e.button; });
canvas.addEventListener('pointermove', (e) => {
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, view.camera);
  build.hoverAt(raycaster.ray);
});
canvas.addEventListener('pointerup', (e) => {
  if (downBtn === 0 && build.tool !== 'none' && Math.hypot(e.clientX - downX, e.clientY - downY) < 5) {
    build.click(); // a click, not an orbit drag
  }
  downBtn = -1;
});

const TOOL_KEYS: Record<string, Tool> = {
  '1': 'none', '2': 'platform', '3': 'ramp', '4': 'corner', '5': 'wall', '6': 'conveyor', '7': 'host', '8': 'sink', '0': 'erase',
};
window.addEventListener('keyup', (e) => {
  held.delete(e.key.toLowerCase());
  if (e.key === 'Alt') build.snap = true;
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Alt') { e.preventDefault(); build.snap = false; return; } // hold Alt = no snap
  if ((e.target as HTMLElement).closest('input, select, textarea')) return; // typing in the settings panel
  const k = e.key.toLowerCase();
  if (sweeper && (k === 'w' || k === 'a' || k === 's' || k === 'd')) { held.add(k); return; }
  if (sweeper && k === ' ') { e.preventDefault(); wantDump = true; return; }
  if (e.key in TOOL_KEYS) build.setTool(TOOL_KEYS[e.key]);
  else if (e.key === 'r' || e.key === 'R') build.rotate();
  else if (e.key === 'g' || e.key === 'G') build.cycleGrade();
  else if (e.key === 'h' || e.key === 'H') build.cyclePort();
  else if (e.key === 'q' || e.key === 'Q') build.nudgeElev(-1);
  else if (e.key === 'e' || e.key === 'E') build.nudgeElev(1);
  else if (e.key === '[') build.setLevel(build.level - 1);
  else if (e.key === ']') build.setLevel(build.level + 1);
});

// ---- settings panel: the controls live HERE, not in the URL bar --------------
const panel = document.createElement('div');
panel.style.cssText =
  'position:fixed;bottom:12px;right:12px;padding:10px 12px;border-radius:10px;' +
  'background:rgba(16,22,32,.88);border:1px solid #243044;font:12px/1.7 ui-monospace,monospace;' +
  'color:#cdd8e6;min-width:235px;z-index:10';
panel.innerHTML = `
  <div style="color:#ffd479;margin-bottom:4px">settings</div>
  <label>engine <select id="set-engine" style="float:right">
    <option value="fluid">GPU fluid</option><option value="cpu">CPU balls</option>
  </select></label><br>
  <label>traffic <select id="set-source" style="float:right">
    <option value="loft">live loft</option><option value="sim">sim</option><option value="storm">sim + storm</option>
  </select></label><br>
  <label>storm pps <input id="set-storm" type="number" min="10" max="20000" step="10" style="float:right;width:74px"></label><br>
  <label>pressure <span id="set-press-v" style="float:right;color:#6fdc8c"></span>
    <input id="set-press" type="range" min="100" max="3000" step="50" style="width:100%"></label>
  <label>viscosity <span id="set-visc-v" style="float:right;color:#6fdc8c"></span>
    <input id="set-visc" type="range" min="0" max="1" step="0.05" style="width:100%"></label>
  <button id="set-sweeper" style="width:100%;margin-top:6px">🚛 spawn sweeper</button>
  <label style="display:block;margin-top:2px"><input id="set-follow" type="checkbox" checked> camera follows vehicle</label>
  <div style="color:#7b8aa0;margin-top:2px">engine &amp; traffic apply on reload; sliders are live</div>`;
document.body.appendChild(panel);
{
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const selEngine = el<HTMLSelectElement>('set-engine');
  const selSource = el<HTMLSelectElement>('set-source');
  const inStorm = el<HTMLInputElement>('set-storm');
  const inPress = el<HTMLInputElement>('set-press');
  const inVisc = el<HTMLInputElement>('set-visc');
  const pv = el('set-press-v'), vv = el('set-visc-v');
  selEngine.value = settings.backend;
  selSource.value = settings.source;
  inStorm.value = String(settings.storm);
  inPress.value = String(settings.pressure);
  inVisc.value = String(settings.viscosity);
  const labels = () => { pv.textContent = inPress.value; vv.textContent = inVisc.value; };
  labels();
  selEngine.onchange = () => { settings.backend = selEngine.value as Settings['backend']; saveSettings(settings); location.reload(); };
  selSource.onchange = () => { settings.source = selSource.value as Settings['source']; saveSettings(settings); location.reload(); };
  inStorm.onchange = () => { settings.storm = Number(inStorm.value) || 500; saveSettings(settings); if (settings.source === 'storm') location.reload(); };
  inPress.oninput = () => { settings.pressure = Number(inPress.value); saveSettings(settings); if (fluid) fluid.stiffness.value = settings.pressure; labels(); };
  inVisc.oninput = () => { settings.viscosity = Number(inVisc.value); saveSettings(settings); if (fluid) fluid.viscosity.value = settings.viscosity; labels(); };
  const btnSweep = el<HTMLButtonElement>('set-sweeper');
  const chkFollow = el<HTMLInputElement>('set-follow');
  if (!fluid) { btnSweep.disabled = true; btnSweep.textContent = 'sweeper needs the GPU fluid engine'; }
  btnSweep.onclick = () => {
    if (!fluid || sweeper) return;
    sweeper = new Sweeper(view.scene);
    btnSweep.textContent = '🚛 sweeper active — WASD · Space dumps';
    btnSweep.disabled = true;
    log('sweeper', 'rolled out: WASD to drive, vacuum is always on, Space tips the bed');
  };
  chkFollow.onchange = () => { followCam = chkFollow.checked; };
}

// ---- main loop (physics runs off-thread in the worker) ----------------------
let lastHud = 0;
let prevFrame = performance.now();
function frame(now: number): void {
  const dtMs = now - prevFrame;
  prevFrame = now;
  controls.update();

  // drive the sweeper: kinematic on CPU, a moving boundary + vacuum on the GPU
  if (sweeper && fluid) {
    const dtSec = Math.min(dtMs / 1000, 0.05);
    sweeper.update(dtSec, {
      forward: (held.has('w') ? 1 : 0) - (held.has('s') ? 1 : 0),
      turn: (held.has('d') ? 1 : 0) - (held.has('a') ? 1 : 0),
    }, (x, z, refY) => build.heightAt(x, z, refY));
    fluid.setVehicles(sweeper.hullBoxes());
    const zone = sweeper.suctionZone();
    fluid.setSuction(zone ? [{ ...zone, id: 0 }] : []);
    if (wantDump) {
      wantDump = false;
      const items = sweeper.dump();
      const dp = sweeper.dumpPos();
      const back = sweeper.forward.multiplyScalar(-2);
      for (const it of items) {
        const jx = (Math.random() - 0.5) * 1.4, jz = (Math.random() - 0.5) * 1.4;
        fluid.spawn(it.frameId, new THREE.Vector3(dp.x + jx, dp.y, dp.z + jz),
          new THREE.Vector3(back.x, 0.8, back.z), BALL_RADIUS, it.color, it.spawnMs);
      }
      if (items.length) log('sweeper', `dumped ${items.length} packet(s)`);
    }
    // packets rot in the hopper past the loft TTL — drop them (counted, never silent)
    const nowMs = performance.now();
    sweeper.hopper = sweeper.hopper.filter((it) => {
      if (nowMs - it.spawnMs > 24_000) { bridge.drop(it.frameId); dropped++; return false; }
      return true;
    });
    if (followCam) controls.target.lerp(sweeper.pos, 0.08);
  }

  physics.render(); // pull the latest worker transforms into the InstancedMesh

  const tr = performance.now();
  view.render();
  const renderMs = performance.now() - tr;

  const s = physics.stats();
  perf.frame(now, {
    dtMs, workerMs: s.stepMs, renderMs,
    active: s.active, awake: s.awake,
    spawnedTotal: spawned, deliveredTotal: delivered, droppedTotal: dropped,
  });

  if (now - lastHud > 250) { lastHud = now; renderHud(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function hex(c: number): string { return '#' + c.toString(16).padStart(6, '0'); }
function renderHud(): void {
  const legend = [...ports.values()]
    .map((p) => {
      const sel = p.id === build.selectedPort;
      return `<span style="color:${hex(portColor(p.id))}">●</span> <span style="${sel ? 'text-decoration:underline;color:#fff' : ''}">${p.pod}</span>`;
    })
    .join('  ');
  const selName = build.selectedPort !== null ? (ports.get(build.selectedPort)?.pod ?? '?') : '—';
  const rampInfo = build.tool === 'ramp' ? ` <span style="color:#7b8aa0">(grade: ${build.gradeName} — G)</span>`
    : build.tool === 'corner' ? ` <span style="color:#7b8aa0">(turn: ${build.turnName} — G)</span>` : '';
  hudBody.innerHTML = `
    <div>state: <span class="k">${state}</span> · ports: ${ports.size}</div>
    <div>balls in play: <span class="k">${physics.stats().active}</span></div>
    <div>delivered: <span class="k">${delivered}</span> · dropped: <span class="warn">${dropped}</span></div>
    ${sweeper ? `<div>🚛 hopper <span class="${sweeper.hopper.length >= HOPPER_CAP ? 'warn' : 'k'}">${sweeper.hopper.length}/${HOPPER_CAP}</span> · WASD drive · Space dump</div>` : ''}
    <div style="margin-top:6px">${legend || '—'}</div>
    <div style="margin-top:6px;color:#7b8aa0">
      tool: <span class="k">${build.tool}</span>${rampInfo} · level <span class="k">${build.level}</span> · elev <span class="k">${build.ghostElev.toFixed(0)}</span> · host: <span class="k">${selName}</span><br>
      <b>1</b> none · <b>2</b> platform · <b>3</b> ramp · <b>4</b> corner · <b>5</b> wall · <b>6</b> belt · <b>7</b> dock · <b>8</b> sink · <b>0</b> erase<br>
      <b>R</b> rotate · <b>G</b> grade/turn · <b>Q/E</b> height · <b>Alt</b> no-snap · <b>H</b> host · <b>[ ]</b> level<br>
      left-click build · left-drag orbit · right-drag pan · wheel zoom
    </div>`;
}
