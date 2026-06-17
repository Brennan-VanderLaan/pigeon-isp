# @pigeon/protocol

**The Pigeon API, as a library. The loft is the engine; your demo is a consumer.**

A `loftd` runs on every node of the cluster and owns the data plane: it taps
real ethernet frames off real pods, buffers the payloads, and hands you a
**token** for each one — port, frame id, length, and a 128-byte header snapshot.
You decide where every token goes (`deliver`) or that it dies (`drop`). Nothing
moves unless you move it. That is the whole game, and it is also the whole API.

`pigeon.localhost` (the conveyor-belt factory in `game/`) and the Rokenbok
ball-pit in `ballpit/` are **both just consumers of this package** — two skins
on one engine. This README is how you write a third.

> If you only want the wire bytes (you're writing a consumer in Go, Rust, or
> raw JS without this lib), read [`docs/pigeon-api.md`](../docs/pigeon-api.md) —
> the framing contract this package implements. This README is the *TypeScript*
> ergonomic layer on top of it.

---

## The one rule: no silent drops

Every token you receive must end in exactly one of two states:

- **`deliver(port, frameId)`** — the frame leaves out that port. A real pod's
  kernel receives it (and may still reject it if the dst MAC is wrong — that's
  the pod's call, not yours).
- **`drop(frameId)`** — you give up on it; the loft frees the buffer and counts
  the loss.

Sit on a token and do neither, and the loft TTL-drops it after ~30s and charges
you `drops.ttl`. **There is no third option and no invisible loss.** Build your
demo around that and you've built a router; ignore it and packets pile up in the
loft. See "The no-silent-drop rule" in [`docs/pigeon-api.md`](../docs/pigeon-api.md).

---

## Install

It's a workspace package (TypeScript source, no build step — `main` points at
`src/index.ts`). Inside this repo, depend on it by name:

```jsonc
// your-demo/package.json
{
  "dependencies": { "@pigeon/protocol": "*" }
}
```

```ts
import {
  WsBridge, SimBridge, defaultBridgeUrl,
  decodeFrame, KIND_COLORS,
  type Bridge, type BridgeEvents, type FrameToken, type PortInfo, type LoftStats,
} from '@pigeon/protocol';
```

The package is framework-agnostic: no three.js, no DOM beyond `WebSocket` and
(optionally) `location`. It runs in the browser and, with Node 22+'s built-in
`WebSocket`, headless too.

---

## Quickstart: a learning switch in ~30 lines

The smallest *useful* consumer is a MAC-learning switch — learn which port each
source MAC lives behind, forward known unicast, flood the rest. It satisfies the
one rule by construction.

```ts
import { WsBridge, defaultBridgeUrl, decodeFrame, type BridgeEvents } from '@pigeon/protocol';

const ports = new Map<number, import('@pigeon/protocol').PortInfo>();
const macTable = new Map<string, number>();   // dst MAC -> egress port
let bridge: WsBridge;

const events: BridgeEvents = {
  onHello(list)        { ports.clear(); for (const p of list) ports.set(p.id, p); },
  onPortAdded(p)       { ports.set(p.id, p); },
  onPortRemoved(id)    { ports.delete(id); },
  onStats(_s)          {},
  onLog(_who, _line)   {},
  onState(_s)          {},

  onToken(t) {
    const d = decodeFrame(t.snapshot, t.fullLen);
    macTable.set(d.srcMac, t.port);                 // learn

    const egress = macTable.get(d.dstMac);
    if (egress !== undefined && egress !== t.port) {
      bridge.deliver(egress, t.id);                 // known unicast
      return;
    }
    // broadcast or unknown dst: flood to every other port, then free the buffer.
    let copies = 0;
    for (const id of ports.keys()) {
      if (id !== t.port) { bridge.copyDeliver(id, t.id); copies++; }
    }
    bridge.drop(t.id);                              // copy-delivered frames aren't a "loss"
  },
};

bridge = new WsBridge(defaultBridgeUrl(), events);
bridge.connect();
```

Point that at a running cluster and `alice` can ping `bob` — you are the
network. (`tools/autoroute.mjs` is exactly this, in dependency-free JS, as the
headless benchmark consumer.)

---

## Two bridges, one interface

Both implement `Bridge` and drive the same `BridgeEvents`, so your consumer code
is identical against a live cluster or your laptop on a plane.

### `WsBridge` — the live loft

```ts
const bridge = new WsBridge(url, events);
bridge.connect();   // opens the WebSocket; auto-reconnects with capped backoff
bridge.close();     // stop (won't reconnect)
```

- One WebSocket to `ws://<loft>:9777/ws`. Exactly one *router* consumer per loft
  — a new connection bumps the old one (last writer wins). Want read-only? Attach
  as an observer (`/ws?mode=observe`) — see the wire doc.
- Reconnect backoff is built in (2s → 15s) so a flapping or contested loft
  doesn't thrash.

**`defaultBridgeUrl()`** picks a sane URL for you:

| Situation | URL |
|---|---|
| `?bridge=ws://…` in the page URL | that, verbatim (deep-link / override) |
| `vite dev` on port 5173/5174 | `ws://127.0.0.1:9777/ws` (docker-exposed loft) |
| served by the cluster ingress | same-origin `/ws` (`ws`/`wss` to match the page) |

### `SimBridge` — a real fake loft for offline dev

```ts
const bridge = new SimBridge(events, /* stormPps */ 0);
bridge.start();
bridge.stop();
```

