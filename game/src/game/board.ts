// The factory floor: a grid of cells. Every port (host) gets TWO structures
// on the perimeter — a ROOST where its outgoing frames spawn, and a LANDING
// pad where you drop frames bound for it. Separate in/out locations is what
// makes belt routing tractable (the factorio rule: inputs and outputs never
// share a tile).
//
// Interior cells hold player-built machinery: belts and filter machines.
// The floor persists to localStorage — your router survives a refresh.
import * as THREE from 'three';
import type { PortInfo } from '../types';
import {
  DIR_ARROWS, compileFilter, describeFilter, legacyExits, newFilterStats,
  type CompiledFilter, type FilterConfig, type FilterStats,
} from './filters';
import {
  meterLabel, newMeterState, newSwitchState, switchStep,
  type MeterMode, type MeterState, type SwitchState,
} from './machines';
import type { Decoded } from '../net/decode';
import type { Emission } from './pigeons';

export const COLS = 28;
export const ROWS = 16;
export const CELL = 1;

/** 0=+x (east), 1=+z (south), 2=-x (west), 3=-z (north) */
export const DIRS = [
  { dx: 1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: -1 },
];

export type Cell =
  | { type: 'belt'; dir: number; mesh: THREE.Group }
  | {
      type: 'filter'; matchDir: number; defaultDir: number;
      config: FilterConfig; compiled: CompiledFilter; mesh: THREE.Group;
      stats: FilterStats; lastFrame?: Uint8Array;
    }
  | { type: 'hub'; count: number; mesh: THREE.Group }
  | { type: 'meter'; state: MeterState; defaultDir: number; overflowDir: number; mesh: THREE.Group }
  // Multi-cell appliance: a body cell (solid) or a numbered port cell.
  | { type: 'appliance-body'; applianceId: number }
  | { type: 'appliance-port'; applianceId: number; portIndex: number; dir: number }
  | { type: 'roost'; port: PortInfo; facing: number; mesh: THREE.Group }
  | { type: 'landing'; port: PortInfo; mesh: THREE.Group };

/** A multi-cell switch (or future router). Frames enter at a port, the FDB
 *  decides, they leave at exit port(s). IEEE 802.1D. */
export interface Appliance {
  id: number;
  kind: 'switch';
  cells: Set<string>; // body + port cells, "col,row"
  ports: AppliancePort[]; // numbered in placement order
  state: SwitchState;
  group: THREE.Group;
}

export interface AppliancePort {
  col: number;
  row: number;
  dir: number; // outward compass direction (the edge it sits on)
  index: number;
}

export interface PortLoc {
  roost: { col: number; row: number };
  landing: { col: number; row: number };
  facing: number;
}

// Roost/landing pairs around the perimeter (roost first, landing two cells
// over), generated: 2 pairs per edge = 8 hosts. The sandbox spawns hosts at
// runtime; the floor has to keep up.
const SLOTS: PortLoc[] = (() => {
  const out: PortLoc[] = [];
  for (const row of [3, 10]) {
    out.push({ roost: { col: 0, row }, landing: { col: 0, row: row + 2 }, facing: 0 });
    out.push({ roost: { col: COLS - 1, row }, landing: { col: COLS - 1, row: row + 2 }, facing: 2 });
  }
  for (const col of [9, 17]) {
    out.push({ roost: { col, row: 0 }, landing: { col: col + 2, row: 0 }, facing: 1 });
    out.push({ roost: { col, row: ROWS - 1 }, landing: { col: col + 2, row: ROWS - 1 }, facing: 3 });
  }
  return out;
})();

const STORE_KEY = 'pigeon-isp-floor-v1';

