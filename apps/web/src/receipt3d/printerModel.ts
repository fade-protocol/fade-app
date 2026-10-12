// The Blender-modelled printer (public/receipt3d/printer.glb): named nodes Body, Lid, TearBar, LED, Slot.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export type PrinterModel = {
  group: THREE.Group;
  ledMat: THREE.MeshStandardMaterial;
  ledLight: THREE.PointLight;
  /** The paper strip's origin, in the group's space. */
  slot: THREE.Vector3;
};

export async function parsePrinter(glb: ArrayBuffer): Promise<PrinterModel> {
  const gltf = await new GLTFLoader().parseAsync(glb, "");
  const model = gltf.scene;
  const group = new THREE.Group();
  group.name = "Printer";
  group.add(model);
  group.updateMatrixWorld(true);

  const need = (name: string) => {
    const o = model.getObjectByName(name);
    if (!o) throw new Error(`printer.glb: no node named ${name}`);
    return o;
  };
  need("Body");
  const ledNode = need("LED");
  const slotNode = need("Slot");

  model.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.castShadow = true;
    o.receiveShadow = true;
    // the environment is kept dim for the matte shell; polished metal would read
    // black under it, so the tear bar gets more of the reflections
    const m = o.material as THREE.MeshStandardMaterial;
    if (m.name === "Metal") m.envMapIntensity = 4;
  });

  // the LED gets its own material so the scene can drive its glow
  const led =
    ledNode instanceof THREE.Mesh
      ? ledNode
      : (ledNode.getObjectByProperty("isMesh", true) as THREE.Mesh | undefined);
  if (!led) throw new Error("printer.glb: the LED has no mesh");
  const ledMat = (led.material as THREE.MeshStandardMaterial).clone();
  led.material = ledMat;
  led.castShadow = false;
  ledMat.emissive.set("#8a6dff");

  const ledLight = new THREE.PointLight("#8a6dff", 0.2, 0.9, 2);
  ledLight.position
    .copy(led.getWorldPosition(new THREE.Vector3()))
    .add(new THREE.Vector3(0, 0, 0.08));
  group.add(ledLight);

  return { group, ledMat, ledLight, slot: slotNode.getWorldPosition(new THREE.Vector3()) };
}
