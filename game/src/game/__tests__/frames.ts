// Test frame builders: real wire-format ethernet frames, checksums and all,
// so the decode/filter tests exercise exactly what the loft snapshots carry.

export const macBytes = (s: string) => s.split(':').map((x) => parseInt(x, 16));
export const ipBytes = (s: string) => s.split('.').map(Number);

function cksum(b: number[]): number {
  let s = 0;
  for (let i = 0; i < b.length; i += 2) s += (b[i] << 8) | (b[i + 1] ?? 0);
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  return ~s & 0xffff;
}

export function eth(dst: string, src: string, type: number, payload: number[]): Uint8Array {
  return new Uint8Array([...macBytes(dst), ...macBytes(src), type >> 8, type & 0xff, ...payload]);
}

export function ipv4(src: string, dst: string, proto: number, payload: number[], opts?: { ihl?: number }): number[] {
  const ihl = opts?.ihl ?? 20;
  const optBytes = new Array(ihl - 20).fill(0);
  const len = ihl + payload.length;
  const h = [
    0x40 | (ihl / 4), 0, len >> 8, len & 0xff, 0x12, 0x34, 0x40, 0,
    64, proto, 0, 0, ...ipBytes(src), ...ipBytes(dst), ...optBytes,
  ];
  const ck = cksum(h);
  h[10] = ck >> 8;
  h[11] = ck & 0xff;
  return [...h, ...payload];
}

export function icmpEcho(reply: boolean, seq: number, payloadLen = 56): number[] {
  const p = [reply ? 0 : 8, 0, 0, 0, 0x1d, 0x42, (seq >> 8) & 0xff, seq & 0xff];
  for (let i = 0; i < payloadLen; i++) p.push(i & 0xff);
  const ck = cksum(p);
  p[2] = ck >> 8;
  p[3] = ck & 0xff;
  return p;
}

export function arp(oper: 1 | 2, sha: string, spa: string, tha: string, tpa: string): number[] {
  return [0, 1, 8, 0, 6, 4, 0, oper, ...macBytes(sha), ...ipBytes(spa), ...macBytes(tha), ...ipBytes(tpa)];
}

export function tcp(srcPort: number, dstPort: number, flags: number): number[] {
  return [
    srcPort >> 8, srcPort & 0xff, dstPort >> 8, dstPort & 0xff,
    0, 0, 0, 1, 0, 0, 0, 0, 0x50, flags, 0xff, 0xff, 0, 0, 0, 0,
  ];
}

export function udp(srcPort: number, dstPort: number, payloadLen: number): number[] {
  const len = 8 + payloadLen;
  return [srcPort >> 8, srcPort & 0xff, dstPort >> 8, dstPort & 0xff, len >> 8, len & 0xff, 0, 0,
    ...new Array(payloadLen).fill(0x42)];
}

export const ALICE_MAC = '0a:58:0a:63:03:0a';
export const BOB_MAC = '0a:58:0a:63:04:0a';
export const BCAST = 'ff:ff:ff:ff:ff:ff';
export const ALICE_IP = '10.99.3.10';
export const BOB_IP = '10.99.4.10';

export const FRAMES = {
  icmpEchoUni: () => eth(BOB_MAC, ALICE_MAC, 0x0800, ipv4(ALICE_IP, BOB_IP, 1, icmpEcho(false, 7))),
  icmpReplyUni: () => eth(ALICE_MAC, BOB_MAC, 0x0800, ipv4(BOB_IP, ALICE_IP, 1, icmpEcho(true, 7))),
  arpWhoHasBcast: () => eth(BCAST, ALICE_MAC, 0x0806, arp(1, ALICE_MAC, ALICE_IP, '00:00:00:00:00:00', BOB_IP)),
  // Linux neighbor revalidation: a who-has sent UNICAST. Real, observed in
  // the aviary, and the reason "is broadcast" correctly rejects some ARP.
  arpWhoHasUnicast: () => eth(BOB_MAC, ALICE_MAC, 0x0806, arp(1, ALICE_MAC, ALICE_IP, BOB_MAC, BOB_IP)),
  arpReply: () => eth(ALICE_MAC, BOB_MAC, 0x0806, arp(2, BOB_MAC, BOB_IP, ALICE_MAC, ALICE_IP)),
  tcpSyn: () => eth(BOB_MAC, ALICE_MAC, 0x0800, ipv4(ALICE_IP, BOB_IP, 6, tcp(43210, 5201, 0x02))),
  tcpSynIpOptions: () => eth(BOB_MAC, ALICE_MAC, 0x0800, ipv4(ALICE_IP, BOB_IP, 6, tcp(43210, 5201, 0x02), { ihl: 24 })),
  udpStream: () => eth(BOB_MAC, ALICE_MAC, 0x0800, ipv4(ALICE_IP, BOB_IP, 17, udp(5004, 5004, 100))),
};