const beltBase = new THREE.BoxGeometry(CELL * 0.94, 0.08, CELL * 0.94);
const beltBaseMat = new THREE.MeshStandardMaterial({ color: 0x232c3a, roughness: 0.9 });
const filterBaseMat = new THREE.MeshStandardMaterial({ color: 0x2d2438, roughness: 0.8 });
const arrowGeo = new THREE.ConeGeometry(0.16, 0.42, 4);
const arrowMat = new THREE.MeshStandardMaterial({ color: 0xffb347, roughness: 0.6 });
const sideArrowMat = new THREE.MeshStandardMaterial({ color: 0xb98aff, roughness: 0.6 });

function key(col: number, row: number): string {
  return col + ',' + row;
}

export class Board {
  cells = new Map<string, Cell>();
  private portLocs = new Map<number, PortLoc>();
  private usedSlots = new Set<number>();
  private appliances = new Map<number, Appliance>();
  private nextApplianceId = 1;
  readonly group = new THREE.Group();
  onChange: () => void = () => {};

  constructor(scene: THREE.Scene) {
    scene.add(this.group);

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(COLS * CELL + 1.5, 0.3, ROWS * CELL + 1.5),
      new THREE.MeshStandardMaterial({ color: 0x141a24, roughness: 1 }),
    );
    floor.position.y = -0.18;
    this.group.add(floor);

