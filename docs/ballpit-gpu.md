# Ballpit GPU sim — 100k+ balls as a fluid

CPU rigid-body (Rapier) tops out near ~5k active balls (measured: ~20 ms/step
single-thread; see `ballpit/src/__tests__/bench.test.ts`). The concurrent-100k
pit needs the balls treated as a **GPU particle system** — a granular "fluid"
simulated entirely on the GPU, never round-tripping to the CPU.

## Target architecture

- **Platform: WebGPU compute shaders.** All particle state lives in GPU storage
  buffers; compute passes integrate it; the same buffers are read directly by
  the instanced renderer (zero CPU round-trip). WebGPU-only (modern Chrome/Edge;
  no WebGL fallback — the whole point is compute).
- **Renderer: three.js `WebGPURenderer` + TSL compute.** Keeps everything we
  built — the build-grid parts, lights, OrbitControls, picking — while running
  compute on the same device. Particles render as one instanced mesh whose
  positions are a storage buffer the compute pass writes.

## Simulation (granular fluid, position-based)

Per frame, a few compute passes over N particles:

1. **Integrate** — gravity + external fields (conveyors, launchers) → predicted
   position (Verlet / semi-implicit Euler).
2. **Spatial hash** — bin each particle into a uniform grid cell (cell ≈ 2·r).
   Built with atomic counters (count per cell → prefix sum → scatter), so
   neighbour lookups are O(1). This is the one pass that needs GPU atomics.
3. **Collision solve** — for each particle, push apart from neighbours in the 27
   adjacent cells (granular repulsion / PBD density constraint), and resolve
   against **static geometry**: the build parts as analytic boxes / inclined
   slabs (a small uniform buffer of part AABBs+rotations), plus the floor/walls.
   1–4 relaxation iterations.
4. **Finalise** — velocity = (pos − prevPos)/dt with damping; write transforms.

Settled regions cost little (low velocity → cheap), and there's no CPU solver
ceiling — the GPU does 100k–1M particles.

## Keeping the Pigeon semantics

- **Spawn**: a loft token allocates a particle slot (free-list on CPU; the GPU
  just gets `spawn(slot, pos, vel, color)`).
- **Sinks / delivery**: each sink is an analytic box in the static buffer flagged
  with a port. A compute pass tags particles inside a sink with that port into a
  small **GPU→CPU readback buffer** (a ring of {slot, port}); the CPU drains it
  and calls `deliver(port, frame)`. Out-of-bounds / TTL → `drop(frame)`.
- **Conveyors / launchers**: regions in the static buffer that add a velocity /
  impulse in the integrate pass — same data the CPU build already produces.

## Validation without eyes on the screen

GPU output can't be asserted in Node, but we can:
- Read back particle positions to the CPU in a debug pass and assert invariants
  in a browser test (Playwright/WebGPU) — e.g. particles rest above the floor,
  don't overlap beyond 2r, a particle in a sink box is tagged.
- Keep the CPU `Sim` as the reference oracle for small N: same inputs → compare
  aggregate behaviour (rest heights, delivery counts).

## Milestones

1. **Renderer swap** — ballpit on `WebGPURenderer`; the existing scene renders
   unchanged. (Verify on screen.)
2. **Particles, no self-collision** — 100k particles, gravity + static box/floor
   collision, instanced from a storage buffer. Proves the compute→render path at
   scale. (They'll overlap — that's expected this step.)
3. **Spatial hash + granular collision** — particles collide with each other.
   The "fluid."
4. **Routing fields** — sinks (readback delivery), conveyors, launchers wired to
   the build data; loft spawn/deliver/drop on the GPU set.
5. **Scale + polish** — 100k→1M tuning, LOD, colour-by-protocol, telemetry.

The CPU `Sim` + worker stays as the reference/fallback for small counts.
