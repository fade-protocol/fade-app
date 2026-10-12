// The Booster demo's pack in 3D: the Blender-modelled pouch (public/pack3d/pack.glb) with Fade's print,
// four of the series' cards fanned out behind it, and the card it gives. Loaded on demand
// (this module and three.js are their own chunk); the React wrapper (components/Pack3D.tsx) feeds
// it the game's state through sync().
//
// While the wallet and the network are waited on, the pack breathes; while the oracle draws, it
// shakes. The reveal runs on the result's clock (view.resultAt): the fan folds away, the top seal
// tears off, the card rises out of the pouch, the pouch drops, the card turns over. A scene created
// late lands on the same frame, and a finished reveal is never replayed.
//
// Frames are drawn only while something moves, plus a few seconds of float that eases to rest;
// nothing at all while paused. The renderer, light rig and environment are the 3D receipt's.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  CARD_H,
  CARD_W,
  H,
  SEAL_BOT,
  SEAL_TOP,
  cardBack,
  cardFace,
  packNormals,
  packPrint,
} from "./textures";
import { CARDS } from "./tiers";
import { REVEAL_MS, type PackOptions, type PackScene, type PackView } from "./types";

/** The world box the camera keeps in view: the pouch and its fan of cards. */
const BOX = { w: 2.5, h: 1.75, cy: 0.02 };
const HOLD_MS = 2500;
const SETTLE_MS = 2500;
/** Where the card waits inside the pouch: the middle of its body. */
const CARD_IN = (-H / 2 + SEAL_BOT + H / 2 - SEAL_TOP) / 2;
/** The fan: card, x, depth, roll. */
const FAN: [number, number, number, number][] = [
  [0, -0.86, -0.3, 0.3],
  [1, -0.52, -0.2, 0.16],
  [2, 0.52, -0.2, -0.16],
  [3, 0.86, -0.3, -0.3],
];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (k: number) => 1 - Math.pow(1 - clamp01(k), 3);
const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

async function fontsReady(): Promise<void> {
  await Promise.race([
    Promise.all([
      document.fonts.load("700 64px Poppins"),
      document.fonts.load("800 150px Poppins"),
      document.fonts.load('500 30px "Roboto Mono"'),
      document.fonts.load('700 40px "Roboto Mono"'),
    ]),
    new Promise((r) => setTimeout(r, 2500)),
  ]);
}

type Card = {
  group: THREE.Group;
  front: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>;
  back: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>;
};