    const grid = new THREE.GridHelper(Math.max(COLS, ROWS) * CELL, Math.max(COLS, ROWS), 0x2c3442, 0x222a36);
    grid.position.y = 0.01;
    grid.scale.set(COLS / Math.max(COLS, ROWS), 1, ROWS / Math.max(COLS, ROWS));
    this.group.add(grid);
  }

  cellToWorld(col: number, row: number, y = 0): THREE.Vector3 {
    return new THREE.Vector3((col - (COLS - 1) / 2) * CELL, y, (row - (ROWS - 1) / 2) * CELL);
  }

  worldToCell(p: THREE.Vector3): { col: number; row: number } | null {
    const col = Math.round(p.x / CELL + (COLS - 1) / 2);
    const row = Math.round(p.z / CELL + (ROWS - 1) / 2);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
    return { col, row };
  }

  cellAt(col: number, row: number): Cell | undefined {
    return this.cells.get(key(col, row));
  }

  // ---- machinery (belts + filters) -------------------------------------------

  setBelt(col: number, row: number, dir: number): void {
    if (!this.clearForBuild(col, row)) return;
    const existing = this.cells.get(key(col, row));
    if (existing?.type === 'belt' && existing.dir === dir) return;
    this.removeMachine(col, row);
    const mesh = makeBeltMesh(dir);
    mesh.position.copy(this.cellToWorld(col, row, 0.04));
    this.group.add(mesh);
    this.cells.set(key(col, row), { type: 'belt', dir, mesh });
    this.onChange();
  }

  setFilter(col: number, row: number, matchDir: number, defaultDir: number, config?: FilterConfig): void {
    if (!this.clearForBuild(col, row)) return;
    this.removeMachine(col, row);
    const cfg = config ?? { field: 'kind', value: 'arp' };
    const mesh = makeFilterMesh(matchDir, defaultDir);
    mesh.position.copy(this.cellToWorld(col, row, 0.04));
    mesh.userData.boardCell = { col, row };
    attachRuleLabel(mesh, cfg, matchDir, defaultDir);
    this.group.add(mesh);
    this.cells.set(key(col, row), {
      type: 'filter', matchDir, defaultDir, config: cfg, compiled: compileFilter(cfg), mesh,
      stats: newFilterStats(),
    });
    this.onChange();
  }

  /** Update a filter's config in place (from the config panel). */
  configureFilter(col: number, row: number, config: FilterConfig, matchDir: number, defaultDir: number): string | undefined {
    const c = this.cells.get(key(col, row));
    if (c?.type !== 'filter') return;
    c.config = config;
    if (c.matchDir !== matchDir || c.defaultDir !== defaultDir) {
      c.matchDir = matchDir;
      c.defaultDir = defaultDir;
      this.group.remove(c.mesh);
      c.mesh = makeFilterMesh(matchDir, defaultDir);
      c.mesh.position.copy(this.cellToWorld(col, row, 0.04));
      c.mesh.userData.boardCell = { col, row };
      this.group.add(c.mesh);
    }
    attachRuleLabel(c.mesh, config, matchDir, defaultDir);
    c.compiled = compileFilter(config);
    c.stats = newFilterStats(); // new rule, fresh score
    this.onChange();
    return c.compiled.error;
  }

  setHub(col: number, row: number): void {
    if (!this.clearForBuild(col, row)) return;
    this.removeMachine(col, row);
    const mesh = makeHubMesh();
    mesh.position.copy(this.cellToWorld(col, row, 0.04));
    mesh.userData.boardCell = { col, row };
    this.group.add(mesh);
    this.cells.set(key(col, row), { type: 'hub', count: 0, mesh });
    this.onChange();
  }

  setMeter(col: number, row: number, defaultDir: number, overflowDir: number, limit = 100, mode: MeterMode = 'pps'): void {
    if (!this.clearForBuild(col, row)) return;
    this.removeMachine(col, row);
    const mesh = makeMeterMesh(defaultDir, overflowDir);
    mesh.position.copy(this.cellToWorld(col, row, 0.04));
    mesh.userData.boardCell = { col, row };
    this.group.add(mesh);
    this.cells.set(key(col, row), {
      type: 'meter', state: newMeterState(limit, mode), defaultDir, overflowDir, mesh,
    });
    this.onChange();
  }

  configureMeter(col: number, row: number, limit: number, mode: MeterMode, defaultDir: number, overflowDir: number): void {
    const c = this.cells.get(key(col, row));
    if (c?.type !== 'meter') return;
    c.state.limit = limit;
    if (c.state.mode !== mode) {
      c.state.mode = mode;
      c.state.tokens = limit; // fresh bucket on a unit change
    }
    if (c.defaultDir !== defaultDir || c.overflowDir !== overflowDir) {
      c.defaultDir = defaultDir;
      c.overflowDir = overflowDir;
      this.group.remove(c.mesh);
      c.mesh = makeMeterMesh(defaultDir, overflowDir);
      c.mesh.position.copy(this.cellToWorld(col, row, 0.04));
      c.mesh.userData.boardCell = { col, row };
      this.group.add(c.mesh);
    }
    this.onChange();
  }

  // ---- appliances (multi-cell switches) --------------------------------------

  /** Lay a switch body over a rectangle. Cells already holding a host are
   *  skipped; returns the new appliance id, or null if nothing was placed. */
  createSwitch(c0: number, r0: number, c1: number, r1: number): number | null {
    const minC = Math.max(0, Math.min(c0, c1));
    const maxC = Math.min(COLS - 1, Math.max(c0, c1));
    const minR = Math.max(0, Math.min(r0, r1));
    const maxR = Math.min(ROWS - 1, Math.max(r0, r1));
    const cells = new Set<string>();
    for (let col = minC; col <= maxC; col++) {
      for (let row = minR; row <= maxR; row++) {
        const ex = this.cells.get(key(col, row));
        if (ex && !Board.isMachine(ex.type)) continue; // don't pave a host
        cells.add(key(col, row));
      }
    }
    if (cells.size < 2) return null;

    // Clear any machines under the footprint first.
    for (const k of cells) {
      const [col, row] = k.split(',').map(Number);
      this.removeMachine(col, row);
    }

    const id = this.nextApplianceId++;
    const group = new THREE.Group();
    this.group.add(group);
    const app: Appliance = { id, kind: 'switch', cells, ports: [], state: newSwitchState(), group };
    this.appliances.set(id, app);
    for (const k of cells) {
      this.cells.set(k, { type: 'appliance-body', applianceId: id });
    }
    this.rebuildApplianceMesh(app);
    this.onChange();
    return id;
  }

  /** Toggle a perimeter cell of an appliance as a numbered port. */
  togglePort(applianceId: number, col: number, row: number): void {
    const app = this.appliances.get(applianceId);
    if (!app || !app.cells.has(key(col, row))) return;
    const dir = this.edgeDir(app, col, row);
    if (dir < 0) return; // interior cell: can't be a port

    const existing = app.ports.findIndex((p) => p.col === col && p.row === row);
    if (existing >= 0) {
      app.ports.splice(existing, 1);
      app.ports.forEach((p, i) => (p.index = i)); // renumber
      this.cells.set(key(col, row), { type: 'appliance-body', applianceId });
    } else {
      const port: AppliancePort = { col, row, dir, index: app.ports.length };
      app.ports.push(port);
      this.cells.set(key(col, row), { type: 'appliance-port', applianceId, portIndex: port.index, dir });
    }
    this.rebuildApplianceMesh(app);
    this.onChange();
  }

  /** Which outward edge is (col,row) on? -1 if interior (not on the hull). */
  private edgeDir(app: Appliance, col: number, row: number): number {
    const has = (c: number, r: number) => app.cells.has(key(c, r));
    // A cell is a port candidate on the edge where it has no body neighbor.
    if (!has(col, row - 1)) return 3; // north open
    if (!has(col + 1, row)) return 0; // east open
    if (!has(col, row + 1)) return 1; // south open
    if (!has(col - 1, row)) return 2; // west open
    return -1;
  }

  applianceAt(col: number, row: number): Appliance | undefined {
    const c = this.cells.get(key(col, row));
    if (c?.type === 'appliance-body' || c?.type === 'appliance-port') return this.appliances.get(c.applianceId);
    return undefined;
  }

  getAppliance(id: number): Appliance | undefined {
    return this.appliances.get(id);
  }

  /** The pigeon-facing routing call: a frame entered port `ingress`, where
   *  does it leave? Returns exit emissions, or 'filtered' to drop. */
  routeAppliance(id: number, ingress: number, frame: Decoded, now: number): Emission[] | 'filtered' {
    const app = this.appliances.get(id);
    if (!app || app.ports.length === 0) return 'filtered';
    const decision = switchStep(app.state, frame, ingress, app.ports.length, now);
    if (decision.exits.length === 0) return 'filtered';
    return decision.exits
      .map((idx) => app.ports[idx])
      .filter(Boolean)
      .map((p) => ({ col: p.col, row: p.row, dir: p.dir }));
  }

  private removeAppliance(id: number): void {
    const app = this.appliances.get(id);
    if (!app) return;
    this.group.remove(app.group);
    for (const k of app.cells) this.cells.delete(k);
    this.appliances.delete(id);
  }

  /** Rebuild an appliance's 3D body + port markers + label. */
  private rebuildApplianceMesh(app: Appliance): void {
    while (app.group.children.length) app.group.remove(app.group.children[0]);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1d4e5c, roughness: 0.5 });
    const portMat = new THREE.MeshStandardMaterial({ color: 0x53d8e8, emissive: 0x53d8e8, emissiveIntensity: 0.7 });
    const badgeKeep = app.group.userData.badge; // preserve badge sprite if any
    for (const k of app.cells) {
      const [col, row] = k.split(',').map(Number);
      const isPort = this.cells.get(k)?.type === 'appliance-port';
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(CELL * 0.96, 0.22, CELL * 0.96),
        isPort ? portMat : bodyMat,
      );
      tile.position.copy(this.cellToWorld(col, row, 0.11));
      app.group.add(tile);
    }
    // Port number labels.
    for (const p of app.ports) {
      const lbl = makeTinyLabel(`P${p.index}`);
      lbl.position.copy(this.cellToWorld(p.col, p.row, 0.34));
      app.group.add(lbl);
      // little outward arrow
      const d = DIRS[p.dir];
      const arrow = new THREE.Mesh(arrowGeo, new THREE.MeshStandardMaterial({ color: 0x0b0e13 }));
      arrow.position.copy(this.cellToWorld(p.col, p.row, 0.24));
      arrow.position.x += d.dx * 0.3;
      arrow.position.z += d.dz * 0.3;
      arrow.rotation.x = Math.PI / 2;
      arrow.rotation.z = -Math.atan2(d.dx, d.dz);
      app.group.add(arrow);
    }
    if (badgeKeep) app.group.add(badgeKeep);
    app.group.userData.boardCell = { col: app.ports[0]?.col ?? [...app.cells][0].split(',').map(Number)[0], row: 0 };
    // userData for picking: any cell click maps back via cells map; store id.
    app.group.userData.applianceId = app.id;
  }

  eraseMachine(col: number, row: number): void {
    if (this.removeMachine(col, row)) this.onChange();
  }

  private static isMachine(t: string): boolean {
    return t === 'belt' || t === 'filter' || t === 'hub' || t === 'meter' ||
      t === 'appliance-body' || t === 'appliance-port';
  }

  private removeMachine(col: number, row: number): boolean {
    const existing = this.cells.get(key(col, row));
    if (!existing || !Board.isMachine(existing.type)) return false;
    if (existing.type === 'appliance-body' || existing.type === 'appliance-port') {
      this.removeAppliance(existing.applianceId); // erasing any cell scraps the box
      return true;
    }
    this.group.remove(existing.mesh);
    this.cells.delete(key(col, row));
    return true;
  }

  private clearForBuild(col: number, row: number): boolean {
    const existing = this.cells.get(key(col, row));
    return existing === undefined || Board.isMachine(existing.type);
  }

  /** Meshes of machines with config/inspector panels (select-click). */
  machineMeshes(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const c of this.cells.values()) {
      if (c.type === 'filter' || c.type === 'hub' || c.type === 'meter') out.push(c.mesh);
    }
    for (const app of this.appliances.values()) out.push(app.group);
    return out;
  }

  /** Refresh floor badges (entry counts, rates) — called a few times/sec. */
  updateBadges(): void {
    const now = performance.now();
    for (const c of this.cells.values()) {
      if (c.type === 'meter') {
        const lbl = c.state.mode === 'pps' ? `${c.state.rate}/${c.state.limit} pps` : `${meterLabel(c.state)}`;
        setBadge(c.mesh, lbl, c.state.diverted > 0 ? '#ffb347' : '#6fdc8c');
      } else if (c.type === 'hub') {
        setBadge(c.mesh, `${c.count}`, '#8a93a0');
      }
    }
    for (const app of this.appliances.values()) {
      let live = 0;
      for (const e of app.state.fdb.values()) if (now - e.learnedAt <= app.state.ttlMs) live++;
      setBadge(app.group, `${app.ports.length}p · ${live} macs`, '#53d8e8');
    }
  }

  // ---- ports (roost + landing pairs) -------------------------------------------

  addPort(port: PortInfo): void {
    if (this.portLocs.has(port.id)) return;
    let slotIdx = SLOTS.findIndex((_, i) => !this.usedSlots.has(i));
    if (slotIdx < 0) slotIdx = 0;
    this.usedSlots.add(slotIdx);
    const slot = SLOTS[slotIdx];

    // Building over the slot? The host wins; the machine is scrap.
    this.removeMachine(slot.roost.col, slot.roost.row);
    this.removeMachine(slot.landing.col, slot.landing.row);

    const roostMesh = makeRoostMesh(port);
    roostMesh.position.copy(this.cellToWorld(slot.roost.col, slot.roost.row, 0));
    this.group.add(roostMesh);
    this.cells.set(key(slot.roost.col, slot.roost.row), { type: 'roost', port, facing: slot.facing, mesh: roostMesh });

    const landingMesh = makeLandingMesh(port);
    landingMesh.position.copy(this.cellToWorld(slot.landing.col, slot.landing.row, 0));
    this.group.add(landingMesh);
    this.cells.set(key(slot.landing.col, slot.landing.row), { type: 'landing', port, mesh: landingMesh });

    this.portLocs.set(port.id, { roost: { ...slot.roost }, landing: { ...slot.landing }, facing: slot.facing });
  }

  removePort(id: number): void {
    const loc = this.portLocs.get(id);
    if (!loc) return;
    this.portLocs.delete(id);
    for (const cellLoc of [loc.roost, loc.landing]) {
      const cell = this.cells.get(key(cellLoc.col, cellLoc.row));
      if (cell?.type === 'roost' || cell?.type === 'landing') {
        this.group.remove(cell.mesh);
        this.cells.delete(key(cellLoc.col, cellLoc.row));
      }
    }
    const slotIdx = SLOTS.findIndex((s) => s.roost.col === loc.roost.col && s.roost.row === loc.roost.row);
    if (slotIdx >= 0) this.usedSlots.delete(slotIdx);
  }

  portLoc(portId: number): PortLoc | undefined {
    return this.portLocs.get(portId);
  }

  // ---- persistence ----------------------------------------------------------------

  serialize(): string {
    const items: any[] = [];
    for (const [k, c] of this.cells) {
      const [col, row] = k.split(',').map(Number);
      if (c.type === 'belt') items.push({ t: 'b', col, row, dir: c.dir });
      if (c.type === 'filter') {
        items.push({ t: 'f', col, row, md: c.matchDir, dd: c.defaultDir, cfg: c.config });
      }
      if (c.type === 'hub') items.push({ t: 'h', col, row });
      if (c.type === 'meter') {
        items.push({ t: 'm', col, row, dd: c.defaultDir, od: c.overflowDir, lim: c.state.limit, mode: c.state.mode });
      }
    }
    for (const app of this.appliances.values()) {
      const cells = [...app.cells].map((k) => k.split(',').map(Number));
      items.push({ t: 'A', cells, ports: app.ports.map((p) => [p.col, p.row]), ttl: app.state.ttlMs });
    }
    return JSON.stringify(items);
  }

  save(): void {
    try {
      localStorage.setItem(STORE_KEY, this.serialize());
    } catch { /* storage full/blocked: the floor just won't persist */ }
  }

  restore(): number {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return 0;
      const items = JSON.parse(raw) as any[];
      for (const it of items) {
        if (it.t === 'b') this.setBelt(it.col, it.row, it.dir);
        if (it.t === 'h') this.setHub(it.col, it.row);
        // 's' (legacy 1x1 switch) is intentionally dropped — superseded by
        // multi-port appliances.
        if (it.t === 'm') this.setMeter(it.col, it.row, it.dd, it.od, it.lim ?? it.th ?? 100, it.mode ?? 'pps');
        if (it.t === 'A') {
          const cols = it.cells.map((c: number[]) => c[0]);
          const rows = it.cells.map((c: number[]) => c[1]);
          const id = this.createSwitch(Math.min(...cols), Math.min(...rows), Math.max(...cols), Math.max(...rows));
          if (id !== null) for (const [pc, pr] of it.ports) this.togglePort(id, pc, pr);
        }
        if (it.t === 'f') {
          if (it.md !== undefined) {
            this.setFilter(it.col, it.row, it.md, it.dd, it.cfg);
          } else {
            // v1 floor: facing + side + match-goes-where → two exits.
            const { matchDir, defaultDir } = legacyExits(it.dir, it.side, it.m);
            this.setFilter(it.col, it.row, matchDir, defaultDir, it.cfg);
          }
        }
      }
      return items.length;
    } catch {
      return 0;
    }
  }

  clearFloor(): void {
    const toRemove: [number, number][] = [];
    for (const [k, c] of this.cells) {
      if (c.type === 'belt' || c.type === 'filter') {
        const [col, row] = k.split(',').map(Number);
        toRemove.push([col, row]);
      }
    }
    for (const [col, row] of toRemove) this.removeMachine(col, row);
    this.onChange();
  }
}

