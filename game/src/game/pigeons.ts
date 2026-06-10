// Pigeons: the physical body of a frame token. They spawn at their host's
// ROOST, ride belts, get judged by filter machines (straight or ejected out
// the side), and deliver their buffered frame when they walk onto a LANDING
// pad. No belt, no movement — a pigeon with nowhere to go just sits there
// while the protocol above it times out.
import * as THREE from 'three';
import { Board, DIRS, COLS, ROWS } from './board';
import { decodeFrame, KIND_COLORS, type Decoded } from '../net/decode';
import type { Bridge, FrameToken } from '../types';

const MAX_PIGEONS = 250; // beyond this, oldest waiting pigeons get dropped
const BASE_SPEED = 2.2; // cells per second at 1x

// Global speed multiplier: slow for debugging, crank it to "router on".
let speedMult = 1;
export function setSpeed(mult: number): void {
  speedMult = Math.max(0.1, Math.min(mult, 100));
}
export function getSpeed(): number {
  return speedMult;
}

const bodyGeo = new THREE.SphereGeometry(0.16, 10, 8);
const headGeo = new THREE.SphereGeometry(0.09, 8, 6);
const beakGeo = new THREE.ConeGeometry(0.04, 0.1, 6);
const scrollGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.24, 8);
const bodyMat = new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.7 });
const headMat = new THREE.MeshStandardMaterial({ color: 0x9aa5b1, roughness: 0.7 });
const beakMat = new THREE.MeshStandardMaterial({ color: 0xffa940, roughness: 0.6 });

export class Pigeon {
  mesh: THREE.Group;
  decoded: Decoded;
  state: 'waiting' | 'riding' = 'waiting';
  col: number;
  row: number;
  private fromPos: THREE.Vector3;
  private toPos: THREE.Vector3;
  private toCell: { col: number; row: number } | null = null;
  private progress = 0;
  private bobPhase = Math.random() * Math.PI * 2;
  bornAt = performance.now();

  constructor(readonly token: FrameToken, board: Board, col: number, row: number) {
    this.decoded = decodeFrame(token.snapshot, token.fullLen);
    this.col = col;
    this.row = row;
    this.mesh = makePigeonMesh(KIND_COLORS[this.decoded.kind]);
    const p = board.cellToWorld(col, row, 0.22);
    p.x += (Math.random() - 0.5) * 0.3;
    p.z += (Math.random() - 0.5) * 0.3;
    this.mesh.position.copy(p);
    this.fromPos = p.clone();
    this.toPos = p.clone();
    this.mesh.userData.pigeon = this;
  }

  /** Returns the portId to deliver to when the pigeon lands. */
  update(dt: number, board: Board): number | null {
    if (this.state === 'waiting') {
      this.bobPhase += dt * 6;
      this.mesh.position.y = 0.22 + Math.abs(Math.sin(this.bobPhase)) * 0.05;
      const out = this.exitDirFrom(board, this.col, this.row);
      if (out !== null) this.tryRide(board, out);
      return null;
    }

    this.progress += dt * BASE_SPEED * speedMult;
    const t = Math.min(this.progress, 1);
    this.mesh.position.lerpVectors(this.fromPos, this.toPos, t);
    this.mesh.position.y = 0.22 + Math.sin(t * Math.PI) * 0.06;
    if (this.progress < 1) return null;

    this.col = this.toCell!.col;
    this.row = this.toCell!.row;
    const here = board.cellAt(this.col, this.row);
    if (here?.type === 'landing') {
      return here.port.id; // touched down: deliver
    }
    const out = this.exitDirFrom(board, this.col, this.row);
    if (out !== null) this.tryRide(board, out);
    else this.state = 'waiting';
    return null;
  }

  /** Which way does the machinery at (col,row) send THIS pigeon? */
  private exitDirFrom(board: Board, col: number, row: number): number | null {
    const cell = board.cellAt(col, row);
    if (!cell) return null;
    switch (cell.type) {
      case 'belt':
        return cell.dir;
      case 'filter': {
        // The branching machine: inspect the frame, pick an exit.
        const matched = cell.compiled.match(this.decoded);
        const ejected = cell.matchToSide ? matched : !matched;
        return ejected ? (cell.dir + cell.side + 4) % 4 : cell.dir;
      }
      case 'roost':
        // Fresh out of the cote: step toward the interior if anything's there.
        return cell.facing;
      case 'landing':
        return null;
    }
  }

