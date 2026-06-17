import * as THREE from 'three';
import type { PartsHost } from './proto';
import type { ColliderSpec, ConveyorCell } from './proto';
import { portColor } from './arena';

// The construction system: a 3D grid (col, row, level) of placeable parts — the
// Rokenbok build layer. Parts also carry an ELEVATION (world units above their
// level's base), and placement auto-chains: a ramp placed in front of another
// ramp starts where that one ends, so chained ramps form one continuous slope.
//
// Parts: Platform, Ramp (graded rise per cell: 2 / 3 / 6 — chain three gentle
// ramps to climb a level), Corner (banked 90° turn, G flips handedness), Wall
// (thin slab on the cell edge you're facing), Conveyor, Host Dock (spout over a
// shedding apron — fluid pours ON and flows OFF toward the dock's direction),
// Host Sink. Every part is a real collider; the GPU fluid bakes them all into
// one SDF, the CPU worker gets them as oriented boxes.
export const CELL = 4;
export const FLOOR_H = 6;
const CONVEYOR_SPEED = 7;
const SPOUT_Y = 3.2;
const WALL_H = FLOOR_H; // a wall spans exactly one level — stack by level to build

// Ramp grades: vertical RISE per cell (run = CELL). gentle 2 (3 cells/level),
// medium 3 (2 cells/level), steep 6 (1 cell/level) — all divide FLOOR_H so
// chains land exactly on levels.
const GRADES = [
  { rise: 2, name: 'gentle' },
  { rise: 3, name: 'medium' },
  { rise: 6, name: 'steep' },
];
const rampAngle = (g: number) => Math.atan2(GRADES[g].rise, CELL);

export type Tool = 'none' | 'platform' | 'ramp' | 'corner' | 'wall' | 'conveyor' | 'host' | 'sink' | 'erase';
export type PartType = 'platform' | 'ramp' | 'corner' | 'wall' | 'conveyor' | 'host-spawn' | 'host-sink';

export interface Part {
  type: PartType;
  col: number;
  row: number;
  level: number;
  dir: number;    // 0=+x, 1=+z, 2=-x, 3=-z
  elev?: number;  // world units above level base (auto-chained)
  grade?: number; // ramp grade index
  turn?: 1 | -1;  // corner handedness (1 = right)
  port?: number;  // host-spawn / host-sink
}

interface PortView { id: number; label: string; }

const DIRV = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }];
const STORE_KEY = 'pigeon-ballpit-build-v4';

function keyOf(col: number, row: number, level: number): string {
  return `${col},${row},${level}`;
}
export function cellToWorld(col: number, row: number, level: number): THREE.Vector3 {
  return new THREE.Vector3(col * CELL, level * FLOOR_H, row * CELL);
}
const yawQ = (dir: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dir * Math.PI / 2);

export class Build {
  tool: Tool = 'none';
  dir = 0;
  level = 0;
  grade = 1;       // medium
  turn: 1 | -1 = 1; // corner handedness
  snap = true;     // auto-chain elevation; hold Alt to disable
  selectedPort: number | null = null;

  private parts = new Map<string, Part>();
  private meshes = new Map<string, THREE.Object3D>();
  private group = new THREE.Group();
  private ghost: THREE.Object3D | null = null;
  private hover: { col: number; row: number } | null = null;
  private hoverElev = 0;
  private elevNudge = 0; // manual Q/E height offset, world units

  private ports = new Map<number, PortView>();
  private autoSlot = new Map<number, number>();
  private nextSlot = 0;

  constructor(scene: THREE.Scene, private physics: PartsHost) {
    scene.add(this.group);
    this.load();
    this.syncConveyors();
  }

  get gradeName(): string { return GRADES[this.grade].name; }
  get turnName(): string { return this.turn === 1 ? 'right' : 'left'; }

  // ---- ports ----------------------------------------------------------------

  syncPorts(list: PortView[]): void {
    this.ports.clear();
    for (const p of list) this.ports.set(p.id, p);
    if (this.selectedPort === null || !this.ports.has(this.selectedPort)) {
      this.selectedPort = list[0]?.id ?? null;
    }
    for (const p of list) {
      if (!this.autoSlot.has(p.id)) this.autoSlot.set(p.id, this.nextSlot++);
      if (!this.hasPartFor('host-spawn', p.id)) this.autoPlaceHost(p.id);
    }
  }

