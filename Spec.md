# Pigeon ISP — System Specification

**Build a router. For real. Out of conveyor belts and pigeons — or out of a
GPU ball pit.**

Real applications run in a real Kubernetes cluster. Their pods are wired by a
custom CNI whose host-side veths connect to *nothing* — no bridge, no kernel
forwarding. The only data plane is **you**: every ethernet frame becomes an
object on a 3D factory floor in your browser, and it only arrives if you
physically route it to the right destination. Drop it, and a real TCP stack
retransmits. RFC 1149 (IP over Avian Carriers) was a warning, not a joke.

This document specifies the whole system: the cluster + CNI + data plane, the
Pigeon API that makes the loft a general frame-plane, the two independent
visualizers built on it, the VPN/edge stack that brings real devices and the
real internet onto the pigeon network, and the in-progress GPU fluid simulation.

---

## 1. Thesis & layering

The loft is **not** "the game's backend." It is a general frame-plane API; a
visualizer is merely a *consumer*. That separation is the spine of the system:

```
 Kubernetes pods (aviary namespace)         real devices (phones, laptops)
        │ veth (to nowhere)                         │ WireGuard / IKEv2
        ▼                                           ▼
 ┌─────────────────────────  loftd (one per node)  ──────────────────────────┐
 │  AF_PACKET tap • token protocol • multi-node trunks • external /port agents │
 │                         THE PIGEON API  (ws /ws)                            │
 └───────────────┬───────────────────────────────────────────┬──────────────┘
                 │ tokens / deliver-drop                       │
        ┌────────▼─────────┐                          ┌────────▼─────────┐
        │  Visualizer #1   │                          │  Visualizer #2   │
        │  belt + pigeon   │   both speak ONLY         │  GPU ball pit    │
        │  factory (game/) │   @pigeon/protocol        │  (ballpit/)      │
        └──────────────────┘                          └──────────────────┘
```

Two visualizers on one engine is the forcing function that keeps the API a real
contract, not "whatever game/ happens to do."

---

## 2. Cluster & data plane

### 2.1 Ephemeral Talos cluster
- **Talos Linux**, docker provisioner, throwaway PKI, `cni: none`, single or
  multi-node (`up.ps1 -Workers N`). Everything builds itself **inside the
  cluster** from source tarballs — no registry, no cloud, no accounts.
- `cluster/up.ps1` brings it up; `cluster/down.ps1` burns it all down (PKI,
  nodes, kube/talos contexts — nothing left behind). Hardened for clean,
  repeatable, shareable bring-ups.
- The game is served in-cluster at **`http://pigeon.localhost`** via Traefik
  ingress (`*.localhost` → loopback on Win/macOS).

### 2.2 `pigeon-cni` (dual-mode CNI, `bridge/cmd/pigeon-cni`)
- **aviary namespace** → *game-wired*: a veth whose host end connects to
  nothing. Flat L2, `10.99.0.0/16`, per-node `/24`, default route via
  `10.99.0.1`. These pods have no network unless **you** move their frames.
- **every other namespace** (Traefik, CoreDNS, ArgoCD, the game's own web
  server, the gateways) → a normal cni0 bridge + NAT, because infrastructure
  shouldn't depend on whether you've finished building the internet yet.
- Disables checksum offload (frames cross userspace). Go (Talos has no shell);
  the infra-mode path is the Altoros "bash CNI" article's algorithm, faithfully.

### 2.3 `loftd` (the data plane, `bridge/cmd/loftd`)
- One per node. AF_PACKET tap on each aviary veth. **Token protocol**: frame
  payloads stay node-side; the consumer gets a token (port, frameId, length,
  128-byte header snapshot). Delivering a token releases the buffered frame.
  Multi-gig flows never cross the WebSocket.
- **Multi-node**: star control plane (`/trunk`, edge→gateway) + mesh data plane
  (`/peer`, loft↔loft). The gateway loft is the single Pigeon API endpoint;
  consumers see the union of all nodes' ports.
- **No-silent-drop rule**: every frame ends as `delivered` or a *counted* drop
  (`overflow` / `ttl` / `consumer` / `no-consumer` / `trunk`).