// ---- meshes ------------------------------------------------------------------------

function orient(g: THREE.Group, dir: number): void {
  const d = DIRS[dir];
  g.rotation.y = Math.atan2(d.dx, d.dz);
}

function makeBeltMesh(dir: number): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(beltBase, beltBaseMat));
  const arrow = new THREE.Mesh(arrowGeo, arrowMat);
  arrow.position.y = 0.09;
  arrow.rotation.x = Math.PI / 2; // cone +y -> +z; group rotation points it along dir
  g.add(arrow);
  orient(g, dir);
  return g;
}

/** Filter mesh: housing + TWO absolute compass arrows. Purple = matching
 *  traffic's exit, gray = the default exit. The mesh itself is never
 *  rotated — the arrows point where the frames will actually go. */
function makeFilterMesh(matchDir: number, defaultDir: number): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(beltBase, filterBaseMat));
  const housing = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.3, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x3a2f4d, roughness: 0.6 }),
  );
  housing.position.y = 0.2;
  g.add(housing);
  const eye = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xb98aff, emissive: 0xb98aff, emissiveIntensity: 0.6 }),
  );
  eye.position.y = 0.4;
  g.add(eye);

  g.add(exitArrow(defaultDir, new THREE.MeshStandardMaterial({ color: 0x8a93a0 })));
  g.add(exitArrow(matchDir, sideArrowMat));
  return g;
}

