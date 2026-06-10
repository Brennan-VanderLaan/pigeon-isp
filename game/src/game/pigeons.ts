// Pigeons: the physical body of a frame token. They spawn at their host's
// ROOST, ride belts and machines, and deliver their buffered frame at a
// LANDING pad.
//
// Movement is emission-based: every machine a pigeon enters yields a list of
// EMISSIONS {col,row,dir} — the pigeon takes the first and clones for the
// rest (refcounted via copy-deliver). A belt emits one (same cell, its dir);
// a hub emits one per exit; a multi-port switch emits at its exit PORT cells,
// possibly across the appliance body. An empty emission list from an
// appliance means the frame was filtered (802.1D § 7.7) and is dropped.
//
// Built for 5000x: multi-cell stepping, full queue drain, mesh pooling.
import * as THREE from 'three';
import { Board, DIRS, COLS, ROWS } from './board';
import { hubExits, meterStep } from './machines';
import { midi, triggerMidi } from './midi';
import { tableKey, tableLearn, tableLookup } from './tables';
import { decodeFrame, KIND_COLORS, type Decoded } from '../net/decode';
import type { Bridge, FrameToken } from '../types';

const MAX_PIGEONS = 500;
const MAX_QUEUE = 10000;
const MAX_STEPS_PER_TICK = 512;
const BASE_SPEED = 2.2;

let speedMult = 1;
export function setSpeed(mult: number): void {
  speedMult = Math.max(0.1, Math.min(mult, 5000));
}
export function getSpeed(): number {
  return speedMult;
}

/** Where a machine sends a pigeon: a cell to be at, and a direction to ride. */
export interface Emission {
  col: number;
  row: number;
  dir: number;
}