- HTTP: `/stats`, `/hosts` (name→ip registry for DNS), `/` (health).

### 2.4 `tower` (in-cluster admin, `tower/`, client-go)
Health, kubelet usage, runtime host spawning (`/api/hosts`), periodic workloads,
live pod shells over WebSocket (persistent), and the iperf3 bidirectional
speedtest.

---

## 3. The Pigeon API (`docs/pigeon-api.md`, code: `@pigeon/protocol`)

One WebSocket, `ws://<loft>:9777/ws`. Text = JSON control, binary = data plane
(big-endian). The contract, in code, is the **`protocol/` package**:

- `Bridge` — verbs a consumer calls: `deliver(port, frameId)`,
  `copyDeliver(port, frameId)` (flood), `drop(frameId)`.
- `BridgeEvents` — callbacks: `onHello(ports)`, `onPortAdded/Removed`,
  `onToken(token)`, `onStats`, `onState`, `onLog`.
- Types: `PortInfo {id, ifname, mac, ip, pod, namespace, node?}`,
  `FrameToken {id, port, fullLen, snapshot}`, `LoftStats`.
- `decodeFrame(snapshot, len)` — L2–L4 header decode (ARP/ICMP/TCP/UDP) +
  `KIND_COLORS`.
- `WsBridge` (live loft) and `SimBridge` (offline two-fake-pods sim) both
  implement the contract.

**Extracted as a shared workspace-style package** (`protocol/`), consumed by
both visualizers via a Vite/tsconfig path alias `@pigeon/protocol →
../protocol/src`. The in-cluster game build ships `game/` and `protocol/` as
siblings (`up.ps1` tars both; `web.yaml` builds from `/build/game`).

### External agents (`/port`)
A port needn't be a pod veth. An agent connects to `ws://<gateway>:9777/port`,
registers `{name, mac, ip}`, then exchanges raw ethernet — a **virtual host** on
the pigeon network. Agents: `perch` (synthetic ARP/ICMP), `wggw` (WireGuard),
`tunbridge` (IKEv2 XFRM), `uplink` (NAT gateway).

---

## 4. Visualizer #1 — the belt & pigeon factory (`game/`)

TypeScript + three.js (WebGL). Frames are **pigeons** carrying scrolls on
conveyor belts; deliver one to a host's dovecote and the real frame is written
to that port. Build:

- **Machines**: belts, crossings (overpass), filters (compass-routed by frame
  field), hubs (clone), multi-port **switch** appliance (IEEE 802.1D, in/out
  lane pairs), **meter** (token-bucket pps/bps), **MIDI** block (frame→music:
  scales/chords/arpeggiator via Web MIDI), **learn/lookup** primitives over
  named tables (build-your-own switch).
- **Hosts placement**: 18 perimeter "roosts" (out) + landings (in); persisted by
  host identity (ns/pod) in localStorage so the same hosts return to the same
  slots across cluster rebuilds; shelve/inventory; **move-roost** (relocate a
  host to a free slot, persisted).
- **Tabs**: Factory / Hosts (spawn, xterm shells, roost diagnostics) / Network /
  VPN / Speedtest / Health.
- 46 vitest tests over the pure machine logic (filters, switch, meter, tables).

Born from a 2023 custom-CNI experiment (Altoros bash-CNI homage).

---

## 5. Edge / VPN — real devices & the real internet on the pigeon network

### 5.1 WireGuard (`bridge/cmd/wggw`, `cluster/manifests/vpn/wg-gateway.yaml`)
Terminates WireGuard from real devices and bridges **each peer** onto the pigeon
network as its own virtual host (per-peer MAC/IP + loft `/port`). Userspace
wireguard-go (no kernel module). Highlights, all shipped:

- **QR onboarding**: `/vpn/qr/<peer>.png` (skip2/go-qrcode); the VPN tab shows a
  scannable QR per peer.
- **LAN endpoint**: configs/QRs take `?host=<addr>` so the `Endpoint` is the
  host's reachable LAN IP, not `127.0.0.1` (phones can't dial loopback). The tab
  has an address box defaulting to how you reached the game.
