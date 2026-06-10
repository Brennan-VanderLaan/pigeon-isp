# The Pigeon API

The loft is not "the game's backend" — it is a general frame-plane API. The
web game is merely the first *consumer*; a script, a TUI, or a headless
routing daemon must be able to take its place. Istio, but stranger: the mesh
tap is a DaemonSet, and the routing logic is whatever application you point
at this API.

## Concepts

- **Loft** — one `loftd` per node. Owns every aviary veth on that node.
- **Port** — one wired endpoint (today: an aviary pod's veth; later: edge
  agents, inter-node trunks). Identified by `(node, portId)`; within one
  loft's session, `portId` (u16) is unique and never reused.
- **Frame** — a buffered ethernet frame with a loft-assigned `frameId` (u32).
  The payload stays in the loft; consumers see a **token** (port, id, length,
  128-byte header snapshot).
- **Consumer** — whoever holds the WebSocket. Exactly one active consumer per
  loft (a new connection bumps the old one — last writer wins, no split
  brain).

## Frame lifecycle — the no-silent-drop rule

Every frame that enters a loft ends in exactly one of these states, and every
terminal state except `delivered` increments a named counter. If a frame can
be lost without showing up in a counter, that is a bug in loftd, not a
gameplay event.

| Terminal state | Meaning | Counter |
|---|---|---|
| `delivered` | consumer said `deliver(port, id)`; payload written to that port | `txFrames`/`txBytes` |
| `dropped:consumer` | consumer said `drop(id)` — an intentional kill | `drops.consumer` |
| `dropped:ttl` | consumer never decided within 30s | `drops.ttl` |
| `dropped:overflow` | buffer full on arrival (8192 frames); tail drop | `drops.overflow` |
| `dropped:no-consumer` | arrived while no consumer attached | `droppedNoConsumer` |

Notes:
- `ttl` and `overflow` are *policy* drops: real routers shed load the same
  way, and consumers see them in stats. They are intentional in the sense
  that the policy is explicit and observable — never invisible.
- A frame delivered to a port whose pod ignores it (wrong dst MAC) is
  `delivered` from the loft's point of view; rejection happens in the pod's
  kernel, where it belongs.

## Transport & messages

One WebSocket, `ws://<loft>:9777/ws`. Text frames = JSON control; binary
frames = data plane, big-endian.

Loft → consumer:

```
{"type":"hello","ports":[Port…]}        on attach: current port set
{"type":"port-added","port":Port}
{"type":"port-removed","id":N}          port's frames in flight are ttl-dropped
{"type":"stats", …}                     1 Hz; counters are cumulative
0x01 token   [u8 1][u16 port][u32 frameId][u32 fullLen][snapshot ≤128B]
```

Consumer → loft:

```
0x02 deliver      [u8 2][u16 egressPort][u32 frameId]   delivers and consumes
0x03 drop         [u8 3][u16 0        ][u32 frameId]    frees the buffer
0x04 copy-deliver [u8 4][u16 egressPort][u32 frameId]   delivers, does NOT consume
```

Flooding (broadcast/unknown-unicast): `copy-deliver` to each egress, then
`drop` to free. Freeing a frame that was copy-delivered at least once does
not count as `drops.consumer` — it went somewhere.

`Port` is `{id, ifname, mac, ip, pod, namespace}`.

Reserved (fast path, milestone 3): `0x10 offload-add` / `0x11 offload-remove`
— consumer installs `match(5-tuple) → egress` so an established flow bypasses
tokenization. Offloaded frames count toward `txFrames` and a per-rule counter;
still no silent path.


## Multi-node (implemented): star control plane, mesh data plane

- **Gateway**: the control-plane node's loft is the Pigeon API endpoint.
  Consumers attach to it and see the union of every node's ports (each
  carries a `"node"` field). The consumer wire protocol is identical to
  single-node; `hello` carries `version` for future evolution.
- **Trunks** (`/trunk`, edge → gateway): control only — port registry,
  per-second stats, and tokens (the gateway rewrites edge-local port/frame
  ids into its consumer-facing id space). Tens of bytes per frame.
- **Mesh** (`/peer`, loft ↔ loft): payloads. A cross-node `deliver` becomes a
  `send-remote` instruction to the ingress loft, which pushes the buffered
  frame straight to the egress loft over the standard node network. One hop;
  the gateway and the consumer never carry payloads. Same-node deliveries are
  forwarded verbatim and never leave the node.
- Failures follow the lifecycle rule: an unreachable peer or a dead edge
  turns in-flight frames into `dropped:trunk` / `drops.trunk` — counted,
  never silent.
- Flow offload (reserved `0x10/0x11`) will reuse the mesh: an offloaded
  cross-node flow is pure loft→loft forwarding with no tokens at all.

Consumers may also attach as **observers** (`/ws?mode=observe`): read-only —
tokens, port events and stats, no routing verbs. One router at a time (latest
wins); any number of observers.

## External agents — bridging a real host in (`/port`)

A port doesn't have to be a pod veth. An **agent** connects to the gateway
loft at `ws://<gateway>:9777/port` and becomes a **virtual port** — a host on
the pigeon network with no veth, its wire is the WebSocket:

1. First message (text): registration `{"name","mac","ip"}`. The loft creates
   a virtual port, assigns an id, announces `port-added`, replies `{"ok",id}`.
2. Thereafter, **binary messages from the agent are ingress ethernet frames**
   (tokenized to the consumer like any veth frame), and the loft **writes
   egress frames back to the agent** over the same socket.
3. On disconnect the port is removed (`port-removed`).

So the agent speaks raw ethernet both ways. What it does with that is up to it:

- **`perch -synthetic`** (`bridge/cmd/perch`) answers ARP who-has for its IP
  and replies to ICMP echo — a minimal pingable host, used to prove external
  bridging end to end.
- **`perch -tap`** (Linux) bridges a real TAP device: actual host traffic
  rides the factory.
- A **VPN gateway** terminates WireGuard/TAP from remote desktops and presents
  them as virtual ports — see docs/edge.md.

Virtual ports are identical to veth ports from the consumer's view (same
tokens, deliver/drop, drop counters, board roost+landing). The aviary CNI is
not involved — the agent IS the network stack for its host.

## Consumer rules

1. Decide every token: `deliver` or `drop`. Sitting on tokens costs you
   `drops.ttl`.
2. Don't assume payload access — you route on headers, like hardware does.
3. Treat `stats` counters as cumulative; diff them yourself.
4. Reconnects are cheap: `hello` re-syncs the port set. Frames buffered while
   you were gone are governed by TTL, frames that *arrived* while no consumer
   was attached are `droppedNoConsumer` (visible in stats and on `GET /`).
