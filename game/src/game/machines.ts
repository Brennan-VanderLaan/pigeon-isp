// Machine-local state and decision logic for the router legos. Pure
// functions + plain state objects: the simulation, the inspector panels,
// and the tests all consume exactly this — no behavior hides in meshes.
//
// Direction convention everywhere: 0=east 1=south 2=west 3=north. A frame
// that is TRAVELING in direction d entered the cell FROM (d+2)%4 — machines
// that care about provenance (hub, switch) reason in "toward where it came
// from" terms, exactly like switch ports.

import type { Decoded } from '../net/decode';

export const OPPOSITE = (dir: number): number => (dir + 2) % 4;

// ---- hub --------------------------------------------------------------------

/** A dumb repeater: every frame goes out every exit except back the way it
 *  came. The reason pigeon cloning exists. */
export function hubExits(travelDir: number): number[] {
  const back = OPPOSITE(travelDir);
  return [0, 1, 2, 3].filter((d) => d !== back);
}

// ---- switch -----------------------------------------------------------------

export interface CamEntry {
  dir: number; // exit direction toward this MAC
  learnedAt: number; // ms clock
  hits: number;
}

export interface SwitchState {
  table: Map<string, CamEntry>;
  ttlMs: number;
  maxEntries: number;
  floods: number;
  forwards: number;
}

export function newSwitchState(ttlMs = 30_000, maxEntries = 64): SwitchState {
  return { table: new Map(), ttlMs, maxEntries, floods: 0, forwards: 0 };
}

export interface SwitchDecision {
  /** unicast hit: single exit; otherwise flood out everything except entry */
  exits: number[];
  flooded: boolean;
}

/** The whole learning-switch algorithm, one pure step:
 *  1. learn src MAC → the direction the frame came from
 *  2. known unicast dst → forward out the stored direction
 *  3. broadcast or unknown dst → flood (all exits except entry)
 *  Aged-out entries are evicted lazily as they're touched. */
export function switchStep(st: SwitchState, frame: Decoded, travelDir: number, now: number): SwitchDecision {
  const cameFrom = OPPOSITE(travelDir);

  // learn (refresh) the source
  const src = st.table.get(frame.srcMac);
  if (src && now - src.learnedAt <= st.ttlMs) {
    src.dir = cameFrom;
    src.learnedAt = now;
  } else {
    if (st.table.size >= st.maxEntries && !st.table.has(frame.srcMac)) {
      evictOldest(st);
    }
    st.table.set(frame.srcMac, { dir: cameFrom, learnedAt: now, hits: 0 });
  }

  if (!frame.broadcast) {
    const dst = st.table.get(frame.dstMac);
    if (dst) {
      if (now - dst.learnedAt > st.ttlMs) {
        st.table.delete(frame.dstMac); // stale CAM entry: forget, flood
      } else if (dst.dir !== cameFrom) {
        dst.hits++;
        st.forwards++;
        return { exits: [dst.dir], flooded: false };
      } else {
        // dst lives back where this came from: a real switch filters
        // (drops) here; we send it back rather than lose it — the landing
        // can sort it out. Still counts as a forward.
        dst.hits++;
        st.forwards++;
        return { exits: [dst.dir], flooded: false };
      }
    }
  }

  st.floods++;
  return { exits: hubExits(travelDir), flooded: true };
}

function evictOldest(st: SwitchState): void {
  let oldest: string | null = null;
  let oldestAt = Infinity;
  for (const [mac, e] of st.table) {
    if (e.learnedAt < oldestAt) {
      oldestAt = e.learnedAt;
      oldest = mac;
    }
  }
  if (oldest) st.table.delete(oldest);
}

/** Inspector view of the CAM table, freshest first, stale entries dropped. */
export function camRows(st: SwitchState, now: number): { mac: string; dir: number; ageS: number; hits: number }[] {
  const rows: { mac: string; dir: number; ageS: number; hits: number }[] = [];
  for (const [mac, e] of st.table) {
    if (now - e.learnedAt > st.ttlMs) continue;
    rows.push({ mac, dir: e.dir, ageS: Math.floor((now - e.learnedAt) / 1000), hits: e.hits });
  }
  return rows.sort((a, b) => a.ageS - b.ageS);
}

// ---- meter ------------------------------------------------------------------

export interface MeterState {
  /** sliding 1s window via two buckets */
  bucketStart: number;
  bucketCount: number;
  lastRate: number; // frames/sec from the previous full bucket
  total: number;
  overTotal: number;
  thresholdPps: number;
}

export function newMeterState(thresholdPps = 100): MeterState {
  return { bucketStart: 0, bucketCount: 0, lastRate: 0, total: 0, overTotal: 0, thresholdPps };
}

export interface MeterDecision {
  over: boolean;
  rate: number;
}

/** Count a frame, roll the 1s bucket, decide over/under threshold. Over-rate
 *  traffic takes the machine's overflow exit — a rate limiter you can SEE. */
export function meterStep(st: MeterState, now: number): MeterDecision {
  if (now - st.bucketStart >= 1000) {
    // bucket rolled: last full bucket becomes the rate
    st.lastRate = now - st.bucketStart < 2000 ? st.bucketCount : 0;
    st.bucketStart = now;
    st.bucketCount = 0;
  }
  st.bucketCount++;
  st.total++;
  const rate = Math.max(st.lastRate, st.bucketCount); // react within the current second too
  const over = rate > st.thresholdPps;
  if (over) st.overTotal++;
  return { over, rate };
}
