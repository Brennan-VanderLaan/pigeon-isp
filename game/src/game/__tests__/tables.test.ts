// Named-table primitives: the parts you build a switch from. If Learn +
// Lookup over a shared table behaves like 802.1D, a player can reconstruct
// the switch appliance by hand.
import { describe, expect, it } from 'vitest';
import { decodeFrame } from '../../net/decode';
import { newNamedTable, tableKey, tableLearn, tableLookup, tableRows } from '../tables';
import { ALICE_MAC, BOB_MAC, FRAMES } from './frames';

const decode = (raw: Uint8Array) => decodeFrame(raw.slice(0, 128), raw.length);

describe('tableKey', () => {
  it('pulls the keyed field, null when absent', () => {
    const tcp = decode(FRAMES.tcpSyn());
    expect(tableKey('eth.src', tcp)).toBe(ALICE_MAC);
    expect(tableKey('eth.dst', tcp)).toBe(BOB_MAC);
    expect(tableKey('l4.dst', tcp)).toBe('5201');
    // ARP has no IP/L4 fields
    expect(tableKey('l4.dst', decode(FRAMES.arpWhoHasBcast()))).toBeNull();
    expect(tableKey('ip.src', decode(FRAMES.arpWhoHasBcast()))).toBeNull();
  });
});

describe('Learn + Lookup = a switch, by hand', () => {
  it('learns src→direction, looks up dst→direction, misses on unknown', () => {
    const t = newNamedTable('mac0', 60_000);
    // alice's frame arrived from the west (a Learn there records west)
    tableLearn(t, ALICE_MAC, 2, 1000);
    // a frame for alice now resolves to west
    expect(tableLookup(t, ALICE_MAC, 1100)).toBe(2);
    // bob unknown → miss (Lookup would take its miss exit / flood)
    expect(tableLookup(t, BOB_MAC, 1100)).toBeNull();
  });

  it('ages entries out like a real CAM', () => {
    const t = newNamedTable('mac0', 5_000);
    tableLearn(t, BOB_MAC, 0, 1000);
    expect(tableLookup(t, BOB_MAC, 4000)).toBe(0);
    expect(tableLookup(t, BOB_MAC, 7000)).toBeNull(); // stale
    expect(tableRows(t, 7000).find((r) => r.key === BOB_MAC)).toBeUndefined();
  });

  it('refreshes and counts hits', () => {
    const t = newNamedTable('mac0', 60_000);
    tableLearn(t, ALICE_MAC, 1, 1000);
    tableLookup(t, ALICE_MAC, 2000);
    tableLookup(t, ALICE_MAC, 3000);
    const row = tableRows(t, 3000).find((r) => r.key === ALICE_MAC);
    expect(row?.hits).toBe(2);
    expect(row?.dir).toBe(1);
  });

  it('evicts oldest when full', () => {
    const t = newNamedTable('mac0', 60_000, 2);
    tableLearn(t, 'a', 0, 1000);
    tableLearn(t, 'b', 0, 2000);
    tableLearn(t, 'c', 0, 3000); // evicts 'a'
    expect(t.entries.size).toBe(2);
    expect(t.entries.has('a')).toBe(false);
  });
});