export async function createPackScene(
  canvas: HTMLCanvasElement,
  opts: PackOptions,
): Promise<PackScene> {
  const [gltf] = await Promise.all([new GLTFLoader().parseAsync(opts.glb, ""), fontsReady()]);

  // ------------------------------------------------------------ renderer (the receipt's)
  const renderer = new THREE.WebGLRenderer({ canvas, context: opts.context, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTex: THREE.Texture | null = null;
  const buildEnv = () => {
    envTex?.dispose();
    const room = new RoomEnvironment();
    envTex = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    scene.environment = envTex;
  };
  buildEnv();
  scene.environmentIntensity = 0.32;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  const target = new THREE.Vector3(0, BOX.cy, 0);

  scene.add(new THREE.HemisphereLight("#b8a8ff", "#0c0a12", 0.5));
  const key = new THREE.DirectionalLight("#fff3e6", 2.6);
  key.position.set(-2.6, 4.6, 3.6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, {
    left: -2,
    right: 2,
    top: 2.6,
    bottom: -1.6,
    near: 1,
    far: 12,
  });
  key.shadow.radius = 4;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  const rim = new THREE.DirectionalLight("#8d6fff", 3.2);
  rim.position.set(3, 2.4, -4);
  scene.add(rim);
  const rim2 = new THREE.DirectionalLight("#6a54d8", 1.6);
  rim2.position.set(-3.5, 1.5, -3);
  scene.add(rim2);
  const fill = new THREE.DirectionalLight("#d8d0ff", 0.55);
  fill.position.set(3, 1.2, 3);
  scene.add(fill);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 8),
    new THREE.ShadowMaterial({ color: "#05030a", opacity: 0.5 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.9;
  ground.receiveShadow = true;
  scene.add(ground);

  // ------------------------------------------------------------ the pouch
  let view = opts.view;
  const normalMap = packNormals();
  const foil = (map: THREE.Texture) =>
    new THREE.MeshPhysicalMaterial({
      map,
      normalMap,
      metalness: 0.5,
      roughness: 0.24,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      transparent: true,
    });
  const frontMat = foil(packPrint(view.price, true));
  const backMat = foil(packPrint(view.price, false));
  gltf.scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const named = o.material as THREE.Material;
    named.dispose();
    o.material = named.name === "Back" ? backMat : frontMat;
    o.castShadow = true;
  });
  const found = gltf.scene.getObjectByName("Seal");
  if (!gltf.scene.getObjectByName("Body") || !found)
    throw new Error("pack.glb: Body or Seal missing");
  const seal: THREE.Object3D = found;
  const pack = new THREE.Group();
  pack.add(gltf.scene);
  scene.add(pack);

  // ------------------------------------------------------------ the cards
  const cardGeo = new THREE.PlaneGeometry(CARD_W, CARD_H);
  const backTex = cardBack();
  const makeCard = (): Card => {
    const group = new THREE.Group();
    const front = new THREE.Mesh(
      cardGeo,
      new THREE.MeshPhysicalMaterial({
        map: backTex,
        alphaTest: 0.5,
        roughness: 0.4,
        clearcoat: 0.6,
        transparent: true,
      }),
    );
    const back = new THREE.Mesh(
      cardGeo,
      new THREE.MeshPhysicalMaterial({
        map: backTex,
        alphaTest: 0.5,
        roughness: 0.45,
        clearcoat: 0.5,
        transparent: true,
      }),
    );
    back.rotation.y = Math.PI;
    front.castShadow = back.castShadow = true;
    group.add(front, back);
    scene.add(group);
    return { group, front, back };
  };
  const fan = FAN.map(() => makeCard());
  const card = makeCard();
  card.group.visible = false;

  const setFace = (c: Card, art: number) => {
    const m = c.front.material;
    if (m.map !== backTex) m.map?.dispose();
    m.map = cardFace(CARDS[art]!);
    m.needsUpdate = true;
  };
  FAN.forEach(([t], i) => setFace(fan[i]!, t));

  // ------------------------------------------------------------ state
  let shownPrice = view.price;
  let cardShown: number | null = null;
  let drawAt = 0;
  let waitAt = 0;

  function sync(next: PackView) {
    const prev = view;
    view = next;
    if (next.price !== shownPrice) {
      shownPrice = next.price;
      for (const [m, front] of [
        [frontMat, true],
        [backMat, false],
      ] as const) {
        m.map?.dispose();
        m.map = packPrint(next.price, front);
        m.needsUpdate = true;
      }
    }
    if (next.phase === "drawing" && prev.phase !== "drawing") drawAt = performance.now();
    if (next.phase === "wait" && prev.phase !== "wait") waitAt = performance.now();
    const art = next.phase === "result" ? next.card : null;
    if (art !== null && art !== cardShown) {
      cardShown = art;
      setFace(card, art);
      Object.assign(
        card.front.material,
        art === 0
          ? { iridescence: 1, iridescenceIOR: 1.35, metalness: 0.35, roughness: 0.22 }
          : { iridescence: 0, metalness: 0, roughness: 0.4 },
      );
      card.front.material.needsUpdate = true;
    }
    if (art === null) cardShown = null;
    wake();
  }

  // ------------------------------------------------------------ loop
  let raf = 0;
  let paused = false;
  let disposed = false;
  let last = 0;
  let clock = 0;
  let lastActivity = performance.now();
  let dist = 6;
  const mouse = new THREE.Vector2();
  const mouseS = new THREE.Vector2();
  let probing: { samples: number[]; until: number; ms: number; done: (m: number) => void } | null =
    null;

  function schedule() {
    if (!raf && !paused && !disposed) raf = requestAnimationFrame(frame);
  }
  function wake() {
    lastActivity = performance.now();
    schedule();
  }

  function placeFan(out: number, shake: number, amp: number) {
    fan.forEach((c, i) => {
      const [, x, z, r] = FAN[i]!;
      const bob = amp * 0.03 * Math.sin(clock * 1.1 + i);
      c.group.position.set(
        x * (1 - 0.6 * out),
        -0.08 + bob - 0.4 * out - Math.abs(x) * 0.08,
        z - 0.3 * out,
      );
      c.group.rotation.set(0, -x * 0.25, r + shake * Math.sin(clock * 25 + i));
      c.front.material.opacity = c.back.material.opacity = 1 - out;
      c.group.visible = out < 0.99;
    });
  }

  function frame(ts: number) {
    raf = 0;
    const raw = last ? ts - last : 16;
    const dt = Math.min(0.05, raw / 1000);
    last = ts;
    clock += dt;
    const now = performance.now();

    const result = view.phase === "result" && view.resultAt !== null;
    const rt = result ? (now - view.resultAt!) / 1000 : 0;
    const revealing = result && cardShown !== null && rt < REVEAL_MS / 1000 + 0.3;
    const pointerMoving = mouseS.distanceToSquared(mouse) > 1e-6;
    const busy = view.phase === "wait" || view.phase === "drawing" || revealing || pointerMoving;
    if (busy) lastActivity = now;
    const idleFor = now - lastActivity;
    // the float eases to rest once nothing moves
    const amp = 1 - smooth(HOLD_MS, HOLD_MS + SETTLE_MS, idleFor);
    mouseS.lerp(mouse, 1 - Math.exp(-dt * 4));
    const sway = amp * 0.2 * Math.sin(clock * 0.55) + mouseS.x * 0.5;

    if (result && cardShown !== null) {
      placeFan(ease(seg(rt, 0, 0.45)), 0, amp);
      const shake = rt < 0.45 ? 0.06 * Math.sin(rt * 70) * (rt / 0.45) : 0;
      pack.rotation.set(0, sway * (1 - seg(rt, 0.4, 1)), shake);
      const k = ease(seg(rt, 0.4, 1.0));
      seal.position.set(0.5 * k, 0.8 * k, 0.15 * k);
      seal.rotation.set(0, 0, -0.9 * k);
      seal.visible = k < 0.98;
      const up = ease(seg(rt, 0.55, 1.25));
      const turn = ease(seg(rt, 1.25, 1.95));
      const drop = ease(seg(rt, 1.0, 1.8));
      pack.position.set(0, -2.4 * drop, 0.05);
      frontMat.opacity = backMat.opacity = 1 - drop;
      pack.visible = drop < 0.99;
      card.group.visible = rt > 0.55;
      const settle = turn >= 1 ? amp * 0.04 * Math.sin(clock * 1.3) : 0;
      card.group.position.set(0, CARD_IN + up - 0.96 * turn + settle, 0.85 * turn);
      card.group.rotation.set(
        -0.06 * turn,
        Math.PI + Math.PI * turn + (turn >= 1 ? sway * 0.45 : 0),
        0,
      );
    } else {
      // at rest, waiting on the wallet (a breath) or on the oracle (a shake)
      const shaking = view.phase === "drawing" ? Math.min(1, (now - drawAt) / 600) : 0;
      const breath = view.phase === "wait" ? Math.min(1, (now - waitAt) / 400) : 0;
      placeFan(0, shaking * 0.02, amp);
      pack.visible = true;
      frontMat.opacity = backMat.opacity = 1;
      seal.position.set(0, 0, 0);
      seal.rotation.set(0, 0, 0);
      seal.visible = true;
      card.group.visible = false;
      pack.position.set(0, amp * 0.04 * Math.sin(clock * 1.2), 0.05);
      pack.rotation.set(
        -mouseS.y * 0.2 + shaking * 0.02 * Math.sin(clock * 31),
        sway,
        shaking * 0.045 * Math.sin(clock * 23),
      );
      pack.scale.setScalar(
        1 + shaking * 0.012 * Math.sin(clock * 9) + breath * 0.01 * Math.sin(clock * 4),
      );
      rim.intensity =
        3.2 +
        shaking * 2.4 * (0.5 + 0.5 * Math.sin(clock * 6)) +
        breath * 0.8 * (0.5 + 0.5 * Math.sin(clock * 3));
    }
    if (view.phase !== "drawing" && view.phase !== "wait")
      rim.intensity += (3.2 - rim.intensity) * 0.1;

    camera.position.set(0.3 + mouseS.x * 0.15, target.y + 0.2 - mouseS.y * 0.08, dist);
    camera.lookAt(target);
    renderer.render(scene, camera);

    if (probing) {
      if (raw > 0 && last) probing.samples.push(raw);
      if (now >= probing.until && probing.samples.length >= 5) {
        const s = [...probing.samples].sort((a, b) => a - b);
        const p = probing;
        probing = null;
        p.done(s[Math.floor(s.length / 2)]!);
      }
    }

    if (busy || idleFor < HOLD_MS + SETTLE_MS || probing) schedule();
    else last = 0;
  }

  // ------------------------------------------------------------ framing
  function resize() {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    renderer.setPixelRatio(Math.min(opts.mobile ? 1.5 : 2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    dist = Math.max(BOX.h / (2 * tan), BOX.w / (2 * tan * camera.aspect));
    camera.updateProjectionMatrix();
    wake();
  }

  // ------------------------------------------------------------ boot: the first frame, in sync
  sync(view);
  resize();
  frame(performance.now());
  await new Promise((r) => requestAnimationFrame(r));

  return {
    sync,
    resize,
    pointer(x, y = 0) {
      if (x === null) mouse.set(0, 0);
      else mouse.set(x, y);
      wake();
    },
    pause() {
      paused = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
      if (probing) probing.samples = [];
    },
    resume() {
      paused = false;
      if (probing) probing.until = performance.now() + probing.ms;
      wake();
    },
    probe(ms) {
      return new Promise((done) => {
        probing = { samples: [], until: performance.now() + ms, ms, done };
        wake();
      });
    },
    restored() {
      // the environment map lived only on the GPU; textures and buffers re-upload by themselves
      buildEnv();
      wake();
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats as THREE.Material[]) {
            for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
            m.dispose();
          }
        }
      });
      envTex?.dispose();
      pmrem.dispose();
      renderer.dispose();
      // frees the context now rather than at garbage collection
      if (!renderer.getContext().isContextLost()) renderer.forceContextLoss();
    },
  };
}
