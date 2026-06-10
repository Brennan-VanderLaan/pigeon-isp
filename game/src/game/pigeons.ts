// Pigeons: the physical body of a frame token. They spawn at their host's
// ROOST, ride belts, get judged by filter machines, and deliver their
// buffered frame when they walk onto a LANDING pad.
//
// Built for speed: at 5000x a pigeon crosses ~180 cells per render frame, so
// movement is multi-step — every cell along the way is evaluated (filters
// still filter, landings still land) no matter how fast the belt runs.
// Tokens land in a queue that is FULLY drained into the simulation every
// tick (all available frames, every frame), and pigeon meshes are pooled so
// thousands of spawns per second don't churn the GC.
import * as THREE from 'three';
import { Board, DIRS, COLS, ROWS } from './board';
import { filterExit } from './filters';
import { decodeFrame, KIND_COLORS, type Decoded } from '../net/decode';
import type { Bridge, FrameToken } from '../types';

const MAX_PIGEONS = 500; // live entities on the floor
const MAX_QUEUE = 10000; // tokens waiting to spawn; beyond this, oldest drop
const MAX_STEPS_PER_TICK = 512; // belt-loop guard
const BASE_SPEED = 2.2; // cells per second at 1x

// Global speed multiplier: slow for debugging, crank it to "router on".
let speedMult = 1;
export function setSpeed(mult: number): void {
  speedMult = Math.max(0.1, Math.min(mult, 5000));
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
  mesh!: THREE.Group;
  decoded: Decoded;
  state: 'waiting' | 'riding' = 'waiting';
  col: number;
  row: number;
  private fromPos = new THREE.Vector3();
  private toPos = new THREE.Vector3();
  private toCell: { col: number; row: number } | null = null;
  private progress = 0;
  private bobPhase = Math.random() * Math.PI * 2;

  constructor(readonly token: FrameToken, col: number, row: number) {
    this.decoded = decodeFrame(token.snapshot, token.fullLen);
    this.col = col;
    this.row = row;
  }

  attachMesh(mesh: THREE.Group, board: Board): void {
    this.mesh = mesh;
    const p = board.cellToWorld(this.col, this.row, 0.22);
    p.x += (Math.random() - 0.5) * 0.3;
    p.z += (Math.random() - 0.5) * 0.3;
    this.mesh.position.copy(p);
    this.fromPos.copy(p);
    this.toPos.copy(p);
    this.mesh.userData.pigeon = this;
    this.mesh.visible = true;
  }

  /** Returns the portId to deliver to when the pigeon lands. */
  update(dt: number, board: Board): number | null {
    if (this.state === 'waiting') {
      this.bobPhase += dt * 6;
      this.mesh.position.y = 0.22 + Math.abs(Math.sin(this.bobPhase)) * 0.05;
      const out = this.exitDirFrom(board, this.col, this.row);
      if (out === null || !this.beginSegment(board, out)) return null;
      this.state = 'riding';
      // fall through: a fast pigeon shouldn't waste this tick standing up
    }

    this.progress += dt * BASE_SPEED * speedMult;
    let steps = 0;
    while (this.progress >= 1) {
      if (++steps > MAX_STEPS_PER_TICK) {
        this.progress = 0; // circular belt at warp speed: yield, spin more next tick
        break;
      }
      this.progress -= 1;
      this.col = this.toCell!.col;
      this.row = this.toCell!.row;
      const here = board.cellAt(this.col, this.row);
      if (here?.type === 'landing') {
        return here.port.id; // touched down: deliver
      }
      const out = this.exitDirFrom(board, this.col, this.row);
      if (out === null || !this.beginSegment(board, out)) {
        this.state = 'waiting';
        this.progress = 0;
        this.mesh.position.copy(board.cellToWorld(this.col, this.row, 0.22));
        return null;
      }
    }

    const t = Math.min(this.progress, 1);
    this.mesh.position.lerpVectors(this.fromPos, this.toPos, t);
    this.mesh.position.y = 0.22 + Math.sin(t * Math.PI) * 0.06;
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
        const matched = cell.compiled.match(this.decoded);
        const exit = filterExit(cell.dir, cell.side, cell.matchToSide, matched);
        // Score the machine: the editor shows live verdicts (ring buffer,
        // cheap enough to run at 5000x). `ejected` records the PHYSICAL
        // exit, not the match result — displays must never lie about
        // geometry.
        const st = cell.stats;
        if (matched) st.hits++;
        else st.misses++;
        st.recent[st.ptr % st.recent.length] = {
          summary: this.decoded.summary, matched, ejected: exit !== cell.dir,
        };
        st.ptr++;
        cell.lastFrame = this.token.snapshot;
        return exit;
      }
      case 'roost':
        return cell.facing;
      case 'landing':
        return null;
    }
  }

  /** Point the pigeon at the next cell; false if it can't go there. */
  private beginSegment(board: Board, dir: number): boolean {
    const toCol = this.col + DIRS[dir].dx;
    const toRow = this.row + DIRS[dir].dz;
    if (toCol < 0 || toRow < 0 || toCol >= COLS || toRow >= ROWS) return false;
    const target = board.cellAt(toCol, toRow);
    if (target?.type === 'roost') return false; // roosts are solid
    const here = board.cellAt(this.col, this.row);
    if (here?.type === 'roost' && target === undefined) return false; // wait for machinery
    this.toCell = { col: toCol, row: toRow };
    this.fromPos.copy(board.cellToWorld(this.col, this.row, 0.22));
    this.toPos.copy(board.cellToWorld(toCol, toRow, 0.22));
    this.mesh.rotation.y = Math.atan2(this.toPos.x - this.fromPos.x, this.toPos.z - this.fromPos.z);
    return true;
  }
}