  cyclePort(): void {
    const ids = [...this.ports.keys()];
    if (!ids.length) return;
    const i = this.selectedPort === null ? -1 : ids.indexOf(this.selectedPort);
    this.selectedPort = ids[(i + 1) % ids.length];
    this.refreshGhost();
  }

  /** Where this port's packets pour in: above the dock's apron, near its high
   *  (back) edge so the flow runs down and off the front. */
  spawnPosFor(port: number): THREE.Vector3 | null {
    for (const p of this.parts.values()) {
      if (p.type === 'host-spawn' && p.port === port) {
        const d = DIRV[p.dir];
        return cellToWorld(p.col, p.row, p.level)
          .add(new THREE.Vector3(-d.x * 1.0, (p.elev ?? 0) + SPOUT_Y, -d.z * 1.0));
      }
    }
    return null;
  }

  private hasPartFor(type: PartType, port: number): boolean {
    for (const p of this.parts.values()) if (p.type === type && p.port === port) return true;
    return false;
  }

  private autoPlaceHost(port: number): void {
    const slot = this.autoSlot.get(port) ?? 0;
    const angle = (slot / 12) * Math.PI * 2;
    const dockC = Math.round(Math.cos(angle) * 6), dockR = Math.round(Math.sin(angle) * 6);
    const sinkC = Math.round(Math.cos(angle) * 3.5), sinkR = Math.round(Math.sin(angle) * 3.5);
    // dock faces inward (toward its sink) so the apron sheds the right way
    const dir = Math.abs(dockC) >= Math.abs(dockR) ? (dockC > 0 ? 2 : 0) : (dockR > 0 ? 3 : 1);
    this.place({ type: 'host-spawn', col: dockC, row: dockR, level: 0, dir, port });
    this.place({ type: 'host-sink', col: sinkC, row: sinkR, level: 0, dir: 0, port });
    this.save();
  }

  // ---- tools / placement ----------------------------------------------------

  setTool(t: Tool): void { this.tool = t; this.refreshGhost(); }
  rotate(): void { this.dir = (this.dir + 1) % 4; this.refreshGhost(); }
  cycleGrade(): void {
    if (this.tool === 'corner') { this.turn = this.turn === 1 ? -1 : 1; }
    else { this.grade = (this.grade + 1) % GRADES.length; }
    this.refreshGhost();
  }
  setLevel(l: number): void { this.level = Math.max(0, Math.min(6, l)); this.refreshGhost(); }

  /** Lower/raise the pending part by 1 world unit (Q/E). Resets after placing —
   *  once a part is down, the auto-chain continues from it. */
  nudgeElev(delta: number): void {
    this.elevNudge += delta;
    this.hoverElev = this.computeElev(this.hover?.col ?? 0, this.hover?.row ?? 0);
  }

  get ghostElev(): number { return this.hoverElev; }

  private toolType(): PartType | null {
    switch (this.tool) {
      case 'platform': case 'ramp': case 'corner': case 'wall': case 'conveyor': return this.tool;
      case 'host': return 'host-spawn';
      case 'sink': return 'host-sink';
      default: return null;
    }
  }

  /** Exit height (world y) of a part at its +dir edge when continued in `dir`. */
  private exitHeightW(p: Part, dir: number): number {
    const base = p.level * FLOOR_H + (p.elev ?? 0);
    return p.type === 'ramp' && p.dir === dir ? base + GRADES[p.grade ?? 1].rise : base;
  }

