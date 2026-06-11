import * as THREE from 'three';
import type { PhysicsClient } from './physics-client';
import type { ColliderSpec, ConveyorCell } from './proto';
import { portColor } from './arena';

// The construction system: a 3D grid (col, row, level) of placeable parts — the
// Rokenbok build layer. Decks for verticality (Platform, graded Ramp),
// machinery (Conveyor), and host I/O (Dock spawns this port's packets as balls;
// Sink delivers a ball to its port). Every part is a real collider — vehicles
// and balls interact with all of it. No magic surfaces.
export const CELL = 4;
export const FLOOR_H = 6;
const CONVEYOR_SPEED = 7;
const SPOUT_Y = 3.2; // height above a dock where its balls drop in

// Ramp grades — angle in radians + a label. Gentle climbs are drivable; steep
// ones are quick ball chutes. Chain ramps in a line to climb a full level.
const GRADES = [
  { angle: 0.20, name: 'gentle' },
  { angle: 0.38, name: 'medium' },
  { angle: 0.58, name: 'steep' },
];

export type Tool = 'none' | 'platform' | 'ramp' | 'conveyor' | 'host' | 'sink' | 'erase';
type PartType = 'platform' | 'ramp' | 'conveyor' | 'host-spawn' | 'host-sink';

interface Part {
  type: PartType;
  col: number;
  row: number;
  level: number;
  dir: number;    // 0=+x, 1=+z, 2=-x, 3=-z
  grade?: number; // ramp grade index
  port?: number;  // host-spawn / host-sink
}

interface PortView { id: number; label: string; }

const DIRV = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }];
const STORE_KEY = 'pigeon-ballpit-build-v3';

function keyOf(col: number, row: number, level: number): string {
  return `${col},${row},${level}`;
}
export function cellToWorld(col: number, row: number, level: number): THREE.Vector3 {
  return new THREE.Vector3(col * CELL, level * FLOOR_H, row * CELL);
}

export class Build {
  tool: Tool = 'none';
  dir = 0;
  level = 0;
  grade = 1; // medium
  selectedPort: number | null = null;

  private parts = new Map<string, Part>();
  private meshes = new Map<string, THREE.Object3D>();
  private group = new THREE.Group();
  private ghost: THREE.Object3D | null = null;
  private hover: { col: number; row: number } | null = null;

  private ports = new Map<number, PortView>();
  private autoSlot = new Map<number, number>();
  private nextSlot = 0;

  constructor(scene: THREE.Scene, private physics: PhysicsClient) {
    scene.add(this.group);
    this.load();
    this.syncConveyors();
  }

  get gradeName(): string { return GRADES[this.grade].name; }

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