export class PigeonManager {
  pigeons: Pigeon[] = [];
  droppedByMe = 0;
  readonly group = new THREE.Group();
  private queue: FrameToken[] = [];
  private pool: THREE.Group[] = [];
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

  /** Tokens arrive here; the next tick drains everything it can. */
  enqueue(token: FrameToken): void {
    this.queue.push(token);
    if (this.queue.length > MAX_QUEUE) {
      // Spawn queue overflow: oldest queued frame drops (counted, like
      // every other drop in this system).
      const victim = this.queue.shift()!;
      this.bridge().drop(victim.id);
      this.droppedByMe++;
    }
  }

  queued(): number {
    return this.queue.length;
  }

  update(dt: number): void {
    // Inject ALL available frames into the simulation (up to the live-entity
    // cap; at high speed the floor drains in the same tick, so the queue
    // empties fast).
    while (this.queue.length > 0 && this.pigeons.length < MAX_PIGEONS) {
      this.spawn(this.queue.shift()!);
    }

    for (let i = this.pigeons.length - 1; i >= 0; i--) {
      const p = this.pigeons[i];
      const deliveredTo = p.update(dt, this.board);
      if (deliveredTo !== null) {
        this.pigeons.splice(i, 1);
        this.releaseMesh(p.mesh);
        this.bridge().deliver(deliveredTo, p.token.id);
        this.onDeliver(p, deliveredTo);
      }
    }
  }

  private spawn(token: FrameToken): void {
    const loc = this.board.portLoc(token.port);
    if (!loc) {
      this.bridge().drop(token.id);
      this.droppedByMe++;
      return;
    }
    const p = new Pigeon(token, loc.roost.col, loc.roost.row);
    p.attachMesh(this.acquireMesh(KIND_COLORS[p.decoded.kind]), this.board);
    this.pigeons.push(p);
  }

  pickablesByMesh(): THREE.Object3D[] {
    return this.pigeons.map((p) => p.mesh);
  }

  // ---- mesh pool --------------------------------------------------------------

  private acquireMesh(scrollColor: number): THREE.Group {
    let mesh = this.pool.pop();
    if (!mesh) {
      mesh = makePigeonMesh();
      this.group.add(mesh);
    }
    const scroll = mesh.userData.scrollMat as THREE.MeshStandardMaterial;
    scroll.color.setHex(scrollColor);
    scroll.emissive.setHex(scrollColor);
    return mesh;
  }

  private releaseMesh(mesh: THREE.Group): void {
    mesh.visible = false;
    mesh.userData.pigeon = null;
    if (this.pool.length < MAX_PIGEONS) this.pool.push(mesh);
    else this.group.remove(mesh);
  }
}

function makePigeonMesh(): THREE.Group {
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
  const scrollMat = new THREE.MeshStandardMaterial({ emissiveIntensity: 0.35, roughness: 0.5 });
  const scroll = new THREE.Mesh(scrollGeo, scrollMat);
  scroll.position.set(0, -0.14, 0);
  scroll.rotation.z = Math.PI / 2;
  g.add(scroll);
  g.userData.scrollMat = scrollMat;
  return g;
}
