// Pigeon ISP — wire-up. Picks a bridge (live loft, or sim with fake pods),
// builds the world, routes input.
//
//   ?sim=1          force sim mode
//   ?storm=2000     sim mode + UDP packet storm at N pps (client benchmark)
//   ?bridge=ws://…  explicit loft URL
//   ?autoroute=1    BENCHMARK MODE: no physics — the consumer becomes a
//                   MAC-learning software switch and delivers every token
//                   immediately. Measures the webapp's raw ceiling and its
//                   per-frame decide time (docs/benchmarks.md).
import { Board, makeGhostBelt, makeGhostFilter, orientGhost } from './game/board';
import { PigeonManager, setSpeed } from './game/pigeons';
import { World } from './game/world';
import { SimBridge } from './net/simbridge';
import { WsBridge, defaultBridgeUrl } from './net/wsbridge';
import { Health } from './ui/health';
import { Hud, type Tool } from './ui/hud';
import { Speedtest } from './ui/speedtest';
import type { Bridge, BridgeEvents, FrameToken, LoftStats, PortInfo } from './types';

const params = new URLSearchParams(location.search);
const stormPps = Number(params.get('storm') ?? 0);
const forceSim = params.has('sim') || stormPps > 0;
const autoroute = params.has('autoroute');

const world = new World(document.getElementById('app')!);
const board = new Board(world.scene);
const hud = new Hud();

let bridge: Bridge;
const portsById = new Map<number, PortInfo>();
let totalDrops = 0;
let lastRxTotal = 0;
let currentPps = 0;
let tokensThisSecond = 0;
let bytesThisSecond = 0;

// Autoroute benchmark state: a MAC table and decide-time accounting.
const macTable = new Map<string, number>(); // "aa:bb:…" -> portId
let decideUsSum = 0;
let decideCount = 0;

function macKey(b: Uint8Array, off: number): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += b[off + i].toString(16).padStart(2, '0');
  return s;
}

/** The consumer-as-software-switch: learn src, forward by dst, flood
 *  broadcast/unknown to the other port. No physics, just the API. */
function autorouteToken(token: FrameToken): void {
  const t0 = performance.now();
  const b = token.snapshot;
  if (b.length >= 14) {
    macTable.set(macKey(b, 6), token.port);
    const dstPort = macTable.get(macKey(b, 0));
    if (dstPort !== undefined && dstPort !== token.port) {
      bridge.deliver(dstPort, token.id);
    } else {
      // broadcast or unknown dst: copy-deliver to every other port, then free.
      let copies = 0;
      for (const id of portsById.keys()) {
        if (id !== token.port) {
          bridge.copyDeliver(id, token.id);
          copies++;
        }
      }
      bridge.drop(token.id);
      if (copies === 0) { /* nowhere to go: counted as consumer drop */ }
    }
  } else {
    bridge.drop(token.id);
  }
  decideUsSum += (performance.now() - t0) * 1000;
  decideCount++;
}

const pigeons = new PigeonManager(
  world.scene,
  board,
  () => bridge,
  (pigeon, portId) => {
    hud.log('loft', `delivered: ${pigeon.decoded.summary} → port ${portId}`);
  },
);