/** Result of asking a cell where a pigeon goes. */
export type Routing =
  | { kind: 'emit'; emissions: Emission[] }
  | { kind: 'land'; portId: number }
  | { kind: 'drop' } // filtered / nowhere — consume the frame
  | { kind: 'wait' }; // no path yet — sit and bob

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
  travelDir = 0;
  private fromPos = new THREE.Vector3();
  private toPos = new THREE.Vector3();
  private toCell: { col: number; row: number } | null = null;
  private progress = 0;
  private bobPhase = Math.random() * Math.PI * 2;

  constructor(readonly token: FrameToken, col: number, row: number, decoded?: Decoded) {
    this.decoded = decoded ?? decodeFrame(token.snapshot, token.fullLen);
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
    // Scroll size tracks frame size: a 64B ARP carries a thin note, a 1500B
    // MTU frame a fat scroll. Log scale so the range 64B..9KB reads well.
    const scroll = this.mesh.userData.scroll as THREE.Mesh;
    if (scroll) {
      const f = Math.max(0, Math.min(1, Math.log2(this.token.fullLen / 64) / Math.log2(9000 / 64)));
      const s = 0.6 + f * 1.9; // 0.6x (tiny) .. 2.5x (jumbo)
      scroll.scale.set(s, 1, s);
    }
  }

  /** Returns: portId to deliver, -1 to drop, null to keep going. */
  update(dt: number, board: Board): number | null {
    if (this.state === 'waiting') {
      this.bobPhase += dt * 6;
      this.mesh.position.y = 0.22 + Math.abs(Math.sin(this.bobPhase)) * 0.05;
      const r = this.routeFrom(board, this.col, this.row);
      if (r.kind === 'drop') return -1;
      if (r.kind !== 'emit' || !this.take(board, r.emissions)) return null;
      this.state = 'riding';
    }

    // Advance, but never travel more than MAX_STEPS_PER_TICK CELLS in one
    // tick — and cap the INCREMENT itself rather than zeroing progress, so we
    // never skip a cell or discard sub-cell position. Every integer of
    // progress = one cell arrived-at-and-evaluated; nothing is stepped over.
    let budget = dt * BASE_SPEED * speedMult;
    if (budget > MAX_STEPS_PER_TICK) budget = MAX_STEPS_PER_TICK;
    this.progress += budget;
    while (this.progress >= 1) {
      this.progress -= 1;
      this.col = this.toCell!.col;
      this.row = this.toCell!.row;
      const here = board.cellAt(this.col, this.row);
      if (here?.type === 'landing') return here.port.id;

      const r = this.routeFrom(board, this.col, this.row);
      if (r.kind === 'land') return r.portId;
      if (r.kind === 'drop') return -1;
      if (r.kind !== 'emit' || !this.take(board, r.emissions)) {
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

  /** Take emissions[0] (possibly relocating across an appliance), clone the
   *  rest. Returns false if the chosen exit is blocked. */
  private take(board: Board, emissions: Emission[]): boolean {
    // Clones first — they read this pigeon's frame, not its mutated position.
    for (let i = 1; i < emissions.length; i++) this.cloneSink?.(emissions[i]);
    const e = emissions[0];
    this.col = e.col;
    this.row = e.row;
    return this.beginSegment(board, e.dir);
  }

  // set by the manager each update so take() can request clones
  cloneSink?: (e: Emission) => void;

  /** Where does the machinery at (col,row) send THIS frame? */
  private routeFrom(board: Board, col: number, row: number): Routing {
    const cell = board.cellAt(col, row);
    if (!cell) return { kind: 'wait' };
    switch (cell.type) {
      case 'belt':
        return { kind: 'emit', emissions: [{ col, row, dir: cell.dir }] };
      case 'filter': {
        const matched = cell.compiled.match(this.decoded);
        const exit = matched ? cell.matchDir : cell.defaultDir;
        const st = cell.stats;
        if (matched) st.hits++; else st.misses++;
        st.recent[st.ptr % st.recent.length] = { summary: this.decoded.summary, matched, exit };
        st.ptr++;
        cell.lastFrame = this.token.snapshot;
        return { kind: 'emit', emissions: [{ col, row, dir: exit }] };
      }
      case 'hub': {
        cell.count++;
        return { kind: 'emit', emissions: hubExits(this.travelDir).map((dir) => ({ col, row, dir })) };
      }
      case 'meter': {
        const pass = meterStep(cell.state, this.token.fullLen, performance.now()).pass;
        return { kind: 'emit', emissions: [{ col, row, dir: pass ? cell.defaultDir : cell.overflowDir }] };
      }
      case 'midi': {
        // Play music on pass-through, rate-limited (5000x would jam MIDI).
        const now = performance.now();
        if (midi.ready && now - cell.lastFireMs >= cell.cfg.cooldownMs) {
          cell.lastFireMs = now;
          cell.fired++;
          cell.lastNotes = triggerMidi(cell.cfg, this.decoded, this.token.snapshot);
        }
        return { kind: 'emit', emissions: [{ col, row, dir: cell.dir }] };
      }
      case 'learn': {
        // Write key -> the direction this frame CAME FROM, then pass through.
        const k = tableKey(cell.keyField, this.decoded);
        if (k !== null) {
          tableLearn(board.getTable(cell.table), k, (this.travelDir + 2) % 4, performance.now());
          cell.writes++;
        }
        return { kind: 'emit', emissions: [{ col, row, dir: cell.dir }] };
      }
      case 'lookup': {
        // Read key -> stored direction; hit routes there, miss takes missDir.
        const k = tableKey(cell.keyField, this.decoded);
        const dir = k !== null ? tableLookup(board.getTable(cell.table), k, performance.now()) : null;
        if (dir !== null) { cell.hits++; return { kind: 'emit', emissions: [{ col, row, dir }] }; }
        cell.misses++;
        return { kind: 'emit', emissions: [{ col, row, dir: cell.missDir }] };
      }
      case 'appliance-port-in': {
        // A frame entered this port's IN lane — the switch routes it (802.1D),
        // emitting at destination port(s)' OUT lanes.
        const res = board.routeAppliance(cell.applianceId, cell.portIndex, this.decoded, performance.now());
        if (res === 'filtered' || res.length === 0) return { kind: 'drop' };
        return { kind: 'emit', emissions: res };
      }
      case 'appliance-port-out':
        // OUT lane: switch-placed pigeons ride outward off it; anything
        // arriving inward (mis-wired belt) is solid.
        if (this.travelDir === cell.dir) {
          return { kind: 'emit', emissions: [{ col, row, dir: cell.dir }] };
        }
        return { kind: 'wait' };
      case 'appliance-body':
      case 'appliance-pending':
        return { kind: 'wait' }; // solid; pigeons only meet appliances at port lanes
      case 'roost':
        return { kind: 'emit', emissions: [{ col, row, dir: cell.facing }] };
      case 'landing':
        return { kind: 'land', portId: cell.port.id };
    }
  }

  private beginSegment(board: Board, dir: number): boolean {
    const toCol = this.col + DIRS[dir].dx;
    const toRow = this.row + DIRS[dir].dz;
    if (toCol < 0 || toRow < 0 || toCol >= COLS || toRow >= ROWS) return false;
    const target = board.cellAt(toCol, toRow);
    if (target?.type === 'roost') return false;
    // Appliances are solid except at IN lanes (frames enter there). OUT
    // lanes emit but don't accept; bodies and half-placed ports are walls.
    if (target?.type === 'appliance-body' || target?.type === 'appliance-pending' ||
        target?.type === 'appliance-port-out') return false;
    const here = board.cellAt(this.col, this.row);
    if (here?.type === 'roost' && target === undefined) return false;
    this.toCell = { col: toCol, row: toRow };
    this.travelDir = dir;
    this.fromPos.copy(board.cellToWorld(this.col, this.row, 0.22));
    this.toPos.copy(board.cellToWorld(toCol, toRow, 0.22));
    this.mesh.rotation.y = Math.atan2(this.toPos.x - this.fromPos.x, this.toPos.z - this.fromPos.z);
    return true;
  }

  /** Place this (clone) at an emission point and ride out. False if blocked. */
  placeAndRide(board: Board, e: Emission): boolean {
    this.col = e.col;
    this.row = e.row;
    this.state = 'riding';
    return this.beginSegment(board, e.dir);
  }
}

export class PigeonManager {
  pigeons: Pigeon[] = [];
  droppedByMe = 0;
  readonly group = new THREE.Group();
  private queue: FrameToken[] = [];
  private pool: THREE.Group[] = [];
  private onDeliver: (pigeon: Pigeon, portId: number) => void;
  private frameRefs = new Map<number, number>();
  private cloneBacklog: { p: Pigeon; e: Emission }[] = [];

  constructor(
    scene: THREE.Scene,
    private board: Board,
    private bridge: () => Bridge,
    onDeliver: (pigeon: Pigeon, portId: number) => void,
  ) {
    scene.add(this.group);
    this.onDeliver = onDeliver;
  }

  enqueue(token: FrameToken): void {
    this.queue.push(token);
    if (this.queue.length > MAX_QUEUE) {
      const victim = this.queue.shift()!;
      this.bridge().drop(victim.id);
      this.droppedByMe++;
    }
  }

  queued(): number {
    return this.queue.length;
  }

  update(dt: number): void {
    while (this.queue.length > 0 && this.pigeons.length < MAX_PIGEONS) {
      this.spawn(this.queue.shift()!);
    }

    for (let i = this.pigeons.length - 1; i >= 0; i--) {
      const p = this.pigeons[i];
      p.cloneSink = (e) => this.cloneBacklog.push({ p, e });
      const ret = p.update(dt, this.board);
      p.cloneSink = undefined;
      if (ret === null) continue;
      this.pigeons.splice(i, 1);
      this.releaseMesh(p.mesh);
      if (ret === -1) this.unref(p.token.id); // filtered/dropped on the floor
      else { this.resolve(p.token.id, ret); this.onDeliver(p, ret); }
    }

    if (this.cloneBacklog.length > 0) {
      const backlog = this.cloneBacklog;
      this.cloneBacklog = [];
      for (const { p, e } of backlog) {
        if (this.pigeons.length >= MAX_PIGEONS) { this.unref(p.token.id); continue; }
        const refs = this.frameRefs.get(p.token.id) ?? 0;
        if (refs === 0) continue;
        const clone = new Pigeon(p.token, e.col, e.row, p.decoded);
        clone.attachMesh(this.acquireMesh(KIND_COLORS[p.decoded.kind]), this.board);
        if (!clone.placeAndRide(this.board, e)) {
          this.releaseMesh(clone.mesh);
          continue;
        }
        this.frameRefs.set(p.token.id, refs + 1);
        this.pigeons.push(clone);
      }
    }
  }

  private resolve(frameId: number, portId: number): void {
    const refs = this.frameRefs.get(frameId) ?? 1;
    if (refs > 1) {
      this.frameRefs.set(frameId, refs - 1);
      this.bridge().copyDeliver(portId, frameId);
    } else {
      this.frameRefs.delete(frameId);
      this.bridge().deliver(portId, frameId);
    }
  }

  private unref(frameId: number): void {
    const refs = this.frameRefs.get(frameId) ?? 1;
    if (refs > 1) {
      this.frameRefs.set(frameId, refs - 1);
    } else {
      this.frameRefs.delete(frameId);
      this.bridge().drop(frameId);
      this.droppedByMe++;
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
    this.frameRefs.set(token.id, 1);
    this.pigeons.push(p);
  }

  pickablesByMesh(): THREE.Object3D[] {
    return this.pigeons.map((p) => p.mesh);
  }

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
  g.userData.scroll = scroll; // for per-pigeon frame-size scaling
  return g;
}