/** An arrow lying flat, pointing out of the cell along a compass dir. */
function exitArrow(dir: number, mat: THREE.Material): THREE.Mesh {
  const d = DIRS[dir];
  const arrow = new THREE.Mesh(arrowGeo, mat);
  arrow.position.set(d.dx * 0.38, 0.09, d.dz * 0.38);
  // Cone points +y; lay it flat toward (dx,dz).
  arrow.rotation.x = Math.PI / 2;
  arrow.rotation.z = -Math.atan2(d.dx, d.dz);
  return arrow;
}

function makeHubMesh(): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(beltBase, beltBaseMat));
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x4a5563, roughness: 0.5 }),
  );
  dome.position.y = 0.08;
  g.add(dome);
  for (let d = 0; d < 4; d++) {
    g.add(exitArrow(d, new THREE.MeshStandardMaterial({ color: 0x8a93a0 })));
  }
  return g;
}


function makeMeterMesh(defaultDir: number, overflowDir: number): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(beltBase, new THREE.MeshStandardMaterial({ color: 0x3a3324, roughness: 0.8 })));
  const dial = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.28, 0.3, 10),
    new THREE.MeshStandardMaterial({ color: 0x5c4d1d, roughness: 0.5 }),
  );
  dial.position.y = 0.19;
  g.add(dial);
  g.add(exitArrow(defaultDir, new THREE.MeshStandardMaterial({ color: 0x6fdc8c })));
  g.add(exitArrow(overflowDir, new THREE.MeshStandardMaterial({ color: 0xff6b6b })));
  return g;
}

