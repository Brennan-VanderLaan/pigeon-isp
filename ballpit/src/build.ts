import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { Physics } from './physics';

// The construction system: a 3D grid (col, row, level) of placeable parts. This
// is the Rokenbok build layer — start with Conveyor and Chute; Sorter, Lift,
// Launcher and Host pads slot into the same registry. Verticality is baked in
// via `level` (each level is FLOOR_H tall).
export const CELL = 4;
export const FLOOR_H = 6;
const CONVEYOR_SPEED = 7;

export type Tool = 'none' | 'conveyor' | 'chute' | 'erase';
type PartType = 'conveyor' | 'chute';

interface Part {
  type: PartType;
  col: number;
  row: number;
  level: number;
  dir: number; // 0=+x, 1=+z, 2=-x, 3=-z
}

const DIRV = [
  { x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 },
];
const STORE_KEY = 'pigeon-ballpit-build-v1';

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
  private parts = new Map<string, Part>();
  private bodies = new Map<string, RAPIER.RigidBody[]>();
  private meshes = new Map<string, THREE.Object3D>();
  private group = new THREE.Group();
  private ghost: THREE.Object3D | null = null;
  private hover: { col: number; row: number } | null = null;

  constructor(scene: THREE.Scene, private physics: Physics) {
    scene.add(this.group);
    this.load();
  }

  setTool(t: Tool): void {
    this.tool = t;
    this.refreshGhost();
  }
  rotate(): void {
    this.dir = (this.dir + 1) % 4;
    this.refreshGhost();
  }
  setLevel(l: number): void {
    this.level = Math.max(0, Math.min(6, l));
    this.refreshGhost();
  }

  /** Move the placement ghost to wherever `ray` meets the current level plane. */
  hoverAt(ray: THREE.Ray): void {
    const y = this.level * FLOOR_H + 0.2;
    const t = (y - ray.origin.y) / ray.direction.y;
    if (!isFinite(t) || t <= 0) { this.hover = null; if (this.ghost) this.ghost.visible = false; return; }
    const p = ray.origin.clone().addScaledVector(ray.direction, t);
    this.hover = { col: Math.round(p.x / CELL), row: Math.round(p.z / CELL) };
    if (this.ghost) {
      this.ghost.visible = this.tool === 'conveyor' || this.tool === 'chute';
      this.ghost.position.copy(cellToWorld(this.hover.col, this.hover.row, this.level));
    }
  }

  click(): void {
    if (!this.hover) return;
    if (this.tool === 'erase') { this.remove(this.hover.col, this.hover.row, this.level); this.save(); return; }
    if (this.tool === 'conveyor' || this.tool === 'chute') {
      this.place({ type: this.tool, col: this.hover.col, row: this.hover.row, level: this.level, dir: this.dir });
      this.save();
    }
  }

  /** Horizontal velocity a conveyor imparts at a world point, or null. */
  fieldAt(x: number, y: number, z: number): { x: number; z: number } | null {
    const level = Math.round(y / FLOOR_H);
    const surface = level * FLOOR_H;
    if (Math.abs(y - surface) > 1.2) return null; // only balls riding the belt
    const p = this.parts.get(keyOf(Math.round(x / CELL), Math.round(z / CELL), level));
    if (!p || p.type !== 'conveyor') return null;
    const d = DIRV[p.dir];
    return { x: d.x * CONVEYOR_SPEED, z: d.z * CONVEYOR_SPEED };
  }

  // ---- placement internals --------------------------------------------------

  private place(part: Part): void {
    const k = keyOf(part.col, part.row, part.level);
    this.remove(part.col, part.row, part.level);
    this.parts.set(k, part);
    const mesh = makePartMesh(part.type, part.dir);
    mesh.position.copy(cellToWorld(part.col, part.row, part.level));
    this.group.add(mesh);
    this.meshes.set(k, mesh);
    this.bodies.set(k, makePartColliders(this.physics, part));
  }

  private remove(col: number, row: number, level: number): void {
    const k = keyOf(col, row, level);
    const mesh = this.meshes.get(k);
    if (mesh) { this.group.remove(mesh); this.meshes.delete(k); }
    for (const b of this.bodies.get(k) ?? []) this.physics.world.removeRigidBody(b);
    this.bodies.delete(k);
    this.parts.delete(k);
  }

  private refreshGhost(): void {
    if (this.ghost) { this.group.remove(this.ghost); this.ghost = null; }
    if (this.tool === 'conveyor' || this.tool === 'chute') {
      this.ghost = makePartMesh(this.tool, this.dir, true);
      this.ghost.visible = false;
      this.group.add(this.ghost);
    }
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

// ---- meshes & colliders -----------------------------------------------------

function makePartMesh(type: PartType, dir: number, ghost = false): THREE.Group {
  const g = new THREE.Group();
  const opacity = ghost ? 0.4 : 1;
  if (type === 'conveyor') {
    const mat = new THREE.MeshStandardMaterial({ color: 0x37506e, roughness: 0.8, transparent: ghost, opacity });
    const base = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.96, 0.3, CELL * 0.96), mat);
    g.add(base);
    const arrowMat = new THREE.MeshStandardMaterial({ color: 0xffd479, transparent: ghost, opacity });
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.2, 4), arrowMat);
    arrow.rotation.x = Math.PI / 2;
    arrow.position.y = 0.4;
    g.add(arrow);
    g.rotation.y = -dir * Math.PI / 2; // point the arrow along dir (+x at dir 0)
  } else {
    const mat = new THREE.MeshStandardMaterial({ color: 0x6a4f8c, roughness: 0.7, transparent: ghost, opacity });
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.96, 0.3, CELL * 1.3), mat);
    ramp.rotation.x = 0.45; // tilt so balls roll "down-dir"
    g.add(ramp);
    g.rotation.y = -dir * Math.PI / 2;
  }
  return g;
}

function makePartColliders(physics: Physics, part: Part): RAPIER.RigidBody[] {
  const w = cellToWorld(part.col, part.row, part.level);
  if (part.type === 'conveyor') {
    const c = physics.addFixedCuboid(CELL * 0.48, 0.15, CELL * 0.48, w.x, w.y, w.z);
    return [c.parent()!];
  }
  // chute: an inclined slab (rotate the collider about the axis perpendicular to dir)
  const inclined = physics.addInclinedSlab(CELL * 0.48, 0.15, CELL * 0.65, w.x, w.y, w.z, part.dir, 0.45);
  return [inclined.parent()!];
}
