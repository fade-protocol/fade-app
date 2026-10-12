// Win effects: pixel confetti from the torn edge, and the stamp's slam.
import * as THREE from "three";
import type { Frame } from "./paper";
import { STAMP } from "./receiptCanvas";

const TONES = ["#7c5cff", "#7c5cff", "#9a80ff", "#f0eee8", "#f0eee8", "#2a2238"];

type Bit = {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  spin: THREE.Vector3;
  age: number;
  life: number;
  alive: boolean;
};

export class Confetti {
  readonly mesh: THREE.InstancedMesh;
  active = false;
  private readonly bits: Bit[];
  private readonly dummy = new THREE.Object3D();

  constructor(
    scene: THREE.Object3D,
    private readonly count = 120,
  ) {
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.034, 0.034, 0.012),
      new THREE.MeshStandardMaterial({
        roughness: 0.5,
        emissive: "#2a1f55",
        emissiveIntensity: 0.6,
      }),
      count,
    );
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.bits = Array.from({ length: count }, () => ({
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      rot: new THREE.Euler(),
      spin: new THREE.Vector3(),
      age: 0,
      life: 0,
      alive: false,
    }));
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) this.mesh.setColorAt(i, c.set(TONES[i % TONES.length]!));
    this.hideAll();
    scene.add(this.mesh);
  }

  private hideAll(): void {
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < this.count; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** origin + across: world point on the edge and the edge's direction; up/out: launch directions. */
  burst(origin: THREE.Vector3, across: THREE.Vector3, up: THREE.Vector3, out: THREE.Vector3): void {
    const r = Math.random;
    for (const q of this.bits) {
      const k = r() - 0.5;
      q.pos.copy(origin).addScaledVector(across, k * 0.95);
      q.vel
        .copy(up)
        .multiplyScalar(1.3 + r() * 1.9)
        .addScaledVector(out, 0.3 + r() * 1.3)
        .addScaledVector(across, k * 1.6 + (r() - 0.5) * 0.6);
      q.rot.set(r() * 6, r() * 6, r() * 6);
      q.spin.set((r() - 0.5) * 18, (r() - 0.5) * 18, (r() - 0.5) * 18);
      q.age = -r() * 0.18;
      q.life = 1.3 + r() * 0.8;
      q.alive = true;
    }
    this.active = true;
  }

  update(dt: number): void {
    if (!this.active) return;
    let any = false;
    this.bits.forEach((q, i) => {
      if (!q.alive) return;
      q.age += dt;
      if (q.age < 0) {
        this.dummy.scale.setScalar(0);
      } else {
        q.vel.y -= 5.2 * dt;
        q.vel.multiplyScalar(Math.exp(-dt * 0.9));
        q.pos.addScaledVector(q.vel, dt);
        if (q.pos.y < 0.017) {
          q.pos.y = 0.017;
          q.vel.y *= -0.25;
          q.vel.x *= 0.6;
          q.vel.z *= 0.6;
          q.spin.multiplyScalar(0.5);
        }
        q.rot.x += q.spin.x * dt;
        q.rot.y += q.spin.y * dt;
        q.rot.z += q.spin.z * dt;
        const fade = 1 - Math.max(0, (q.age - q.life * 0.6) / (q.life * 0.4));
        this.dummy.position.copy(q.pos);
        this.dummy.rotation.copy(q.rot);
        this.dummy.scale.setScalar(Math.max(0, fade));
        if (q.age > q.life) q.alive = false;
      }
      any ||= q.alive;
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (!any) {
      this.active = false;
      this.hideAll();
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

/** A quad that falls onto the paper, then gets baked into its texture. */
export class StampSlam {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private readonly texture: THREE.CanvasTexture;
  private readonly basis = new THREE.Matrix4();
  private readonly xAxis = new THREE.Vector3(1, 0, 0);
  private t = -1;
  private frame: Frame | null = null;
  private x = 0;
  private duration = 0.16;

  constructor(stampCanvas: HTMLCanvasElement) {
    this.texture = new THREE.CanvasTexture(stampCanvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const h = (STAMP.w * stampCanvas.height) / stampCanvas.width;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(STAMP.w, h),
      new THREE.MeshStandardMaterial({
        map: this.texture,
        transparent: true,
        roughness: 0.55,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
      }),
    );
    this.mesh.castShadow = true;
    this.mesh.renderOrder = 2;
  }

  /** frame: paper frame at the stamp's spot (local to `parent`), x: offset across the paper. */
  start(parent: THREE.Object3D, frame: Frame, x: number, duration = 0.16): void {
    parent.add(this.mesh);
    this.frame = frame;
    this.x = x;
    this.duration = duration;
    this.t = 0;
    this.update(0);
  }

  update(dt: number): boolean {
    if (this.t < 0 || !this.frame) return false;
    this.t += dt;
    const k = Math.min(1, this.t / this.duration);
    const e = k * k * k; // accelerates into the paper
    const { p, t, n } = this.frame;
    this.basis.makeBasis(this.xAxis, t, n);
    this.mesh.quaternion.setFromRotationMatrix(this.basis);
    this.mesh.rotateZ(STAMP.rot);
    this.mesh.position
      .copy(p)
      .addScaledVector(n, 0.004 + (1 - e) * 0.55)
      .addScaledVector(this.xAxis, this.x);
    this.mesh.scale.setScalar(1 + (1 - e) * 1.5);
    this.mesh.material.opacity = Math.min(1, k * 2.2) * 0.95;
    return k >= 1;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.t = -1;
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}
