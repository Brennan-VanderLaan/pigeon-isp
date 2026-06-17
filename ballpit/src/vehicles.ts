import * as THREE from 'three';

// Vehicles — the Rokenbok dexterity layer. First in: the STREET SWEEPER.
// Vacuums fluid through a suction intake up front into a dump bed; Space tips
// the bed and pours everything back out behind it. The packets it carries are
// REAL loft frames — their TTL keeps ticking in the hopper, so a sweeper that
// dawdles drops traffic.
//
// Motion is kinematic arcade driving on the CPU (WASD); the build grid's
// heightAt() makes it ride platforms and drive up ramps. The GPU fluid sees the
// hull as a MOVING boundary (nodes inside take the vehicle's velocity, so it
// pushes fluid like a blade) and the intake as a suction volume.
export interface DriveInput { forward: number; turn: number }
export interface HopperItem { frameId: number; color: number; spawnMs: number }
export interface VehicleBox { c: THREE.Vector3; h: THREE.Vector3; q: THREE.Quaternion; vel: THREE.Vector3 }

const ACCEL = 16, MAX_SPEED = 9, FRICTION = 8, TURN_RATE = 2.2;
export const HOPPER_CAP = 200;

export class Sweeper {
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3(6, 0, -12);
  heading = Math.PI; // facing -x, toward the middle
  speed = 0;
  readonly vel = new THREE.Vector3();
  hopper: HopperItem[] = [];

  private bed: THREE.Group;
  private load: THREE.Mesh;
  private wheels: THREE.Mesh[] = [];
  private brush: THREE.Mesh;
  private dumpAnim = 0;
  private pitch = 0;

  constructor(scene: THREE.Scene) {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 1.0, 1.9),
      new THREE.MeshStandardMaterial({ color: 0xffb347, roughness: 0.55 }),
    );
    body.position.y = 0.95;
    this.group.add(body);

    const cab = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.85, 1.7),
      new THREE.MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.4 }),
    );
    cab.position.set(0.7, 1.85, 0);
    this.group.add(cab);

    // suction intake: an angled scoop at the front
    const intake = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.7, 1.9),
      new THREE.MeshStandardMaterial({ color: 0x95a5a6, roughness: 0.6, metalness: 0.3 }),
    );
    intake.position.set(1.8, 0.55, 0);
    intake.rotation.z = -0.35;
    this.group.add(intake);

    this.brush = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.32, 1.7, 10),
      new THREE.MeshStandardMaterial({ color: 0xe74c3c, roughness: 0.9 }),
    );
    this.brush.rotation.x = Math.PI / 2;
    this.brush.position.set(2.35, 0.32, 0);
    this.group.add(this.brush);

    // the dump bed at the rear — tips backward on dump; the load mesh inside
    // grows with the hopper fill so you can SEE how full you are
    this.bed = new THREE.Group();
    const bedShell = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 1.1, 1.8),
      new THREE.MeshStandardMaterial({ color: 0x7f8c8d, roughness: 0.7 }),
    );
    bedShell.position.y = 0.55;
    this.bed.add(bedShell);
    this.load = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.0, 1.6),
      new THREE.MeshStandardMaterial({ color: 0x53d8e8, roughness: 0.4, emissive: 0x53d8e8, emissiveIntensity: 0.25 }),
    );
    this.load.position.y = 0.1;
    this.load.scale.y = 0.001;
    this.bed.add(this.load);
    this.bed.position.set(-1.1, 1.45, 0);
    this.group.add(this.bed);

    const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 12);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1b222d, roughness: 0.9 });
    for (const [wx, wz] of [[0.95, 1.0], [0.95, -1.0], [-0.95, 1.0], [-0.95, -1.0]] as const) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(wx, 0.42, wz);
      this.group.add(wheel);
      this.wheels.push(wheel);
    }
    scene.add(this.group);
  }

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(Math.cos(this.heading), 0, Math.sin(this.heading));
  }

  update(dt: number, input: DriveInput, ground: (x: number, z: number, refY: number) => number): void {
    // arcade drive: throttle + tank-ish steering
    this.speed += input.forward * ACCEL * dt;
    this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), FRICTION * dt * (input.forward === 0 ? 1 : 0.15));
    this.speed = Math.max(-MAX_SPEED * 0.5, Math.min(MAX_SPEED, this.speed));
    this.heading += input.turn * TURN_RATE * dt * (this.speed < -0.2 ? -1 : 1);

    const f = this.forward;
    this.vel.copy(f).multiplyScalar(this.speed);
    this.pos.addScaledVector(this.vel, dt);
    this.pos.x = Math.max(-28.5, Math.min(28.5, this.pos.x));
    this.pos.z = Math.max(-28.5, Math.min(28.5, this.pos.z));

    // ride the terrain (platforms, ramps); fall when there's nothing under you
    const g = ground(this.pos.x, this.pos.z, this.pos.y);
    this.pos.y += (g - this.pos.y) * Math.min(1, dt * (g > this.pos.y ? 14 : 7));

    // pitch with the slope under the wheelbase
    const ahead = ground(this.pos.x + f.x * 1.2, this.pos.z + f.z * 1.2, this.pos.y);
    const behind = ground(this.pos.x - f.x * 1.2, this.pos.z - f.z * 1.2, this.pos.y);
    this.pitch += (Math.atan2(ahead - behind, 2.4) - this.pitch) * Math.min(1, dt * 8);

    this.group.position.copy(this.pos);
    this.group.quaternion
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), -this.heading)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.pitch));

    for (const w of this.wheels) w.rotation.y -= (this.speed * dt) / 0.42;
    this.brush.rotation.y -= dt * (4 + Math.abs(this.speed));

    this.dumpAnim = Math.max(0, this.dumpAnim - dt * 1.6);
    this.bed.rotation.z = this.dumpAnim * 0.8; // rear tips down while dumping
    const fill = this.hopper.length / HOPPER_CAP;
    this.load.scale.y = Math.max(0.001, fill);
    this.load.position.y = 0.1 + fill * 0.45;
  }

  /** Hull + intake as moving GPU boundaries (they push fluid). */
  hullBoxes(): VehicleBox[] {
    const f = this.forward;
    const up = new THREE.Vector3(0, 1, 0);
    const c1 = this.pos.clone().addScaledVector(up, 0.95);
    const c2 = this.pos.clone().addScaledVector(f, 1.9).addScaledVector(up, 0.5);
    return [
      { c: c1, h: new THREE.Vector3(1.5, 0.8, 1.0), q: this.group.quaternion.clone(), vel: this.vel.clone() },
      { c: c2, h: new THREE.Vector3(0.6, 0.5, 1.0), q: this.group.quaternion.clone(), vel: this.vel.clone() },
    ];
  }

  /** The vacuum volume in front of the intake — null when the bed is full
   *  (suction chokes; dump to keep sweeping). */
  suctionZone(): { c: THREE.Vector3; h: THREE.Vector3 } | null {
    if (this.hopper.length >= HOPPER_CAP) return null;
    const c = this.pos.clone().addScaledVector(this.forward, 2.6).add(new THREE.Vector3(0, 0.7, 0));
    return { c, h: new THREE.Vector3(1.3, 0.9, 1.3) };
  }

  /** Tip the bed: hand back everything carried (caller re-spawns it as fluid). */
  dump(): HopperItem[] {
    const out = this.hopper;
    this.hopper = [];
    if (out.length) this.dumpAnim = 1;
    return out;
  }

  dumpPos(): THREE.Vector3 {
    return this.pos.clone().addScaledVector(this.forward, -2.4).add(new THREE.Vector3(0, 2.2, 0));
  }
}
