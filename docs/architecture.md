# Pigeon ISP — Architecture

## The core trick

A normal CNI plugs the pod's veth into a bridge and lets the kernel forward.
`pigeon-cni` (aviary mode) plugs the host end into **nothing**. `loftd` opens
an `AF_PACKET` socket on it, so the only path between aviary pods is:

```
alice (real pod)                                 bob (real pod)
  └─ eth0 ─ veth ─► loftd buffers frame,           ▲
              assigns id, sends TOKEN ──ws──► GAME │
                                              you carry the pigeon
                                              across belts you built
              loftd writes buffered frame ◄──ws── deliver(port, id)
  ┌────────────────────────────────────────────────┘
  └─► bob's veth ─ eth0 ─ bob's kernel
```

No game connected → frames drop (`droppedNoGame`). Wrong dovecote → the pod's
kernel drops the mismatched dst MAC. The game never needs to know the right
answer; the network grades you.

## Components

### `bridge/cmd/loftd` — the data plane daemon

- Polls `/run/pigeon/ports/*.json` (written by the CNI) and opens one
  promiscuous `AF_PACKET` socket per aviary veth.
- Buffers each ingress frame (`maxBuffered` 8192, TTL 30s) and sends the game
  a token: `[0x01][u16 port][u32 id][u32 len][≤128B snapshot]`.
- `deliver` (`0x02`) writes the buffered frame to the egress veth; `drop`
  (`0x03`) frees it. Overflow/TTL eviction = tail drop with per-port counters,
  published in a 1 Hz `stats` JSON message.
- One game client at a time; a new connection bumps the old one.

### `bridge/cmd/pigeon-cni` — dual-mode CNI

| | aviary namespace | every other namespace |
|---|---|---|
| veth host end | attached to nothing; loftd taps it | enslaved to `cni0` bridge |
| IPs | `10.244.0.0/24`, flock'd counter file | per-node `10.244.<X>.0/24` |
| routes | none — you are the route | default via `cni0`, NAT egress |
| who needs it | alice, bob, your future workloads | ArgoCD, Traefik, CoreDNS, game-web |

Infra mode exists because cluster infrastructure cannot depend on a network
the player hasn't built. It is the Altoros bash-CNI algorithm in Go (Talos
ships no shell, so a bash plugin cannot exec).

Node prep (done by the loft DaemonSet before installing the CNI): create
`cni0`, enable forwarding + `bridge-nf-call-iptables`, MASQUERADE the infra
subnet, host-gw routes to sibling nodes (`10.244.<x>.0/24 via 10.5.0.<x>`),
write `/run/pigeon/node.json`.

### Cluster lifecycle (Talos, docker provisioner)

`talosctl cluster create` gives ephemeral clusters with throwaway PKI in
seconds; `down.ps1` destroys everything. Config patch sets `cni: none`.
`--exposed-ports` publishes 80 (Traefik) and 9777 (direct loftd) on localhost.
No image registry anywhere: the loft DaemonSet and the game-web init container
compile/build their artifacts from source ConfigMap tarballs at pod start.

### Ingress & GitOps

- **Traefik v3**, hostNetwork on the worker, standard `Ingress` resources with
  `ingressClassName: traefik` — annotation-light auto-wiring.
  `pigeon.localhost` → game-web, `pigeon.localhost/ws` → loftd (same-origin
  WebSocket), `argocd.localhost` → ArgoCD.
- **ArgoCD** installed by `up.ps1`. `gitops/root.yaml` is an app-of-apps over
  `cluster/manifests/{infra,loft,web,aviary}`; pass `-GitRepo` to enable. The
  source ConfigMaps stay script-generated until we host an image registry.

## Performance model (the multi-gig question)

Hard constraint: a browser cannot ingest a video stream's worth of frames as
3D objects. The design accepts this and splits planes, like real routers do:

1. **Tokens, not payloads** (done): the WebSocket carries ~140 bytes per
   frame regardless of frame size. A 1500-byte MTU stream at 1 Gbps is ~83k
   pps — still too many *tokens* to render individually, hence:
2. **Flow offload = the fast path** (next): protocol verbs `0x10/0x11`
   (reserved) let the game install `match(5-tuple) → egress` rules in loftd.
   Gameplay: an established flow's pigeons arrive as a stream; you build a
   dedicated "pneumatic tube" and the flow stops visiting the factory. Your
   factory is the slow path (CPU); tubes are the fast path (ASIC). Stats keep
   flowing so the game can render the tube's throughput as an effect, not as
   entities.
   - Phase 1: userspace forwarding in loftd (good to ~1 Gbps with recvmmsg
     batching).
   - Phase 2: eBPF/XDP redirect installed per flow (true multi-gig, frames
     never reach userspace).
3. **Client-side ceilings** (done): 250 live pigeons max with oldest-waiting
   culling (drops are reported — a full floor IS a full buffer), 8192-frame
   daemon buffer, 1 Hz aggregate stats.
4. **Benchmarks**: `?storm=<pps>` in sim mode storms UDP tokens at the client
   while the HUD shows fps/ingest/drops. Cluster-side, an iperf3 pod pair in
   the aviary is the milestone-2 benchmark (add `bench.yaml`); the win
   condition is "the game stays at 60 fps while the loft tail-drops honestly."

## Edge agent — routing YOUR machine through the game (roadmap)

The plan for "Pigeon ISP as an actual ISP":

- A small Go agent (`perch`, Windows/Linux) creates a TUN device (wintun on
  Windows), routes `10.244.0.0/24` into it, and connects to loftd over a new
  `/port` WebSocket endpoint: `{"type":"register","name":"laptop",...}` makes
  it a dovecote like any pod.
- TUN is L3; the loft is L2. The agent owns a synthetic MAC and runs a tiny
  ARP responder/requester — its ARP requests become pigeons too, so plugging
  your laptop in looks identical to a pod joining.
- loftd treats agent ports exactly like veth ports: same tokens, same
  delivery, same drops. Your real wget routes through your belts.
- Security note for later: that endpoint needs auth (the throwaway-PKI client
  cert story fits — mint an agent cert at cluster create).

## Known limitations (deliberate, for now)

- Aviary IPAM is node-local; aviary pods must share one node. The cluster is
  single-node anyway (`--exposed-ports` only publishes on the init node, so
  everything lives there). Multi-node aviary = milestone "build a WAN".
- CoreDNS works on the infra network, but aviary pods doing DNS would need you
  to route their queries — that's a future goal ("make DNS work"), not a bug.
- One game client per loft; multiplayer would need a session broker.
- `kubectl exec` works against aviary pods (it rides the API server, not the
  pod network) — that's how `ping-test.ps1` drives alice.

## Milestones

1. **ARP + ping** (now): alice pings bob through hand-built belts.
2. **wget**: nginx pod in the aviary; TCP handshake + segments. Add splitter/
   filter machines (route by EtherType/port → build an actual switch fabric).
3. **Flow offload**: iperf3 benchmark, pneumatic tubes, stats-driven effects.
4. **DNS + services**: route aviary DNS to CoreDNS's dovecote.
5. **Edge agent**: your real laptop traffic through the factory.
6. **Multi-node WAN**: lofts peer over the talos docker network; inter-loft
   links are player-built "undersea cables".
