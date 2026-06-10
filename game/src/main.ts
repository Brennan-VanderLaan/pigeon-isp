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
import * as THREE from 'three';
import { Board, makeGhostBelt, makeGhostFilter, makeGhostHub, makeGhostLearn, makeGhostLookup, makeGhostMeter, makeGhostMidi, orientGhost } from './game/board';
import { fdbRows } from './game/machines';
import { midi, triggerMidi } from './game/midi';
import { tableRows } from './game/tables';
import { decodeFrame } from './net/decode';
import { sampleFrame } from './game/filters';
import { PigeonManager, setSpeed } from './game/pigeons';
import { World } from './game/world';
import { SimBridge } from './net/simbridge';
import { WsBridge, defaultBridgeUrl } from './net/wsbridge';
import { Health } from './ui/health';
import { Hosts } from './ui/hosts';
import { Hud, type Tool } from './ui/hud';
import { Speedtest } from './ui/speedtest';
import { PodTerminal, restoreTerminals } from './ui/terminal';
import { Vpn } from './ui/vpn';
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
    latestStats = stats; // roost diagnostics read per-pod counters from here
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

let switchDragStart: { col: number; row: number } | null = null;
let switchDragEnd: { col: number; row: number } | null = null;

const ghosts: Record<string, THREE.Group> = {
  belt: makeGhostBelt(),
  filter: makeGhostFilter(),
  hub: makeGhostHub(),
  meter: makeGhostMeter(),
  midi: makeGhostMidi(),
  learn: makeGhostLearn(),
  lookup: makeGhostLookup(),
};
for (const g of Object.values(ghosts)) {
  g.visible = false;
  world.scene.add(g);
}

function activeGhost(): THREE.Group | null {
  return ghosts[tool] ?? null;
}

hud.onToolChange = (t) => {
  tool = t;
  for (const g of Object.values(ghosts)) g.visible = false;
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

// The appliance the player is currently editing ports on (select tool).
let activeApplianceId: number | null = null;

function openMachineInspector(col: number, row: number): void {
  const cell = board.cellAt(col, row);
  if (!cell) return;
  if (cell.type === 'filter') {
    activeApplianceId = null;
    hud.openFilterPanel(
      { config: cell.config, matchDir: cell.matchDir, defaultDir: cell.defaultDir, error: cell.compiled.error },
      (s) => board.configureFilter(col, row, s.config, s.matchDir, s.defaultDir),
      () => {
        const c = board.cellAt(col, row);
        return c?.type === 'filter' ? { stats: c.stats, lastFrame: c.lastFrame } : null;
      },
    );
  } else if (cell.type === 'appliance-body' || cell.type === 'appliance-port-in' ||
             cell.type === 'appliance-port-out' || cell.type === 'appliance-pending') {
    const app = board.applianceAt(col, row);
    if (!app) return;
    activeApplianceId = app.id;
    hud.openSwitchPanel(app.id, () => {
      const a = board.getAppliance(app.id);
      if (!a) return null;
      return {
        ports: a.ports.length, rows: fdbRows(a.state, performance.now()),
        floods: a.state.floods, forwards: a.state.forwards, filters: a.state.filters, ttlMs: a.state.ttlMs,
      };
    });
  } else if (cell.type === 'meter') {
    activeApplianceId = null;
    hud.openMeterPanel(
      { limit: cell.state.limit, mode: cell.state.mode, defaultDir: cell.defaultDir, overflowDir: cell.overflowDir },
      (limit, mode, dd, od) => board.configureMeter(col, row, limit, mode, dd, od),
      () => {
        const c = board.cellAt(col, row);
        return c?.type === 'meter' ? { rate: c.state.rate, total: c.state.total, diverted: c.state.diverted, mode: c.state.mode } : null;
      },
    );
  } else if (cell.type === 'hub') {
    activeApplianceId = null;
    hud.openHubPanel(() => {
      const c = board.cellAt(col, row);
      return c?.type === 'hub' ? c.count : null;
    });
  } else if (cell.type === 'learn') {
    activeApplianceId = null;
    hud.openTablePanel('learn',
      { table: cell.table, keyField: cell.keyField, missDir: 0 },
      () => board.tableNames(),
      (table, kf) => board.configureLearn(col, row, table, kf),
      () => {
        const c = board.cellAt(col, row);
        if (c?.type !== 'learn') return null;
        return { rows: tableRows(board.getTable(c.table), performance.now()), writes: c.writes };
      },
    );
  } else if (cell.type === 'lookup') {
    activeApplianceId = null;
    hud.openTablePanel('lookup',
      { table: cell.table, keyField: cell.keyField, missDir: cell.missDir },
      () => board.tableNames(),
      (table, kf, miss) => board.configureLookup(col, row, table, kf, miss),
      () => {
        const c = board.cellAt(col, row);
        if (c?.type !== 'lookup') return null;
        return { rows: tableRows(board.getTable(c.table), performance.now()), hits: c.hits, misses: c.misses };
      },
    );
  } else if (cell.type === 'midi') {
    activeApplianceId = null;
    // Test plays a sample frame through the live config.
    hud.midiTest = () => {
      const c = board.cellAt(col, row);
      if (c?.type === 'midi') triggerMidi(c.cfg, decodeFrame(sampleFrame(), 590), sampleFrame());
    };
    hud.openMidiPanel(
      { ...cell.cfg },
      (cfg) => board.configureMidi(col, row, cfg),
      () => midi.enable(),
      () => ({ ready: midi.ready, error: midi.error, outputs: midi.outputs() }),
      () => { const c = board.cellAt(col, row); return c?.type === 'midi' ? { fired: c.fired, lastNotes: c.lastNotes } : null; },
    );
  }
}

function paintAtPointer(): void {
  const hit = world.pickGround();
  if (!hit) return;
  const cell = board.worldToCell(hit);
  if (!cell) return;
  if (tool === 'belt' && painting) board.setBelt(cell.col, cell.row, buildDir);
  if (tool === 'hub' && painting) board.setHub(cell.col, cell.row);
  if (tool === 'midi' && painting) board.setMidi(cell.col, cell.row, buildDir);
  if (tool === 'learn' && painting) board.setLearn(cell.col, cell.row, buildDir);
  if (tool === 'lookup' && painting) board.setLookup(cell.col, cell.row, buildDir, (buildDir + ejectSide + 4) % 4);
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
  if (tool === 'switch' && switchDragStart) {
    const hit = world.pickGround();
    const cell = hit ? board.worldToCell(hit) : null;
    if (cell) switchDragEnd = cell;
  }
  paintAtPointer();
});