/** Small status badge above a machine; only re-renders when text changes. */
function setBadge(mesh: THREE.Group, text: string, color: string): void {
  if (mesh.userData.badgeText === text && mesh.userData.badgeColor === color) return;
  mesh.userData.badgeText = text;
  mesh.userData.badgeColor = color;
  const old = mesh.userData.badge as THREE.Sprite | undefined;
  if (old) mesh.remove(old);
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 48;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(12,17,24,0.85)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 26px Consolas, monospace';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(text, canvas.width / 2, 33);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  sprite.scale.set(0.95, 0.24, 1);
  sprite.position.y = 0.55;
  mesh.add(sprite);
  mesh.userData.badge = sprite;
}

export function makeGhostBelt(): THREE.Group {
  return ghostify(makeBeltMesh(0));
}

export function makeGhostFilter(): THREE.Group {
  return ghostify(makeFilterMesh(1, 0));
}

export function makeGhostHub(): THREE.Group {
  return ghostify(makeHubMesh());
}

export function makeGhostMeter(): THREE.Group {
  return ghostify(makeMeterMesh(0, 1));
}

function makeTinyLabel(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 40px Consolas, monospace';
  ctx.fillStyle = '#0b0e13';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  sprite.scale.set(0.5, 0.5, 1);
  return sprite;
}

