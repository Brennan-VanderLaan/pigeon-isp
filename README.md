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

Requirements: Docker Desktop, `talosctl`, `kubectl`, Node 20+ (only for local
game dev), PowerShell.

```powershell
.\cluster\up.ps1            # ephemeral 3-node Talos cluster, throwaway PKI, ~5 min
# game + speedtest + health:  http://pigeon.localhost   (served from the cluster)
# argocd:                     http://argocd.localhost
node tools\autoroute.mjs    # attach a router (or play the game and build belts)
.\cluster\ping-test.ps1     # alice pings bob ACROSS NODES through your routing
.\cluster\down.ps1          # burn it all down; nothing is left behind
```

Game development without a cluster — the sim bridge runs two fake pods with a
real ARP cache and ping loop:

```powershell
cd game
npm install
npm run dev                 # http://localhost:5173/?sim=1
# benchmark mode: http://localhost:5173/?storm=2000   (UDP storm at 2000 pps)
```

## The pieces

| Path        | What it is |
|-------------|------------|
| `game/`     | TypeScript + three.js webapp: the factory floor, plus **Speedtest** and **Health** tabs (speedtest-style baseline-vs-pigeon benchmarks, cluster/loft telemetry). |
| `bridge/`   | One Go module, two binaries. `loftd`: AF_PACKET tap per aviary veth, token protocol, multi-node trunks (star control plane, mesh data plane). `pigeon-cni`: dual-mode CNI plugin. |
| `tower/`    | In-cluster admin service: health, kubelet usage, and the `/api/run` benchmark trigger (iperf3, baseline path vs pigeon path). |
| `tools/`    | `autoroute.mjs` — headless MAC-learning consumer (the "it could be scripts" proof, and the bench workhorse). |
| `cluster/`  | `up.ps1 -Workers 2` / `down.ps1` Talos lifecycle + all manifests. |
| `gitops/`   | ArgoCD app-of-apps. `up.ps1 -GitRepo <url>` points ArgoCD at your remote. |
| `docs/`     | Architecture, the Pigeon API contract, performance model, roadmap. |

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
