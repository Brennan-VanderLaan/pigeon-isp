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
import { newMeterState, newSwitchState, type MeterState, type SwitchState } from './machines';

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
  | { type: 'switch'; state: SwitchState; mesh: THREE.Group }
  | { type: 'meter'; state: MeterState; defaultDir: number; overflowDir: number; mesh: THREE.Group }
  | { type: 'roost'; port: PortInfo; facing: number; mesh: THREE.Group }
  | { type: 'landing'; port: PortInfo; mesh: THREE.Group };

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

  setSwitch(col: number, row: number, ttlMs = 30_000): void {
    if (!this.clearForBuild(col, row)) return;
    this.removeMachine(col, row);
    const mesh = makeSwitchMesh();
    mesh.position.copy(this.cellToWorld(col, row, 0.04));
    mesh.userData.boardCell = { col, row };
    this.group.add(mesh);
    this.cells.set(key(col, row), { type: 'switch', state: newSwitchState(ttlMs), mesh });
    this.onChange();
  }

  setMeter(col: number, row: number, defaultDir: number, overflowDir: number, thresholdPps = 100): void {
    if (!this.clearForBuild(col, row)) return;
    this.removeMachine(col, row);
    const mesh = makeMeterMesh(defaultDir, overflowDir);
    mesh.position.copy(this.cellToWorld(col, row, 0.04));
    mesh.userData.boardCell = { col, row };
    this.group.add(mesh);
    this.cells.set(key(col, row), {
      type: 'meter', state: newMeterState(thresholdPps), defaultDir, overflowDir, mesh,
    });
    this.onChange();
  }

  configureMeter(col: number, row: number, thresholdPps: number, defaultDir: number, overflowDir: number): void {
    const c = this.cells.get(key(col, row));
    if (c?.type !== 'meter') return;
    c.state.thresholdPps = thresholdPps;
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

  eraseMachine(col: number, row: number): void {
    if (this.removeMachine(col, row)) this.onChange();
  }

  private static isMachine(t: string): boolean {
    return t === 'belt' || t === 'filter' || t === 'hub' || t === 'switch' || t === 'meter';
  }

  private removeMachine(col: number, row: number): boolean {
    const existing = this.cells.get(key(col, row));
    if (!existing || !Board.isMachine(existing.type)) return false;
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
      if (c.type === 'filter' || c.type === 'hub' || c.type === 'switch' || c.type === 'meter') out.push(c.mesh);
    }
    return out;
  }

  /** Refresh floor badges (entry counts, rates) — called a few times/sec. */
  updateBadges(): void {
    const now = performance.now();
    for (const c of this.cells.values()) {
      if (c.type === 'switch') {
        let live = 0;
        for (const e of c.state.table.values()) {
          if (now - e.learnedAt <= c.state.ttlMs) live++;
        }
        setBadge(c.mesh, `${live} macs`, '#53d8e8');
      } else if (c.type === 'meter') {
        setBadge(c.mesh, `${c.state.lastRate}/${c.state.thresholdPps} pps`, c.state.lastRate > c.state.thresholdPps ? '#ff6b6b' : '#6fdc8c');
      } else if (c.type === 'hub') {
        setBadge(c.mesh, `${c.count}`, '#8a93a0');
      }
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
      if (c.type === 'switch') items.push({ t: 's', col, row, ttl: c.state.ttlMs });
      if (c.type === 'meter') {
        items.push({ t: 'm', col, row, dd: c.defaultDir, od: c.overflowDir, th: c.state.thresholdPps });
      }
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
        if (it.t === 's') this.setSwitch(it.col, it.row, it.ttl);
        if (it.t === 'm') this.setMeter(it.col, it.row, it.dd, it.od, it.th);
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

function makeSwitchMesh(): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(beltBase, new THREE.MeshStandardMaterial({ color: 0x16323a, roughness: 0.8 })));
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.26, 0.6),
    new THREE.MeshStandardMaterial({ color: 0x1d4e5c, roughness: 0.5 }),
  );
  box.position.y = 0.17;
  g.add(box);
  // blinkenlights
  for (let i = 0; i < 4; i++) {
    const led = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 6, 4),
      new THREE.MeshStandardMaterial({ color: 0x53d8e8, emissive: 0x53d8e8, emissiveIntensity: 0.8 }),
    );
    led.position.set(-0.18 + i * 0.12, 0.31, 0.31);
    g.add(led);
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

export function makeGhostSwitch(): THREE.Group {
  return ghostify(makeSwitchMesh());
}

export function makeGhostMeter(): THREE.Group {
  return ghostify(makeMeterMesh(0, 1));
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
