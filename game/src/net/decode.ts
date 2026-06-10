// Header decoders. Everything the inspector shows comes from the snapshot —
// the first ~128 bytes of the frame. That covers L2 through L4 headers;
// payloads stay in the loft.

export type FrameKind =
  | 'arp-request' | 'arp-reply'
  | 'icmp-echo' | 'icmp-reply' | 'icmp-other'
  | 'tcp' | 'udp' | 'other';

export interface Decoded {
  kind: FrameKind;
  summary: string; // one-liner for labels
  fields: [string, string][]; // inspector rows
  broadcast: boolean;
  dstMac: string;
  srcMac: string;
}

const ETH_ARP = 0x0806;
const ETH_IP4 = 0x0800;

function mac(b: Uint8Array, off: number): string {
  let s = [];
  for (let i = 0; i < 6; i++) s.push(b[off + i].toString(16).padStart(2, '0'));
  return s.join(':');
}

function ip4(b: Uint8Array, off: number): string {
  return `${b[off]}.${b[off + 1]}.${b[off + 2]}.${b[off + 3]}`;
}

function u16(b: Uint8Array, off: number): number {
  return (b[off] << 8) | b[off + 1];
}

export function decodeFrame(b: Uint8Array, fullLen: number): Decoded {
  const out: Decoded = {
    kind: 'other',
    summary: `frame (${fullLen}B)`,
    fields: [],
    broadcast: false,
    dstMac: '?',
    srcMac: '?',
  };
  if (b.length < 14) return out;

  out.dstMac = mac(b, 0);
  out.srcMac = mac(b, 6);
  out.broadcast = out.dstMac === 'ff:ff:ff:ff:ff:ff';
  const etherType = u16(b, 12);

  out.fields.push(
    ['eth.dst', out.dstMac + (out.broadcast ? '  (broadcast)' : '')],
    ['eth.src', out.srcMac],
    ['eth.type', '0x' + etherType.toString(16).padStart(4, '0')],
    ['length', `${fullLen} bytes`],
  );

  if (etherType === ETH_ARP && b.length >= 42) {
    const oper = u16(b, 20);
    const sha = mac(b, 22), spa = ip4(b, 28), tha = mac(b, 32), tpa = ip4(b, 38);
    out.fields.push(
      ['arp.oper', oper === 1 ? '1 (request)' : oper === 2 ? '2 (reply)' : String(oper)],
      ['arp.sender', `${spa} (${sha})`],
      ['arp.target', `${tpa} (${tha})`],
    );
    if (oper === 1) {
      out.kind = 'arp-request';
      out.summary = `ARP who-has ${tpa}? tell ${spa}`;
    } else {
      out.kind = 'arp-reply';
      out.summary = `ARP ${spa} is-at ${sha}`;
    }
    return out;
  }

  if (etherType === ETH_IP4 && b.length >= 34) {
    const ihl = (b[14] & 0x0f) * 4;
    const proto = b[23];
    const ttl = b[22];
    const src = ip4(b, 26), dst = ip4(b, 30);
    out.fields.push(['ip.src', src], ['ip.dst', dst], ['ip.ttl', String(ttl)], ['ip.proto', String(proto)]);
    const l4 = 14 + ihl;

    if (proto === 1 && b.length >= l4 + 8) {
      const t = b[l4], seq = u16(b, l4 + 6), id = u16(b, l4 + 4);
      out.fields.push(['icmp.type', String(t)], ['icmp.id', String(id)], ['icmp.seq', String(seq)]);
      if (t === 8) { out.kind = 'icmp-echo'; out.summary = `ICMP echo ${src} → ${dst} seq=${seq}`; }
      else if (t === 0) { out.kind = 'icmp-reply'; out.summary = `ICMP reply ${src} → ${dst} seq=${seq}`; }
      else { out.kind = 'icmp-other'; out.summary = `ICMP type ${t} ${src} → ${dst}`; }
      return out;
    }
    if (proto === 6 && b.length >= l4 + 14) {
      const sp = u16(b, l4), dp = u16(b, l4 + 2);
      const flags = b[l4 + 13];
      const names = [];
      if (flags & 0x02) names.push('SYN');
      if (flags & 0x10) names.push('ACK');
      if (flags & 0x01) names.push('FIN');
      if (flags & 0x04) names.push('RST');
      if (flags & 0x08) names.push('PSH');
      out.kind = 'tcp';
      out.summary = `TCP ${src}:${sp} → ${dst}:${dp} [${names.join(',') || '·'}]`;
      out.fields.push(['tcp.src', String(sp)], ['tcp.dst', String(dp)], ['tcp.flags', names.join(',') || 'none']);
      return out;
    }
    if (proto === 17 && b.length >= l4 + 8) {
      const sp = u16(b, l4), dp = u16(b, l4 + 2);
      out.kind = 'udp';
      out.summary = `UDP ${src}:${sp} → ${dst}:${dp} (${fullLen}B)`;
      out.fields.push(['udp.src', String(sp)], ['udp.dst', String(dp)]);
      return out;
    }
    out.summary = `IPv4 proto ${proto} ${src} → ${dst}`;
    return out;
  }
  return out;
}

export function hexDump(b: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < b.length; i += 16) {
    const chunk = Array.from(b.slice(i, i + 16));
    const hex = chunk.map((x) => x.toString(16).padStart(2, '0')).join(' ');
    const ascii = chunk.map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
    lines.push(i.toString(16).padStart(4, '0') + '  ' + hex.padEnd(47) + '  ' + ascii);
  }
  return lines.join('\n');
}

/** Scroll tint per protocol — what the pigeon is carrying, at a glance. */
export const KIND_COLORS: Record<FrameKind, number> = {
  'arp-request': 0xffa940, // orange: a question
  'arp-reply': 0xffe06b,   // gold: an answer
  'icmp-echo': 0x53d8e8,   // cyan
  'icmp-reply': 0x6fdc8c,  // green: success color
  'icmp-other': 0x9aa5b1,
  tcp: 0xb98aff,
  udp: 0xff7eb6,
  other: 0x8a93a0,
};
