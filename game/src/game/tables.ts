// Named tables — shared router state the primitive machines read and write.
// A Learn machine writes src MAC -> the direction the frame came from; a
// Lookup machine reads dst MAC -> that direction. Co-locate them at a
// junction sharing one table ("mac0"), wire the miss exit to a hub, and you
// have built a learning switch (IEEE 802.1D) out of parts — the control
// plane (the table) and the data plane (the machines) made explicit and
// separate, exactly like real hardware.
//
// Directions are absolute board compass (0=E 1=S 2=W 3=N), so the value a
// Learn stores at one cell means the same physical direction at a Lookup a
// few cells away.
import type { Decoded } from '../net/decode';

export type KeyField = 'eth.src' | 'eth.dst' | 'ip.src' | 'ip.dst' | 'l4.src' | 'l4.dst';

export const KEY_FIELDS: { id: KeyField; label: string }[] = [
  { id: 'eth.src', label: 'src MAC' },
  { id: 'eth.dst', label: 'dst MAC' },
  { id: 'ip.src', label: 'src IP' },
  { id: 'ip.dst', label: 'dst IP' },
  { id: 'l4.src', label: 'src port' },
  { id: 'l4.dst', label: 'dst port' },
];

/** Extract the key a table is keyed on from a decoded frame. null = the field
 *  isn't present (e.g. L4 port on an ARP frame), so the machine no-ops. */
export function tableKey(field: KeyField, d: Decoded): string | null {
  switch (field) {
    case 'eth.src': return d.srcMac || null;
    case 'eth.dst': return d.dstMac || null;
    case 'ip.src': return d.ip?.src ?? null;
    case 'ip.dst': return d.ip?.dst ?? null;
    case 'l4.src': return d.l4 ? String(d.l4.src) : null;
    case 'l4.dst': return d.l4 ? String(d.l4.dst) : null;
  }
}

export interface TableEntry {
  dir: number;
  at: number; // ms clock, for ageing
  hits: number;
}

export interface NamedTable {
  name: string;
  entries: Map<string, TableEntry>;
  ttlMs: number;
  maxEntries: number;
}

export function newNamedTable(name: string, ttlMs = 300_000, maxEntries = 256): NamedTable {
  return { name, entries: new Map(), ttlMs, maxEntries };
}

export function tableLearn(t: NamedTable, key: string, dir: number, now: number): void {
  const e = t.entries.get(key);
  if (e) {
    e.dir = dir;
    e.at = now;
    return;
  }
  if (t.entries.size >= t.maxEntries) {
    // evict oldest
    let oldest: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of t.entries) {
      if (v.at < oldestAt) { oldestAt = v.at; oldest = k; }
    }
    if (oldest) t.entries.delete(oldest);
  }
  t.entries.set(key, { dir, at: now, hits: 0 });
}

/** Returns the stored direction, or null on miss / stale. */
export function tableLookup(t: NamedTable, key: string, now: number): number | null {
  const e = t.entries.get(key);
  if (!e) return null;
  if (now - e.at > t.ttlMs) {
    t.entries.delete(key);
    return null;
  }
  e.hits++;
  return e.dir;
}

export function tableRows(t: NamedTable, now: number): { key: string; dir: number; ageS: number; hits: number }[] {
  const rows: { key: string; dir: number; ageS: number; hits: number }[] = [];
  for (const [key, e] of t.entries) {
    if (now - e.at > t.ttlMs) continue;
    rows.push({ key, dir: e.dir, ageS: Math.floor((now - e.at) / 1000), hits: e.hits });
  }
  return rows.sort((a, b) => a.ageS - b.ageS);
}