- **Masked private keys** on screen (QR/copy carry the real key).
- **Live handshake telemetry**: the gateway reads wireguard-go's UAPI for
  per-peer last-handshake / rx / tx / endpoint; the tab shows a real
  connected/idle/no-handshake badge (not the meaningless loft-side "bridged").
- **Durable keys**: keys derive from a per-cluster seed (`WG_SEED` Secret
  planted by `up.ps1`), so redeploys/restarts keep the same keys and scanned QRs
  stay valid. Proven identical across a restart.
- **`Recreate` rollout** strategy (hostNetwork pin + UDP 51820 → rolling updates
  deadlocked).
- **Verified working on a real phone** (handshake + bytes flowing).

### 5.2 Named full-tunnel network — `pigeon.isp`
Turns the VPN from "ping specific IPs" into "your device's real internet rides
the pigeons." Decisions: domain **`pigeon.isp`**, **full-tunnel by default**,
**joined devices reach the UI**.

- **`wggw` full vs split tunnel** (`?mode=full|split`, default full): full →
  `AllowedIPs 0.0.0.0/0, ::/0`; both push `DNS = 10.99.0.1, pigeon.isp`.
- **`uplink` is the named gateway** (`bridge/cmd/uplink`): a dual-homed NAT host
  registered as `10.99.0.1`. Its TUN owns `10.99.0.1/16`, so services bound
  there are delivered locally and replies ride the existing return path:
  - **DNS resolver** on `:53` — answers `*.pigeon.isp` from the loft `/hosts`
    registry (`alice.pigeon.isp` → its aviary IP) + gateway aliases
    (`ui/gateway/router` → 10.99.0.1); forwards everything else upstream
    (1.1.1.1). DNS only resolves if you route the query to the uplink.
  - **HTTP reverse-proxy** on `:80` → Traefik (`10.5.0.2:80`, Host rewritten to
    `pigeon.localhost`) so a joined device opens `http://ui.pigeon.isp` — gated
    by VPN membership.
  - **NAT egress** (`ip_forward` + `iptables MASQUERADE`) for the rest.
- `loftd` `/hosts` endpoint feeds the resolver.
- **The full-tunnel ARP gotcha (fixed)**: a bridged peer must behave like a host
  with a default gateway — on-subnet (`10.99.0.0/16`) it ARPs for the dst;
  off-subnet (public IPs) it sends to the **gateway's MAC** (uplink), not ARP
  for the public IP. Missing this caused an ARP storm and no egress. Fixed in
  `wggw bridgeHost.sendIP` (`-aviary-gateway`/`-aviary-net`).
- **Verified**: phone full-tunnel pulls real internet through the routed path;
  ARP storm gone.

So: route the peer→uplink path across the factory and a phone gets internet +
DNS + the console — the routing *is* the firewall.

### 5.3 IKEv2 (`bridge/cmd/tunbridge`, `cluster/manifests/vpn/ikev2.yaml`)
strongSwan responder (kernel-netlink XFRM, `ipsec0` if_id 42, EAP
`pigeon`/`pigeon-vpn`) + a `tunbridge` sidecar attaching the XFRM interface via
AF_PACKET. Responder + data plane up; gated behind `up.ps1 -WithIKEv2` (host
often already binds UDP 500/4500). Device-gated — WireGuard is the proven path.

### 5.4 Operational notes learned
- IKEv2 ports 500/4500 conflict with Windows IPsec → gated behind `-WithIKEv2`.
- Aviary DNS: cluster CoreDNS (10.96.0.10) is unreachable on the pigeon net →
  tower spawns hosts with `dnsPolicy: None` + `1.1.1.1`/`8.8.8.8`.
- Windows Firewall blocks inbound UDP 51820 on a Public profile → add an allow
  rule for phones to reach the gateway.

---

## 6. Visualizer #2 — the GPU ball factory (`ballpit/`)

A near-1:1 **Rokenbok** homage: build a physical ball factory that **is** your
router. Independent Vite app on the *same* `@pigeon/protocol`. Default URL = the
loft-driven game; `?gpu=1` = the GPU particle sim.

