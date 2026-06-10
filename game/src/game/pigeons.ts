// Pigeons: the physical body of a frame token. They spawn at their ingress
// dovecote, ride belts the player painted, and deliver their buffered frame
// when they walk into another dovecote. No belt, no movement — a pigeon with
// nowhere to go just sits there while the protocol above it times out.
import * as THREE from 'three';
import { Board, DIRS } from './board';
import { decodeFrame, KIND_COLORS, type Decoded } from '../net/decode';
import type { Bridge, FrameToken } from '../types';

const MAX_PIGEONS = 250; // beyond this, oldest waiting pigeons get dropped
const SPEED = 2.2; // cells per second
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
    // Crowd jitter so queued pigeons don't z-fight.
    p.x += (Math.random() - 0.5) * 0.3;
    p.z += (Math.random() - 0.5) * 0.3;
    this.mesh.position.copy(p);
    this.fromPos = p.clone();
    this.toPos = p.clone();
    this.mesh.userData.pigeon = this;
  }

  /** Returns the portId to deliver to when the pigeon enters a dovecote. */
  update(dt: number, board: Board): number | null {
    if (this.state === 'waiting') {
      this.bobPhase += dt * 6;
      this.mesh.position.y = 0.22 + Math.abs(Math.sin(this.bobPhase)) * 0.05;
      const here = board.cellAt(this.col, this.row);
      if (here?.type === 'belt') {
        this.ride(board, this.col + DIRS[here.dir].dx, this.row + DIRS[here.dir].dz);
      } else if (here?.type === 'dovecote') {
        // Fresh out of the cote: step onto the facing cell if a belt waits there.
        const fc = this.col + DIRS[here.facing].dx;
        const fr = this.row + DIRS[here.facing].dz;
        if (board.cellAt(fc, fr)?.type === 'belt') this.ride(board, fc, fr);
      }
      return null;
    }

    this.progress += (dt * SPEED);
    const t = Math.min(this.progress, 1);
    this.mesh.position.lerpVectors(this.fromPos, this.toPos, t);
    this.mesh.position.y = 0.22 + Math.sin(t * Math.PI) * 0.06;
    if (this.progress < 1) return null;

    this.col = this.toCell!.col;
    this.row = this.toCell!.row;
    const here = board.cellAt(this.col, this.row);
    if (here?.type === 'dovecote') {
      return here.port.id; // landed: deliver
    }
    if (here?.type === 'belt') {
      this.ride(board, this.col + DIRS[here.dir].dx, this.row + DIRS[here.dir].dz);
    } else {
      this.state = 'waiting';
    }
    return null;
  }

  private ride(board: Board, toCol: number, toRow: number): void {
    const target = board.cellAt(toCol, toRow);
    const inBounds = toCol >= 0 && toRow >= 0;
    if (!inBounds || (target === undefined && !this.cellExists(board, toCol, toRow))) {
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

  private cellExists(_board: Board, col: number, row: number): boolean {
    // Riding off the edge of the board is allowed-but-pointless; clamp instead.
    return col >= 0 && row >= 0 && col < 24 && row < 14;
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
    const cote = this.board.dovecoteFor(token.port);
    if (!cote) {
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
    const p = new Pigeon(token, this.board, cote.col, cote.row);
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