  /** Elevation (relative to the CURRENT level) a part placed at (col,row)
   *  facing this.dir should start at. World-space and cross-level: the chain is
   *  found whether its parts live on this level or a neighbouring one, so a
   *  slope can run straight through level boundaries.
   *  - behind cell has a part → continue from its exit height (ascend)
   *  - placing a RAMP with a part in FRONT → tuck our top edge under its base
   *    (descend toward it)
   *  - plus the manual Q/E nudge. */
  private computeElev(col: number, row: number, type: PartType | null = this.toolType(), grade: number = this.grade): number {
    // snap off (Alt held) → manual only. Walls neither snap NOR act as snap
    // sources: they're building faces, not flow surfaces, and chaining off them
    // made stacked-wall construction impossible.
    if (!this.snap || type === 'wall') {
      return Math.max(0, Math.min(FLOOR_H * 4, this.elevNudge));
    }
    const d = DIRV[this.dir];
    const lvls = [this.level, this.level - 1, this.level + 1].filter((l) => l >= 0);
    let auto = 0;
    let found = false;
    for (const lv of lvls) {
      const behind = this.parts.get(keyOf(col - d.x, row - d.z, lv));
      if (behind && behind.type !== 'wall') { auto = this.exitHeightW(behind, this.dir) - this.level * FLOOR_H; found = true; break; }
    }
    if (!found && type === 'ramp') {
      for (const lv of lvls) {
        const front = this.parts.get(keyOf(col + d.x, row + d.z, lv));
        if (front && front.type !== 'wall') {
          auto = front.level * FLOOR_H + (front.elev ?? 0) - this.level * FLOOR_H - GRADES[grade].rise;
          break;
        }
      }
    }
    return Math.max(0, Math.min(FLOOR_H * 4, auto + this.elevNudge));
  }

  hoverAt(ray: THREE.Ray): void {
    const y = this.level * FLOOR_H + 0.2;
    const t = (y - ray.origin.y) / ray.direction.y;
    if (!isFinite(t) || t <= 0) { this.hover = null; if (this.ghost) this.ghost.visible = false; return; }
    const p = ray.origin.clone().addScaledVector(ray.direction, t);
    this.hover = { col: Math.round(p.x / CELL), row: Math.round(p.z / CELL) };
    this.hoverElev = this.computeElev(this.hover.col, this.hover.row);
    if (this.ghost) {
      this.ghost.visible = this.tool !== 'none' && this.tool !== 'erase';
      this.ghost.position.copy(cellToWorld(this.hover.col, this.hover.row, this.level));
      this.ghost.position.y += this.hoverElev;
    }
  }

  /** Place a part the way the player does — auto-chained elevation + nudge.
   *  Public so headless tests can drive real placements. */
  placeAt(type: PartType, col: number, row: number, opts: { grade?: number; turn?: 1 | -1; port?: number } = {}): Part {
    const elev = this.computeElev(col, row, type, opts.grade ?? this.grade);
    const part: Part = {
      type, col, row, level: this.level, dir: this.dir, elev,
      grade: type === 'ramp' ? (opts.grade ?? this.grade) : undefined,
      turn: type === 'corner' ? (opts.turn ?? this.turn) : undefined,
      port: opts.port,
    };
    this.place(part);
    this.elevNudge = 0; // chain continues from the placed part
    this.save();
    return part;
  }

  getPart(col: number, row: number, level: number): Part | undefined {
    return this.parts.get(keyOf(col, row, level));
  }

  /** Driving surface height at (x,z), as seen from refY: the highest deck top
   *  that's within climbing reach (so driving UNDER a bridge doesn't teleport
   *  you onto it). Ramps interpolate linearly along their slope — this is what
   *  lets vehicles drive up them. Arena floor = 0. */
  heightAt(x: number, z: number, refY = 0): number {
    const CLIMB = 1.6;
    let best = 0;
    for (const p of this.parts.values()) {
      const lx = x - p.col * CELL, lz = z - p.row * CELL;
      if (Math.abs(lx) > CELL / 2 || Math.abs(lz) > CELL / 2) continue;
      const base = p.level * FLOOR_H + (p.elev ?? 0);
      let top: number | null = null;
      if (p.type === 'platform' || p.type === 'conveyor' || p.type === 'corner') top = base + 0.15;
      else if (p.type === 'ramp') {
        const d = DIRV[p.dir];
        const s = (lx * d.x + lz * d.z + CELL / 2) / CELL; // 0 at entry edge → 1 at exit
        top = base + GRADES[p.grade ?? 1].rise * Math.min(1, Math.max(0, s)) + 0.15;
      }
      if (top !== null && top > best && top <= refY + CLIMB) best = top;
    }
    return best;
  }

  click(): void {
    if (!this.hover) return;
    const { col, row } = this.hover;
    if (this.tool === 'erase') { this.remove(col, row, this.level); this.save(); return; }
    const type = this.toolType();
    if (!type) return;
    if ((type === 'host-spawn' || type === 'host-sink') && this.selectedPort === null) return;
    this.placeAt(type, col, row, { port: type === 'host-spawn' || type === 'host-sink' ? this.selectedPort! : undefined });
  }

