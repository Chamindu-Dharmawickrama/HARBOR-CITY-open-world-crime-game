import * as THREE from 'three';
import type { WheelState } from '../sim/raycast-vehicle';
import type { VehicleDef } from '../vehicle-def';
import { createLightMaterial, type LightUniforms } from './vehicle-materials';
import type { VehicleModel } from './vehicle-mesh';

/** Shared materials for every vehicle view (paint, glass, cracked glass, burnt). */
export interface VehicleMaterials {
  paint: THREE.Material;
  glass: THREE.Material;
  crackedGlass: THREE.Material;
  burnt: THREE.Material;
  hidden: THREE.Material;
}

export type GlassState = 'intact' | 'cracked' | 'shattered';

const DOOR_OPEN = 1.15;
const tmpQ = new THREE.Quaternion();
const steerQ = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);

/**
 * The visible vehicle: one skinned mesh (paint / glass / lights groups) whose bones carry the
 * hinged doors, wheels (spin, steer, suspension travel) and a bike's fork. Lights are driven by
 * per-vehicle uniforms; bikes lean visually about the tire contact line.
 */
export class VehicleView {
  readonly root = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  readonly bones: THREE.Bone[];
  readonly lights: LightUniforms;
  readonly lightMaterial: THREE.Material;
  glass: GlassState = 'intact';
  burnt = false;
  /** Current and target opening of each door (0 = shut, 1 = open). */
  readonly doorOpen: number[];
  readonly doorTarget: number[];
  private readonly rest: THREE.Vector3[];
  private blink = 0;
  private geometryOwned = false;

  constructor(
    readonly model: VehicleModel,
    readonly def: VehicleDef,
    private readonly materials: VehicleMaterials,
  ) {
    const light = createLightMaterial();
    this.lights = light.uniforms;
    this.lightMaterial = light.material;
    this.mesh = new THREE.SkinnedMesh(model.geometry, [materials.paint, materials.glass, light.material]);
    this.mesh.name = `vehicle:${def.id}`;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.bones = model.bones.map((b) => {
      const bone = new THREE.Bone();
      bone.name = b.name;
      return bone;
    });
    this.rest = model.bones.map((b) => {
      const parent = b.parent >= 0 ? model.bones[b.parent] : undefined;
      return new THREE.Vector3(b.x - (parent?.x ?? 0), b.y - (parent?.y ?? 0), b.z - (parent?.z ?? 0));
    });
    model.bones.forEach((b, i) => {
      const bone = this.bones[i];
      bone.position.copy(this.rest[i]);
      if (b.parent >= 0) this.bones[b.parent].add(bone);
    });
    this.mesh.add(this.bones[0]);
    this.mesh.bind(new THREE.Skeleton(this.bones));
    this.mesh.boundingSphere = model.bounds.clone();
    this.root.add(this.mesh);
    this.doorOpen = model.doors.map(() => 0);
    this.doorTarget = model.doors.map(() => 0);
  }

  setTransform(x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): void {
    this.root.position.set(x, y, z);
    this.root.quaternion.set(qx, qy, qz, qw);
  }

  /** Two-wheelers: visual lean (+ = left) about the tire contact line. */
  setLean(lean: number): void {
    this.mesh.rotation.z = -lean;
  }

  /** Wheels follow the simulation: spin, steering, suspension travel; detached wheels vanish. */
  updateWheels(wheels: readonly WheelState[]): void {
    const model = this.model;
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      const boneIndex = model.wheelBones[i];
      if (boneIndex === undefined) continue;
      const bone = this.bones[boneIndex];
      const rest = this.rest[boneIndex];
      if (w.detached) {
        bone.scale.setScalar(0.0001);
        continue;
      }
      const forkBone = model.forkBone;
      if (forkBone >= 0 && i === 0) {
        // Bike: the fork steers; the wheel just spins (and travels) inside it.
        this.bones[forkBone].quaternion.setFromAxisAngle(Y, w.steer);
        bone.position.set(rest.x, rest.y + (w.hy - w.suspensionLength - this.def.wheelRadius) * 0.6, rest.z);
        bone.quaternion.setFromAxisAngle(X, w.rotation);
        continue;
      }
      bone.position.set(rest.x, w.hy - w.suspensionLength, rest.z);
      steerQ.setFromAxisAngle(Y, w.steer);
      tmpQ.setFromAxisAngle(X, w.rotation);
      bone.quaternion.multiplyQuaternions(steerQ, tmpQ);
    }
  }

  /** Door swing (opens outward about its front hinge). */
  update(dt: number): void {
    const doors = this.model.doors;
    for (let i = 0; i < doors.length; i++) {
      const target = this.doorTarget[i];
      let open = this.doorOpen[i];
      open += Math.max(-dt * 3, Math.min(dt * 3, target - open));
      this.doorOpen[i] = open;
      const door = doors[i];
      if (!door) continue;
      const eased = open * open * (3 - 2 * open);
      this.bones[door.bone].quaternion.setFromAxisAngle(Y, -door.side * eased * DOOR_OPEN);
    }
    this.blink = (this.blink + dt) % 1;
  }

  /** Light states: headlights level, brake, reverse, indicators (blinking), light bar. */
  setLights(
    head: number,
    brake: boolean,
    reverse: boolean,
    left: boolean,
    right: boolean,
    bar: boolean,
    barPhase: number,
  ): void {
    const on = this.blink < 0.5 ? 1 : 0;
    const l = this.lights;
    l.uHead.value = this.burnt ? 0 : head;
    l.uBrake.value = brake && !this.burnt ? 1 : 0;
    l.uReverse.value = reverse && !this.burnt ? 1 : 0;
    l.uIndicatorLeft.value = left && !this.burnt ? on : 0;
    l.uIndicatorRight.value = right && !this.burnt ? on : 0;
    l.uBarOn.value = bar && !this.burnt ? 1 : 0;
    l.uBar.value = barPhase;
  }

  setGlass(state: GlassState): void {
    if (this.burnt) return;
    this.glass = state;
    const m = this.materials;
    this.setMaterial(1, state === 'intact' ? m.glass : state === 'cracked' ? m.crackedGlass : m.hidden);
  }

  /** Wreck: burnt paint, no glass, dark lights. */
  setBurnt(): void {
    this.burnt = true;
    const m = this.materials;
    this.setMaterial(0, m.burnt);
    this.setMaterial(1, m.hidden);
    this.setMaterial(2, m.burnt);
  }

  /** Copy-on-write geometry (dents) — shared model geometry is cloned on first deformation. */
  ownGeometry(): THREE.BufferGeometry {
    if (!this.geometryOwned) {
      this.mesh.geometry = this.mesh.geometry.clone();
      this.geometryOwned = true;
    }
    return this.mesh.geometry;
  }

  get hasOwnGeometry(): boolean {
    return this.geometryOwned;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.lightMaterial.dispose();
    if (this.geometryOwned) this.mesh.geometry.dispose();
  }

  private setMaterial(index: number, material: THREE.Material): void {
    const list = this.mesh.material as THREE.Material[];
    list[index] = material;
  }
}
