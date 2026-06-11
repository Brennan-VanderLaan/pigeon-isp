import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { Physics } from './physics';

export interface PortView {
  id: number;
  label: string; // pod name
}

const FLOOR = 30; // half-extent of the play floor
const WALL_H = 2.4;

// A distinct hue per port so its bin and nozzle read at a glance.
export function portColor(id: number): number {
  const hue = (id * 0.61803398875) % 1; // golden-ratio hashing → spread hues
  return new THREE.Color().setHSL(hue, 0.62, 0.55).getHex();
}

export class Arena {
  /** where each port's balls drop in */
  private nozzles = new Map<number, THREE.Vector3>();
  private portGroup = new THREE.Group();
  private portBodies: RAPIER.RigidBody[] = [];

  constructor(private scene: THREE.Scene, private physics: Physics) {
    this.scene.add(this.portGroup);
    this.buildFloor();
  }

  private buildFloor(): void {
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x161d28, roughness: 0.95 });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(FLOOR * 2, 1, FLOOR * 2), floorMat);
    floor.position.y = -0.5;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.physics.addFixedCuboid(FLOOR, 0.5, FLOOR, 0, -0.5, 0);

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
      this.scene.add(m);
      this.physics.addFixedCuboid(hx, hy, hz, x, y, z);
    }

    const grid = new THREE.GridHelper(FLOOR * 2, 24, 0x2c3848, 0x1d2632);
    grid.position.y = 0.01;
    this.scene.add(grid);
  }

  nozzleFor(id: number): THREE.Vector3 | undefined {
    return this.nozzles.get(id);
  }

  /** (Re)lay out one nozzle + one catch bin per port around the rim. */
  setPorts(ports: PortView[]): void {
    // tear down the previous layout
    for (const b of this.portBodies) this.physics.world.removeRigidBody(b);
    this.portBodies = [];
    this.physics.binByCollider.clear();
    this.scene.remove(this.portGroup);
    this.portGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    this.portGroup = new THREE.Group();
    this.scene.add(this.portGroup);
    this.nozzles.clear();

    const n = Math.max(ports.length, 1);
    ports.forEach((p, i) => {
      const angle = (i / n) * Math.PI * 2;
      const color = portColor(p.id);
      const nozzleR = FLOOR - 3;
      const binR = FLOOR - 9;
      const nx = Math.cos(angle) * nozzleR, nz = Math.sin(angle) * nozzleR;
      const bx = Math.cos(angle) * binR, bz = Math.sin(angle) * binR;
      this.nozzles.set(p.id, new THREE.Vector3(nx, 9, nz));
      this.buildNozzle(nx, nz, color);
      this.buildBin(p.id, bx, bz, color, p.label);
    });
  }

  private buildNozzle(x: number, z: number, color: number): void {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3, emissive: color, emissiveIntensity: 0.15 });
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 1.6, 16, 1, true), mat);
    tube.position.set(x, 9, z);
    this.portGroup.add(tube);
  }

  private buildBin(portId: number, x: number, z: number, color: number, label: string): void {
    const half = 2.2, h = 1.6, t = 0.18;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, emissive: color, emissiveIntensity: 0.25 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(half * 2, 0.2, half * 2), mat);
    base.position.set(x, 0.1, z);
    base.receiveShadow = true;
    this.portGroup.add(base);

    // four short walls so balls settle in, each a mesh + a fixed collider
    const sideMat = new THREE.MeshStandardMaterial({ color, roughness: 0.7, transparent: true, opacity: 0.55 });
    const sides: [number, number, number, number, number, number][] = [
      [half, h / 2, t, x, h / 2, z + half],
      [half, h / 2, t, x, h / 2, z - half],
      [t, h / 2, half, x + half, h / 2, z],
      [t, h / 2, half, x - half, h / 2, z],
    ];
    for (const [hx, hy, hz, sx, sy, sz] of sides) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), sideMat);
      wall.position.set(sx, sy, sz);
      this.portGroup.add(wall);
      const col = this.physics.addFixedCuboid(hx, hy, hz, sx, sy, sz);
      this.portBodies.push(col.parent()!);
    }

    // a sensor volume just above the base — entering it = delivered to this port
    const sensor = this.physics.addFixedCuboid(half - 0.25, h * 0.6, half - 0.25, x, h * 0.6, z, true);
    this.physics.binByCollider.set(sensor.handle, portId);
    this.portBodies.push(sensor.parent()!);

    void label; // (3D text labels come with the HUD legend for now)
  }
}
