// The filter logic contract. Every bug a player reports about "the machine
// matched the wrong thing" lands here as a regression test.
import { describe, expect, it } from 'vitest';
import { decodeFrame } from '../../net/decode';
import { compileFilter, fieldByteRanges, filterExit, legacyExits, sampleFrame } from '../filters';
import { ALICE_IP, ALICE_MAC, BOB_IP, FRAMES } from './frames';

const decode = (raw: Uint8Array) => decodeFrame(raw.slice(0, 128), raw.length);

describe('decode', () => {
  it('classifies the aviary protocol zoo', () => {
    expect(decode(FRAMES.icmpEchoUni()).kind).toBe('icmp-echo');
    expect(decode(FRAMES.icmpReplyUni()).kind).toBe('icmp-reply');
    expect(decode(FRAMES.arpWhoHasBcast()).kind).toBe('arp-request');
    expect(decode(FRAMES.arpWhoHasUnicast()).kind).toBe('arp-request');
    expect(decode(FRAMES.arpReply()).kind).toBe('arp-reply');
    expect(decode(FRAMES.tcpSyn()).kind).toBe('tcp');
    expect(decode(FRAMES.udpStream()).kind).toBe('udp');
  });

  it('broadcast means dst ff:ff:ff:ff:ff:ff, nothing else', () => {
    expect(decode(FRAMES.arpWhoHasBcast()).broadcast).toBe(true);
    // Linux revalidates neighbors with UNICAST who-has — an ARP request that
    // is NOT broadcast. Observed live in the aviary; keep it that way.
    expect(decode(FRAMES.arpWhoHasUnicast()).broadcast).toBe(false);
    expect(decode(FRAMES.icmpEchoUni()).broadcast).toBe(false);
  });

  it('exposes structured fields for filters', () => {
    const d = decode(FRAMES.tcpSyn());
    expect(d.ip).toMatchObject({ src: ALICE_IP, dst: BOB_IP, proto: 6 });
    expect(d.l4).toMatchObject({ src: 43210, dst: 5201 });
    expect(d.l4?.flags).toContain('SYN');
    expect(d.srcMac).toBe(ALICE_MAC);
  });

  it('honors IP header options (IHL > 20) for L4 fields', () => {
    const d = decode(FRAMES.tcpSynIpOptions());
    expect(d.kind).toBe('tcp');
    expect(d.l4).toMatchObject({ src: 43210, dst: 5201 });
  });

  it('survives truncated snapshots without misclassifying', () => {
    const tiny = FRAMES.tcpSyn().slice(0, 20); // cut inside the IP header
    const d = decodeFrame(tiny, 1500);
    expect(d.kind).toBe('other'); // not enough bytes to claim tcp
    expect(d.len).toBe(1500);
  });
});

