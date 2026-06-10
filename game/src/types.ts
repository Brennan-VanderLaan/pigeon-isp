// Shared types for the loft wire protocol and the game.

export interface PortInfo {
  id: number;
  ifname: string;
  mac: string;
  ip: string;
  pod: string;
  namespace: string;
}

/** A pigeon's papers: the token loftd sends instead of the full frame.
 *  Payloads never cross the WebSocket — multi-gig streams stay node-side. */
export interface FrameToken {
  id: number;
  port: number; // ingress port
  fullLen: number;
  snapshot: Uint8Array; // first ~128 bytes, enough to decode headers
}

/** Every drop is attributed — the no-silent-drop rule (docs/pigeon-api.md). */
export interface DropCounters {
  overflow: number;
  ttl: number;
  consumer: number;
}

export interface PortStats {
  rxFrames: number;
  rxBytes: number;
  txFrames: number;
  txBytes: number;
  drops: DropCounters;
  /** arrival → deliver decision latency, µs (loft-side overhead telemetry) */
  deliverLatencyUs?: { sum: number; count: number; max: number };
}

export interface LoftStats {
  buffered: number;
  droppedNoConsumer: number;
  ports: Record<string, PortStats>;
}

/** What a bridge (live loft or sim) tells the game. */
export interface BridgeEvents {
  onHello(ports: PortInfo[]): void;
  onPortAdded(port: PortInfo): void;
  onPortRemoved(id: number): void;
  onToken(token: FrameToken): void;
  onStats(stats: LoftStats): void;
  onLog(who: string, line: string): void;
  onState(state: 'connecting' | 'live' | 'sim' | 'down'): void;
}

/** What the game tells a bridge. */
export interface Bridge {
  /** The pigeon reached a dovecote: write the buffered frame out this port. */
  deliver(portId: number, frameId: number): void;
  /** Deliver WITHOUT consuming — flooding/broadcast. Free with drop() after. */
  copyDeliver(portId: number, frameId: number): void;
  /** The pigeon was lost (or a flooded frame is done): free the buffer. */
  drop(frameId: number): void;
}