  private tryRide(board: Board, dir: number): void {
    const toCol = this.col + DIRS[dir].dx;
    const toRow = this.row + DIRS[dir].dz;
    if (toCol < 0 || toRow < 0 || toCol >= COLS || toRow >= ROWS) {
      this.state = 'waiting';
      return;
    }
    const target = board.cellAt(toCol, toRow);
    // Roosts are solid: pigeons don't walk into someone's front door.
    if (target?.type === 'roost') {
      this.state = 'waiting';
      return;
    }
    const here = board.cellAt(this.col, this.row);
    if (here?.type === 'roost' && target === undefined) {
      // Don't hop off the roost into empty floor — wait for machinery.
      this.state = 'waiting';
      return;
    }
    this.state = 'riding';
    this.toCell = { col: toCol, row: toRow };
    this.fromPos = this.mesh.position.clone();
    this.toPos = board.cellToWorld(toCol, toRow, 0.22);
    this.progress = 0;
    const dx = this.toPos.x - this.fromPos.x;
    const dz = this.toPos.z - this.fromPos.z;
    this.mesh.rotation.y = Math.atan2(dx, dz);
  }
}

export class PigeonManager {
  pigeons: Pigeon[] = [];
  droppedByMe = 0;
  readonly group = new THREE.Group();
  private onDeliver: (pigeon: Pigeon, portId: number) => void;

  constructor(
    scene: THREE.Scene,
    private board: Board,
    private bridge: () => Bridge,
    onDeliver: (pigeon: Pigeon, portId: number) => void,
  ) {
    scene.add(this.group);
    this.onDeliver = onDeliver;
  }

  spawn(token: FrameToken): void {
    const loc = this.board.portLoc(token.port);
    if (!loc) {
      this.bridge().drop(token.id);
      this.droppedByMe++;
      return;
    }
    if (this.pigeons.length >= MAX_PIGEONS) {
      // Queue overflow: the oldest waiting pigeon is culled. A router's
      // buffer is finite; so is the floor.
      const idx = this.pigeons.findIndex((p) => p.state === 'waiting');
      const victim = idx >= 0 ? this.pigeons.splice(idx, 1)[0] : null;
      if (victim) {
        this.group.remove(victim.mesh);
        this.bridge().drop(victim.token.id);
        this.droppedByMe++;
      } else {
        this.bridge().drop(token.id);
        this.droppedByMe++;
        return;
      }
    }
    const p = new Pigeon(token, this.board, loc.roost.col, loc.roost.row);
    this.pigeons.push(p);
    this.group.add(p.mesh);
  }

  update(dt: number): void {
    for (let i = this.pigeons.length - 1; i >= 0; i--) {
      const p = this.pigeons[i];
      const deliveredTo = p.update(dt, this.board);
      if (deliveredTo !== null) {
        this.pigeons.splice(i, 1);
        this.group.remove(p.mesh);
        this.bridge().deliver(deliveredTo, p.token.id);
        this.onDeliver(p, deliveredTo);
      }
    }
  }

  pickablesByMesh(): THREE.Object3D[] {
    return this.pigeons.map((p) => p.mesh);
  }
}

function makePigeonMesh(scrollColor: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.scale.set(1, 0.85, 1.25);
  g.add(body);
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.set(0, 0.13, 0.16);
  g.add(head);
  const beak = new THREE.Mesh(beakGeo, beakMat);
  beak.position.set(0, 0.12, 0.27);
  beak.rotation.x = Math.PI / 2;
  g.add(beak);
  const scroll = new THREE.Mesh(
    scrollGeo,
    new THREE.MeshStandardMaterial({ color: scrollColor, emissive: scrollColor, emissiveIntensity: 0.35, roughness: 0.5 }),
  );
  scroll.position.set(0, -0.14, 0);
  scroll.rotation.z = Math.PI / 2;
  g.add(scroll);
  return g;
}