### 6.1 The mapping (Rokenbok ↔ packets)
| Rokenbok | Ballpit part | Packet meaning |
|---|---|---|
| ball | one ball | one loft frame (token), colored by protocol |
| loading dock | **Host Dock** | a port; its frames spawn as balls here |
| bin/chute-to-truck | **Host Sink** (volume) | drop a ball in → `deliver(port, frame)` |
| conveyor | **Conveyor** | powered belt (friction drive, real physics) |
| chute/ramp | **Chute / graded Ramp** | gravity guide; verticality |
| platform | **Platform** | solid deck at any level (for vehicles) |
| sorter | **Sorter** (planned) | split by frame field = the router brain |
| RC bots | **Vehicles** (planned) | drive to push/scoop balls |

Lose a ball (off-world or past the loft's ~30s TTL) → `drop(frame)`.

### 6.2 Construction (shipped)
- 3D **build grid** `(col,row,level)` with verticality; part registry; raycast
  placement (ghost, rotate `R`, erase, build level `[ ]`), persisted to
  localStorage.
- Parts: **Platform**, **graded Ramp** (gentle/medium/steep, `G`), **Conveyor**
  (physical friction drive — not a velocity teleport), **Host Dock** + **Sink**
  (bound to a selected host, `H` cycles), auto-placed for new hosts.
- Real **OrbitControls** camera (left-drag orbit, right-drag pan, wheel zoom);
  left-click builds.

### 6.3 Physics paths
- **CPU (default game, `sim.ts` + Web Worker)**: Rapier (rapier3d-compat). Owns
  the world, balls (one `InstancedMesh`), part colliders, sink sensors;
  transforms streamed to the main thread via SharedArrayBuffer (COOP/COEP); the
  worker init-queue fixes the "balls phase through solids" race. Body sleeping.
  **Headless vitest physics tests** validate it (ball rests on floor / collides
  / sink-delivers / conveyor pushes). **Measured ceiling: ~5k active rigid
  bodies (~20 ms/step)** — the reason for the GPU pivot.

- **GPU (`?gpu=1`, the target)**: target is **100k+ concurrent** balls as a "3D
  fluid under high traffic." WebGPU-only (Chrome/Edge), three.js **0.184**
  `WebGPURenderer` + TSL compute. See §7.

### 6.4 Vision (planned)
- **Multiplayer co-op** (core, like Rokenbok): an authoritative ballpit server
  owns the physics and is the loft's single *router* consumer; clients stream
  transforms in / inputs out (mirrors "one router, many peers").
- **Vehicles** (Brennan's favorites): a **street sweeper** (vacuum front → dump
  bed → tip into a chute), a **monorail**, **electric sorters**.
- **Router parts**: Sorter (by frame field), Lift, Launcher.
- Wire the loft to the GPU set (spawn on token; GPU→CPU sink readback →
  `deliver`).

Roadmap detail: `docs/ballpit.md`, `docs/ballpit-gpu.md`.

---

## 7. The GPU fluid simulation (in progress)

**Goal**: 100k+ concurrent balls colliding as a granular fluid, entirely on the
GPU (no CPU round-trip). All particle state lives in TSL storage buffers; a
compute pass integrates it; the instanced mesh reads the position buffer
directly (`positionNode`).

### 7.1 Milestones
- **M1 ✅** — ballpit migrated to `WebGPURenderer` (async device init); existing
  scene renders unchanged.
- **M2 ✅** — 100k particles in storage buffers, gravity + arena-box collision,
  rendered instanced from the GPU buffer. **~0.3 ms compute at 100k** — huge
  headroom. (No inter-particle collision yet.)
- **M3 🚧** — granular collision. Uniform grid (cell = 2r), built with atomics
  (`toAtomic` + `atomicAdd` counter, per-cell index bucket of K=8), then a
  **Position-Based Dynamics** solve (Macklin & Müller, *Position Based Fluids*
  2013; XPBD "small steps" 2019):
  - predict (save prevPos, gravity, advance) → grid → N Jacobi non-penetration
    iterations (clamped, under-relaxed corrections) → `velocity = (pos −
    prevPos)/dt`.
  - **Key fix found via telemetry**: corrections are clamped to
    `MAX_SEP_SPEED·dt` (a position push over a tiny substep dt was injecting
    ~84 m/s → launches). Substepping (4) + velocity cap.

### 7.2 Status (honest)
Launching/NaN are fixed (telemetry: escaped 0, nan 0, floor solid). **Still not
settling**: the pile "boils" (maxSpeed pinned at the cap, surface heaves, whole
mass sloshes off the floor), and **balls still overlap** at the dense bottom
layer. Diagnosis: Jacobi over-relaxation + energy not dissipating + bottom
pressure not propagating. Next: measure overlap directly (per-particle
interpenetration counter — instrumented), then either tune (under-relax +
contact damping + more iterations) or switch the constraint from hard pairwise
non-penetration to a **PBF density constraint** (SPH kernels — smoother, the
true SOTA for GPU fluids), now that there's a real feedback loop (§7.3).

### 7.3 The telemetry loop (how we debug GPU blind)
WebGPU can't run headless in CI, so the browser ships diagnostics to a local
logger and the agent reads the file:
- `ballpit/telemetry-logger.mjs` — a tiny Node HTTP sink on `:7788`
  (permissive CORS/CORP) that writes `telemetry-latest.json` + `telemetry.log`.
- The GPU demo reads positions/velocities/overlap back off the GPU
  (`renderer.getArrayBufferAsync`) ~2 Hz and POSTs a health summary (maxY, minY,
  maxSpeed, escaped, nan, ovAvg/ovMax/ovPct, compute ms, fps).
- This turned "it's crazy" into numbers and directly found the launch bug.

### 7.4 Known GPU/TSL gotchas
- Vite pre-bundling mangles three's WebGPU/TSL named exports → `optimizeDeps:
  { exclude: ['three', 'three/webgpu', 'three/tsl', 'three/addons'] }`.
- TSL types don't expose node swizzles/atomics → liberal `as any` in shader
  helpers (runtime is correct).
- Atomic storage: `instancedArray(n,'int').toAtomic()` + `atomicAdd/Store/Load`.
- `vec3` storage is padded to 16 bytes (stride 4 floats) — readback accounts for
  it.

---

## 8. Repo layout

```
bridge/        one Go module: loftd, pigeon-cni, and agents (perch, wggw,
               tunbridge, uplink)
protocol/      @pigeon/protocol — the Pigeon API client (types, decode, bridges)
game/          visualizer #1: belt + pigeon factory (three.js / WebGL)
ballpit/       visualizer #2: GPU ball factory (three.js WebGPU + TSL compute)
tower/         in-cluster admin service (client-go)
tools/         autoroute.mjs — headless MAC-learning consumer / bench workhorse
cluster/       up.ps1 / down.ps1 Talos lifecycle + all manifests
gitops/        ArgoCD app-of-apps
docs/          architecture, pigeon-api, benchmarks, edge, uplink, ballpit,
               ballpit-gpu
```

Public repo: **github.com/Brennan-VanderLaan/pigeon-isp** (branch `main`).

---

## 9. Status summary

| Area | Status |
|---|---|
| Talos cluster + dual-mode CNI + loft token plane | ✅ working |
| Clean teardown / rebuild / sharing | ✅ verified |
| Pigeon API extracted as `@pigeon/protocol` | ✅ both games use it |
| Belt/pigeon visualizer (machines, hosts, tabs, 46 tests) | ✅ working |
| WireGuard (QR, LAN endpoint, masked keys, durable keys, telemetry) | ✅ verified on a phone |
| Full-tunnel `pigeon.isp` (uplink DNS + UI proxy + NAT) | ✅ verified |
| IKEv2 responder + XFRM data plane | ✅ up, device-gated |
| Ballpit construction (grid, conveyors, ramps, platforms, docks/sinks) | ✅ working |
| Ballpit CPU physics (worker, headless-tested) | ✅ ~5k ceiling |
| GPU sim M1 (WebGPU renderer) / M2 (100k particles) | ✅ |
| GPU sim M3 (granular collision) | 🚧 boiling/overlap — tuning via telemetry |
| GPU ↔ loft wiring, vehicles, multiplayer, sorters | ⬜ planned |
