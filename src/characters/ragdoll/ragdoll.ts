import type { ImpulseJoint, RigidBody } from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Group, interactionGroups } from '../../physics/collision-groups';
import type { PhysicsWorld } from '../../physics/physics-world';
import type { Pose } from '../anim/pose';
import type { CharacterView } from '../rig/character-view';
import { BONE_INDEX, BONE_PARENT, BONES, type BoneName } from '../rig/skeleton-def';

/** Ragdoll parts collide with the world, street furniture, vehicles and debris — not with each other. */
export const RAGDOLL_GROUPS = interactionGroups(
  Group.RAGDOLL,
  Group.WORLD | Group.PROP | Group.VEHICLE | Group.DEBRIS,
);

interface PartSpec {
  /** Bone whose joint is the body origin (its rotation is the body's). */
  bone: BoneName;
  /** Parent part (−1 for the pelvis). */
  parent: number;
  /** Bones between the parent's bone and this one that are frozen at rest (e.g. the chest). */
  joint: 'root' | 'ball' | 'hinge';
  /** Hinge limits about the bone's local X axis (rad). */
  limits?: readonly [number, number];
  shape: 'box' | 'capsule' | 'ball';
  /** Box half extents / capsule [radius, half length] / ball [radius], reference (1.8 m) units. */
  size: readonly number[];
  /** Collider centre in the body frame, reference units. */
  centre: readonly [number, number, number];
  mass: number;
}

/**
 * The 11 parts. Spine + chest form the torso (chest frozen at rest), neck + head the head, and
 * hands and feet ride on their forearm and shin.
 */
const PARTS: readonly PartSpec[] = [
  {
    bone: 'hips',
    parent: -1,
    joint: 'root',
    shape: 'box',
    size: [0.16, 0.1, 0.1],
    centre: [0, -0.01, 0],
    mass: 11,
  },
  {
    bone: 'spine',
    parent: 0,
    joint: 'ball',
    shape: 'box',
    size: [0.18, 0.24, 0.11],
    centre: [0, 0.22, 0],
    mass: 20,
  },
  {
    bone: 'neck',
    parent: 1,
    joint: 'ball',
    shape: 'box',
    size: [0.1, 0.12, 0.11],
    centre: [0, 0.17, 0.01],
    mass: 5,
  },
  {
    bone: 'upperArmL',
    parent: 1,
    joint: 'ball',
    shape: 'capsule',
    size: [0.055, 0.1],
    centre: [0, -0.14, 0],
    mass: 2.5,
  },
  {
    bone: 'lowerArmL',
    parent: 3,
    joint: 'hinge',
    limits: [-2.5, 0.05],
    shape: 'capsule',
    size: [0.05, 0.14],
    centre: [0, -0.2, 0],
    mass: 1.8,
  },
  {
    bone: 'upperArmR',
    parent: 1,
    joint: 'ball',
    shape: 'capsule',
    size: [0.055, 0.1],
    centre: [0, -0.14, 0],
    mass: 2.5,
  },
  {
    bone: 'lowerArmR',
    parent: 5,
    joint: 'hinge',
    limits: [-2.5, 0.05],
    shape: 'capsule',
    size: [0.05, 0.14],
    centre: [0, -0.2, 0],
    mass: 1.8,
  },
  {
    bone: 'upperLegL',
    parent: 0,
    joint: 'ball',
    shape: 'capsule',
    size: [0.08, 0.15],
    centre: [0, -0.215, 0],
    mass: 8,
  },
  {
    bone: 'lowerLegL',
    parent: 7,
    joint: 'hinge',
    limits: [-0.05, 2.5],
    shape: 'capsule',
    size: [0.065, 0.17],
    centre: [0, -0.22, 0.02],
    mass: 4.5,
  },
  {
    bone: 'upperLegR',
    parent: 0,
    joint: 'ball',
    shape: 'capsule',
    size: [0.08, 0.15],
    centre: [0, -0.215, 0],
    mass: 8,
  },
  {
    bone: 'lowerLegR',
    parent: 9,
    joint: 'hinge',
    limits: [-0.05, 2.5],
    shape: 'capsule',
    size: [0.065, 0.17],
    centre: [0, -0.22, 0.02],
    mass: 4.5,
  },
];