  // ---- internals ------------------------------------------------------------

  private place(part: Part): void {
    const k = keyOf(part.col, part.row, part.level);
    this.remove(part.col, part.row, part.level);
    this.parts.set(k, part);
    const color = part.port !== undefined ? portColor(part.port) : 0;
    const mesh = makePartMesh(part, color);
    mesh.position.copy(cellToWorld(part.col, part.row, part.level));
    mesh.position.y += part.elev ?? 0;
    this.group.add(mesh);
    this.meshes.set(k, mesh);
    this.physics.addPart(k, colliderSpecs(part), part.type === 'host-sink' ? part.port : undefined);
    if (part.type === 'conveyor') this.syncConveyors();
  }

  private remove(col: number, row: number, level: number): void {
    const k = keyOf(col, row, level);
    const mesh = this.meshes.get(k);
    if (mesh) { this.group.remove(mesh); this.meshes.delete(k); }
    const had = this.parts.get(k);
    this.physics.removePart(k);
    this.parts.delete(k);
    if (had?.type === 'conveyor') this.syncConveyors();
  }

  private syncConveyors(): void {
    const cells: ConveyorCell[] = [];
    for (const p of this.parts.values()) {
      if (p.type !== 'conveyor') continue;
      const d = DIRV[p.dir];
      cells.push({ cx: p.col, cz: p.row, level: p.level, dx: d.x, dz: d.z, speed: CONVEYOR_SPEED });
    }
    this.physics.setConveyors(cells);
  }

  private refreshGhost(): void {
    if (this.ghost) { this.group.remove(this.ghost); this.ghost = null; }
    if (this.tool === 'none' || this.tool === 'erase') return;
    const type: PartType =
      this.tool === 'host' ? 'host-spawn' : this.tool === 'sink' ? 'host-sink' : this.tool;
    const color = (this.tool === 'host' || this.tool === 'sink') && this.selectedPort !== null ? portColor(this.selectedPort) : 0;
    this.ghost = makePartMesh({ type, col: 0, row: 0, level: 0, dir: this.dir, grade: this.grade, turn: this.turn }, color, true);
    this.ghost.visible = false;
    this.group.add(this.ghost);
  }

  private save(): void {
    try { localStorage.setItem(STORE_KEY, JSON.stringify([...this.parts.values()])); } catch { /* */ }
  }
  private load(): void {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) for (const p of JSON.parse(raw) as Part[]) this.place(p);
    } catch { /* nothing saved */ }
  }
}

// ---- colliders (consumed by the CPU worker AND baked into the fluid's SDF) ----

function quatSpec(center: THREE.Vector3, half: THREE.Vector3, q: THREE.Quaternion): ColliderSpec {
  return { x: center.x, y: center.y, z: center.z, hx: half.x, hy: half.y, hz: half.z, rot: [q.x, q.y, q.z, q.w] };
}

