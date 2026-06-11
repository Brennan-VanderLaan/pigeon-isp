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
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Scene } from './scene';
import { PhysicsClient } from './physics-client';
import { Arena, portColor } from './arena';
import { Build, CELL, FLOOR_H, type Tool } from './build';
import { Perf } from './perf';

const params = new URLSearchParams(location.search);
const stormPps = Number(params.get('storm') ?? 0);
const forceSim = params.has('sim') || stormPps > 0;

const hudBody = document.getElementById('hud-body')!;
const logEl = document.getElementById('log')!;
function log(who: string, line: string): void {
  const d = document.createElement('div');
  d.textContent = `${who}  ${line}`;
  logEl.prepend(d);
  while (logEl.childElementCount > 14) logEl.lastChild!.remove();
}

const view = new Scene(document.getElementById('app')!);
const perf = new Perf();

const ports = new Map<number, PortInfo>();
let state = 'connecting';
let spawned = 0;
let delivered = 0;
let dropped = 0;

// Physics + ball rendering live behind the worker client. Deliveries/losses
// come back as events we relay to the loft.
const BALL_RADIUS = 0.35;
const physics = new PhysicsClient(view.scene, {
  onSpawned(items) { spawned += items.length; },
  onGone(deliveredList, droppedList) {
    for (const [frameId, port] of deliveredList) {
      bridge.deliver(port, frameId);
      delivered++;
    }
    for (const frameId of droppedList) { bridge.drop(frameId); dropped++; }
  },
}, { cell: CELL, floorH: FLOOR_H, radius: BALL_RADIUS });

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
  '1': 'none', '2': 'platform', '3': 'ramp', '4': 'conveyor', '5': 'host', '6': 'sink', '0': 'erase',
};
window.addEventListener('keydown', (e) => {
  if (e.key in TOOL_KEYS) build.setTool(TOOL_KEYS[e.key]);
  else if (e.key === 'r' || e.key === 'R') build.rotate();
  else if (e.key === 'g' || e.key === 'G') build.cycleGrade();
  else if (e.key === 'h' || e.key === 'H') build.cyclePort();
  else if (e.key === '[') build.setLevel(build.level - 1);
  else if (e.key === ']') build.setLevel(build.level + 1);
});

// ---- main loop (physics runs off-thread in the worker) ----------------------
let lastHud = 0;
let prevFrame = performance.now();
function frame(now: number): void {
  const dtMs = now - prevFrame;
  prevFrame = now;
  controls.update();
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
  const rampInfo = build.tool === 'ramp' ? ` <span style="color:#7b8aa0">(grade: ${build.gradeName} — G)</span>` : '';
  hudBody.innerHTML = `
    <div>state: <span class="k">${state}</span> · ports: ${ports.size}</div>
    <div>balls in play: <span class="k">${physics.stats().active}</span></div>
    <div>delivered: <span class="k">${delivered}</span> · dropped: <span class="warn">${dropped}</span></div>
    <div style="margin-top:6px">${legend || '—'}</div>
    <div style="margin-top:6px;color:#7b8aa0">
      tool: <span class="k">${build.tool}</span>${rampInfo} · level <span class="k">${build.level}</span> · host: <span class="k">${selName}</span><br>
      <b>1</b> none · <b>2</b> platform · <b>3</b> ramp · <b>4</b> conveyor · <b>5</b> dock · <b>6</b> sink · <b>0</b> erase<br>
      <b>R</b> rotate · <b>G</b> grade · <b>H</b> next host · <b>[ ]</b> level<br>
      left-click build · left-drag orbit · right-drag pan · wheel zoom
    </div>`;
}
