// The factory floor: a grid of cells. Dovecotes (ports) sit on the perimeter;
// the player paints directional belts on the interior. Pure data + meshes —
// pigeons live in pigeons.ts.
import * as THREE from 'three';
import type { PortInfo } from '../types';

export const COLS = 24;
export const ROWS = 14;
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
  | { type: 'dovecote'; port: PortInfo; facing: number; mesh: THREE.Group };

const SLOTS = [
  { col: 0, row: 7, facing: 0 },
  { col: COLS - 1, row: 7, facing: 2 },
  { col: 0, row: 3, facing: 0 },
  { col: COLS - 1, row: 3, facing: 2 },
  { col: 0, row: 11, facing: 0 },
  { col: COLS - 1, row: 11, facing: 2 },
  { col: 12, row: 0, facing: 1 },
  { col: 12, row: ROWS - 1, facing: 3 },
];

const beltBase = new THREE.BoxGeometry(CELL * 0.94, 0.08, CELL * 0.94);
const beltBaseMat = new THREE.MeshStandardMaterial({ color: 0x232c3a, roughness: 0.9 });
const arrowGeo = new THREE.ConeGeometry(0.16, 0.42, 4);
const arrowMat = new THREE.MeshStandardMaterial({ color: 0xffb347, roughness: 0.6 });

function key(col: number, row: number): string {
  return col + ',' + row;
}

export class Board {
  cells = new Map<string, Cell>();
  private dovecotesByPort = new Map<number, { col: number; row: number; facing: number }>();
  private usedSlots = new Set<number>();
  readonly group = new THREE.Group();

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
    // GridHelper is square; scale to the board's aspect.
    grid.scale.set(COLS / Math.max(COLS, ROWS), 1, ROWS / Math.max(COLS, ROWS));
    this.group.add(grid);
  }

  cellToWorld(col: number, row: number, y = 0): THREE.Vector3 {
    return new THREE.Vector3(
      (col - (COLS - 1) / 2) * CELL, y, (row - (ROWS - 1) / 2) * CELL,
    );
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

  // ---- belts ----------------------------------------------------------------

  setBelt(col: number, row: number, dir: number): void {
    const existing = this.cells.get(key(col, row));
    if (existing?.type === 'dovecote') return;
    if (existing?.type === 'belt') {
      if (existing.dir === dir) return;
      this.group.remove(existing.mesh);
    }
    const mesh = makeBeltMesh(dir);
    mesh.position.copy(this.cellToWorld(col, row, 0.04));
    this.group.add(mesh);
    this.cells.set(key(col, row), { type: 'belt', dir, mesh });
  }

  eraseBelt(col: number, row: number): void {
    const existing = this.cells.get(key(col, row));
    if (existing?.type !== 'belt') return;
    this.group.remove(existing.mesh);
    this.cells.delete(key(col, row));
  }

  // ---- dovecotes --------------------------------------------------------------

  addPort(port: PortInfo): void {
    if (this.dovecotesByPort.has(port.id)) return;
    let slotIdx = SLOTS.findIndex((_, i) => !this.usedSlots.has(i));
    if (slotIdx < 0) slotIdx = 0; // out of slots: stack on the first (unlikely)
    this.usedSlots.add(slotIdx);
    const slot = SLOTS[slotIdx];

    const mesh = makeDovecoteMesh(port);
    mesh.position.copy(this.cellToWorld(slot.col, slot.row, 0));
    this.group.add(mesh);
    this.cells.set(key(slot.col, slot.row), { type: 'dovecote', port, facing: slot.facing, mesh });
    this.dovecotesByPort.set(port.id, { col: slot.col, row: slot.row, facing: slot.facing });
  }

  removePort(id: number): void {
    const loc = this.dovecotesByPort.get(id);
    if (!loc) return;
    this.dovecotesByPort.delete(id);
    const cell = this.cells.get(key(loc.col, loc.row));
    if (cell?.type === 'dovecote') {
      this.group.remove(cell.mesh);
      this.cells.delete(key(loc.col, loc.row));
    }
    const slotIdx = SLOTS.findIndex((s) => s.col === loc.col && s.row === loc.row);
    if (slotIdx >= 0) this.usedSlots.delete(slotIdx);
  }

  dovecoteFor(portId: number): { col: number; row: number; facing: number } | undefined {
    return this.dovecotesByPort.get(portId);
  }
}

function makeBeltMesh(dir: number): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(beltBase, beltBaseMat);
  g.add(base);
  const arrow = new THREE.Mesh(arrowGeo, arrowMat);
  arrow.position.y = 0.09;
  arrow.rotation.x = Math.PI / 2; // lie flat, point along -z by default... fix below
  g.add(arrow);
  // Cone points +y by default; after rotation.x=PI/2 it points +z (south, dir 1).
  const d = DIRS[dir];
  g.rotation.y = Math.atan2(d.dx, d.dz);
  return g;
}

export function makeGhostBelt(): THREE.Group {
  const g = makeBeltMesh(0);
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
  const d = DIRS[dir];
  g.rotation.y = Math.atan2(d.dx, d.dz);
}

function makeDovecoteMesh(port: PortInfo): THREE.Group {
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

  g.add(makeLabel(`${port.pod}\n${port.ip}\n${port.mac}`));
  return g;
}

function makeLabel(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(14,18,26,0.85)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#2c3442';
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  ctx.font = 'bold 44px Consolas, monospace';
  ctx.fillStyle = '#ffb347';
  const lines = text.split('\n');
  ctx.fillText(lines[0] ?? '', 18, 56);
  ctx.font = '36px Consolas, monospace';
  ctx.fillStyle = '#cfd8e3';
  ctx.fillText(lines[1] ?? '', 18, 110);
  ctx.fillStyle = '#7b8794';
  ctx.fillText(lines[2] ?? '', 18, 160);

  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(2.6, 0.975, 1);
  sprite.position.y = 2.1;
  return sprite;
}
