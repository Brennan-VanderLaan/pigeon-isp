// Pigeon Ballpit — a second visualizer on the same engine.
//
// Every loft token becomes a BALL dropped from its ingress port's nozzle. You
// route packets by routing balls: tilt the table (left-drag) to roll each ball
// into a destination port's bin. A ball in a bin = deliver(port, frame); a ball
// that falls out or ages past the loft TTL = drop(frame). Same Pigeon API the
// belt game speaks (@pigeon/protocol) — nothing here knows about belts.
//
//   ?sim=1          force the offline sim (two fake pods, no cluster)
//   ?storm=2000     sim + a UDP storm at N pps (stress the ball factory)
//   ?bridge=ws://…  explicit loft URL
import {
  SimBridge, WsBridge, defaultBridgeUrl, decodeFrame, KIND_COLORS,
  type Bridge, type BridgeEvents, type FrameToken, type LoftStats, type PortInfo,
} from '@pigeon/protocol';
import * as THREE from 'three';
import { Scene } from './scene';
import { Physics } from './physics';
import { Arena, portColor } from './arena';
import { Balls } from './balls';
import { Build, type Tool } from './build';

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

const physics = await Physics.create();
const view = new Scene(document.getElementById('app')!);
const arena = new Arena(view.scene, physics);
const balls = new Balls(view.scene, physics);
view.scene.add(balls.mesh);
const build = new Build(view.scene, physics);

const ports = new Map<number, PortInfo>();
let state = 'connecting';
let delivered = 0;
let dropped = 0;
let mismatched = 0; // balls landed in a bin, but caller had no record (already gone)

function relayout(): void {
  arena.setPorts([...ports.values()].map((p) => ({ id: p.id, label: p.pod })));
}

const events: BridgeEvents = {
  onHello(list) {
    ports.clear();
    for (const p of list) ports.set(p.id, p);
    relayout();
    log('loft', `hello: ${list.length} port(s)`);
  },
  onPortAdded(p) { ports.set(p.id, p); relayout(); log('loft', `port up: ${p.pod}`); },
  onPortRemoved(id) { ports.delete(id); relayout(); log('loft', `port down: ${id}`); },
  onToken(token: FrameToken) {
    const nozzle = arena.nozzleFor(token.port);
    if (!nozzle) { bridge.drop(token.id); return; } // unknown ingress: free it
    const d = decodeFrame(token.snapshot, token.fullLen);
    const color = KIND_COLORS[d.kind] ?? 0xffffff;
    if (!balls.spawn(token.id, token.port, nozzle, color, performance.now())) {
      bridge.drop(token.id); // factory full — shed load, counted
      dropped++;
    }
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
}

// ---- input: RIGHT-drag tilts the table, LEFT builds -------------------------
const MAX_TILT = 14;
let tiltX = 0, tiltZ = 0, tilting = false, sx = 0, sy = 0;
const canvas = view.renderer.domElement;
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 2) { tilting = true; sx = e.clientX; sy = e.clientY; canvas.setPointerCapture(e.pointerId); return; }
  if (e.button === 0 && build.tool !== 'none') build.click();
});
canvas.addEventListener('pointermove', (e) => {
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, view.camera);
  build.hoverAt(raycaster.ray);
  if (tilting) {
    tiltX = clamp(((e.clientX - sx) / window.innerWidth) * 2 * MAX_TILT, -MAX_TILT, MAX_TILT);
    tiltZ = clamp(((e.clientY - sy) / window.innerHeight) * 2 * MAX_TILT, -MAX_TILT, MAX_TILT);
  }
});
canvas.addEventListener('pointerup', () => { tilting = false; });
function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

const TOOL_KEYS: Record<string, Tool> = { '1': 'none', '2': 'conveyor', '3': 'chute', '0': 'erase' };
window.addEventListener('keydown', (e) => {
  if (e.key in TOOL_KEYS) build.setTool(TOOL_KEYS[e.key]);
  else if (e.key === 'r' || e.key === 'R') build.rotate();
  else if (e.key === '[') build.setLevel(build.level - 1);
  else if (e.key === ']') build.setLevel(build.level + 1);
});

// ---- main loop --------------------------------------------------------------
let lastHud = 0;
function frame(now: number): void {
  if (!tilting) { tiltX *= 0.9; tiltZ *= 0.9; } // ease back to level
  physics.setTilt(tiltX, tiltZ);

  const hits = physics.step();
  for (const [frameId, portId] of hits) {
    if (balls.catch(frameId)) {
      bridge.deliver(portId, frameId);
      delivered++;
      if (ports.get(portId)) log('deliver', `ball → ${ports.get(portId)!.pod}`);
    } else {
      mismatched++;
    }
  }

  balls.applyField((x, y, z) => build.fieldAt(x, y, z)); // conveyors push balls
  const expired = balls.sync(now);
  for (const id of expired) { bridge.drop(id); dropped++; }

  if (now - lastHud > 250) { lastHud = now; renderHud(); }
  view.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function renderHud(): void {
  const legend = [...ports.values()]
    .map((p) => `<span style="color:#${portColor(p.id).toString(16).padStart(6, '0')}">●</span> ${p.pod}`)
    .join('  ');
  hudBody.innerHTML = `
    <div>state: <span class="k">${state}</span> · ports: ${ports.size}</div>
    <div>balls in play: <span class="k">${balls.count}</span></div>
    <div>delivered: <span class="k">${delivered}</span> · dropped: <span class="warn">${dropped}</span></div>
    <div style="margin-top:6px">${legend || '—'}</div>
    <div style="margin-top:6px;color:#7b8aa0">
      tool: <span class="k">${build.tool}</span> · level <span class="k">${build.level}</span><br>
      <b>1</b> none · <b>2</b> conveyor · <b>3</b> chute · <b>0</b> erase · <b>R</b> rotate · <b>[ ]</b> level<br>
      right-drag tilt · left-click build · wheel zoom
    </div>`;
}
