# Pigeon Ballpit — a Rokenbok router

A second visualizer (`ballpit/`) on the same engine as the belt game. Both are
just **consumers of `@pigeon/protocol`** — the loft is the engine, the games are
skins. This one is a near-1:1 Rokenbok homage: you build a physical ball factory
out of construction parts, drive vehicles, and route real packets by routing
balls through it.

> Want to build your *own* visualizer on the same stack? Read the consumer SDK
> guide — [`protocol/README.md`](../protocol/README.md). Ballpit is the
> worked example: every loft token becomes a ball (`onToken` → spawn), and a
> ball reaching a sink is a `deliver` (a ball lost off the world is a `drop`).
> That's the entire coupling between this game and the network.

## The mapping (Rokenbok ↔ packets)

| Rokenbok thing | Ballpit part | Packet meaning |
|---|---|---|
| Ball | one ball | one loft frame (token); colored by protocol |
| Loading dock | **Host Spawner** pad | a port; its frames drop in as balls here |
| Bin / chute-to-truck | **Host Sink** volume | drop a ball in → `deliver(port, frame)` |
| Conveyor | **Conveyor** | powered belt: pushes balls along its facing |
| Chute / ramp | **Chute** | gravity guide (verticality between floors) |
| Sorter | **Sorter** | splits balls by a frame field (proto / dst-mac / port) → different exits. This is the router brain. |
| Spiral / elevator | **Lift** | raises balls a floor (verticality up) |
| Launcher | **Launcher** | impulses a ball toward a target |
| RC bots (dozer, loader, forklift) | **Vehicles** | drive to push/scoop balls into chutes/sinks — the dexterity layer |
| Multi-level build | **Floors** | parts live at a level; balls fall through gaps |

Lose a ball (off the world, or past the loft's ~30s TTL) → `drop(frame)`. The
no-silent-drop rule holds: every ball ends as a deliver or a counted drop.

## Architecture

- **`@pigeon/protocol`** — the shared client (types, decode, live+sim Bridge).
  Nothing in ballpit knows about belts or pods beyond this contract.
- **`physics.ts`** — Rapier (WASM) behind a small interface. Rigid balls,
  fixed/kinematic part colliders, sensor volumes for sinks/sorters. Designed to
  move into a **Web Worker** (the perf path for tens of thousands of balls);
  gameplay talks to an interface, not Rapier directly.
- **`balls.ts`** — every ball in ONE `InstancedMesh` (single draw call); slots
  recycled; settled balls sleep (a still pit is nearly free). Each ball carries
  a small **tag** (ingress port, dst-mac, protocol) so sorters can route it.
- **build system** — a 3D grid `(col, row, level)`. A **part registry**: each
  part type declares its footprint, meshes, colliders, and a per-step behavior
  (conveyor push, sorter decision, lift force…). Placement by raycast with a
  ghost preview; rotate/erase; persisted to localStorage. **Levels** give
  verticality.
- **vehicles** — kinematic character bodies you drive (WASD / on-screen);
  push/scoop forces on contacted balls.

## Multiplayer (a core pillar, like Rokenbok)

Rokenbok is co-op: friends each drive a vehicle to make one factory work.
Ballpit must support the same — several players operating the SAME factory at
once. Physics isn't deterministic across browsers, so the model is an
**authoritative sim**:

- One process owns the Rapier world and is the loft's single **router**
  consumer (it decides every token by where its balls land). Candidates: a
  headless Node/Go "ballpit server", or the tower.
- Players connect to that server (WebSocket): they receive ball + vehicle +
  part **transforms** (compact binary, like the loft's token stream) and the
  build state; they send **inputs** (vehicle controls, part placements).
- The server is the source of truth; clients render and predict. This reuses
  the exact pattern the loft already proves — one authority, many attached
  peers — just for the physical layer instead of the frame layer.

Until the server exists, the client runs the sim locally (single-player /
prototype). The `Physics` interface + transform-buffer rendering are written so
the authority can move out of the browser without touching gameplay code: the
same step→transforms→render loop, sourced from the network instead of local
Rapier.

## Performance plan (tens of thousands of balls)

1. InstancedMesh rendering — done (one draw call).
2. Body sleeping — done (Rapier islands; settled pits cost ~nothing).
3. Physics in a Web Worker — main thread renders from a transform buffer; the
   `Physics` interface already isolates this.
4. Rapier SIMD build + fixed timestep with substeps under load.
5. LOD / cull for balls far below the active floor.

The honest ceiling: full rigid-body for *active* balls tops out in the low
thousands per frame on the main thread; the worker + sleeping is what buys the
"mostly-settled tens of thousands" pit. We measure as we scale.

## Roadmap

1. ✅ Foundation: API → ball per token → physics → bins → deliver/drop, tilt.
2. **Construction core**: build grid + levels, part registry, placement UI;
   Host Spawner / Host Sink / Conveyor / Chute as the first parts.
3. **Router parts**: Sorter (by frame field), Lift, Launcher, merger/splitter.
4. **Vehicles**: drivable bots; pick-up & dump. Wishlist (Brennan's favorites):
   - **Street sweeper** — vacuums balls from the front, accumulates them in a
     dump-truck bed at the back, tips them into a chute/sink.
   - **Monorail** — an elevated track line that carries balls between stations.
   - **Electric sorters** — powered diverters that flick balls down different
     lanes by a frame field (the Sorter part, motorized).
5. **Multiplayer**: authoritative ballpit server (owns Rapier + is the loft
   router); clients stream transforms in, inputs out. Co-op driving, shared
   build. The big one.
6. **Verticality UX**: level selector, ghost floors, cutaway camera.
7. **Polish**: save/share factories, ball trails, sound, the win states.
