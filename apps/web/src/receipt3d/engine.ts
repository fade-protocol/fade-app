// The 3D receipt printer: the Blender-modelled printer, the bending paper strip,
// the receipt typed on it, the FREE stamp, pixel confetti and the tear-off.
// Loaded on demand (this module and three.js are their own chunk); the React
// wrapper (components/Receipt3D.tsx) feeds it the demo's state through sync().
//
// One timeline per receipt. Its clock starts when the payout started
// (view.startedAt) and every step of the choreography sleeps until a point on
// that clock, so a scene created mid-payout fast-forwards silently to where the
// 2D receipt is (no confetti, no tear animation while catching up) and a
// finished print is never replayed.
//
// At rest the slot holds a blank stub, or with `headAtRest` the order's head (its
// title and lines): the rest prints under it once the payment goes through (a new
// key), while the light blinks as the open waits.
//
// Frames are drawn only while something moves (that light included), plus a
// few seconds of camera drift that eases to rest; nothing at all while paused.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { Confetti, StampSlam } from "./fx";
import { PaperStrip, paperMaterial } from "./paper";
import { parsePrinter } from "./printerModel";
import {
  ALL,
  COLORS,
  EDGE,
  PAPER_W,
  ReceiptCanvas,
  makeStampCanvas,
  type Row,
  type RowInit,
} from "./receiptCanvas";
import type { PrinterData, PrinterOptions, PrinterScene, PrinterView, Stage } from "./types";

/** The world box the camera keeps in the stage: the printer and a full receipt. */
const BOX = { w: 1.84, h: 1.98, cy: 0.9 };
/** The resting camera: a little to the right, a little above. */
const AZ0 = 0.13;
const EL0 = 0.26;
/** Camera drift after the last movement, then it eases to rest and rendering stops. */
const HOLD_MS = 2500;
const SETTLE_MS = 2500;
/** A line is typed once it clears the slot by this much. */
const VIS = 0.03;
/** The blank paper out of the slot at rest (before a payment, after a tear). */
const STUB = 0.13;
/** With `headAtRest`, the blank paper out of the slot under the head's last line. */
const HEAD_TAIL = 0.07;
const GLYPHS = "0123456789ABCDEFGHJKLMNPRSTUVWXYZ#%&*+?";

type Led = "idle" | "print" | "pulse" | "won" | "off" | "dim" | "sign" | "confirm";
type Fall = {
  body: THREE.Group;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  receipt: ReceiptCanvas;
  age: number;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
};

class Cancel extends Error {}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

async function fontsReady(): Promise<void> {
  await Promise.race([
    Promise.all([
      document.fonts.load('500 32px "Roboto Mono"'),
      document.fonts.load('700 40px "Roboto Mono"'),
      document.fonts.load("700 132px Poppins"),
    ]),
    new Promise((r) => setTimeout(r, 2500)),
  ]);
}

