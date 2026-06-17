import * as THREE from 'three';
import type { PartsHost } from './proto';
import type { ColliderSpec } from './proto';

// The static play space: floor + perimeter walls. Meshes live here; the matching
// colliders are sent to the physics worker as one 'arena' part. Host I/O and
// machinery are placeable parts (see build.ts).
const FLOOR = 30; // half-extent of the play floor
const WALL_H = 2.4;

// A distinct hue per port so its dock, sink and balls read at a glance.
export function portColor(id: number): number {
  const hue = (id * 0.61803398875) % 1; // golden-ratio hashing → spread hues
  return new THREE.Color().setHSL(hue, 0.62, 0.55).getHex();
}

export class Arena {
  constructor(scene: THREE.Scene, physics: PartsHost) {
    const colliders: ColliderSpec[] = [];

    const floorMat = new THREE.MeshStandardMaterial({ color: 0x161d28, roughness: 0.95 });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(FLOOR * 2, 1, FLOOR * 2), floorMat);
    floor.position.y = -0.5;
    floor.receiveShadow = true;
    scene.add(floor);
    colliders.push({ hx: FLOOR, hy: 0.5, hz: FLOOR, x: 0, y: -0.5, z: 0 });

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x222c3c, roughness: 0.9, transparent: true, opacity: 0.5 });
    const walls: [number, number, number, number, number, number][] = [
      [FLOOR, WALL_H / 2, 0.3, 0, WALL_H / 2, FLOOR],
      [FLOOR, WALL_H / 2, 0.3, 0, WALL_H / 2, -FLOOR],
      [0.3, WALL_H / 2, FLOOR, FLOOR, WALL_H / 2, 0],
      [0.3, WALL_H / 2, FLOOR, -FLOOR, WALL_H / 2, 0],
    ];
    for (const [hx, hy, hz, x, y, z] of walls) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), wallMat);
      m.position.set(x, y, z);
      scene.add(m);
      colliders.push({ hx, hy, hz, x, y, z });
    }

    const grid = new THREE.GridHelper(FLOOR * 2, 24, 0x2c3848, 0x1d2632);
    grid.position.y = 0.01;
    scene.add(grid);

    physics.addPart('arena', colliders);
  }
}
