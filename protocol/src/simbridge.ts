// SimBridge — a fake loft with two fake pods, for development without a
// cluster. This is not a mock: alice runs a real ARP cache + retry loop and a
// real ping loop; bob answers ARP and ICMP like a kernel would, and both drop
// frames whose dst MAC isn't theirs. If you mis-route a pigeon, the sim
// behaves exactly like the cluster: silence.
//
// ?storm=<pps> adds a UDP packet storm from alice to bob — the benchmark for
// "can the client survive a video stream". Payloads are token-only here too,
// matching the live protocol's performance model.
import type { Bridge, BridgeEvents, LoftStats, PortStats } from './types';

// ---- frame builders ---------------------------------------------------------

function macBytes(s: string): number[] {
  return s.split(':').map((x) => parseInt(x, 16));
}
function ipBytes(s: string): number[] {
  return s.split('.').map(Number);
}

function ethernet(dst: string, src: string, etherType: number, payload: number[]): Uint8Array {
  return new Uint8Array([
    ...macBytes(dst), ...macBytes(src),
    (etherType >> 8) & 0xff, etherType & 0xff,
    ...payload,
  ]);
}

function arp(oper: number, sha: string, spa: string, tha: string, tpa: string): number[] {
  return [
    0, 1, 8, 0, 6, 4, 0, oper,
    ...macBytes(sha), ...ipBytes(spa),
    ...macBytes(tha), ...ipBytes(tpa),
  ];
}

function checksum(bytes: number[]): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    sum += (bytes[i] << 8) | (bytes[i + 1] ?? 0);
  }
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

function ipv4(src: string, dst: string, proto: number, payload: number[]): number[] {
  const totalLen = 20 + payload.length;
  const hdr = [
    0x45, 0, (totalLen >> 8) & 0xff, totalLen & 0xff,
    0, 0, 0x40, 0, // id, flags DF
    64, proto, 0, 0, // ttl, proto, checksum placeholder
    ...ipBytes(src), ...ipBytes(dst),
  ];
  const ck = checksum(hdr);
  hdr[10] = (ck >> 8) & 0xff;
  hdr[11] = ck & 0xff;
  return [...hdr, ...payload];
}

function icmpEcho(reply: boolean, id: number, seq: number, payloadLen = 24): number[] {
  const pkt = [
    reply ? 0 : 8, 0, 0, 0,
    (id >> 8) & 0xff, id & 0xff, (seq >> 8) & 0xff, seq & 0xff,
  ];
  for (let i = 0; i < payloadLen; i++) pkt.push(0x61 + (i % 26));
  const ck = checksum(pkt);
  pkt[2] = (ck >> 8) & 0xff;
  pkt[3] = ck & 0xff;
  return pkt;
}

function udp(srcPort: number, dstPort: number, payloadLen: number): number[] {
  const len = 8 + payloadLen;
  const pkt = [
    (srcPort >> 8) & 0xff, srcPort & 0xff, (dstPort >> 8) & 0xff, dstPort & 0xff,
    (len >> 8) & 0xff, len & 0xff, 0, 0, // checksum 0 = none (v4 legal)
  ];
  for (let i = 0; i < Math.min(payloadLen, 40); i++) pkt.push(i & 0xff);
  return pkt;
}

// ---- the sim ---------------------------------------------------------------

interface SimPod {
  name: string;
  ip: string;
  mac: string;
  portId: number;
}

const BCAST = 'ff:ff:ff:ff:ff:ff';

export class SimBridge implements Bridge {
  private alice: SimPod = { name: 'alice', ip: '10.244.0.10', mac: '0a:58:0a:f4:00:0a', portId: 1 };
  private bob: SimPod = { name: 'bob', ip: '10.244.0.11', mac: '0a:58:0a:f4:00:0b', portId: 2 };

  private frames = new Map<number, { data: Uint8Array; port: number }>();
  private nextFrameId = 1;
  private arpCache = new Map<string, string>(); // alice's neighbor table: ip -> mac
  private arpAskedAt = 0;
  private pingSeq = 0;
  private pingId = 0x1d42;
  private pingsAnswered = 0;
  private timers: number[] = [];
  private stats: Record<string, PortStats> = {};
  private droppedNoConsumer = 0;
  private won = false;

  constructor(private events: BridgeEvents, private stormPps: number) {
    for (const p of [this.alice, this.bob]) {
      this.stats[p.name] = {
        rxFrames: 0, rxBytes: 0, txFrames: 0, txBytes: 0,
        drops: { overflow: 0, ttl: 0, consumer: 0 },
      };
    }
  }

  start(): void {
    this.events.onState('sim');
    this.events.onHello([this.alice, this.bob].map((p) => ({
      id: p.portId, ifname: 'sim-' + p.name, mac: p.mac, ip: p.ip,
      pod: p.name, namespace: 'aviary',
    })));
    this.log('sim', 'two fake pods released: alice wants to ping bob');

    // alice's loop: ARP until resolved, then ping every second. Linux-ish.
    this.timers.push(window.setInterval(() => this.aliceTick(), 1000));
    if (this.stormPps > 0) {
      this.log('sim', `UDP storm enabled: ${this.stormPps} pps alice → bob (benchmark mode)`);
      const interval = Math.max(4, 1000 / this.stormPps);
      const perTick = Math.max(1, Math.round(this.stormPps / (1000 / interval)));
      this.timers.push(window.setInterval(() => {
        for (let i = 0; i < perTick; i++) this.stormPacket();
      }, interval));
    }
    this.timers.push(window.setInterval(() => this.publishStats(), 1000));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
  }