export async function createPrinterScene(
  canvas: HTMLCanvasElement,
  opts: PrinterOptions,
): Promise<PrinterScene> {
  const [printer] = await Promise.all([parsePrinter(opts.glb), fontsReady()]);

  // ------------------------------------------------------------ renderer
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
  scene.environmentIntensity = 0.24;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  const target = new THREE.Vector3(0, BOX.cy, 0);

  // ------------------------------------------------------------ lights (on the app's violet)
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

  // no floor: the panel shows through; only the shadows land on it
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 6),
    new THREE.ShadowMaterial({ color: "#05030a", opacity: 0.55 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  scene.add(printer.group);
  const paperRoot = new THREE.Group();
  paperRoot.position.copy(printer.slot);
  printer.group.add(paperRoot);

  const confetti = new Confetti(scene);
  // one stamp per word ("FREE", "HALF BACK"), drawn when a win first needs it
  const stamps = new Map<string, HTMLCanvasElement>();
  const stampOf = (text: string) => {
    let c = stamps.get(text);
    if (!c) stamps.set(text, (c = makeStampCanvas(text)));
    return c;
  };

  // ------------------------------------------------------------ state
  let view: PrinterView = opts.view;
  let stage: Stage = opts.stage;
  /** The receipt on the printer: "idle" (a blank stub, or the head) or a payout's key. */
  let current: string | null = null;
  let paper: PaperStrip | null = null;
  let receipt: ReceiptCanvas | null = null;
  let seed = 7;
  const falling: Fall[] = [];
  let slam: StampSlam | null = null;
  let scrambleRow: Row | null = null;
  let scrambleAt = 0;
  let led: Led = "idle";
  let ledT = 0;
  let shake = 0;
  let jolt = 0;
  let feedPulse = 0;

  // the timeline: sleeps land on points of a clock that started at `origin`
  let epoch = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const tl = { origin: performance.now(), v: 0 };
  const lag = () => performance.now() - (tl.origin + tl.v);
  /** Fast-forwarding to the present: effects are skipped. */
  const catchingUp = () => lag() > 250 || paused;

  function sleep(ms: number, moving = true): Promise<void> {
    const my = epoch;
    tl.v += ms;
    if (moving) wake();
    const wait = tl.origin + tl.v - performance.now();
    if (wait <= 0) return my === epoch ? Promise.resolve() : Promise.reject(new Cancel());
    return new Promise((res, rej) => {
      const id = setTimeout(() => {
        timers.delete(id);
        if (my === epoch) res();
        else rej(new Cancel());
      }, wait);
      timers.add(id);
    });
  }
  const run = (fn: () => Promise<void>) => {
    fn().catch((e: unknown) => {
      if (!(e instanceof Cancel)) console.error(e);
    });
  };
  function cancel() {
    epoch++;
    timers.forEach(clearTimeout);
    timers.clear();
    scrambleRow = null;
    slam?.dispose();
    slam = null;
  }

  /** A nudge from the feed: skipped while fast-forwarding, or it would pile up. */
  function bump(p: PaperStrip, a = 0.6) {
    if (catchingUp()) return;
    p.kick(a);
    feedPulse = 1;
  }

  // ------------------------------------------------------------ the receipt
  function newPaper(stub = STUB) {
    receipt = new ReceiptCanvas(seed++);
    receipt.setRows([{ id: "edge", kind: "edge", h: EDGE }]);
    receipt.draw();
    paper = new PaperStrip(receipt);
    paper.L = stub;
    paperRoot.add(paper.mesh);
  }

  function rowsFor(d: PrinterData): RowInit[] {
    return [
      { id: "edge", kind: "edge", h: EDGE },
      { id: "gap", kind: "space", h: 0.05 },
      { id: "title", kind: "title", h: 0.13, segs: [{ t: d.title }] },
      { id: "gap2", kind: "space", h: 0.025 },
      ...d.lines.map((l, i): RowInit => ({
        id: `line-${i}`,
        kind: "item",
        h: 0.1,
        segs: [{ t: l.label }],
        value: l.value,
      })),
      { id: "rule1", kind: "rule", h: 0.06 },
      { id: "sub", kind: "item", h: 0.1, segs: [{ t: d.subtotalLabel }], value: d.subtotal },
      {
        id: "draw",
        kind: "item",
        h: 0.1,
        segs:
          d.drawPrice !== null
            ? [{ t: d.drawLabel }, { t: ` · ${d.drawPrice}`, c: COLORS.inkDim }]
            : [{ t: d.drawLabel }],
        value: d.pending,
      },
      { id: "rule2", kind: "rule", h: 0.06 },
      {
        id: "total",
        kind: "total",
        h: 0.14,
        segs: [{ t: d.totalLabel }],
        value: total(d.totalFrom),
      },
      { id: "thanks", kind: "note", h: 0.11, segs: [{ t: d.thanks }] },
      { id: "tail", kind: "space", h: 0.07 },
    ];
  }
  /** The head printed at rest with `headAtRest`: everything above the first rule. */
  function headRows(d: PrinterData): RowInit[] {
    const all = rowsFor(d);
    return all.slice(
      0,
      all.findIndex((r) => r.id === "rule1"),
    );
  }
  const total = (micro: string | bigint) => `${opts.format(BigInt(micro))} USDC`;

  async function feedTo(L: number, step = 0.02, ms = 26) {
    const p = paper;
    if (!p) return;
    while (p.L < L - 1e-6) {
      p.L = Math.min(L, p.L + step);
      bump(p);
      await sleep(ms);
    }
  }

  async function type(row: Row, ms: number, upTo = ReceiptCanvas.len(row)) {
    const r = receipt;
    if (!r) return;
    r.active = row;
    for (let i = row.n + 1; i <= upTo; i++) {
      row.n = i;
      r.dirty = true;
      await sleep(ms);
    }
    r.active = null;
    r.dirty = true;
  }

  async function typeValue(row: Row, text: string, ms: number) {
    row.value = text;
    row.n = ReceiptCanvas.labelLen(row);
    await type(row, ms);
  }

  /** The draw line while there is no ending: reels while drawing, PENDING before. */
  function waiting(row: Row, d: PrinterData) {
    if (view.draw === "drawing") {
      if (scrambleRow !== row) {
        scrambleRow = row;
        row.valueColor = COLORS.violetInk;
      }
      led = "pulse";
    } else {
      scrambleRow = null;
      row.value = d.pending;
      delete row.valueColor;
    }
    if (receipt) receipt.dirty = true;
  }

  /** Rows already typed on this paper (the head printed at rest) keep what they show. */
  function setRowsKeeping(r: ReceiptCanvas, rows: RowInit[]) {
    const typed = new Map(r.rows.map((x) => [x.id, x.n]));
    r.setRows(rows);
    for (const row of r.rows) row.n = typed.get(row.id) ?? 0;
  }

  /** Feeds a row out of the slot and types it. */
  async function printRow(row: Row) {
    if (row.kind === "edge" || row.kind === "space") return feedTo(row.y + row.h);
    await feedTo(row.y + row.h + VIS);
    await type(row, row.kind === "rule" ? 6 : 16);
  }

  /** At rest with `headAtRest`: the order's head, typed, or shown printed at once. */
  async function printHead(d: PrinterData, animate: boolean) {
    const r = receipt;
    const p = paper;
    if (!r || !p) return;
    setRowsKeeping(r, headRows(d));
    if (!animate) {
      for (const row of r.rows) row.n = ALL;
      p.L = Math.max(p.L, r.length + HEAD_TAIL);
      r.dirty = true;
      return;
    }
    led = "print";
    await sleep(220);
    for (const row of r.rows) await printRow(row);
    await feedTo(r.length + HEAD_TAIL);
    led = "idle";
  }

  async function printPayout(d: PrinterData) {
    const r = receipt;
    if (!r) return;
    led = "print";
    // a head printed at rest stays: the payout prints under it
    setRowsKeeping(r, rowsFor(d));
    await sleep(220);
    for (const row of r.rows) {
      if (row.id !== "draw") {
        await printRow(row);
        continue;
      }
      // the label prints; the value waits for the draw
      await feedTo(row.y + row.h + VIS);
      await type(row, 16, ReceiptCanvas.labelLen(row));
      row.n = ALL;
      waiting(row, d);
    }
    if (led === "print") led = "idle";
    await drawPhase(d);
  }

  async function drawPhase(d: PrinterData) {
    const row = receipt?.row("draw");
    if (!row) return;
    let shown: string | null = null;
    for (;;) {
      const v = view;
      const at = v.resultAt === null ? 0 : v.resultAt - tl.origin;
      if (v.resultText && v.draw !== shown && tl.v >= at) {
        scrambleRow = null;
        if (v.draw === "won") return revealWin(row, d, v.resultText);
        if (v.draw === "lost") return revealLose(row, v.resultText);
        // a quiet ending (expired, on hold, settled...): a retry may still follow
        led = "dim";
        row.valueColor = COLORS.inkDim;
        await typeValue(row, v.resultText, 30);
        shown = v.draw;
        continue;
      }
      if (!v.resultText) {
        if (shown !== null) led = "idle";
        shown = null;
        waiting(row, d);
      }
      await sleep(40, false);
    }
  }

  async function revealWin(row: Row, d: PrinterData, text: string) {
    const r = receipt;
    const p = paper;
    if (!r || !p) return;
    led = "won";
    ledT = 0;
    row.valueColor = COLORS.violetInk;
    await typeValue(row, text, 70);
    await sleep(180);
    // a new line opens under the draw: the paper above lifts as it feeds
    const back = r.insertAfter("draw", {
      id: "back",
      kind: "item",
      h: 0,
      accent: true,
      segs: [{ t: d.wonBackLabel }],
      value: d.wonBack,
    });
    await grow(back, 0.1);
    await type(back, 34);
    await sleep(260);
    await slamStamp();
    await sleep(120);
    const row2 = r.row("total");
    if (row2) {
      const from = Number(BigInt(d.totalFrom));
      const to = Number(BigInt(d.totalTo));
      for (let ms = 16; ; ms += 16) {
        const k = Math.min(1, ms / 900);
        const e = 1 - (1 - k) ** 3;
        row2.value = total(BigInt(Math.round(from + (to - from) * e)));
        r.dirty = true;
        if (k >= 1) break;
        await sleep(16);
      }
      row2.value = total(d.totalTo);
    }
    if (d.footer) {
      const foot = r.insertAfter("thanks", {
        id: "footer",
        kind: "note",
        h: 0,
        segs: [{ t: d.footer, c: COLORS.violetInk }],
      });
      await grow(foot, 0.1);
      await type(foot, 17);
    }
  }

  /** Opens a new line inside the printed receipt: the paper feeds by its height. */
  async function grow(row: Row, H: number) {
    const r = receipt;
    const p = paper;
    if (!r || !p) return;
    while (row.h < H - 1e-6) {
      const s = Math.min(0.02, H - row.h);
      row.h += s;
      p.L += s;
      bump(p);
      r.layout();
      await sleep(26);
    }
  }

  async function slamStamp() {
    const r = receipt;
    const p = paper;
    if (!r || !p) return;
    // across the last cart line, like the 2D stamp
    const rule = r.rows.findIndex((x) => x.id === "rule1");
    const line = r.rows[Math.max(0, rule - 1)]!;
    const cy = line.y + line.h * 0.95;
    const cx = 0.63;
    const live = !catchingUp();
    const stampCanvas = stampOf(view.data.stamp);
    if (live) {
      slam = new StampSlam(stampCanvas);
      slam.start(paperRoot, p.frameAt(p.L - cy), cx * PAPER_W - PAPER_W / 2, 0.15);
    }
    await sleep(150);
    r.stamp = { canvas: stampCanvas, cx, cy };
    r.dirty = true;
    if (live && slam) {
      shake = 0.045;
      p.kick(2.2);
      jolt = 1;
      ledT = 0;
      const tip = p.frameAt(p.L);
      const o = paperRoot.localToWorld(tip.p.clone());
      const q = paperRoot.getWorldQuaternion(new THREE.Quaternion());
      confetti.burst(
        o,
        new THREE.Vector3(1, 0, 0).applyQuaternion(q),
        tip.t.clone().applyQuaternion(q),
        tip.n.clone().applyQuaternion(q),
      );
    }
    await sleep(40);
    slam?.dispose();
    slam = null;
  }

  async function revealLose(row: Row, text: string) {
    led = "off";
    row.valueColor = COLORS.ink;
    await typeValue(row, text, 30);
    await sleep(470);
    await tear();
    // a blank stub in the slot, until the next order
    led = "idle";
  }

  /** The sheet is torn off and falls away; a fresh stub is left in the slot. */
  async function tear() {
    const old = paper;
    const oldReceipt = receipt;
    if (!old || !oldReceipt) return newPaper();
    if (old.L <= STUB + 0.02 && oldReceipt.length <= EDGE + 1e-6) return;
    if (catchingUp()) {
      old.dispose();
      oldReceipt.dispose();
      newPaper();
      return;
    }
    const L0 = old.L;
    for (let i = 1; i <= 4; i++) {
      old.lift = 0.05 * Math.sin((i / 4) * Math.PI * 0.5);
      await sleep(16);
    }
    oldReceipt.tearY = L0 + 0.002;
    oldReceipt.active = null;
    oldReceipt.draw();
    // freeze its shape into a free body pivoting around its middle
    old.update(0, clock);
    const geo = old.geometry.clone();
    const mid = old.frameAt((L0 + old.lift) / 2).p;
    const mesh = new THREE.Mesh(geo, paperMaterial(oldReceipt.texture, { transparent: true }));
    mesh.castShadow = true;
    mesh.position.copy(mid).negate();
    const body = new THREE.Group();
    body.add(mesh);
    body.position.copy(mid);
    paperRoot.add(body);
    old.dispose();
    falling.push({
      body,
      mesh,
      receipt: oldReceipt,
      age: 0,
      vel: new THREE.Vector3(0.55 + Math.random() * 0.3, 1.25, 0.55),
      spin: new THREE.Vector3(1.2, 0.5 + Math.random() * 0.6, -1.9),
    });
    shake = 0.012;
    newPaper(0);
    await sleep(240);
    await feedTo(STUB, 0.015, 30);
  }

  /**
   * At rest, like a till: a blank stub in the slot, or with `headAtRest` the
   * order's head. The rest prints once the payment goes through (a new key); a
   * finished receipt is torn off first.
   */
  async function showIdle(animate: boolean) {
    led = "idle";
    if (animate) await tear();
    else {
      paper?.dispose();
      receipt?.dispose();
      newPaper();
    }
    if (view.headAtRest) await printHead(view.data, animate);
  }

  // ------------------------------------------------------------ sync
  function sync(v: PrinterView) {
    view = v;
    // at rest the ticket can change: nothing is printed yet, so nothing reprints
    const first = current === null;
    const fromHead = current === "idle" && v.headAtRest;
    if (first || current !== v.key) {
      cancel();
      current = v.key;
      tl.origin = v.key === "idle" ? performance.now() : v.startedAt;
      tl.v = 0;
      if (v.key === "idle") run(() => showIdle(!first));
      else
        run(async () => {
          if (first) {
            paper?.dispose();
            receipt?.dispose();
            newPaper();
          } else if (!fromHead) await tear();
          await printPayout(v.data);
        });
    }
    wake();
  }

  // ------------------------------------------------------------ loop
  let raf = 0;
  let paused = false;
  let disposed = false;
  let last = 0;
  let clock = 0;
  let lastActivity = performance.now();
  let size = { w: 1, h: 1 };
  let dist = 6;
  const mouse = new THREE.Vector2();
  const mouseS = new THREE.Vector2();
  const ledColor = new THREE.Color("#8a6dff");
  let probing: { samples: number[]; until: number; ms: number; done: (m: number) => void } | null =
    null;

  function schedule() {
    if (!raf && !paused && !disposed) raf = requestAnimationFrame(frame);
  }
  function wake() {
    lastActivity = performance.now();
    schedule();
  }

  /** At rest, the wallet or the network can be waited on: that light wins. */
  const waitingOpen = () => view.key === "idle" && view.signal !== null;

  function ledLevel(t: number, dt: number): number {
    ledT += dt;
    const mode: Led = waitingOpen() ? (view.signal ?? led) : led;
    switch (mode) {
      case "sign":
        // a steady blink, about once a second: waiting for the signature
        return 0.12 + 1.6 * smooth(-0.25, 0.25, Math.sin(t * Math.PI * 2));
      case "confirm":
        // quicker: the network is confirming
        return 0.25 + 1.6 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 2.2));
      case "print":
        return 1.1 + 0.25 * Math.sin(t * 40) * feedPulse;
      case "pulse":
        return 0.25 + 1.6 * (0.5 + 0.5 * Math.sin(t * 9));
      case "won":
        return 1.3 + 2.5 * Math.exp(-ledT * 3);
      case "off":
        return 0.06;
      case "dim":
        return 0.3;
      default:
        return 0.75;
    }
  }

  function updateFalling(dt: number) {
    for (let i = falling.length - 1; i >= 0; i--) {
      const f = falling[i]!;
      f.age += dt;
      f.vel.y -= 4.6 * dt;
      f.body.position.addScaledVector(f.vel, dt);
      f.body.rotation.x += f.spin.x * dt;
      f.body.rotation.y += f.spin.y * dt;
      f.body.rotation.z += f.spin.z * dt;
      const m = f.mesh.material;
      m.opacity = 1 - Math.max(0, (f.age - 0.55) / 0.5);
      m.alphaTest = 0.5 * m.opacity;
      if (f.age > 1.05) dropFall(i);
    }
  }
  function dropFall(i: number) {
    const f = falling[i]!;
    f.body.removeFromParent();
    f.mesh.geometry.dispose();
    f.mesh.material.dispose();
    f.receipt.dispose();
    falling.splice(i, 1);
  }

  function frame(ts: number) {
    raf = 0;
    const raw = last ? ts - last : 16;
    const dt = Math.min(0.05, raw / 1000);
    last = ts;
    clock += dt;
    const now = performance.now();

    if (scrambleRow && clock - scrambleAt > 0.075) {
      scrambleAt = clock;
      let s = "";
      for (let i = 0; i < 7; i++) s += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      scrambleRow.value = s;
      if (receipt) receipt.dirty = true;
    }
    if (receipt?.dirty) receipt.draw();

    const pointerMoving = mouseS.distanceToSquared(mouse) > 1e-6;
    const busy =
      scrambleRow !== null ||
      confetti.active ||
      falling.length > 0 ||
      slam !== null ||
      (paper?.moving ?? false) ||
      shake > 5e-4 ||
      jolt > 1e-3 ||
      feedPulse > 0.01 ||
      (led === "won" && ledT < 2) ||
      waitingOpen() ||
      pointerMoving;
    if (busy) lastActivity = now;
    const idleFor = now - lastActivity;
    // the drift eases to rest once nothing moves
    const amp = 1 - smooth(HOLD_MS, HOLD_MS + SETTLE_MS, idleFor);

    if (paper) {
      paper.swayAmp = amp;
      paper.update(dt, clock);
    }
    slam?.update(dt);
    confetti.update(dt);
    updateFalling(dt);

    const lvl = ledLevel(clock, dt);
    printer.ledMat.emissiveIntensity = lvl * 2.2;
    printer.ledLight.intensity = lvl * 0.35;
    printer.ledLight.color.copy(ledColor);

    // the printer: motor buzz while feeding, a jolt on the stamp
    feedPulse *= Math.exp(-dt * 14);
    jolt *= Math.exp(-dt * 10);
    printer.group.position.y = feedPulse * 0.0025 * Math.sin(clock * 160) - jolt * 0.012;

    // camera: slow drift, pointer parallax, shake
    mouseS.lerp(mouse, 1 - Math.exp(-dt * 4));
    const az = AZ0 + amp * 0.05 * Math.sin(clock * 0.17) + mouseS.x * 0.14;
    const el = EL0 + amp * 0.02 * Math.sin(clock * 0.23) - mouseS.y * 0.05;
    camera.position.set(
      Math.sin(az) * Math.cos(el) * dist,
      target.y + Math.sin(el) * dist,
      Math.cos(az) * Math.cos(el) * dist,
    );
    camera.lookAt(target);
    if (shake > 5e-4) {
      camera.position.x += (Math.random() - 0.5) * shake;
      camera.position.y += (Math.random() - 0.5) * shake;
      shake *= Math.exp(-dt * 16);
    }

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
    size = { w, h };
    renderer.setPixelRatio(Math.min(opts.mobile ? 1.5 : 2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    frameCamera();
    wake();
  }

  /** Fits BOX into the stage (a rect of the canvas) and centres it there. */
  function frameCamera() {
    const { w: W, h: H } = size;
    const st = stage.w > 0 && stage.h > 0 ? stage : { x: 0, y: 0, w: W, h: H };
    camera.aspect = W / H;
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    dist = Math.max((BOX.h * H) / (st.h * 2 * tan), (BOX.w * H) / (st.w * 2 * tan));
    const cx = st.x + st.w / 2;
    const cy = st.y + st.h / 2;
    camera.setViewOffset(W, H, W / 2 - cx, H / 2 - cy, W, H);
    camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ boot: the first frame, in sync
  sync(view);
  resize();
  frame(performance.now());
  await new Promise((r) => requestAnimationFrame(r));

  return {
    sync,
    setStage(s) {
      if (s.x === stage.x && s.y === stage.y && s.w === stage.w && s.h === stage.h) return;
      stage = s;
      frameCamera();
      wake();
    },
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
      // falling sheets would hang mid-air until the next frame
      for (let i = falling.length - 1; i >= 0; i--) dropFall(i);
      if (probing) {
        probing.samples = [];
      }
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
      if (receipt) receipt.dirty = true;
      wake();
    },
    dispose() {
      disposed = true;
      cancel();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      for (let i = falling.length - 1; i >= 0; i--) dropFall(i);
      paper?.dispose();
      receipt?.dispose();
      confetti.dispose();
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