function ghostify(g: THREE.Group): THREE.Group {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const m = (o.material as THREE.MeshStandardMaterial).clone();
      m.transparent = true;
      m.opacity = 0.4;
      o.material = m;
    }
  });
  return g;
}

export function orientGhost(g: THREE.Group, dir: number): void {
  orient(g, dir);
}

// Every filter wears its rule on the floor — an unprogrammed default in a
// chain should be impossible to miss.
function attachRuleLabel(mesh: THREE.Group, cfg: FilterConfig, matchDir: number, defaultDir: number): void {
  const old = mesh.userData.ruleLabel as THREE.Sprite | undefined;
  if (old) mesh.remove(old);
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(26,18,40,0.88)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#3a2f4d';
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  ctx.font = '30px Consolas, monospace';
  ctx.fillStyle = '#b98aff';
  // match exit arrow first (purple rule), then where everything else goes.
  ctx.fillText(`${DIR_ARROWS[matchDir]} ${describeFilter(cfg)}`.slice(0, 20), 12, 42);
  ctx.fillStyle = '#8a93a0';
  ctx.textAlign = 'right';
  ctx.fillText(`else${DIR_ARROWS[defaultDir]}`, canvas.width - 10, 42);
  ctx.textAlign = 'left';
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(1.7, 0.28, 1);
  sprite.position.y = 0.72;
  // Counter-rotate so the label reads upright regardless of machine facing.
  sprite.userData.isLabel = true;
  mesh.add(sprite);
  mesh.userData.ruleLabel = sprite;
}

