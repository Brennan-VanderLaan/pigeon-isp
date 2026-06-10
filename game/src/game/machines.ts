// Router lego logic — pure functions + plain state, shared by the
// simulation, the inspector panels, and the tests. No behavior hides in a
// mesh.
//
// Direction convention: 0=east 1=south 2=west 3=north. A frame TRAVELING in
// direction d entered the cell it's on FROM (d+2)%4.

import type { Decoded } from '../net/decode';

export const OPPOSITE = (dir: number): number => (dir + 2) % 4;

// ---- hub --------------------------------------------------------------------

/** A dumb repeater: every frame out every exit except back the way it came. */
export function hubExits(travelDir: number): number[] {
  const back = OPPOSITE(travelDir);
  return [0, 1, 2, 3].filter((d) => d !== back);
}

// ---- switch (IEEE 802.1D transparent bridge) --------------------------------
//
// The forwarding behaviour is IEEE 802.1D, MAC Bridges:
//   - learning the source address      § 7.8
//   - forward / filter / flood the dst  § 7.7
//   - ageing entries out of the FDB     § 7.9
// Unknown-unicast and broadcast/group frames are flooded to every port in the
// same domain except the ingress port — that is what lets ARP (RFC 826)
// who-has frames reach an as-yet-unlearned host.

export interface FdbEntry {
  port: number; // port index the MAC was learned on
  learnedAt: number; // ms clock
  hits: number;
}

export interface SwitchState {
  fdb: Map<string, FdbEntry>; // the filtering database (CAM table)
  ttlMs: number; // ageing time (802.1D default 300s; we default shorter)
  maxEntries: number;
  floods: number;
  forwards: number;
  filters: number;
}

export function newSwitchState(ttlMs = 300_000, maxEntries = 256): SwitchState {
  return { fdb: new Map(), ttlMs, maxEntries, floods: 0, forwards: 0, filters: 0 };
}

export type SwitchAction = 'forward' | 'flood' | 'filter';

export interface SwitchDecision {
  exits: number[]; // port indices to emit on ([] = filtered/dropped)
  action: SwitchAction;
}

/** One 802.1D forwarding step. `ingress` is the port index the frame arrived
 *  on; `portCount` is the number of ports on this bridge. */
export function switchStep(st: SwitchState, frame: Decoded, ingress: number, portCount: number, now: number): SwitchDecision {
  // § 7.8 learning: associate the source MAC with the ingress port.
  const src = st.fdb.get(frame.srcMac);
  if (src) {
    src.port = ingress;
    src.learnedAt = now;
  } else {
    if (st.fdb.size >= st.maxEntries) evictOldest(st);
    st.fdb.set(frame.srcMac, { port: ingress, learnedAt: now, hits: 0 });
  }

  const others = (): number[] => {
    const out: number[] = [];
    for (let p = 0; p < portCount; p++) if (p !== ingress) out.push(p);
    return out;
  };

  // § 7.7 forwarding decision.
  if (!frame.broadcast) {
    const dst = st.fdb.get(frame.dstMac);
    if (dst && now - dst.learnedAt <= st.ttlMs) {
      dst.hits++;
      if (dst.port === ingress) {
        // Destination is on the ingress port: the two hosts share a segment,
        // the bridge must not forward (§ 7.7). Filtered.
        st.filters++;
        return { exits: [], action: 'filter' };
      }
      st.forwards++;
      return { exits: [dst.port], action: 'forward' };
    }
    if (dst) st.fdb.delete(frame.dstMac); // aged out: forget, then flood
  }

  // Unknown unicast OR broadcast/group: flood everywhere but ingress.
  st.floods++;
  return { exits: others(), action: 'flood' };
}

function evictOldest(st: SwitchState): void {
  let oldest: string | null = null;
  let oldestAt = Infinity;
  for (const [mac, e] of st.fdb) {
    if (e.learnedAt < oldestAt) {
      oldestAt = e.learnedAt;
      oldest = mac;
    }
  }
  if (oldest) st.fdb.delete(oldest);
}

/** Inspector view of the FDB, freshest first, stale entries hidden. */
export function fdbRows(st: SwitchState, now: number): { mac: string; port: number; ageS: number; hits: number }[] {
  const rows: { mac: string; port: number; ageS: number; hits: number }[] = [];
  for (const [mac, e] of st.fdb) {
    if (now - e.learnedAt > st.ttlMs) continue;
    rows.push({ mac, port: e.port, ageS: Math.floor((now - e.learnedAt) / 1000), hits: e.hits });
  }
  return rows.sort((a, b) => a.ageS - b.ageS);
}

// ---- meter (token-bucket rate limiter) --------------------------------------
//
// A token bucket: tokens accrue at `limit` per second up to a burst cap.
// Each frame spends tokens — 1 per frame in pps mode, its byte length in bps
// mode. Frames that can pay take the normal exit; the EXCESS (no tokens) is
// diverted to the overflow exit. So the allowed rate always flows; only the
// surplus is shaped. (cf. a classic leaky/token bucket, RFC 2697 srTCM.)

export type MeterMode = 'pps' | 'bps';

export interface MeterState {
  mode: MeterMode;
  limit: number; // tokens per second (frames/s, or bytes/s)
  tokens: number;
  lastRefill: number;
  total: number;
  passed: number;
  diverted: number;
  rate: number; // observed pass-rate, for the readout
  rateBucketStart: number;
  rateBucketUnits: number;
}

export function newMeterState(limit = 100, mode: MeterMode = 'pps'): MeterState {
  return {
    mode, limit, tokens: limit, lastRefill: 0,
    total: 0, passed: 0, diverted: 0,
    rate: 0, rateBucketStart: 0, rateBucketUnits: 0,
  };
}

export interface MeterDecision {
  pass: boolean;
}

/** Spend tokens for one frame of `frameLen` bytes; pass if affordable. */
export function meterStep(st: MeterState, frameLen: number, now: number): MeterDecision {
  // Refill: limit tokens per second, burst cap = 1s worth.
  if (st.lastRefill === 0) st.lastRefill = now;
  const elapsed = Math.max(0, now - st.lastRefill) / 1000;
  st.tokens = Math.min(st.limit, st.tokens + elapsed * st.limit);
  st.lastRefill = now;

  const cost = st.mode === 'pps' ? 1 : frameLen;
  st.total++;
  let pass = false;
  if (st.tokens >= cost) {
    st.tokens -= cost;
    st.passed++;
    pass = true;
    rollRate(st, now, cost);
  } else {
    st.diverted++;
  }
  return { pass };
}

/** Observed pass-rate over a 1s window, in the meter's own units. */
function rollRate(st: MeterState, now: number, units: number): void {
  if (st.rateBucketStart === 0) st.rateBucketStart = now;
  if (now - st.rateBucketStart >= 1000) {
    st.rate = st.rateBucketUnits;
    st.rateBucketStart = now;
    st.rateBucketUnits = 0;
  }
  st.rateBucketUnits += units;
}

/** Human limit string, e.g. "100 pps" or "2.0 Mbps". */
export function meterLabel(st: MeterState): string {
  if (st.mode === 'pps') return `${st.limit} pps`;
  const bits = st.limit * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gbps`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbps`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(1)} kbps`;
  return `${bits} bps`;
}