Not a mock — it runs **two fake pods** (`alice`, `bob`) with a *real* ARP cache,
retry loop, and ping loop. `bob` answers ARP and ICMP like a kernel; both drop
frames whose dst MAC isn't theirs. Mis-route a pigeon and you get exactly what
the cluster gives you: silence. Route four echo replies and it declares you've
built a router.

Pass `stormPps > 0` to add a UDP packet storm (`alice → bob`) — the benchmark
for "does my visualizer survive a video stream". Payloads are token-only here
too, matching the live performance model.

> A common pattern (used by both games): try `WsBridge` first, and if no loft
> answers within a few seconds, fall back to `SimBridge` so there's *always* a
> factory to look at. See `ballpit/src/loft-game.ts` for the exact fallback.

---

## API reference

### `interface Bridge` — what you send

```ts
deliver(portId: number, frameId: number): void;      // route out this port, consume
copyDeliver(portId: number, frameId: number): void;  // route out, do NOT consume (flooding)
drop(frameId: number): void;                          // free the buffer, count the loss
```

Flooding pattern: `copyDeliver` to each egress port, then `drop` to free the
original. Freeing a frame that was copy-delivered at least once does **not**
count as a consumer drop — it went somewhere.

### `interface BridgeEvents` — what you receive

```ts
onHello(ports: PortInfo[]): void;     // on attach: the current port set
onPortAdded(port: PortInfo): void;    // a pod/host appeared
onPortRemoved(id: number): void;      // a pod/host left; its in-flight frames TTL-drop
onToken(token: FrameToken): void;     // a frame arrived — decide it
onStats(stats: LoftStats): void;      // ~1 Hz, cumulative counters (diff them yourself)
onLog(who: string, line: string): void;  // human log line — live loft narrates attach/backpressure/peer health; SimBridge narrates the sim
onState(state: 'connecting' | 'live' | 'sim' | 'down'): void;
```

You must supply all seven (it's one object), but most demos no-op `onStats` and
`onLog`. The verb that matters is `onToken`.

### `interface FrameToken` — a pigeon's papers

```ts
{ id: number;          // frameId — pass to deliver/drop
  port: number;        // ingress port id
  fullLen: number;     // true frame length on the wire
  snapshot: Uint8Array // first ~128 bytes — enough for L2–L4 headers
}
```

The payload never crosses the WebSocket; multi-gig flows stay node-side. You
route on `snapshot`, exactly like hardware routes on headers it has already
clocked in.

### `interface PortInfo` — an endpoint

```ts
{ id: number; ifname: string; mac: string; ip: string;
  pod: string; namespace: string; node?: string /* multi-node lofts */ }
```

### `decodeFrame(snapshot, fullLen) → Decoded`

Turns the snapshot into structured headers so you don't re-implement ethernet:

```ts
const d = decodeFrame(token.snapshot, token.fullLen);
d.kind;        // 'arp-request' | 'arp-reply' | 'icmp-echo' | 'icmp-reply'
               // | 'icmp-other' | 'tcp' | 'udp' | 'other'
d.summary;     // 'ARP who-has 10.244.0.11? tell 10.244.0.10'
d.srcMac, d.dstMac, d.broadcast, d.etherType, d.len;
d.ip;          // { src, dst, proto, ttl }   — present for IPv4
d.l4;          // { src, dst, flags? }        — present for TCP/UDP
d.fields;      // [label, value][] ready for an inspector panel
```

Route on whatever field fits your demo: ingress `port`, `dstMac`, `ip.dst`,
`l4.dst`, `kind`. A "sorter that splits by protocol" is just a `switch (d.kind)`.

- **`KIND_COLORS`** — a `FrameKind → 0xRRGGBB` map (ARP orange/gold, ICMP
  cyan/green, TCP purple, UDP pink). Tint your pigeons/balls/particles by what
  they carry, for free.
- **`hexDump(bytes) → string`** — classic offset/hex/ASCII dump of a snapshot.

### `interface LoftStats` — the scoreboard

```ts
{ buffered: number;             // frames currently held, awaiting your decision
  droppedNoConsumer: number;    // arrived while nobody was attached
  ports: Record<string, PortStats> }  // per-port rx/tx frames+bytes and drop breakdown
```

Counters are cumulative — diff successive `onStats` calls for rates.

---

## What "build a consumer" actually looks like

Three shipped consumers, same API, wildly different surfaces:

| Consumer | Token becomes… | `deliver` happens when… |
|---|---|---|
| **`game/`** (pigeon.localhost) | a pigeon carrying a scroll on a 3D factory floor | the pigeon lands in the dst pod's dovecote |
| **`ballpit/`** | a physics ball colored by protocol | the ball rolls into the dst port's sink volume |
| **`tools/autoroute.mjs`** | nothing — a row in a MAC table | the learned egress port is known |

The pattern is always: `onToken` → spawn a *thing* at the ingress port →
let your world move it → when it reaches a destination, call `deliver`; when it
falls off the world or ages past TTL, call `drop`. Your "router" is whatever
physical/visual logic decides where things end up.

To start a new demo, copy the quickstart, swap the `onToken` body for "spawn a
thing in my world," and wire your world's "thing reached port X" event to
`bridge.deliver(X, frameId)`. That's the contract — everything else is your show.

---

## See also

- [`docs/pigeon-api.md`](../docs/pigeon-api.md) — the raw wire protocol (framing,
  multi-node trunks/mesh, external `/port` agents, the full lifecycle table).
- [`docs/architecture.md`](../docs/architecture.md) — how `loftd`, the CNI, and
  the token offload fit together.
- [`docs/ballpit.md`](../docs/ballpit.md) — the ball-pit consumer in depth.
- The root [`README.md`](../README.md) — bring a cluster up and watch ARP happen.