function makeRoostMesh(port: PortInfo): THREE.Group {
  const g = new THREE.Group();
  const tower = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.4, 1.1, 8),
    new THREE.MeshStandardMaterial({ color: 0xcfc3ae, roughness: 0.8 }),
  );
  tower.position.y = 0.55;
  g.add(tower);
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(0.46, 0.42, 8),
    new THREE.MeshStandardMaterial({ color: 0x8a4f3d, roughness: 0.7 }),
  );
  roof.position.y = 1.3;
  g.add(roof);
  const hole = new THREE.Mesh(
    new THREE.CircleGeometry(0.09, 12),
    new THREE.MeshBasicMaterial({ color: 0x14100c }),
  );
  hole.position.set(0, 0.78, 0.401);
  g.add(hole);

  const where = port.node ? `@${port.node.replace(/^pigeon-/, '')}` : '';
  g.add(makeLabel(`▲ ${port.pod}  OUT`, `${port.ip}  ${where}`, port.mac, '#ffb347'));
  return g;
}

function makeLandingMesh(port: PortInfo): THREE.Group {
  const g = new THREE.Group();
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.46, 0.12, 10),
    new THREE.MeshStandardMaterial({ color: 0x2a4435, roughness: 0.8 }),
  );
  pad.position.y = 0.06;
  g.add(pad);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.34, 0.04, 8, 18),
    new THREE.MeshStandardMaterial({ color: 0x6fdc8c, emissive: 0x6fdc8c, emissiveIntensity: 0.4 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.13;
  g.add(ring);

  g.add(makeLabel(`▼ ${port.pod}  IN`, port.ip, 'drop frames here', '#6fdc8c'));
  return g;
}

function makeLabel(line1: string, line2: string, line3: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(14,18,26,0.85)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#2c3442';
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  ctx.font = 'bold 44px Consolas, monospace';
  ctx.fillStyle = color;
  ctx.fillText(line1, 18, 56);
  ctx.font = '36px Consolas, monospace';
  ctx.fillStyle = '#cfd8e3';
  ctx.fillText(line2, 18, 110);
  ctx.fillStyle = '#7b8794';
  ctx.fillText(line3, 18, 160);

  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(2.6, 0.975, 1);
  sprite.position.y = 1.9;
  return sprite;
}