window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // Clicks inside any UI chrome (panels, the roost popover, terminal windows,
  // the taskbar) must not also drive the board — this is what swallowed the
  // roost "shell" button before.
  if ((e.target as HTMLElement).closest('.panel, #roost-pop, .term-win, #term-taskbar, .fullpanel, #views')) return;
  world.setPointer(e.clientX, e.clientY);

  if (tool === 'select') {
    // Pigeons first (world objects above the floor).
    const hit = world.pickObjects(pigeons.pickablesByMesh());
    let obj = hit?.object ?? null;
    while (obj && !obj.userData.pigeon) obj = obj.parent;
    if (obj?.userData.pigeon) {
      hud.inspect(obj.userData.pigeon.decoded, obj.userData.pigeon.token);
      return;
    }
    // Otherwise dispatch by what's under the cursor on the floor.
    const g = world.pickGround();
    const cell = g ? board.worldToCell(g) : null;
    if (!cell) { hud.closeInspector(); hud.closeFilterPanel(); activeApplianceId = null; return; }
    // Editing an appliance's ports: clicking its perimeter toggles a port.
    if (activeApplianceId !== null) {
      const app = board.getAppliance(activeApplianceId);
      if (app && app.cells.has(`${cell.col},${cell.row}`)) {
        const hint = board.togglePort(activeApplianceId, cell.col, cell.row);
        if (hint) hud.log('switch', hint);
        return;
      }
    }
    const c = board.cellAt(cell.col, cell.row);
    if (c?.type === 'roost') {
      showRoostDiagnostics(c.port, e.clientX, e.clientY);
    } else if (c && c.type !== 'landing' && c.type !== 'belt') {
      roostPop.style.display = 'none';
      openMachineInspector(cell.col, cell.row);
    } else {
      roostPop.style.display = 'none';
      hud.closeInspector(); hud.closeFilterPanel(); activeApplianceId = null;
    }
    return;
  }
  if (tool === 'filter') {
    const hit = world.pickGround();
    const cell = hit ? board.worldToCell(hit) : null;
    if (cell) {
      const matchDir = (buildDir + ejectSide + 4) % 4;
      board.setFilter(cell.col, cell.row, matchDir, buildDir);
      openMachineInspector(cell.col, cell.row);
    }
    return;
  }
  if (tool === 'meter') {
    const hit = world.pickGround();
    const cell = hit ? board.worldToCell(hit) : null;
    if (cell) {
      board.setMeter(cell.col, cell.row, buildDir, (buildDir + ejectSide + 4) % 4);
      openMachineInspector(cell.col, cell.row);
    }
    return;
  }
  if (tool === 'switch') {
    // Drag a rectangle for the switch body.
    const hit = world.pickGround();
    const cell = hit ? board.worldToCell(hit) : null;
    if (cell) { switchDragStart = cell; switchDragEnd = cell; }
    return;
  }
  painting = tool === 'belt' || tool === 'hub' || tool === 'midi' || tool === 'learn' || tool === 'lookup';
  erasing = tool === 'erase';
  paintAtPointer();
});

