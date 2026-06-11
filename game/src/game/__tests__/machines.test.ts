// Router lego logic — the algorithms that make a switch a switch. Player
// bug reports about "my switch flooded a known host" land here.
import { describe, expect, it } from 'vitest';
import { decodeFrame } from '@pigeon/protocol';
import {
  OPPOSITE, fdbRows, hubExits, meterStep, newMeterState, newSwitchState, switchStep,
} from '../machines';
import { ALICE_MAC, BOB_MAC, FRAMES } from './frames';

const decode = (raw: Uint8Array) => decodeFrame(raw.slice(0, 128), raw.length);

describe('hub', () => {
  it('repeats out every exit except the one it came in', () => {
    expect(hubExits(0).sort()).toEqual([0, 1, 3]);
    expect(hubExits(1).sort()).toEqual([0, 1, 2]);
    expect(OPPOSITE(0)).toBe(2);
    expect(OPPOSITE(3)).toBe(1);
  });
});

describe('switch — IEEE 802.1D transparent bridge (port-indexed)', () => {
  // A 4-port switch. alice arrives on port 0, bob on port 2.
  const aliceToBob = () => decode(FRAMES.tcpSyn()); // src alice, dst bob, unicast

  it('floods the first frame (unknown dst) out all ports but ingress; learns src (§7.8)', () => {
    const st = newSwitchState();
    const d = switchStep(st, aliceToBob(), 0, 4, 1000);
    expect(d.action).toBe('flood');
    expect(d.exits.sort()).toEqual([1, 2, 3]); // all ports except ingress 0
    expect(fdbRows(st, 1000).find((r) => r.mac === ALICE_MAC)?.port).toBe(0);
  });

  it('forwards known unicast out the learned port only (§7.7)', () => {
    const st = newSwitchState();
    switchStep(st, decode(FRAMES.icmpReplyUni()), 2, 4, 1000); // learn bob on port 2
    expect(fdbRows(st, 1000).find((r) => r.mac === BOB_MAC)?.port).toBe(2);
    const d = switchStep(st, aliceToBob(), 0, 4, 1001);
    expect(d.action).toBe('forward');
    expect(d.exits).toEqual([2]);
    expect(st.forwards).toBe(1);
  });

  it('filters (drops) a frame whose dst is on the ingress port (§7.7)', () => {
    const st = newSwitchState();
    switchStep(st, decode(FRAMES.icmpReplyUni()), 0, 4, 1000); // bob learned on port 0
    // alice→bob arriving ALSO on port 0: same segment, must not forward
    const d = switchStep(st, aliceToBob(), 0, 4, 1001);
    expect(d.action).toBe('filter');
    expect(d.exits).toEqual([]);
    expect(st.filters).toBe(1);
  });

  it('always floods broadcast even when everything is learned (ARP discovery)', () => {
    const st = newSwitchState();
    switchStep(st, aliceToBob(), 0, 4, 1000);
    const d = switchStep(st, decode(FRAMES.arpWhoHasBcast()), 0, 4, 1001);
    expect(d.action).toBe('flood');
  });

  it('ages entries out after TTL and re-floods (§7.9)', () => {
    const st = newSwitchState(5000);
    switchStep(st, decode(FRAMES.icmpReplyUni()), 2, 4, 1000); // learn bob
    const d = switchStep(st, aliceToBob(), 0, 4, 7001); // 6s later: stale
    expect(d.action).toBe('flood');
    expect(fdbRows(st, 7001).find((r) => r.mac === BOB_MAC)).toBeUndefined();
  });

  it('caps the FDB, evicting the oldest', () => {
    const st = newSwitchState(60_000, 2);
    switchStep(st, decode(FRAMES.icmpReplyUni()), 2, 4, 1000);
    switchStep(st, decode(FRAMES.tcpSyn()), 0, 4, 2000);
    switchStep(st, decode(FRAMES.arpReply()), 2, 4, 3000);
    expect(st.fdb.size).toBeLessThanOrEqual(2);
  });

  it('refreshes age on repeated traffic from the same source', () => {
    const st = newSwitchState(10_000);
    switchStep(st, decode(FRAMES.tcpSyn()), 0, 4, 1000);
    switchStep(st, decode(FRAMES.tcpSyn()), 0, 4, 8000);
    expect(fdbRows(st, 8000).find((r) => r.mac === ALICE_MAC)?.ageS).toBe(0);
  });
});

describe('meter — token bucket', () => {
  it('pps: passes up to the limit, diverts only the excess', () => {
    const st = newMeterState(5, 'pps'); // 5 frames/s, burst 5
    let passed = 0;
    // 10 frames in the same instant: 5 pass (bucket), 5 divert
    for (let i = 0; i < 10; i++) if (meterStep(st, 100, 1000).pass) passed++;
    expect(passed).toBe(5);
    expect(st.passed).toBe(5);
    expect(st.diverted).toBe(5);
  });

  it('pps: refills over time so allowed traffic keeps flowing', () => {
    const st = newMeterState(5, 'pps');
    for (let i = 0; i < 5; i++) meterStep(st, 100, 1000); // drain bucket
    expect(meterStep(st, 100, 1000).pass).toBe(false); // empty now
    expect(meterStep(st, 100, 2000).pass).toBe(true); // +1s = +5 tokens
  });

  it('bps: limit by bytes, big frames cost more', () => {
    const st = newMeterState(1500, 'bps'); // 1500 bytes/s, burst 1500
    expect(meterStep(st, 1000, 1000).pass).toBe(true); // 1000 <= 1500
    expect(meterStep(st, 1000, 1000).pass).toBe(false); // only 500 left
    expect(st.diverted).toBe(1);
  });
});