function colliderSpecs(part: Part): ColliderSpec[] {
  const w = cellToWorld(part.col, part.row, part.level);
  w.y += part.elev ?? 0;
  const qy = yawQ(part.dir);
  const d = DIRV[part.dir];
  const side = { x: -d.z, z: d.x }; // local +z in world

  switch (part.type) {
    case 'platform':
      return [{ hx: CELL * 0.5, hy: 0.15, hz: CELL * 0.5, x: w.x, y: w.y, z: w.z }];
    case 'conveyor':
      return [{ hx: CELL * 0.48, hy: 0.15, hz: CELL * 0.48, x: w.x, y: w.y, z: w.z }];
    case 'ramp': {
      const rise = GRADES[part.grade ?? 1].rise;
      const ang = rampAngle(part.grade ?? 1);
      const len = Math.hypot(CELL, rise);
      const q = qy.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), ang));
      const c = new THREE.Vector3(w.x, w.y + rise / 2, w.z);
      const specs = [quatSpec(c, new THREE.Vector3(len / 2, 0.15, CELL * 0.48), q)];
      // side rails so fluid stays on the slope
      for (const s of [1, -1]) {
        const rc = c.clone().add(new THREE.Vector3(side.x * s * CELL * 0.46, 0.45, side.z * s * CELL * 0.46));
        specs.push(quatSpec(rc, new THREE.Vector3(len / 2, 0.45, 0.15), q));
      }
      return specs;
    }
    case 'wall': {
      // a thin slab on the cell edge you're facing
      const c = new THREE.Vector3(w.x + d.x * (CELL / 2 - 0.15), w.y + WALL_H / 2, w.z + d.z * (CELL / 2 - 0.15));
      const half = new THREE.Vector3(0.15, WALL_H / 2, CELL * 0.5);
      return [quatSpec(c, half, qy)];
    }
    case 'corner': {
      // banked 90° turn: deck + far wall (blocks straight-through) + side wall
      // opposite the exit, so flow entering along dir leaves toward the turn.
      const exit = part.turn === -1 ? (part.dir + 3) % 4 : (part.dir + 1) % 4;
      const eb = DIRV[(exit + 2) % 4];
      const specs: ColliderSpec[] = [
        { hx: CELL * 0.5, hy: 0.15, hz: CELL * 0.5, x: w.x, y: w.y, z: w.z },
      ];
      const farC = new THREE.Vector3(w.x + d.x * (CELL / 2 - 0.15), w.y + 1.2, w.z + d.z * (CELL / 2 - 0.15));
      specs.push(quatSpec(farC, new THREE.Vector3(0.15, 1.2, CELL * 0.5), yawQ(part.dir)));
      const backC = new THREE.Vector3(w.x + eb.x * (CELL / 2 - 0.15), w.y + 1.2, w.z + eb.z * (CELL / 2 - 0.15));
      specs.push(quatSpec(backC, new THREE.Vector3(0.15, 1.2, CELL * 0.5), yawQ(exit)));
      return specs;
    }
    case 'host-spawn': {
      // shedding apron: a slab descending TOWARD dir (fluid pours on near the
      // back edge and runs off the front), plus low side rails. No flat trap.
      const rise = 1.6;
      const ang = Math.atan2(rise, CELL);
      const len = Math.hypot(CELL, rise);
      // ascends toward -dir == descends toward dir
      const q = yawQ((part.dir + 2) % 4).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), ang));
      const c = new THREE.Vector3(w.x, w.y + rise / 2 + 0.2, w.z);
      const specs = [quatSpec(c, new THREE.Vector3(len / 2, 0.15, CELL * 0.48), q)];
      for (const s of [1, -1]) {
        const rc = c.clone().add(new THREE.Vector3(side.x * s * CELL * 0.46, 0.5, side.z * s * CELL * 0.46));
        specs.push(quatSpec(rc, new THREE.Vector3(len / 2, 0.5, 0.15), q));
      }
      return specs;
    }
    default: { // host-sink: four walls + a catch sensor
      const half = CELL * 0.46, h = 1.6, t = 0.18;
      return [
        { hx: half, hy: h / 2, hz: t, x: w.x, y: w.y + h / 2, z: w.z + half },
        { hx: half, hy: h / 2, hz: t, x: w.x, y: w.y + h / 2, z: w.z - half },
        { hx: t, hy: h / 2, hz: half, x: w.x + half, y: w.y + h / 2, z: w.z },
        { hx: t, hy: h / 2, hz: half, x: w.x - half, y: w.y + h / 2, z: w.z },
        { hx: half - 0.25, hy: h * 0.6, hz: half - 0.25, x: w.x, y: w.y + h * 0.6, z: w.z, sensor: true },
      ];
    }
  }
}

// ---- meshes -----------------------------------------------------------------

