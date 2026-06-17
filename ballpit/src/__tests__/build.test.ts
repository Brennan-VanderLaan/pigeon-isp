import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Build, FLOOR_H } from '../build';
import type { PartsHost } from '../proto';

// Headless placement tests through the REAL Build class — these pin the ramp
// chaining math so "ramps don't line up" can't regress silently. World rule:
// a part's entry height must equal the previous part's exit height.
const host: PartsHost = { addPart() { /* */ }, removePart() { /* */ }, setConveyors() { /* */ } };
const mk = () => new Build(new THREE.Scene(), host);
const worldY = (p: { level: number; elev?: number }) => p.level * FLOOR_H + (p.elev ?? 0);

describe('Build — ramp chaining', () => {
  it('ascending gentle ramps chain 0→2→4, and the next platform tops out at 6', () => {
    const b = mk(); b.dir = 0; b.grade = 0; // gentle: rise 2/cell
    const r1 = b.placeAt('ramp', 0, 0);
    const r2 = b.placeAt('ramp', 1, 0);
    const r3 = b.placeAt('ramp', 2, 0);
    expect([r1.elev, r2.elev, r3.elev]).toEqual([0, 2, 4]);
    const top = b.placeAt('platform', 3, 0);
    expect(worldY(top)).toBe(6); // exactly one level up
  });

  it('each ramp ENTERS exactly where the previous one EXITS (any direction)', () => {
    const b = mk(); b.dir = 1; b.grade = 1; // medium: rise 3, heading +z
    const r1 = b.placeAt('ramp', 0, 0);
    const r2 = b.placeAt('ramp', 0, 1);
    expect(worldY(r2)).toBe(worldY(r1) + 3);
  });

  it('chains continue across level switches (world-space, not per-level)', () => {
    const b = mk(); b.dir = 0; b.grade = 1; // medium: 0→3, 3→6
    b.placeAt('ramp', 0, 0);
    b.placeAt('ramp', 1, 0);
    b.level = 1; // player bumps the build level mid-slope — must NOT reset
    const p = b.placeAt('platform', 2, 0);
    expect(worldY(p)).toBe(6);
  });

  it('a ramp placed facing a raised platform tucks its top under it (descending)', () => {
    const b = mk();
    b.level = 1;
    const plat = b.placeAt('platform', 5, 0);
    expect(worldY(plat)).toBe(6);
    b.level = 0; b.dir = 0; b.grade = 1; // facing +x toward the platform
    const ramp = b.placeAt('ramp', 4, 0);
    expect(worldY(ramp)).toBe(3);                 // base at 3…
    expect(worldY(ramp) + 3).toBe(worldY(plat));  // …top meets the platform base
  });

  it('a full medium staircase reaches level 2 in four cells', () => {
    const b = mk(); b.dir = 0; b.grade = 1;
    let last = { level: 0, elev: 0 } as { level: number; elev?: number };
    for (let i = 0; i < 4; i++) last = b.placeAt('ramp', i, 0);
    expect(worldY(last) + 3).toBe(12); // exit of the 4th ramp = two levels
  });

  it('Q/E nudge offsets the next placement, then resets', () => {
    const b = mk(); b.dir = 0;
    b.nudgeElev(2);
    const p1 = b.placeAt('platform', 0, 0);
    expect(p1.elev).toBe(2);
    const p2 = b.placeAt('platform', 0, 5); // far away: no chain, nudge consumed
    expect(p2.elev).toBe(0);
  });

  it('snap off (Alt): placements ignore neighbours entirely', () => {
    const b = mk(); b.dir = 0; b.grade = 1;
    b.placeAt('ramp', 0, 0); // exit 3
    b.snap = false;
    const p = b.placeAt('platform', 1, 0); // would chain to 3 — must NOT
    expect(p.elev).toBe(0);
  });
});

describe('Build — walls', () => {
  it('walls do not snap to neighbours and do not act as snap sources', () => {
    const b = mk(); b.dir = 0; b.grade = 1;
    b.placeAt('ramp', 0, 0);                 // exit 3
    const w = b.placeAt('wall', 1, 0);       // next to the ramp
    expect(w.elev).toBe(0);                  // wall ignores the chain
    const p = b.placeAt('platform', 2, 0);   // behind cell holds the wall
    expect(p.elev).toBe(0);                  // wall is not a chain source
  });

  it('walls stack by level into a building face (full level height)', () => {
    const b = mk(); b.dir = 0;
    const w0 = b.placeAt('wall', 0, 0);
    b.level = 1;
    const w1 = b.placeAt('wall', 0, 0); // same cell, next level — distinct part
    expect(worldY(w0)).toBe(0);
    expect(worldY(w1)).toBe(FLOOR_H);   // starts exactly where the lower one ends
    expect(b.getPart(0, 0, 0)).toBeDefined();
    expect(b.getPart(0, 0, 1)).toBeDefined();
  });
});

describe('Build — heightAt (vehicle ground)', () => {
  it('flat floor is 0; a deck is reachable only from near its own height', () => {
    const b = mk(); b.level = 1;
    b.placeAt('platform', 0, 0);
    expect(b.heightAt(0, 0, 6)).toBeCloseTo(6.15, 2);
    expect(b.heightAt(0, 0, 0)).toBe(0); // can't climb a full level
    expect(b.heightAt(40, 40, 0)).toBe(0);
  });

  it('ramps interpolate smoothly along their slope (drivable)', () => {
    const b = mk(); b.dir = 0; b.grade = 1; // medium: 0→3 over the cell
    b.placeAt('ramp', 0, 0);                // spans x ∈ [-2, 2]
    expect(b.heightAt(-1.9, 0, 0)).toBeCloseTo(0.23, 1);
    expect(b.heightAt(0, 0, 1.5)).toBeCloseTo(1.65, 1);
    expect(b.heightAt(1.9, 0, 3)).toBeCloseTo(3.08, 1);
  });
});
