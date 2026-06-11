import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { Physics } from './physics';
import { portColor } from './arena';

// The construction system: a 3D grid (col, row, level) of placeable parts —
// the Rokenbok build layer. Machinery (Conveyor, Chute) plus host I/O:
//   Host dock  — a port; its packets spawn as balls above this part.
//   Host sink  — drop a ball in → deliver(port, frame).
// Sorter, Lift, Launcher and vehicles slot into the same registry. Verticality
// is baked in via `level` (each level is FLOOR_H tall).
export const CELL = 4;
export const FLOOR_H = 6;
const CONVEYOR_SPEED = 7;
const SPOUT_Y = 3.2; // height above a dock where its balls drop in

export type Tool = 'none' | 'conveyor' | 'chute' | 'host' | 'sink' | 'erase';
type PartType = 'conveyor' | 'chute' | 'host-spawn' | 'host-sink';

interface Part {
  type: PartType;
  col: number;
  row: number;
  level: number;
  dir: number;   // 0=+x, 1=+z, 2=-x, 3=-z
  port?: number; // for host-spawn / host-sink
}

interface PortView { id: number; label: string; }

const DIRV = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }];
const STORE_KEY = 'pigeon-ballpit-build-v2';

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
  selectedPort: number | null = null;

  private parts = new Map<string, Part>();
  private bodies = new Map<string, RAPIER.RigidBody[]>();
  private meshes = new Map<string, THREE.Object3D>();
  private sinkSensors = new Map<string, number>(); // cellKey -> collider handle (for binByCollider cleanup)
  private group = new THREE.Group();
  private ghost: THREE.Object3D | null = null;
  private hover: { col: number; row: number } | null = null;

  private ports = new Map<number, PortView>();
  private autoSlot = new Map<number, number>(); // port -> stable auto-placement slot
  private nextSlot = 0;

  constructor(scene: THREE.Scene, private physics: Physics) {
    scene.add(this.group);
    this.load();
  }

  // ---- ports ----------------------------------------------------------------

  /** Sync the known host set; auto-place a dock+sink for any host that has none
   *  yet (so packets flow immediately — the player can erase/replace). */
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

  /** World point where this port's balls should spawn, or null if no dock. */
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
  setLevel(l: number): void { this.level = Math.max(0, Math.min(6, l)); this.refreshGhost(); }

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
    if (this.tool === 'erase') { this.remove(col, row, this.level); this.save(); return; }
    if (this.tool === 'conveyor' || this.tool === 'chute') {
      this.place({ type: this.tool, col, row, level: this.level, dir: this.dir });
    } else if (this.tool === 'host' || this.tool === 'sink') {
      if (this.selectedPort === null) return;
      this.place({ type: this.tool === 'host' ? 'host-spawn' : 'host-sink', col, row, level: this.level, dir: this.dir, port: this.selectedPort });
    }
    this.save();
  }

  /** Horizontal velocity a conveyor imparts at a world point, or null. */
  fieldAt(x: number, y: number, z: number): { x: number; z: number } | null {
    const level = Math.round(y / FLOOR_H);
    if (Math.abs(y - level * FLOOR_H) > 1.2) return null;
    const p = this.parts.get(keyOf(Math.round(x / CELL), Math.round(z / CELL), level));
    if (!p || p.type !== 'conveyor') return null;
    const d = DIRV[p.dir];
    return { x: d.x * CONVEYOR_SPEED, z: d.z * CONVEYOR_SPEED };
  }

  // ---- internals ------------------------------------------------------------

  private place(part: Part): void {
    const k = keyOf(part.col, part.row, part.level);
    this.remove(part.col, part.row, part.level);
    this.parts.set(k, part);
    const color = part.port !== undefined ? portColor(part.port) : 0;
    const mesh = makePartMesh(part.type, part.dir, color);
    mesh.position.copy(cellToWorld(part.col, part.row, part.level));
    this.group.add(mesh);
    this.meshes.set(k, mesh);
    this.bodies.set(k, this.makeColliders(part, k));
  }

  private remove(col: number, row: number, level: number): void {
    const k = keyOf(col, row, level);
    const mesh = this.meshes.get(k);
    if (mesh) { this.group.remove(mesh); this.meshes.delete(k); }
    for (const b of this.bodies.get(k) ?? []) this.physics.world.removeRigidBody(b);
    this.bodies.delete(k);
    const sensor = this.sinkSensors.get(k);
    if (sensor !== undefined) { this.physics.binByCollider.delete(sensor); this.sinkSensors.delete(k); }
    this.parts.delete(k);
  }

  private makeColliders(part: Part, k: string): RAPIER.RigidBody[] {
    const w = cellToWorld(part.col, part.row, part.level);
    if (part.type === 'conveyor') {
      return [this.physics.addFixedCuboid(CELL * 0.48, 0.15, CELL * 0.48, w.x, w.y, w.z).parent()!];
    }
    if (part.type === 'chute') {
      return [this.physics.addInclinedSlab(CELL * 0.48, 0.15, CELL * 0.65, w.x, w.y, w.z, part.dir, 0.45).parent()!];
    }
    if (part.type === 'host-spawn') {
      return [this.physics.addFixedCuboid(CELL * 0.4, 0.6, CELL * 0.4, w.x, w.y + 0.6, w.z).parent()!];
    }
    // host-sink: four short walls + a catch sensor
    const half = CELL * 0.46, h = 1.6, t = 0.18;
    const bodies: RAPIER.RigidBody[] = [];
    const sides: [number, number, number, number, number, number][] = [
      [half, h / 2, t, w.x, w.y + h / 2, w.z + half],
      [half, h / 2, t, w.x, w.y + h / 2, w.z - half],
      [t, h / 2, half, w.x + half, w.y + h / 2, w.z],
      [t, h / 2, half, w.x - half, w.y + h / 2, w.z],
    ];
    for (const [hx, hy, hz, sx, sy, sz] of sides) bodies.push(this.physics.addFixedCuboid(hx, hy, hz, sx, sy, sz).parent()!);
    const sensor = this.physics.addFixedCuboid(half - 0.25, h * 0.6, half - 0.25, w.x, w.y + h * 0.6, w.z, true);
    this.physics.binByCollider.set(sensor.handle, part.port!);
    this.sinkSensors.set(k, sensor.handle);
    bodies.push(sensor.parent()!);
    return bodies;
  }

  private refreshGhost(): void {
    if (this.ghost) { this.group.remove(this.ghost); this.ghost = null; }
    if (this.tool === 'none' || this.tool === 'erase') return;
    const type: PartType = this.tool === 'host' ? 'host-spawn' : this.tool === 'sink' ? 'host-sink' : this.tool;
    const color = (this.tool === 'host' || this.tool === 'sink') && this.selectedPort !== null ? portColor(this.selectedPort) : 0xffd479;
    this.ghost = makePartMesh(type, this.dir, color, true);
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

// ---- meshes -----------------------------------------------------------------

function makePartMesh(type: PartType, dir: number, color: number, ghost = false): THREE.Group {
  const g = new THREE.Group();
  const opacity = ghost ? 0.4 : 1;
  const std = (c: number, rough = 0.7, emissive = 0) =>
    new THREE.MeshStandardMaterial({ color: c, roughness: rough, transparent: ghost, opacity, emissive, emissiveIntensity: emissive ? 0.25 : 0 });

  if (type === 'conveyor') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.96, 0.3, CELL * 0.96), std(0x37506e, 0.8)));
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.2, 4), std(0xffd479));
    arrow.rotation.x = Math.PI / 2; arrow.position.y = 0.4;
    g.add(arrow);
    g.rotation.y = -dir * Math.PI / 2;
  } else if (type === 'chute') {
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.96, 0.3, CELL * 1.3), std(0x6a4f8c));
    ramp.rotation.x = 0.45;
    g.add(ramp);
    g.rotation.y = -dir * Math.PI / 2;
  } else if (type === 'host-spawn') {
    const dock = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.8, 1.2, CELL * 0.8), std(color || 0x9aa5b1, 0.5, color));
    dock.position.y = 0.6;
    g.add(dock);
    const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 1.4, 14, 1, true), std(color || 0x9aa5b1, 0.5, color));
    spout.position.y = SPOUT_Y;
    g.add(spout);
  } else {
    // host-sink: base + four short translucent walls
    const half = CELL * 0.46;
    const base = new THREE.Mesh(new THREE.BoxGeometry(half * 2, 0.2, half * 2), std(color || 0x6fdc8c, 0.6, color));
    base.position.y = 0.1;
    g.add(base);
    const sideMat = new THREE.MeshStandardMaterial({ color: color || 0x6fdc8c, roughness: 0.7, transparent: true, opacity: ghost ? 0.3 : 0.55 });
    const h = 1.6;
    for (const [sx, sz, w, d] of [[0, half, half, 0.18], [0, -half, half, 0.18], [half, 0, 0.18, half], [-half, 0, 0.18, half]] as const) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w * 2, h, d * 2), sideMat);
      wall.position.set(sx, h / 2, sz);
      g.add(wall);
    }
  }
  return g;
}