window.addEventListener('pointerup', () => {
  painting = false;
  erasing = false;
  if (tool === 'switch' && switchDragStart && switchDragEnd) {
    const id = board.createSwitch(switchDragStart.col, switchDragStart.row, switchDragEnd.col, switchDragEnd.row);
    if (id !== null) {
      hud.setTool('select');
      activeApplianceId = id;
      openMachineInspector(switchDragStart.col, switchDragStart.row);
      hud.log('pigeon-isp', 'switch placed — click its edge cells to add ports');
    }
  }
  switchDragStart = null;
  switchDragEnd = null;
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).matches('input, textarea, select')) return;
  if (e.key === '1') hud.setTool('select');
  if (e.key === '2') hud.setTool('belt');
  if (e.key === '3') hud.setTool('filter');
  if (e.key === '4') hud.setTool('hub');
  if (e.key === '5') hud.setTool('switch');
  if (e.key === '6') hud.setTool('meter');
  if (e.key === '7') hud.setTool('midi');
  if (e.key === '8') hud.setTool('learn');
  if (e.key === '9') hud.setTool('lookup');
  if (e.key === '0') hud.setTool('erase');
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
    board.updateBadges();
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

// Rejoin any pod shells that survived a reload (sessions live tower-side).
restoreTerminals();

// ---- views (factory / hosts / speedtest / health) -----------------------------

new Speedtest();
const healthView = new Health();
const hostsView = new Hosts();
const vpnView = new Vpn();
const viewPanels: Record<string, HTMLElement | null> = {
  hosts: document.getElementById('hosts'),
  vpn: document.getElementById('vpn'),
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
    if (view === 'health') healthView.show(); else healthView.hide();
    if (view === 'hosts') hostsView.show(); else hostsView.hide();
    if (view === 'vpn') vpnView.show(); else vpnView.hide();
  });
});

// ---- roost diagnostics: click a host's roost in the Factory view --------------

const roostPop = document.getElementById('roost-pop')!;
let latestStats: LoftStats | null = null;

function showRoostDiagnostics(port: PortInfo, clientX: number, clientY: number): void {
  const s = latestStats?.ports?.[port.pod];
  const drops = s ? s.drops.overflow + s.drops.ttl + s.drops.consumer : 0;
  roostPop.style.display = 'block';
  roostPop.style.left = Math.min(clientX, window.innerWidth - 280) + 'px';
  roostPop.style.top = Math.min(clientY, window.innerHeight - 240) + 'px';
  roostPop.innerHTML = `
    <h3>▲ ${esc(port.pod)}</h3>
    <table>
      <tr><td>ip</td><td>${esc(port.ip)}</td></tr>
      <tr><td>mac</td><td>${esc(port.mac)}</td></tr>
      <tr><td>node</td><td>${esc(port.node ?? '?')}</td></tr>
      <tr><td>ns</td><td>${esc(port.namespace)}</td></tr>
      <tr><td>rx</td><td>${s ? s.rxFrames + ' frames' : '—'}</td></tr>
      <tr><td>tx</td><td>${s ? s.txFrames + ' frames' : '—'}</td></tr>
      <tr><td>drops</td><td>${drops}</td></tr>
    </table>
    <div class="row">
      <button id="rp-shell">shell</button>
      <button id="rp-close">close</button>
    </div>`;
  roostPop.querySelector('#rp-shell')!.addEventListener('click', () => {
    new PodTerminal(port.pod, port.namespace || 'aviary');
    roostPop.style.display = 'none';
  });
  roostPop.querySelector('#rp-close')!.addEventListener('click', () => { roostPop.style.display = 'none'; });
}

function esc(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
