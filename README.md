# Pigeon ISP

**Build a router. For real. Out of conveyor belts and pigeons.**

Real applications run in a real Kubernetes cluster. Their pods are wired up by
a custom CNI whose host-side veths connect to *nothing* — no bridge, no kernel
forwarding. The only data plane is **you**: every frame becomes a pigeon
carrying a scroll on a 3D factory floor in your browser, and it only arrives
if your belts physically carry it to the right dovecote. Drop a pigeon, and
somewhere a real TCP stack retransmits. RFC 1149 was a warning, not a joke.

Watch ARP happen. Carry the who-has broadcast to the other pod by hand. Route
the reply back. Then keep the ICMP echoes flowing until `ping` prints
`0% packet loss` — because you, personally, are the network.

## Quickstart

You need, on PATH: **Docker Desktop** (running), **`talosctl`**, **`kubectl`**,
**`tar`** (Git-for-Windows / built-in Win10+), and **PowerShell**. Node 20+ is
only needed for local game dev and the `tools/` consumer. No container
registry, no cloud, no accounts — everything builds itself inside the cluster
from source.

```powershell
git clone <repo> ; cd pigeon-isp
.\cluster\up.ps1                  # ephemeral Talos cluster, throwaway PKI, ~5-8 min
#   open http://pigeon.localhost  — Factory / Hosts / Network / VPN / Speedtest / Health
node tools\autoroute.mjs          # attach a headless router (or play: build belts yourself)
.\cluster\ping-test.ps1           # alice pings bob across nodes, through your routing
.\cluster\down.ps1                # burn it ALL down — PKI, nodes, everything

# options
.\cluster\up.ps1 -Workers 0       # single-node (faster bring-up)
.\cluster\up.ps1 -SkipArgoCD      # skip the ArgoCD install
```

**Ephemeral cluster, persistent factory.** Every cluster is throwaway — tear it
down and rebuild from scratch any time. Your *factory* (belts, machines, host
placement) lives in the browser's localStorage and is keyed by host identity,
so the same hosts return to the same roosts on a rebuild and your routes still
line up. Great for sharing: anyone can `up.ps1` from a clean machine and get an
identical cluster.

Game development without a cluster — the sim bridge runs two fake pods with a
real ARP cache and ping loop:

```powershell
cd game ; npm install
npm run dev                 # http://localhost:5173/?sim=1
npm test                    # the machine-logic test suite (decode, filters, switch, tables, meter)
# benchmark mode: http://localhost:5173/?storm=2000   (UDP storm at 2000 pps)
```

First run is slow (the cluster pulls Go modules and `npm install`s the game in
pods). If `pigeon.localhost` doesn't resolve, your OS already maps `*.localhost`
to loopback on Win/macOS; on Linux add `127.0.0.1 pigeon.localhost` to
`/etc/hosts`.

## The pieces

| Path        | What it is |
|-------------|------------|
| `protocol/` | `@pigeon/protocol` — the Pigeon API as a TypeScript library: wire types, frame decode, and the loft consumer bridge (live + offline sim). Both webapps build on exactly this. **[Start here to build your own visualizer.](protocol/README.md)** |
| `game/`     | TypeScript + three.js webapp. Factory floor (belts, crossings, filters, hubs, multi-port switches, meters, MIDI, learn/lookup primitives) + **Hosts / Network / VPN / Speedtest / Health** tabs. |
| `ballpit/`  | A second visualizer on the same `@pigeon/protocol` engine — a Rokenbok-style ball factory; tokens pour in as physics balls you route into sinks. CPU (Rapier) or GPU MLS-MPM fluid backend. See [docs/ballpit.md](docs/ballpit.md). |
| `bridge/`   | One Go module. `loftd` (AF_PACKET tap + token protocol + multi-node trunks), `pigeon-cni` (dual-mode CNI), and the external-host agents: `perch`, `wggw` (WireGuard), `tunbridge` (IKEv2/VPN), `uplink` (NAT to the world). |
| `tower/`    | In-cluster admin service: health, kubelet usage, runtime host spawning, periodic workloads, live pod shells, and the iperf3 speedtest. |
| `tools/`    | `autoroute.mjs` — headless MAC-learning consumer (the "it could be scripts" proof, and the bench workhorse). |
| `cluster/`  | `up.ps1 -Workers 2` / `down.ps1` Talos lifecycle + all manifests. |
| `gitops/`   | ArgoCD app-of-apps. `up.ps1 -GitRepo <url>` points ArgoCD at your remote. |
| `docs/`     | [architecture](docs/architecture.md), the [Pigeon API wire contract](docs/pigeon-api.md) (+ the [consumer SDK guide](protocol/README.md)), [ballpit](docs/ballpit.md), [benchmarks](docs/benchmarks.md), [edge/VPN](docs/edge.md), [uplink](docs/uplink.md). |

## Bring real hosts in, and route out to the world

- **Spawn hosts at runtime** (Hosts tab / tower `/api/hosts`): any image, wired
  only to the pigeon CNI — sandboxed by construction. Live pod shells (xterm)
  and periodic workloads included.
- **VPN in real devices** (VPN tab): WireGuard (per-peer configs, works today)
  or IKEv2 (native phone/Windows clients). Each device becomes its own host on
  the floor. See [docs/edge.md](docs/edge.md).
- **Route out to the internet** via the **uplink** — a dual-homed NAT gateway.
  Aviary pods `apt-get update` only if you carry their packets to it, so the
  routing *is* your firewall. See [docs/uplink.md](docs/uplink.md).

## The one rule

Pods in the **`aviary` namespace** get game networking — their frames move
only when you move them. Every other namespace (ArgoCD, Traefik, CoreDNS, the
game's own web server) gets a normal bridge network from the same CNI plugin,
because infrastructure shouldn't depend on whether you've finished building
the internet yet.

## Why the game doesn't melt under load

Frame payloads never cross the WebSocket. `loftd` buffers frames node-side and
sends the game a *token* — port, frame id, length, and a 128-byte header
snapshot for the inspector. Delivering a pigeon tells the daemon to release
the buffered frame. Multi-gig flows stay in the loft; see
[docs/architecture.md](docs/architecture.md) for the fast-path offload plan.

Born from a custom-CNI experiment based on
[Kubernetes networking: writing your own simple CNI plug-in with bash](https://www.altoros.com/blog/kubernetes-networking-writing-your-own-simple-cni-plug-in-with-bash/).
The plugin is Go now (Talos hosts have no shell to run bash in), but the
infra-mode code path is that article's algorithm, faithfully.