  spawnPosFor(port: number): THREE.Vector3 | null {
    for (const p of this.parts.values()) {
      if (p.type === 'host-spawn' && p.port === port) {
        return cellToWorld(p.col, p.row, p.level).add(new THREE.Vector3(0, SPOUT_Y, 0));
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
    this.place({ type: 'host-spawn', col: dockC, row: dockR, level: 0, dir: 0, port });
    this.place({ type: 'host-sink', col: sinkC, row: sinkR, level: 0, dir: 0, port });
    this.save();
  }

  // ---- tools / placement ----------------------------------------------------

  setTool(t: Tool): void { this.tool = t; this.refreshGhost(); }
  rotate(): void { this.dir = (this.dir + 1) % 4; this.refreshGhost(); }
  cycleGrade(): void { this.grade = (this.grade + 1) % GRADES.length; this.refreshGhost(); }
  setLevel(l: number): void { this.level = Math.max(0, Math.min(8, l)); this.refreshGhost(); }

  hoverAt(ray: THREE.Ray): void {
    const y = this.level * FLOOR_H + 0.2;
    const t = (y - ray.origin.y) / ray.direction.y;
    if (!isFinite(t) || t <= 0) { this.hover = null; if (this.ghost) this.ghost.visible = false; return; }
    const p = ray.origin.clone().addScaledVector(ray.direction, t);
    this.hover = { col: Math.round(p.x / CELL), row: Math.round(p.z / CELL) };
    if (this.ghost) {
      this.ghost.visible = this.tool !== 'none' && this.tool !== 'erase';
      this.ghost.position.copy(cellToWorld(this.hover.col, this.hover.row, this.level));
    }
  }

  click(): void {
    if (!this.hover) return;
    const { col, row } = this.hover;
    const base = { col, row, level: this.level, dir: this.dir };
    switch (this.tool) {
      case 'erase': this.remove(col, row, this.level); break;
      case 'platform': this.place({ type: 'platform', ...base }); break;
      case 'ramp': this.place({ type: 'ramp', ...base, grade: this.grade }); break;
      case 'conveyor': this.place({ type: 'conveyor', ...base }); break;
      case 'host':
        if (this.selectedPort !== null) this.place({ type: 'host-spawn', ...base, port: this.selectedPort });
        break;
      case 'sink':
        if (this.selectedPort !== null) this.place({ type: 'host-sink', ...base, port: this.selectedPort });
        break;
      default: return;
    }
    this.save();
  }

  // ---- internals ------------------------------------------------------------

  private place(part: Part): void {
    const k = keyOf(part.col, part.row, part.level);
    this.remove(part.col, part.row, part.level);
    this.parts.set(k, part);
    const color = part.port !== undefined ? portColor(part.port) : 0;
    const mesh = makePartMesh(part, color);
    mesh.position.copy(cellToWorld(part.col, part.row, part.level));
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

  /** Send the current set of conveyor cells to the worker (it applies the
   *  friction drive there). */
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
    this.ghost = makePartMesh({ type, col: 0, row: 0, level: 0, dir: this.dir, grade: this.grade }, color, true);
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

// ---- colliders (sent to the worker) -----------------------------------------

function rampQuat(dir: number, tilt: number): THREE.Quaternion {
  const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt);
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dir * Math.PI / 2);
  return new THREE.Quaternion().multiplyQuaternions(qy, qx); // matches the mesh's Ry*Rx
}

function colliderSpecs(part: Part): ColliderSpec[] {
  const w = cellToWorld(part.col, part.row, part.level);
  switch (part.type) {
    case 'platform': return [{ hx: CELL * 0.5, hy: 0.15, hz: CELL * 0.5, x: w.x, y: w.y, z: w.z }];
    case 'conveyor': return [{ hx: CELL * 0.48, hy: 0.15, hz: CELL * 0.48, x: w.x, y: w.y, z: w.z }];
    case 'ramp': {
      const q = rampQuat(part.dir, GRADES[part.grade ?? 1].angle);
      return [{ hx: CELL * 0.5, hy: 0.15, hz: CELL * 0.62, x: w.x, y: w.y, z: w.z, rot: [q.x, q.y, q.z, q.w] }];
    }
    case 'host-spawn': return [{ hx: CELL * 0.4, hy: 0.6, hz: CELL * 0.4, x: w.x, y: w.y + 0.6, z: w.z }];
    default: { // host-sink: four walls + a catch sensor (sinkPort set by addPart)
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
    arrow.rotation.x = Math.PI / 2; arrow.position.y = 0.4;
    g.add(arrow);
    g.rotation.y = -part.dir * Math.PI / 2;
  } else if (part.type === 'ramp') {
    const angle = GRADES[part.grade ?? 1].angle;
    const inner = new THREE.Group();
    const deck = new THREE.Mesh(new THREE.BoxGeometry(CELL, 0.3, CELL * 1.24), std(0x55708f, 0.8));
    deck.receiveShadow = true;
    inner.add(deck);
    const railMat = std(0x6f86a6, 0.7);
    for (const sx of [-CELL * 0.46, CELL * 0.46]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.5, CELL * 1.24), railMat);
      rail.position.set(sx, 0.4, 0);
      inner.add(rail);
    }
    inner.rotation.x = angle;
    g.add(inner);
    g.rotation.y = -part.dir * Math.PI / 2;
  } else if (part.type === 'host-spawn') {
    const dock = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.8, 1.2, CELL * 0.8), std(color || 0x9aa5b1, 0.5, color));
    dock.position.y = 0.6;
    g.add(dock);
    const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 1.4, 14, 1, true), std(color || 0x9aa5b1, 0.5, color));
    spout.position.y = SPOUT_Y;
    g.add(spout);
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
