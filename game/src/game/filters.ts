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