const events: BridgeEvents = {
  onHello(ports: PortInfo[]) {
    portsById.clear();
    for (const p of ports) {
      portsById.set(p.id, p);
      board.addPort(p);
    }
    hud.log('loft', `hello: ${ports.length} port(s) roosting`);
  },
  onPortAdded(port) {
    portsById.set(port.id, port);
    board.addPort(port);
    hud.log('loft', `port up: ${port.namespace}/${port.pod} ${port.ip} (${port.mac})`);
  },
  onPortRemoved(id) {
    portsById.delete(id);
    board.removePort(id);
    hud.log('loft', `port down: ${id}`);
  },
  onToken(token: FrameToken) {
    tokensThisSecond++;
    bytesThisSecond += token.fullLen;
    if (autoroute) autorouteToken(token);
    else pigeons.enqueue(token);
  },
  onStats(stats: LoftStats) {
    let rxTotal = 0;
    let drops = stats.droppedNoConsumer;
    for (const s of Object.values(stats.ports)) {
      rxTotal += s.rxFrames;
      drops += s.drops.overflow + s.drops.ttl + s.drops.consumer;
    }
    currentPps = Math.max(0, rxTotal - lastRxTotal);
    lastRxTotal = rxTotal;
    totalDrops = drops + pigeons.droppedByMe;
  },
  onLog(who, line) {
    hud.log(who, line);
  },
  onState(state) {
    if (state === 'live') {
      everLive = true;
      hud.setBanner(null);
      hud.setMode('live');
      return;
    }
    if (state === 'down') {
      if (everLive || triedSim) {
        // We had a real loft (or sim is already running): never fall back —
        // another router may have bumped us, or the loft restarted. Keep
        // reconnecting; latest router wins, and that can be us again.
        hud.setMode('down');
        hud.setBanner('loft connection lost — reconnecting… (another router may have taken over)');
        return;
      }
      // Never connected at all: this machine probably has no cluster.
      triedSim = true;
      wsBridge?.close();
      hud.setBanner('loft unreachable — falling back to sim mode (?sim=1 to skip the wait)');
      startSim();
      return;
    }
    hud.setMode(state);
  },
};

let triedSim = false;
let everLive = false;
let wsBridge: WsBridge | null = null;
function startSim(): void {
  const sim = new SimBridge(events, stormPps);
  bridge = sim;
  sim.start();
}

if (forceSim) {
  triedSim = true;
  startSim();
} else {
  wsBridge = new WsBridge(defaultBridgeUrl(), events);
  bridge = wsBridge;
  wsBridge.connect();
}

// ---- input ------------------------------------------------------------------

let tool: Tool = 'belt';
let buildDir = 0;
let ejectSide: 1 | -1 = 1;
let painting = false;
let erasing = false;

const beltGhost = makeGhostBelt();
const filterGhost = makeGhostFilter();
beltGhost.visible = false;
filterGhost.visible = false;
world.scene.add(beltGhost);
world.scene.add(filterGhost);

function activeGhost() {
  return tool === 'belt' ? beltGhost : tool === 'filter' ? filterGhost : null;
}

hud.onToolChange = (t) => {
  tool = t;
  beltGhost.visible = false;
  filterGhost.visible = false;
  if (t !== 'select') hud.closeFilterPanel();
};
hud.setTool('belt');

// The floor persists; rebuild it before traffic arrives.
const restored = board.restore();
if (restored > 0) hud.log('pigeon-isp', `floor restored: ${restored} machine(s) from last session`);
board.onChange = () => board.save();

hud.bindSpeed(setSpeed);
hud.bindClearFloor(() => {
  board.clearFloor();
  hud.log('pigeon-isp', 'floor bulldozed');
});

function openFilterEditor(col: number, row: number): void {
  const cell = board.cellAt(col, row);
  if (cell?.type !== 'filter') return;
  hud.openFilterPanel(
    { config: cell.config, matchToSide: cell.matchToSide, side: cell.side, dir: cell.dir, error: cell.compiled.error },
    (s) => board.configureFilter(col, row, s.config, s.matchToSide, s.side, s.dir),
    () => {
      const c = board.cellAt(col, row);
      return c?.type === 'filter' ? { stats: c.stats, lastFrame: c.lastFrame } : null;
    },
  );
}

function paintAtPointer(): void {
  const hit = world.pickGround();
  if (!hit) return;
  const cell = board.worldToCell(hit);
  if (!cell) return;
  if (tool === 'belt' && painting) board.setBelt(cell.col, cell.row, buildDir);
  if (tool === 'erase' && erasing) board.eraseMachine(cell.col, cell.row);
}

window.addEventListener('pointermove', (e) => {
  world.setPointer(e.clientX, e.clientY);
  const ghost = activeGhost();
  if (ghost) {
    const hit = world.pickGround();
    const cell = hit ? board.worldToCell(hit) : null;
    if (cell) {
      ghost.visible = true;
      ghost.position.copy(board.cellToWorld(cell.col, cell.row, 0.05));
      orientGhost(ghost, buildDir);
    } else {
      ghost.visible = false;
    }
  }
  paintAtPointer();
});

