import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';

// The render side on WebGPU. Same three.js scene (build parts, lights, balls);
// the renderer is WebGPURenderer so the GPU particle compute (next milestones)
// shares one device with rendering — no CPU round-trip. Construction is async
// (device init), so use `await Scene.create(host)`.
export class Scene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  renderer!: WebGPURenderer;

  private constructor() {
    this.scene.background = new THREE.Color(0x0b0f15);
    this.scene.fog = new THREE.Fog(0x0b0f15, 70, 160);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    this.camera.position.set(0, 32, 32); // a starting three-quarter view

    const hemi = new THREE.HemisphereLight(0xbcd2ff, 0x202838, 0.9);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.1);
    sun.position.set(20, 40, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 40;
    sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
    sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
    sun.shadow.camera.far = 120;
    this.scene.add(sun);
  }

  static async create(host: HTMLElement): Promise<Scene> {
    const v = new Scene();
    const renderer = new WebGPURenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    await renderer.init(); // acquire the WebGPU device/adapter
    host.appendChild(renderer.domElement);
    v.renderer = renderer;
    v.resize();
    window.addEventListener('resize', () => v.resize());
    return v;
  }

  private resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
