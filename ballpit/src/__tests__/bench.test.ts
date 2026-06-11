import { describe, it, expect, beforeAll } from 'vitest';
import { Sim } from '../sim';

// A headless throughput probe — NOT a pass/fail gate (Node ≠ the browser worker,
// and there's no SIMD here), but it lets us compare optimizations apples to
// apples and see the step-time curve as the pit fills. Logs ms/step at a few
// ball counts.
const CELL = 4, FLOOR_H = 6;

beforeAll(async () => { await Sim.create({ cell: CELL, floorH: FLOOR_H, maxBalls: 1 }); });

function fill(sim: Sim, n: number, t0: number): void {
  // rain balls into a 20x20 area so they pile, not stack in one column
  for (let i = 0; i < n; i++) {
    const x = (i % 40) - 20, z = (Math.floor(i / 40) % 40) - 20;
    sim.spawn(i, x * 0.5, 5 + (i % 7), z * 0.5, 0, 0, 0, 0.35, t0);
  }
}

function bench(n: number): { settleMs: number; stepMs: number; awake: number } {
  const sim = new Sim({ cell: CELL, floorH: FLOOR_H, maxBalls: n + 10 });
  sim.addPart('floor', [{ hx: 40, hy: 0.5, hz: 40, x: 0, y: -0.5, z: 0 }]);
  fill(sim, n, 0);
  // let them settle (steady-state is what matters for a big pit)
  let t = performance.now();
  for (let i = 0; i < 300; i++) sim.step(i * 16.67);
  const settleMs = (performance.now() - t) / 300;
  // measure steady-state step time once settled
  t = performance.now();
  for (let i = 300; i < 360; i++) sim.step(i * 16.67);
  const stepMs = (performance.now() - t) / 60;
  return { settleMs, stepMs, awake: sim.awakeCount() };
}

describe('Sim — throughput probe', () => {
  it('reports ms/step as the pit fills', () => {
    const counts = [1000, 3000, 5000, 10000];
    const rows = counts.map((n) => {
      const r = bench(n);
      return `  ${String(n).padStart(6)} balls : settle ${r.settleMs.toFixed(2)} ms/step · steady ${r.stepMs.toFixed(2)} ms/step · ${r.awake} awake`;
    });
    // eslint-disable-next-line no-console
    console.log('\n[ballpit bench] single-thread Rapier (rapier3d-compat, Node):\n' + rows.join('\n') + '\n');
    expect(rows.length).toBe(counts.length);
  }, 60_000);
});
