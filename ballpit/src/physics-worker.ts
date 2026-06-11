/// <reference lib="webworker" />
import { FLOATS_PER_BALL, type ToWorker, type FromWorker } from './proto';
import { Sim } from './sim';

// Thin worker around the Sim core: receive build/spawn messages, step the sim,
// write transforms into the shared buffer, report deliveries/losses.
//
// CRITICAL: Sim creation is async (Rapier wasm). Messages that arrive before
// the world exists are QUEUED and replayed once ready — otherwise the floor and
// walls (sent immediately by Arena/Build at startup) would be silently lost and
// every ball would phase through the world.
let sim: Sim | null = null;
let transforms: Float32Array;
let meta: Int32Array;
const queue: ToWorker[] = [];
let pendingSpawned: { frameId: number; slot: number; color: number }[] = [];

const post = (m: FromWorker) => (self as DedicatedWorkerGlobalScope).postMessage(m);

function handle(m: ToWorker): void {
  if (!sim) return;
  switch (m.t) {
    case 'part': sim.addPart(m.id, m.colliders, m.sinkPort); break;
    case 'unpart': sim.removePart(m.id); break;
    case 'conveyors': sim.setConveyors(m.cells); break;
    case 'spawn': {
      const slot = sim.spawn(m.frameId, m.x, m.y, m.z, m.vx, m.vy, m.vz, m.radius, performance.now());
      if (slot < 0) post({ t: 'gone', delivered: [], dropped: [m.frameId] });
      else pendingSpawned.push({ frameId: m.frameId, slot, color: m.color });
      break;
    }
    case 'init': break;
  }
}

function step(): void {
  if (!sim) return;
  const t0 = performance.now();
  const { delivered, dropped } = sim.step(t0);

  let awake = 0;
  sim.forEach((_frameId, slot, body) => {
    const t = body.translation(), r = body.rotation();
    const o = slot * FLOATS_PER_BALL;
    transforms[o] = t.x; transforms[o + 1] = t.y; transforms[o + 2] = t.z;
    transforms[o + 3] = r.x; transforms[o + 4] = r.y; transforms[o + 5] = r.z; transforms[o + 6] = r.w;
    transforms[o + 7] = 1;
    if (!body.isSleeping()) awake++;
  });

  if (pendingSpawned.length) { post({ t: 'spawned', items: pendingSpawned }); pendingSpawned = []; }
  if (delivered.length || dropped.length) post({ t: 'gone', delivered, dropped });

  const elapsed = performance.now() - t0;
  Atomics.store(meta, 0, sim.balls.size);
  Atomics.store(meta, 1, awake);
  Atomics.add(meta, 2, 1);
  Atomics.store(meta, 3, Math.round(elapsed * 1000));
  setTimeout(step, Math.max(0, 16 - elapsed));
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.t === 'init') {
    transforms = new Float32Array(m.transforms);
    meta = new Int32Array(m.meta);
    Sim.create({ cell: m.cell, floorH: m.floorH, maxBalls: m.maxBalls }).then((s) => {
      sim = s;
      for (const q of queue) handle(q); // replay everything that arrived early
      queue.length = 0;
      post({ t: 'ready' });
      step();
    });
    return;
  }
  if (!sim) { queue.push(m); return; } // not ready yet — buffer it
  handle(m);
};