function makePartMesh(part: Part, color: number, ghost = false): THREE.Group {
  const g = new THREE.Group();
  const opacity = ghost ? 0.4 : 1;
  const std = (c: number, rough = 0.7, emissive = 0) =>
    new THREE.MeshStandardMaterial({ color: c, roughness: rough, transparent: ghost, opacity, emissive, emissiveIntensity: emissive ? 0.25 : 0 });

  if (part.type === 'platform') {
    const deck = new THREE.Mesh(new THREE.BoxGeometry(CELL, 0.3, CELL), std(0x3a4659, 0.85));
    deck.receiveShadow = true;
    g.add(deck);
  } else if (part.type === 'conveyor') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.96, 0.3, CELL * 0.96), std(0x37506e, 0.8)));
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.2, 4), std(0xffd479));
    arrow.rotation.z = -Math.PI / 2; // point along local +x = dir
    arrow.position.y = 0.4;
    g.add(arrow);
    g.rotation.y = -part.dir * Math.PI / 2;
  } else if (part.type === 'ramp') {
    const rise = GRADES[part.grade ?? 1].rise;
    const ang = rampAngle(part.grade ?? 1);
    const len = Math.hypot(CELL, rise);
    const inner = new THREE.Group();
    const deck = new THREE.Mesh(new THREE.BoxGeometry(len, 0.3, CELL * 0.96), std(0x55708f, 0.8));
    deck.receiveShadow = true;
    inner.add(deck);
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.9, 0.3), std(0x6f86a6, 0.7));
      rail.position.set(0, 0.45, s * CELL * 0.46);
      inner.add(rail);
    }
    inner.rotation.z = ang;       // ascend toward local +x
    inner.position.y = rise / 2;
    g.add(inner);
    g.rotation.y = -part.dir * Math.PI / 2;
  } else if (part.type === 'wall') {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.3, WALL_H, CELL), std(0x4a5a72, 0.8));
    wall.position.set(CELL / 2 - 0.15, WALL_H / 2, 0);
    g.add(wall);
    g.rotation.y = -part.dir * Math.PI / 2;
  } else if (part.type === 'corner') {
    const deck = new THREE.Mesh(new THREE.BoxGeometry(CELL, 0.3, CELL), std(0x3f5468, 0.85));
    deck.receiveShadow = true;
    g.add(deck);
    const wallMat = std(0x6f86a6, 0.7);
    const far = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.4, CELL), wallMat);
    far.position.set(CELL / 2 - 0.15, 1.2, 0);
    g.add(far);
    // side wall opposite the exit (local: exit is +z for right turns, -z for left)
    const sideWall = new THREE.Mesh(new THREE.BoxGeometry(CELL, 2.4, 0.3), wallMat);
    sideWall.position.set(0, 1.2, (part.turn === -1 ? 1 : -1) * (CELL / 2 - 0.15));
    g.add(sideWall);
    g.rotation.y = -part.dir * Math.PI / 2;
  } else if (part.type === 'host-spawn') {
    const rise = 1.6;
    const ang = Math.atan2(rise, CELL);
    const len = Math.hypot(CELL, rise);
    const inner = new THREE.Group();
    const apron = new THREE.Mesh(new THREE.BoxGeometry(len, 0.3, CELL * 0.96), std(color || 0x9aa5b1, 0.5, color));
    apron.receiveShadow = true;
    inner.add(apron);
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 1.0, 0.3), std(color || 0x9aa5b1, 0.6, color));
      rail.position.set(0, 0.5, s * CELL * 0.46);
      inner.add(rail);
    }
    inner.rotation.z = ang;            // ascend toward local +x
    inner.position.y = rise / 2 + 0.2;
    // apron descends toward dir → its local frame is yawed to the OPPOSITE dir
    inner.rotation.y = 0;
    const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 1.4, 14, 1, true), std(color || 0x9aa5b1, 0.5, color));
    spout.position.set(CELL * 0.25, SPOUT_Y, 0); // over the high (back) end
    const holder = new THREE.Group();
    holder.add(inner);
    holder.add(spout);
    holder.rotation.y = -((part.dir + 2) % 4) * Math.PI / 2;
    g.add(holder);
  } else {
    const half = CELL * 0.46;
    const base = new THREE.Mesh(new THREE.BoxGeometry(half * 2, 0.2, half * 2), std(color || 0x6fdc8c, 0.6, color));
    base.position.y = 0.1;
    g.add(base);
    const sideMat = new THREE.MeshStandardMaterial({ color: color || 0x6fdc8c, roughness: 0.7, transparent: true, opacity: ghost ? 0.3 : 0.55 });
    const h = 1.6;
    for (const [sx, sz, wx, wz] of [[0, half, half, 0.18], [0, -half, half, 0.18], [half, 0, 0.18, half], [-half, 0, 0.18, half]] as const) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(wx * 2, h, wz * 2), sideMat);
      wall.position.set(sx, h / 2, sz);
      g.add(wall);
    }
  }
  return g;
}
