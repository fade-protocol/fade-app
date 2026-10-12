// The strip coming out of the slot: a segmented plane rebuilt every frame along
// a bending centre line. s = arc length from the slot (negative inside the
// printer); the receipt point at s is y = L - s.
import * as THREE from "three";
import { MAX_LEN, PAPER_W, type ReceiptCanvas } from "./receiptCanvas";

const COLS = 10;
const SEG = 120;
export const HIDDEN = 0.12;
/** Leans back a little out of the slot. */
const THETA0 = 0.1;
const CUP = 0.035;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function paperMaterial(
  texture: THREE.Texture,
  { transparent = false } = {},
): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    map: texture,
    roughness: 0.58,
    clearcoat: 0.22,
    clearcoatRoughness: 0.42,
    side: THREE.DoubleSide,
    alphaTest: 0.5,
    transparent,
  });
  // the back of the paper is plain, slightly darker stock
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      "#include <map_fragment>",
      "#include <map_fragment>\n\tif ( !gl_FrontFacing ) diffuseColor.rgb = vec3( 0.74, 0.72, 0.69 );",
    );
  };
  return m;
}

export type Frame = { p: THREE.Vector3; t: THREE.Vector3; n: THREE.Vector3 };

export class PaperStrip {
  /** Length out of the slot, world units. */
  L = 0;
  wob = 0;
  lift = 0;
  /** How much the strip sways: eased to 0 when the scene comes to rest. */
  swayAmp = 1;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.MeshPhysicalMaterial;
  readonly mesh: THREE.Mesh;
  private readonly depth: THREE.MeshDepthMaterial;
  private readonly pos: Float32Array;
  private readonly uv: Float32Array;
  private readonly cy = new Float32Array(SEG + 1);
  private readonly cz = new Float32Array(SEG + 1);
  private readonly th = new Float32Array(SEG + 1);
  private sMin = -HIDDEN;
  private ds = HIDDEN / SEG;

  constructor(readonly receipt: ReceiptCanvas) {
    const nV = (COLS + 1) * (SEG + 1);
    this.pos = new Float32Array(nV * 3);
    this.uv = new Float32Array(nV * 2);
    const idx: number[] = [];
    for (let j = 0; j < SEG; j++)
      for (let i = 0; i < COLS; i++) {
        const a = j * (COLS + 1) + i;
        const b = a + 1;
        const c = a + COLS + 1;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    const geo = new THREE.BufferGeometry();
    geo.setIndex(idx);
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setAttribute("uv", new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    this.geometry = geo;
    this.material = paperMaterial(receipt.texture);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.depth = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: receipt.texture,
      alphaTest: 0.5,
    });
    this.mesh.customDepthMaterial = this.depth;
  }

  kick(a = 1): void {
    this.wob += 0.035 * a;
  }

  /** Whether the strip is still visibly settling. */
  get moving(): boolean {
    return this.wob > 2e-4;
  }

  update(dt: number, t: number): void {
    this.wob *= Math.exp(-dt * 9);
    const L = this.L + this.lift;
    const sMin = -HIDDEN;
    const ds = (L + HIDDEN) / SEG;
    this.sMin = sMin;
    this.ds = ds;
    const droop = smooth(0.25, 1.25, L);
    const sway = this.swayAmp * (0.018 * Math.sin(t * 0.9) + 0.01 * Math.sin(t * 2.3));
    const wob = this.wob * Math.sin(t * 46);
    let y = Math.cos(THETA0) * sMin;
    let z = -Math.sin(THETA0) * sMin;
    let prev = THETA0;
    for (let j = 0; j <= SEG; j++) {
      const s = sMin + j * ds;
      const sp = Math.max(0, s);
      const th =
        s <= 0 ? THETA0 : THETA0 + droop * (0.22 * sp + 0.42 * sp * sp) + (wob + sway) * sp;
      if (j > 0) {
        const mid = (prev + th) / 2;
        y += Math.cos(mid) * ds;
        z -= Math.sin(mid) * ds;
      }
      prev = th;
      this.cy[j] = y;
      this.cz[j] = z;
      this.th[j] = th;
      const ny = Math.sin(th);
      const nz = Math.cos(th);
      const cupK = smooth(0, 0.3, s);
      const v = 1 - (this.L - s) / MAX_LEN;
      for (let i = 0; i <= COLS; i++) {
        const u = i / COLS;
        const k = (j * (COLS + 1) + i) * 3;
        const e = (2 * u - 1) ** 2;
        const off = -CUP * e * cupK;
        this.pos[k] = (u - 0.5) * PAPER_W;
        this.pos[k + 1] = y + ny * off;
        this.pos[k + 2] = z + nz * off;
        const q = (j * (COLS + 1) + i) * 2;
        this.uv[q] = u;
        this.uv[q + 1] = v;
      }
    }
    this.geometry.attributes.position!.needsUpdate = true;
    this.geometry.attributes.uv!.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  /** Point, tangent and face normal at arc length s, in the paper's local space. */
  frameAt(s: number): Frame {
    const f = Math.min(SEG, Math.max(0, (s - this.sMin) / this.ds));
    const j = Math.min(SEG - 1, Math.floor(f));
    const a = f - j;
    const y = this.cy[j]! * (1 - a) + this.cy[j + 1]! * a;
    const z = this.cz[j]! * (1 - a) + this.cz[j + 1]! * a;
    const th = this.th[j]! * (1 - a) + this.th[j + 1]! * a;
    return {
      p: new THREE.Vector3(0, y, z),
      t: new THREE.Vector3(0, Math.cos(th), -Math.sin(th)),
      n: new THREE.Vector3(0, Math.sin(th), Math.cos(th)),
    };
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.depth.dispose();
  }
}
