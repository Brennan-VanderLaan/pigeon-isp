import * as THREE from 'three';

// The render side: scene, lights, renderer, and a perspective camera. The
// camera is driven by OrbitControls in main.ts (orbit / zoom / pan) — no fixed
// view, no magic.
export class Scene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  constructor(host: HTMLElement) {
    this.scene.background = new THREE.Color(0x0b0f15);
    this.scene.fog = new THREE.Fog(0x0b0f15, 70, 140);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

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

    this.resize();
    window.addEventListener('resize', () => this.resize());
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
