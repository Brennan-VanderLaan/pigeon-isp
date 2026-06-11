import * as THREE from 'three';
import { Physics } from './physics';

// The static play space: floor + perimeter walls. Host I/O (spawners, sinks)
// and machinery are placeable parts now (see build.ts), not baked in here.
const FLOOR = 30; // half-extent of the play floor
const WALL_H = 2.4;

// A distinct hue per port so its dock, sink and balls read at a glance.
export function portColor(id: number): number {
  const hue = (id * 0.61803398875) % 1; // golden-ratio hashing → spread hues
  return new THREE.Color().setHSL(hue, 0.62, 0.55).getHex();
}

export class Arena {
  constructor(scene: THREE.Scene, physics: Physics) {
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x161d28, roughness: 0.95 });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(FLOOR * 2, 1, FLOOR * 2), floorMat);
    floor.position.y = -0.5;
    floor.receiveShadow = true;
    scene.add(floor);
    physics.addFixedCuboid(FLOOR, 0.5, FLOOR, 0, -0.5, 0);

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
      physics.addFixedCuboid(hx, hy, hz, x, y, z);
    }

    const grid = new THREE.GridHelper(FLOOR * 2, 24, 0x2c3848, 0x1d2632);
    grid.position.y = 0.01;
    scene.add(grid);
  }
}