  private aliceTick(): void {
    const bobMac = this.arpCache.get(this.bob.ip);
    if (!bobMac) {
      const now = Date.now();
      if (now - this.arpAskedAt >= 1000) {
        this.arpAskedAt = now;
        this.podSend(this.alice, ethernet(BCAST, this.alice.mac, 0x0806,
          arp(1, this.alice.mac, this.alice.ip, '00:00:00:00:00:00', this.bob.ip)));
        this.log('alice', `arp who-has ${this.bob.ip}?`);
      }
      return;
    }
    this.pingSeq++;
    this.podSend(this.alice, ethernet(bobMac, this.alice.mac, 0x0800,
      ipv4(this.alice.ip, this.bob.ip, 1, icmpEcho(false, this.pingId, this.pingSeq))));
    this.log('alice', `ping ${this.bob.ip} seq=${this.pingSeq}`);
  }

  private stormPacket(): void {
    // The storm doesn't wait for ARP — it's a benchmark, not a protocol demo.
    this.podSend(this.alice, ethernet(this.bob.mac, this.alice.mac, 0x0800,
      ipv4(this.alice.ip, this.bob.ip, 17, udp(5004, 5004, 1372))), 1410);
  }

  /** A pod transmits: buffer the frame, release a token to the game. */
  private podSend(pod: SimPod, frame: Uint8Array, pretendLen?: number): void {
    const st = this.stats[pod.name];
    st.txFrames++; // pod's tx = loft's rx for this port; mirror loftd naming
    st.rxFrames = st.txFrames;
    st.rxBytes += pretendLen ?? frame.length;
    if (this.frames.size > 8192) {
      st.drops.overflow++;
      return;
    }
    const id = this.nextFrameId++;
    this.frames.set(id, { data: frame, port: pod.portId });
    this.events.onToken({
      id,
      port: pod.portId,
      fullLen: pretendLen ?? frame.length,
      snapshot: frame.slice(0, 128),
    });
  }

  /** The game delivered a pigeon to a dovecote: the pod's "kernel" receives. */
  deliver(portId: number, frameId: number): void {
    this.deliverInternal(portId, frameId, true);
  }

  copyDeliver(portId: number, frameId: number): void {
    this.deliverInternal(portId, frameId, false);
  }

  private deliverInternal(portId: number, frameId: number, consume: boolean): void {
    const f = this.frames.get(frameId);
    if (!f) return;
    if (consume) this.frames.delete(frameId);
    const pod = portId === this.alice.portId ? this.alice : portId === this.bob.portId ? this.bob : null;
    if (!pod) return;
    const dst = Array.from(f.data.slice(0, 6)).map((x) => x.toString(16).padStart(2, '0')).join(':');
    if (dst !== pod.mac && dst !== BCAST) {
      // Wrong dovecote: the NIC shrugs. Realism is the tutor here.
      this.log(pod.name, `(nic) dropped frame addressed to ${dst}`);
      return;
    }
    this.podReceive(pod, f.data);
  }

  drop(frameId: number): void {
    const f = this.frames.get(frameId);
    if (f) {
      this.frames.delete(frameId);
      const pod = f.port === this.alice.portId ? this.alice : this.bob;
      this.stats[pod.name].drops.consumer++;
    }
  }

  private podReceive(pod: SimPod, b: Uint8Array): void {
    const etherType = (b[12] << 8) | b[13];
    if (etherType === 0x0806) {
      const oper = (b[20] << 8) | b[21];
      const spa = `${b[28]}.${b[29]}.${b[30]}.${b[31]}`;
      const sha = Array.from(b.slice(22, 28)).map((x) => x.toString(16).padStart(2, '0')).join(':');
      const tpa = `${b[38]}.${b[39]}.${b[40]}.${b[41]}`;
      if (oper === 1 && tpa === pod.ip) {
        this.log(pod.name, `arp reply: ${pod.ip} is-at ${pod.mac}`);
        setTimeout(() => this.podSend(pod, ethernet(sha, pod.mac, 0x0806,
          arp(2, pod.mac, pod.ip, sha, spa))), 50);
      } else if (oper === 2 && pod === this.alice) {
        this.arpCache.set(spa, sha);
        this.log('alice', `arp learned: ${spa} is-at ${sha}`);
      }
      return;
    }
    if (etherType === 0x0800) {
      const proto = b[23];
      const src = `${b[26]}.${b[27]}.${b[28]}.${b[29]}`;
      const dstIp = `${b[30]}.${b[31]}.${b[32]}.${b[33]}`;
      if (dstIp !== pod.ip) return;
      const ihl = (b[14] & 0x0f) * 4;
      const l4 = 14 + ihl;
      if (proto === 1) {
        const t = b[l4];
        const seq = (b[l4 + 6] << 8) | b[l4 + 7];
        if (t === 8) {
          // Echo request: swap and answer.
          const srcMac = Array.from(b.slice(6, 12)).map((x) => x.toString(16).padStart(2, '0')).join(':');
          setTimeout(() => this.podSend(pod, ethernet(srcMac, pod.mac, 0x0800,
            ipv4(pod.ip, src, 1, icmpEcho(true, (b[l4 + 4] << 8) | b[l4 + 5], seq)))), 30);
        } else if (t === 0 && pod === this.alice) {
          this.pingsAnswered++;
          this.log('alice', `64 bytes from ${src}: seq=${seq}  ✓`);
          if (!this.won && this.pingsAnswered >= 4) {
            this.won = true;
            this.log('sim', '★ MILESTONE: 4 echo replies routed. You built a router. ★');
          }
        }
      }
    }
  }

  private publishStats(): void {
    const s: LoftStats = {
      buffered: this.frames.size,
      droppedNoConsumer: this.droppedNoConsumer,
      ports: JSON.parse(JSON.stringify(this.stats)),
    };
    this.events.onStats(s);
  }

  private log(who: string, line: string): void {
    this.events.onLog(who, line);
  }
}
