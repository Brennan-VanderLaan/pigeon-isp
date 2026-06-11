// WsBridge — the live connection to loftd.
//
// Binary, big-endian:
//   0x01 token    loftd -> game  [1][u16 port][u32 frameId][u32 fullLen][snapshot...]
//   0x02 deliver  game -> loftd  [1][u16 egressPort][u32 frameId]
//   0x03 drop     game -> loftd  [1][u16 0][u32 frameId]
// Text: JSON control (hello / port-added / port-removed / stats).
import type { Bridge, BridgeEvents, PortInfo } from './types';

const MSG_TOKEN = 0x01;
const MSG_DELIVER = 0x02;
const MSG_DROP = 0x03;
const MSG_COPY_DELIVER = 0x04;

interface WirePort {
  id: number;
  ifname: string;
  mac: string;
  ip: string;
  pod: string;
  namespace: string;
  node?: string;
}

function toPortInfo(p: WirePort): PortInfo {
  return { id: p.id, ifname: p.ifname, mac: p.mac, ip: p.ip, pod: p.pod, namespace: p.namespace, node: p.node };
}

export class WsBridge implements Bridge {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 2000;

  constructor(private url: string, private events: BridgeEvents) {}

  connect(): void {
    this.events.onState('connecting');
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.retryMs = 2000;
      this.events.onState('live');
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.events.onState('down');
      // Backoff (capped): if another router keeps bumping us, don't turn the
      // loft into a two-consumer thrash fest.
      const delay = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 1.6, 15000);
      setTimeout(() => !this.closed && this.connect(), delay);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.handleControl(JSON.parse(ev.data));
        return;
      }
      const b = new Uint8Array(ev.data as ArrayBuffer);
      if (b.length >= 11 && b[0] === MSG_TOKEN) {
        const dv = new DataView(b.buffer, b.byteOffset);
        this.events.onToken({
          port: dv.getUint16(1),
          id: dv.getUint32(3),
          fullLen: dv.getUint32(7),
          snapshot: b.slice(11),
        });
      }
    };
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private handleControl(msg: any): void {
    switch (msg.type) {
      case 'hello':
        this.events.onHello(((msg.ports ?? []) as WirePort[]).map(toPortInfo));
        break;
      case 'port-added':
        this.events.onPortAdded(toPortInfo(msg.port));
        break;
      case 'port-removed':
        this.events.onPortRemoved(msg.id);
        break;
      case 'stats':
        this.events.onStats({
          buffered: msg.buffered ?? 0,
          droppedNoConsumer: msg.droppedNoConsumer ?? 0,
          ports: msg.ports ?? {},
        });
        break;
    }
  }

  private send(type: number, portId: number, frameId: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const b = new ArrayBuffer(7);
    const dv = new DataView(b);
    dv.setUint8(0, type);
    dv.setUint16(1, portId);
    dv.setUint32(3, frameId);
    this.ws.send(b);
  }

  deliver(portId: number, frameId: number): void {
    this.send(MSG_DELIVER, portId, frameId);
  }

  copyDeliver(portId: number, frameId: number): void {
    this.send(MSG_COPY_DELIVER, portId, frameId);
  }

  drop(frameId: number): void {
    this.send(MSG_DROP, 0, frameId);
  }
}

/** Default bridge URL: same-origin /ws when served by the cluster ingress,
 *  the docker-exposed loft port when running `vite dev` locally. */
export function defaultBridgeUrl(): string {
  const q = new URLSearchParams(location.search).get('bridge');
  if (q) return q;
  if (location.port === '5173' || location.port === '5174') return 'ws://127.0.0.1:9777/ws';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