export const RAGDOLL_PART_COUNT = PARTS.length;

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const qInv = new THREE.Quaternion();
const partOfBone = new Int8Array(BONES.length).fill(-1);
PARTS.forEach((p, i) => (partOfBone[BONE_INDEX[p.bone]] = i));

/**
 * A physics ragdoll for one character: 11 Rapier bodies posed from the character's current
 * skeleton, joined by spherical joints (hips, shoulders, neck, waist — damped, no cone limits)
 * and limited hinges (knees, elbows). `writePose` maps the bodies back onto the skeleton.
 */
export class Ragdoll {
  readonly bodies: RigidBody[] = [];
  readonly joints: ImpulseJoint[] = [];
  /** Seconds since creation, and seconds all parts have been nearly still. */
  age = 0;
  stillTime = 0;
  private readonly scale: number;
  private readonly rot: THREE.Quaternion[] = PARTS.map(() => new THREE.Quaternion());

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly view: CharacterView,
    height: number,
    vx: number,
    vy: number,
    vz: number,
  ) {
    const { rapier, world } = physics;
    this.scale = height / 1.8;
    const s = this.scale;
    const bones = view.rig.bones;
    view.root.updateMatrixWorld(true);
    for (let i = 0; i < PARTS.length; i++) {
      const part = PARTS[i];
      const bone = bones[BONE_INDEX[part.bone]];
      bone.getWorldPosition(v1);
      bone.getWorldQuaternion(q1);
      const body = world.createRigidBody(
        rapier.RigidBodyDesc.dynamic()
          .setTranslation(v1.x, v1.y, v1.z)
          .setRotation({ x: q1.x, y: q1.y, z: q1.z, w: q1.w })
          .setLinvel(vx, vy, vz)
          .setLinearDamping(0.05)
          // Strong angular damping stands in for joint friction (limbs and head do not roll about).
          .setAngularDamping(i <= 1 ? 2.5 : 5)
          .setCcdEnabled(i <= 1),
      );
      const [cx, cy, cz] = part.centre;
      let desc;
      if (part.shape === 'box')
        desc = rapier.ColliderDesc.cuboid(part.size[0] * s, part.size[1] * s, part.size[2] * s);
      else if (part.shape === 'capsule')
        desc = rapier.ColliderDesc.capsule(part.size[1] * s, part.size[0] * s);
      else desc = rapier.ColliderDesc.ball(part.size[0] * s);
      desc
        .setTranslation(cx * s, cy * s, cz * s)
        .setMass(part.mass)
        .setFriction(0.7)
        .setRestitution(0.05)
        .setCollisionGroups(RAGDOLL_GROUPS);
      world.createCollider(desc, body);
      this.bodies.push(body);
    }
    // Joints: anchors are rest-pose offsets from the parent part's bone through any frozen bones.
    for (let i = 1; i < PARTS.length; i++) {
      const part = PARTS[i];
      const anchor = this.restOffset(PARTS[part.parent].bone, part.bone);
      const parent = this.bodies[part.parent];
      const child = this.bodies[i];
      let joint: ImpulseJoint;
      if (part.joint === 'hinge') {
        const data = rapier.JointData.revolute(anchor, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
        data.limitsEnabled = true;
        data.limits = [part.limits?.[0] ?? -1, part.limits?.[1] ?? 1];
        joint = world.createImpulseJoint(data, parent, child, true);
      } else {
        joint = world.createImpulseJoint(
          rapier.JointData.spherical(anchor, { x: 0, y: 0, z: 0 }),
          parent,
          child,
          true,
        );
      }
      joint.setContactsEnabled(false);
      this.joints.push(joint);
    }
  }

  /** Rest-pose position of bone `to`'s joint in the frame of ancestor bone `from`. */
  private restOffset(from: BoneName, to: BoneName): { x: number; y: number; z: number } {
    const rest = this.view.rig.rest;
    let x = 0;
    let y = 0;
    let z = 0;
    let b: BoneName | null = to;
    while (b && b !== from) {
      const r = rest[BONE_INDEX[b]];
      x += r.x;
      y += r.y;
      z += r.z;
      b = BONE_PARENT[b];
    }
    return { x, y, z };
  }

  /** Adds a velocity change to every part (impacts, explosions). */
  push(dvx: number, dvy: number, dvz: number): void {
    for (const b of this.bodies) {
      const v = b.linvel();
      b.setLinvel({ x: v.x + dvx, y: v.y + dvy, z: v.z + dvz }, true);
    }
  }

  /** Tracks how long the ragdoll has been at rest. */
  step(dt: number): void {
    this.age += dt;
    let moving = false;
    for (const b of this.bodies) {
      const v = b.linvel();
      const w = b.angvel();
      if (v.x * v.x + v.y * v.y + v.z * v.z > 0.04 || w.x * w.x + w.y * w.y + w.z * w.z > 0.5) {
        moving = true;
        break;
      }
    }
    this.stillTime = moving ? 0 : this.stillTime + dt;
  }

  get settled(): boolean {
    return this.stillTime > 0.75 || this.age > 9;
  }

  /** Pelvis position (for obstacle checks, getting up, despawning). */
  pelvis(out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const t = this.bodies[0].translation();
    out.x = t.x;
    out.y = t.y;
    out.z = t.z;
    return out;
  }

  /** Heading the body faces when lying (from the torso), radians. */
  heading(): number {
    const q = this.bodies[1].rotation();
    q1.set(q.x, q.y, q.z, q.w);
    v1.set(0, 0, 1).applyQuaternion(q1);
    v2.set(0, 1, 0).applyQuaternion(q1);
    // Lying down the body's up axis is horizontal: face along it (head direction).
    const fx = Math.abs(v1.y) > 0.7 ? v2.x : v1.x;
    const fz = Math.abs(v1.y) > 0.7 ? v2.z : v1.z;
    return Math.atan2(fx, fz);
  }

  /**
   * Writes the ragdoll onto a skeleton pose relative to a root at (rx, ry, rz) facing `yaw`:
   * bone rotations from the parts (frozen bones at rest) and the hips offset.
   */
  writePose(out: Pose, rx: number, ry: number, rz: number, yaw: number): void {
    q2.setFromAxisAngle(v1.set(0, 1, 0), yaw);
    qInv.copy(q2).invert();
    for (let i = 0; i < PARTS.length; i++) {
      const r = this.bodies[i].rotation();
      this.rot[i].set(r.x, r.y, r.z, r.w);
    }
    for (let b = 0; b < BONES.length; b++) {
      const o = b * 4;
      const p = partOfBone[b];
      if (p < 0) {
        out.rot[o] = 0;
        out.rot[o + 1] = 0;
        out.rot[o + 2] = 0;
        out.rot[o + 3] = 1;
        continue;
      }
      // Local = inverse(parent part world) · part world; the hips are relative to the root.
      const parent = PARTS[p].parent;
      if (parent < 0) q1.copy(qInv).multiply(this.rot[p]);
      else q1.copy(this.rot[parent]).invert().multiply(this.rot[p]);
      out.rot[o] = q1.x;
      out.rot[o + 1] = q1.y;
      out.rot[o + 2] = q1.z;
      out.rot[o + 3] = q1.w;
    }
    const h = this.bodies[0].translation();
    const restHips = this.view.rig.rest[BONE_INDEX.hips];
    v1.set(h.x - rx, h.y - ry, h.z - rz).applyQuaternion(qInv);
    out.hips[0] = v1.x - restHips.x;
    out.hips[1] = v1.y - restHips.y;
    out.hips[2] = v1.z - restHips.z;
  }

  dispose(): void {
    for (const j of this.joints) this.physics.world.removeImpulseJoint(j, false);
    for (const b of this.bodies) this.physics.removeBody(b);
    this.joints.length = 0;
    this.bodies.length = 0;
  }
}
