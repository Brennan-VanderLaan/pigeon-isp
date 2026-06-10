// Filter machines: the branching logic of the factory. A pigeon rides in,
// the frame's decoded headers get evaluated, and it leaves straight ahead or
// out the side. Field matchers cover the common cases; `custom` takes a raw
// JS expression over the decoded frame for everything else — your router,
// your rules.
import type { Decoded } from '../net/decode';

export interface FilterConfig {
  /** what to look at: a named field, or 'custom' for a JS expression */
  field: 'kind' | 'eth.src' | 'eth.dst' | 'ip.src' | 'ip.dst' | 'l4.src' | 'l4.dst' | 'broadcast' | 'custom';
  /** substring to match (field mode) or the JS expression body (custom mode) */
  value: string;
}

export const FILTER_FIELDS: { id: FilterConfig['field']; label: string; hint: string }[] = [
  { id: 'kind', label: 'frame kind', hint: 'arp / arp-request / icmp / tcp / udp…' },
  { id: 'eth.src', label: 'src MAC', hint: 'substring, e.g. 0a:58' },
  { id: 'eth.dst', label: 'dst MAC', hint: 'substring, e.g. ff:ff' },
  { id: 'ip.src', label: 'src IP', hint: 'substring, e.g. 10.99.3.' },
  { id: 'ip.dst', label: 'dst IP', hint: 'substring, e.g. 10.99.4.10' },
  { id: 'l4.src', label: 'src port', hint: 'exact, e.g. 5201' },
  { id: 'l4.dst', label: 'dst port', hint: 'exact, e.g. 80' },
  { id: 'broadcast', label: 'is broadcast', hint: 'no value needed' },
  { id: 'custom', label: 'custom JS', hint: 'f.kind, f.srcMac, f.dstMac, f.ip?.src, f.ip?.dst, f.l4?.src, f.l4?.dst, f.len, f.broadcast, f.etherType' },
];

export interface CompiledFilter {
  match: (f: Decoded) => boolean;
  error?: string;
}

export function compileFilter(cfg: FilterConfig): CompiledFilter {
  const v = cfg.value.trim().toLowerCase();
  switch (cfg.field) {
    case 'broadcast':
      return { match: (f) => f.broadcast };
    case 'kind':
      return { match: (f) => f.kind.includes(v) };
    case 'eth.src':
      return { match: (f) => f.srcMac.toLowerCase().includes(v) };
    case 'eth.dst':
      return { match: (f) => f.dstMac.toLowerCase().includes(v) };
    case 'ip.src':
      return { match: (f) => (f.ip?.src ?? '').includes(v) };
    case 'ip.dst':
      return { match: (f) => (f.ip?.dst ?? '').includes(v) };
    case 'l4.src':
      return { match: (f) => String(f.l4?.src ?? '') === v };
    case 'l4.dst':
      return { match: (f) => String(f.l4?.dst ?? '') === v };
    case 'custom':
      try {
        // The player's code, the player's machine, the player's router.
        const fn = new Function('f', `"use strict"; return !!(${cfg.value});`) as (f: Decoded) => boolean;
        fn({ kind: 'other', summary: '', fields: [], broadcast: false, dstMac: '', srcMac: '', etherType: 0, len: 0 }); // smoke test
        return { match: (f) => { try { return fn(f); } catch { return false; } } };
      } catch (e) {
        return { match: () => false, error: (e as Error).message };
      }
  }
}

export function describeFilter(cfg: FilterConfig): string {
  if (cfg.field === 'broadcast') return 'broadcast?';
  if (cfg.field === 'custom') return `js: ${cfg.value.slice(0, 40)}`;
  return `${cfg.field} ~ "${cfg.value}"`;
}

/** Known frame kinds for the kind dropdown ('icmp' catches the family). */
export const KIND_OPTIONS = [
  'arp', 'arp-request', 'arp-reply',
  'icmp', 'icmp-echo', 'icmp-reply',
  'tcp', 'udp', 'other',
];

/** Per-filter runtime telemetry: what did this machine actually decide? */
export interface FilterStats {
  hits: number;
  misses: number;
  recent: ({ summary: string; matched: boolean } | undefined)[];
  ptr: number;
}

export function newFilterStats(): FilterStats {
  return { hits: 0, misses: 0, recent: new Array(6), ptr: 0 };
}

/** Which bytes of the datagram a field matcher reads (for the hex view).
 *  IP-based offsets honor the sample's actual IHL when one is available. */
export function fieldByteRanges(field: FilterConfig['field'], sample?: Uint8Array): { ranges: [number, number][]; note: string } {
  const ihl = sample && sample.length > 14 && (sample[12] === 0x08 && sample[13] === 0x00)
    ? (sample[14] & 0x0f) * 4 : 20;
  const l4 = 14 + ihl;
  switch (field) {
    case 'eth.dst': return { ranges: [[0, 6]], note: 'ethernet destination MAC' };
    case 'eth.src': return { ranges: [[6, 12]], note: 'ethernet source MAC' };
    case 'broadcast': return { ranges: [[0, 6]], note: 'dst MAC == ff:ff:ff:ff:ff:ff' };
    case 'ip.src': return { ranges: [[26, 30]], note: 'IPv4 source address' };
    case 'ip.dst': return { ranges: [[30, 34]], note: 'IPv4 destination address' };
    case 'l4.src': return { ranges: [[l4, l4 + 2]], note: `TCP/UDP source port (offset ${l4})` };
    case 'l4.dst': return { ranges: [[l4 + 2, l4 + 4]], note: `TCP/UDP destination port (offset ${l4 + 2})` };
    case 'kind': return {
      ranges: [[12, 14], [23, 24], [l4, l4 + 1]],
      note: 'ethertype + ip.proto + l4 type byte → frame kind',
    };
    case 'custom': return { ranges: [], note: 'your expression sees the whole decoded frame' };
  }
}

/** A mock datagram for the editor when no real frame has crossed yet:
 *  ICMP echo, 10.99.3.10 → 10.99.4.10. */
export function sampleFrame(): Uint8Array {
  const mac = (s: string) => s.split(':').map((x) => parseInt(x, 16));
  const ip = (s: string) => s.split('.').map(Number);
  const icmp = [8, 0, 0xf7, 0xff, 0x1d, 0x42, 0, 1];
  const ihdr = [0x45, 0, 0, 20 + icmp.length, 0x12, 0x34, 0x40, 0, 64, 1, 0, 0, ...ip('10.99.3.10'), ...ip('10.99.4.10')];
  return new Uint8Array([
    ...mac('0a:58:0a:63:04:0a'), ...mac('0a:58:0a:63:03:0a'), 0x08, 0x00,
    ...ihdr, ...icmp,
  ]);
}
