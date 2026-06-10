# Benchmarks & the road to multi-gig

The question: how much real traffic can a *consumer application* route before
the architecture, not the code, is the wall? And when it stalls — whose fault
is it?

## The telemetry split

A frame's life has four timestamps; we instrument the two halves separately so
"the pigeon network is slow" and "the consumer is slow" are different graphs:

```
t0 frame hits loftd          ─┐
t1 token reaches consumer     │  loft side: deliverLatencyUs (t0→t3-ish)
t2 consumer decides           │  consumer side: decide µs (t1→t2)
t3 loftd writes egress veth  ─┘
```

- **Loft side**: `deliverLatencyUs {sum,count,max}` per port, in the 1 Hz
  `stats` message and `GET /stats`. Includes WebSocket transit both ways +
  consumer think time + queueing. Subtract the consumer's number to isolate
  transport.
- **Consumer side**: the game accumulates per-token decide time and shows
  `decide: X µs` in the HUD (autoroute mode measures the pure-switch path).

## Running it

**The speedtest webapp** (multi-node): open `http://pigeon.localhost` →
**Speedtest** tab. Two buttons, two numbers:

- *baseline* — tower pod → baseline-server pod on another node, kernel
  routing on the infra network. The node network's practical ceiling.
- *pigeon* — iperf3 between aviary pods on different nodes: every frame rides
  the loft mesh and your consumer. Keep a router attached (Factory tab in
  `?autoroute=1`, or `node tools/autoroute.mjs`) or it reads zero, correctly.

Results include RTT, retransmits/jitter/loss, and the loft-side verdict
latency delta for exactly the frames the test moved. The **Health** tab is
the same tower talking: node readiness, CPU/mem from the kubelet summary API,
and each loft's role/ports/trunk drops.

CLI equivalents:

```powershell
.\cluster\bench-test.ps1                    # ping RTT + iperf3 TCP + UDP + loft telemetry
# or hit the tower directly:
#   POST http://pigeon.localhost/api/run {"test":"pigeon","proto":"tcp","seconds":10}

# client-only stress (no cluster): how many tokens/s can the page ingest?
#    http://localhost:5173/?storm=20000
```

Modes worth comparing: physics ON (belts, the actual game) vs `?autoroute=1`
(the webapp's honest maximum) vs — later — a headless consumer.

## Measured (2026-06-10, first light)

Single-node Talos in Docker Desktop, consumer = `tools/autoroute.mjs` (Node,
single thread) on the Windows host, every frame individually round-tripping
pod → AF_PACKET → WebSocket → JS MAC table → WebSocket → AF_PACKET → pod:

| Test | Result |
|---|---|
| ICMP RTT (steady state) | ~1.2 ms |
| iperf3 TCP, 10 s | **292 Mbit/s** sustained (270 retransmits) |
| iperf3 UDP @100M | 100 Mbit/s, **0% loss**, 0.14 ms jitter |
| loft deliverLatency under load | ~1.4 ms avg, ~69 ms max |

**Multi-node (same day, 1 CP + 2 workers):** alice (worker-1) ↔ bob
(worker-2), every frame riding edge trunk → gateway → consumer → mesh push:

| Test (cross-node) | Result |
|---|---|
| baseline iperf3 TCP (infra path, kernel-routed) | **52.7 Gbit/s**, 0.10 ms RTT |
| pigeon iperf3 TCP | **269.8 Mbit/s**, 0% loss |
| pigeon ICMP RTT (steady state) | ~1.9 ms |

The pigeon number is within 8% of single-node — the trunk + mesh hop costs
almost nothing; the per-token consumer round trip remains the wall, exactly
where the architecture wants it (that's what batching and offload remove).
The 195× baseline gap is the honest score the Speedtest tab shows; watching
it close is the roadmap.

Lesson that cost an hour: veth checksum offload. The pod kernel leaves
TCP/UDP checksums unfilled (CHECKSUM_PARTIAL) for "hardware"; a raw tap
faithfully replays the garbage and the receiver drops every segment.
`pigeon-cni` now disables tx-checksumming/TSO/GSO/GRO on aviary veths —
the loft demands honest wire-sized, checksummed frames.

## Expected ceilings (and what raises them)

Napkin numbers for the stages we haven't measured yet:

| Stage | ~Ceiling | Bottleneck |
|---|---|---|
| Game, physics mode | ~10²–10³ pps | entity count, render loop |
| Game, autoroute | ~10⁴–10⁵ tokens/s | ws message overhead, JS event loop |
| Headless consumer (Go/Rust) | ~10⁵–10⁶ tokens/s | per-token round trip, syscalls |
| loftd userspace forward (offload) | ~1 Gbps | recvfrom/sendto per frame |
| eBPF/XDP offload | multi-gig | none we'll hit in a home lab |

The per-token decision round trip is the fundamental tax: at 83k pps
(1 Gbps @ 1500 MTU) even a 12 µs decision burns a full core. That's why the
API reserves **flow offload** (`0x10/0x11`): the consumer decides once per
*flow*, installs `match → egress` in loftd, and the per-frame path collapses
to kernel-side forwarding. Multi-gig is reached not by making the consumer
faster but by making it decide less — same as real routers (CPU slow path,
ASIC fast path).

Incremental loftd wins before XDP: batched tokens (one ws message, N tokens),
`recvmmsg`/`sendmmsg`, ring-buffer AF_PACKET (TPACKET_V3), then AF_XDP.

## If the webapp is terrible: other consumers

The Pigeon API is consumer-agnostic by design (docs/pigeon-api.md) — the game
is one client of `ws://loft:9777/ws`, not the architecture. A Rust headless
consumer (`tokio` + `tungstenite`, same token protocol, same MAC-table logic
as `?autoroute=1`) is the natural second implementation:

- benchmarks the *protocol* with the consumer cost near zero,
- doubles as the reference "scripted router" (the it-doesn't-have-to-be-a-game
  consumer), and
- keeps the game honest: game-vs-rust deltas on the same iperf3 run measure
  exactly what the browser costs.

`bridge/` could grow `consumers/rust-switch/` when we get there.

## Multi-node

Once lofts trunk to each other (pigeon-api.md), the same iperf3 pair pinned to
different nodes measures the inter-loft hop over the standard node network.
The lifecycle rule carries over: trunk failures are `dropped:trunk`, counted,
never silent.
