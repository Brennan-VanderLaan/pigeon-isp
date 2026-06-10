# Edge: bridging real hosts into the pigeon network

The aviary is L2 and the game routes ethernet frames. To put a *real* host on
that network — a laptop, a desktop, a container that isn't a pod — something
has to speak ethernet to the loft on the host's behalf. That something is an
**agent** connected to the loft's `/port` API (docs/pigeon-api.md).

## perch (`bridge/cmd/perch`)

A reference agent. It registers a virtual port (`name`/`mac`/`ip`) and then
either synthesizes a host or bridges a real NIC.

```
perch -gateway 10.5.0.2:9777 -name perch -ip 10.99.0.250 -mac 0a:58:0a:63:fe:fe
```

- **`-synthetic`** (default): answers ARP who-has for its IP and replies to
  ICMP echo. A pingable host with no NIC behind it — used to prove the path.
  **Verified**: with a consumer routing, `kubectl -n aviary exec alice -- ping
  10.99.0.250` succeeds 0% loss; the first packet pays ARP resolution, then
  RTT drops to ~2 ms.
- **`-tap`** (Linux, roadmap): bridge a TAP device so real host traffic rides
  the factory.

perch runs as a pod in `pigeon-system` (infra network) because it must *reach*
the gateway loft (10.5.0.2:9777) to dial out — an aviary pod has no normal
connectivity. Its host presence on the aviary is entirely virtual.

## VPN termination (the desktop story) — design

The goal: VPN in from any desktop and have its real traffic route through the
fabric. The reachability constraint shapes the design — aviary pods can't be
reached from outside, so the tunnel endpoint must live where it's reachable
(a node port) and bridge *inward* to the loft.

**Recommended: a WireGuard gateway agent.**

```
your desktop                cluster
┌───────────┐  WireGuard   ┌─────────────────────────────┐
│ wg client │═══UDP════════►│ wg-gateway pod (infra net,  │
│ (stock)   │               │  node-exposed UDP port)     │
└───────────┘               │   wg0 ──► L3↔L2 + ARP ──►    │
                            │   loft /port (virtual host) │
                            └──────────────┬──────────────┘
                                  tokens to the consumer (the game)
```

- The desktop uses the **stock WireGuard client** — no custom software to
  install, works on Windows/macOS/Linux/phones.
- The `wg-gateway` agent terminates WireGuard, and for each peer (or one
  shared presence) it does L3↔L2: wraps the peer's IP packets in ethernet,
  runs a small ARP responder/requester, and feeds them to the loft `/port` as
  a virtual host. Routed frames come back and are decapsulated to the peer.
- Expose the gateway's UDP port via `talosctl ... --exposed-ports` so the
  desktop can reach it on `localhost:<port>`.

Open design fork (needs a call before building):

- **One shared host vs per-peer hosts.** Simplest: all VPN peers share one
  virtual host (one MAC/IP) — the gateway is a NAT router and the desktop
  "is" the gateway on the board. Richer: each peer gets its own virtual port
  (its own MAC/IP, its own roost/landing), so every desktop is a distinct
  host you can watch and route independently. Per-peer is the better demo and
  the `/port` API already supports many ports; it costs per-peer ARP/MAC
  bookkeeping in the gateway.
- **Auth.** The `/port` endpoint is currently open (lab cluster). Production
  would mint per-agent credentials — the throwaway PKI can issue an agent
  cert at cluster create.

L2-over-tunnel (TAP) instead of WireGuard would make each desktop a true
bridged host with its own ethernet stack, but TAP on Windows needs the
OpenVPN tap driver — WireGuard's stock-client reach wins for "any desktop."
