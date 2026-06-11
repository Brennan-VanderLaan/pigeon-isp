import { describe, it, expect, beforeAll } from 'vitest';
import { Sim } from '../sim';

// Headless physics validation — runs the real Rapier sim in Node, no browser.
// These are the assertions that would have caught "balls phase through solids".
const CELL = 4, FLOOR_H = 6;
const newSim = () => new Sim({ cell: CELL, floorH: FLOOR_H, maxBalls: 1000 });

// Drive the sim for `ticks` 60Hz steps starting at t=0, collecting results.
function run(sim: Sim, ticks: number): { delivered: [number, number][]; dropped: number[] } {
  const delivered: [number, number][] = [];
  const dropped: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const r = sim.step(i * 16.67);
    delivered.push(...r.delivered);
    dropped.push(...r.dropped);
  }
  return { delivered, dropped };
}

beforeAll(async () => {
  // one-time wasm init (Sim.create does this; do it once for the suite)
  await Sim.create({ cell: CELL, floorH: FLOOR_H, maxBalls: 1 });
});

describe('Sim — solids are solid', () => {
  it('a ball rests ON a floor, does not phase through', () => {
    const sim = newSim();
    // floor: top surface at y=0 (matches arena)
    sim.addPart('floor', [{ hx: 10, hy: 0.5, hz: 10, x: 0, y: -0.5, z: 0 }]);
    sim.spawn(1, 0, 6, 0, 0, 0, 0, 0.35, 0);
    run(sim, 180); // 3s
    const p = sim.ballPos(1);
    expect(p).not.toBeNull();
    // rests near radius above the floor top, never below it
    expect(p!.y).toBeGreaterThan(0.2);
    expect(p!.y).toBeLessThan(1.0);
  });

  it('without a floor, the ball falls out and is dropped (TTL/OOB)', () => {
    const sim = newSim();
    sim.spawn(2, 0, 6, 0, 0, 0, 0, 0.35, 0);
    const { dropped } = run(sim, 120);
    expect(dropped).toContain(2);
    expect(sim.ballPos(2)).toBeNull();
  });

  it('a wall stops horizontal motion', () => {
    const sim = newSim();
    sim.addPart('floor', [{ hx: 20, hy: 0.5, hz: 20, x: 0, y: -0.5, z: 0 }]);
    sim.addPart('wall', [{ hx: 0.3, hy: 2, hz: 20, x: 5, y: 2, z: 0 }]);
    sim.spawn(3, 0, 0.5, 0, 20, 0, 0, 0.35, 0); // fired hard toward +x
    run(sim, 120);
    const p = sim.ballPos(3)!;
    expect(p.x).toBeLessThan(5); // never tunnels past the wall plane
  });
});

describe('Sim — sinks deliver', () => {
  it('a ball entering a sink sensor delivers to its port', () => {
    const sim = newSim();
    sim.addPart('floor', [{ hx: 10, hy: 0.5, hz: 10, x: 0, y: -0.5, z: 0 }]);
    // a sink sensor for port 42, sitting on the floor
    sim.addPart('sink', [{ hx: 1.5, hy: 1, hz: 1.5, x: 0, y: 1, z: 0, sensor: true }], 42);
    sim.spawn(7, 0, 5, 0, 0, 0, 0, 0.35, 0);
    const { delivered } = run(sim, 180);
    expect(delivered.some(([f, port]) => f === 7 && port === 42)).toBe(true);
    expect(sim.ballPos(7)).toBeNull(); // consumed
  });
});

describe('Sim — conveyors push (physically)', () => {
  it('a conveyor drives a resting ball along its direction', () => {
    const sim = newSim();
    // a platform deck at cell (0,0), top at y=0
    sim.addPart('deck', [{ hx: CELL * 0.5, hy: 0.15, hz: CELL * 0.5, x: 0, y: 0, z: 0 }]);
    sim.addPart('deck1', [{ hx: CELL * 0.5, hy: 0.15, hz: CELL * 0.5, x: CELL, y: 0, z: 0 }]);
    sim.addPart('deck2', [{ hx: CELL * 0.5, hy: 0.15, hz: CELL * 0.5, x: 2 * CELL, y: 0, z: 0 }]);
    sim.setConveyors([
      { cx: 0, cz: 0, level: 0, dx: 1, dz: 0, speed: 7 },
      { cx: 1, cz: 0, level: 0, dx: 1, dz: 0, speed: 7 },
      { cx: 2, cz: 0, level: 0, dx: 1, dz: 0, speed: 7 },
    ]);
    sim.spawn(9, 0, 0.4, 0, 0, 0, 0, 0.35, 0); // rest it on the belt
    run(sim, 120);
    const p = sim.ballPos(9)!;
    expect(p.x).toBeGreaterThan(2); // carried in +x, not sitting still
  });
});

describe('Sim — capacity', () => {
  it('spawning past capacity returns -1 (caller drops the frame)', () => {
    const sim = new Sim({ cell: CELL, floorH: FLOOR_H, maxBalls: 2 });
    expect(sim.spawn(1, 0, 5, 0, 0, 0, 0, 0.35, 0)).toBeGreaterThanOrEqual(0);
    expect(sim.spawn(2, 0, 5, 0, 0, 0, 0, 0.35, 0)).toBeGreaterThanOrEqual(0);
    expect(sim.spawn(3, 0, 5, 0, 0, 0, 0, 0.35, 0)).toBe(-1);
  });
});