window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest('.panel')) return;
  world.setPointer(e.clientX, e.clientY);

  if (tool === 'select') {
    // Pigeons first, then filter machines.
    const hit = world.pickObjects(pigeons.pickablesByMesh());
    let obj = hit?.object ?? null;
    while (obj && !obj.userData.pigeon) obj = obj.parent;
    if (obj?.userData.pigeon) {
      const p = obj.userData.pigeon;
      hud.inspect(p.decoded, p.token);
      return;
    }
    const fhit = world.pickObjects(board.filterMeshes());
    let fobj = fhit?.object ?? null;
    while (fobj && !fobj.userData.boardCell) fobj = fobj.parent;
    if (fobj?.userData.boardCell) {
      const { col, row } = fobj.userData.boardCell;
      openFilterEditor(col, row);
      return;
    }
    hud.closeInspector();
    hud.closeFilterPanel();
    return;
  }
  if (tool === 'filter') {
    // Filters place one per CLICK (no drag-paint: an accidental row of
    // default-programmed filters is how routers lie to you), and the editor
    // opens immediately.
    const hit = world.pickGround();
    const cell = hit ? board.worldToCell(hit) : null;
    if (cell) {
      board.setFilter(cell.col, cell.row, buildDir, ejectSide);
      openFilterEditor(cell.col, cell.row);
    }
    return;
  }
  painting = tool === 'belt';
  erasing = tool === 'erase';
  paintAtPointer();
});

window.addEventListener('pointerup', () => {
  painting = false;
  erasing = false;
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).matches('input, textarea, select')) return;
  if (e.key === '1') hud.setTool('select');
  if (e.key === '2') hud.setTool('belt');
  if (e.key === '3') hud.setTool('filter');
  if (e.key === '4') hud.setTool('erase');
  if (e.key === 'r' || e.key === 'R') {
    buildDir = (buildDir + 1) % 4;
    const ghost = activeGhost();
    if (ghost) orientGhost(ghost, buildDir);
  }
  if (e.key === 'e' || e.key === 'E') {
    ejectSide = ejectSide === 1 ? -1 : 1;
    hud.log('pigeon-isp', `filter eject side: ${ejectSide === 1 ? 'right' : 'left'}`);
  }
  if (e.key === 'Escape') {
    hud.closeInspector();
    hud.closeFilterPanel();
  }
});

// ---- loop -------------------------------------------------------------------

let last = performance.now();
let fpsCount = 0;
let fpsWindow = performance.now();

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  pigeons.update(dt);
  world.render();

  fpsCount++;
  if (now - fpsWindow >= 1000) {
    hud.setFps(fpsCount);
    const mbps = (bytesThisSecond * 8) / 1e6;
    const decideUs = decideCount > 0 ? decideUsSum / decideCount : null;
    hud.setStats(portsById.size, currentPps || tokensThisSecond, mbps, pigeons.pigeons.length, pigeons.queued(), totalDrops, decideUs);
    tokensThisSecond = 0;
    bytesThisSecond = 0;
    decideUsSum = 0;
    decideCount = 0;
    fpsCount = 0;
    fpsWindow = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

hud.log('pigeon-isp', 'welcome to the loft. paint belts (2), rotate with R, route the pigeons.');

// ---- views (factory / speedtest / health) -------------------------------------

new Speedtest();
const healthView = new Health();
const viewPanels: Record<string, HTMLElement | null> = {
  speedtest: document.getElementById('speedtest'),
  health: document.getElementById('health'),
};

document.querySelectorAll<HTMLButtonElement>('#views button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view!;
    document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('active', b === btn));
    for (const [name, panel] of Object.entries(viewPanels)) {
      if (panel) panel.style.display = name === view ? 'block' : 'none';
    }
    if (view === 'health') healthView.show();
    else healthView.hide();
  });
});