describe('field matchers', () => {
  const cases: [string, Parameters<typeof compileFilter>[0], keyof typeof FRAMES, boolean][] = [
    ['kind icmp matches echo', { field: 'kind', value: 'icmp' }, 'icmpEchoUni', true],
    ['kind icmp matches reply', { field: 'kind', value: 'icmp' }, 'icmpReplyUni', true],
    ['kind icmp rejects arp', { field: 'kind', value: 'icmp' }, 'arpWhoHasBcast', false],
    ['kind icmp rejects tcp', { field: 'kind', value: 'icmp' }, 'tcpSyn', false],
    ['kind arp matches unicast who-has', { field: 'kind', value: 'arp' }, 'arpWhoHasUnicast', true],
    ['kind arp rejects icmp', { field: 'kind', value: 'arp' }, 'icmpEchoUni', false],
    ['kind icmp-echo rejects reply', { field: 'kind', value: 'icmp-echo' }, 'icmpReplyUni', false],
    ['broadcast matches bcast arp', { field: 'broadcast', value: '' }, 'arpWhoHasBcast', true],
    ['broadcast rejects unicast arp', { field: 'broadcast', value: '' }, 'arpWhoHasUnicast', false],
    ['broadcast rejects unicast icmp', { field: 'broadcast', value: '' }, 'icmpEchoUni', false],
    ['ip.dst substring (node prefix)', { field: 'ip.dst', value: '10.99.4.' }, 'tcpSyn', true],
    ['ip.dst rejects other node', { field: 'ip.dst', value: '10.99.5.' }, 'tcpSyn', false],
    ['ip.src exact-ish', { field: 'ip.src', value: ALICE_IP }, 'icmpEchoUni', true],
    ['ip fields absent on arp', { field: 'ip.dst', value: '10.99' }, 'arpWhoHasBcast', false],
    ['eth.src substring, case-insensitive', { field: 'eth.src', value: '0A:58' }, 'icmpEchoUni', true],
    ['l4.dst exact', { field: 'l4.dst', value: '5201' }, 'tcpSyn', true],
    ['l4.dst no substring trap (520 != 5201)', { field: 'l4.dst', value: '520' }, 'tcpSyn', false],
    ['l4.dst on udp', { field: 'l4.dst', value: '5004' }, 'udpStream', true],
  ];
  for (const [name, cfg, frame, want] of cases) {
    it(name, () => {
      expect(compileFilter(cfg).match(decode(FRAMES[frame]()))).toBe(want);
    });
  }

  it('custom expressions work and survive runtime errors', () => {
    const f = compileFilter({ field: 'custom', value: "f.kind === 'tcp' && f.l4?.dst === 5201" });
    expect(f.error).toBeUndefined();
    expect(f.match(decode(FRAMES.tcpSyn()))).toBe(true);
    expect(f.match(decode(FRAMES.icmpEchoUni()))).toBe(false);
    const throwy = compileFilter({ field: 'custom', value: 'f.ip.dst.length > 0' }); // f.ip undefined on arp
    expect(throwy.match(decode(FRAMES.arpWhoHasBcast()))).toBe(false); // throws -> no match, never crashes
  });

  it('rejects unparseable custom expressions at compile time', () => {
    const f = compileFilter({ field: 'custom', value: 'this is not js (' });
    expect(f.error).toBeTruthy();
    expect(f.match(decode(FRAMES.tcpSyn()))).toBe(false);
  });
});

describe('filterExit — the geometry truth table', () => {
  // dirs: 0=east 1=south 2=west 3=north. Two independent exits; the
  // DEFAULT (where everything else goes) is fully configurable.
  it('matched frames take the match exit, everything else the default', () => {
    for (let matchDir = 0; matchDir < 4; matchDir++) {
      for (let defaultDir = 0; defaultDir < 4; defaultDir++) {
        expect(filterExit(matchDir, defaultDir, true)).toBe(matchDir);
        expect(filterExit(matchDir, defaultDir, false)).toBe(defaultDir);
      }
    }
  });

  it('converts v1 floors (facing + side + match-goes-where) faithfully', () => {
    // east-facing, eject right, matching ejects: match->south, default->east
    expect(legacyExits(0, 1, true)).toEqual({ matchDir: 1, defaultDir: 0 });
    // east-facing, eject right, matching goes straight (the screenshot
    // config): match->east, everything else thrown south
    expect(legacyExits(0, 1, false)).toEqual({ matchDir: 0, defaultDir: 1 });
    // north-facing, eject left -> west
    expect(legacyExits(3, -1, true)).toEqual({ matchDir: 2, defaultDir: 3 });
  });
});

describe('fieldByteRanges (hex view honesty)', () => {
  it('points at the right bytes for fixed fields', () => {
    expect(fieldByteRanges('eth.dst').ranges).toEqual([[0, 6]]);
    expect(fieldByteRanges('ip.dst').ranges).toEqual([[30, 34]]);
  });

  it('moves L4 offsets when the IP header has options', () => {
    const plain = fieldByteRanges('l4.dst', FRAMES.tcpSyn());
    const opts = fieldByteRanges('l4.dst', FRAMES.tcpSynIpOptions());
    expect(plain.ranges).toEqual([[36, 38]]);
    expect(opts.ranges).toEqual([[40, 42]]);
  });

  it('sample frame decodes to a clean icmp echo', () => {
    const d = decode(sampleFrame());
    expect(d.kind).toBe('icmp-echo');
    expect(d.ip?.dst).toBe('10.99.4.10');
  });
});
