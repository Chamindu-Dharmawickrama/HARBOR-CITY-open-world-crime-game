import * as THREE from 'three';
import { damp } from '../../core/math';
import { solveTwoBoneIK } from '../anim/ik';
import type { Pose } from '../anim/pose';
import type { CharacterRig } from './character-mesh';
import { ankleHeight, BONE_COUNT, BONE_INDEX, type BodyParams } from './skeleton-def';

/** Ground height lookup for foot placement (implemented with physics ray casts by the caller). */
export interface GroundQuery {
  /** Height of the walkable surface below (x, fromY, z) within `maxDrop`, or null. */
  groundHeight(x: number, fromY: number, z: number, maxDrop: number): number | null;
}

const MAX_HIPS_DROP = 0.35;
const FOOT_PROBE_UP = 0.45;
const FOOT_PROBE_DOWN = 0.9;

const LEGS = [
  [BONE_INDEX.upperLegL, BONE_INDEX.lowerLegL, BONE_INDEX.footL],
  [BONE_INDEX.upperLegR, BONE_INDEX.lowerLegR, BONE_INDEX.footR],
] as const;

const ankle = new THREE.Vector3();
const target = new THREE.Vector3();
const pole = new THREE.Vector3();

/**
 * The visible character: positions the rig at the character's feet with its facing yaw,
 * applies animation poses to the bones, and plants the feet on uneven ground (kerbs, steps,
 * slopes) with two-bone leg IK and a pelvis drop.
 */
export class CharacterView {
  readonly root = new THREE.Group();
  private readonly bones: readonly THREE.Bone[];
  private readonly rest: readonly THREE.Vector3[];
  private readonly ankleHeight: number;
  private hipsDrop = 0;
  private readonly footOffset = new Float64Array(2);
  private yaw = 0;

  constructor(
    readonly rig: CharacterRig,
    body: BodyParams,
  ) {
    this.bones = rig.bones;
    this.rest = rig.rest;
    this.ankleHeight = ankleHeight(body);
    this.root.add(rig.mesh);
    // Generous bounds: poses (lying down, swimming) reach well outside the bind pose.
    const s = body.height / 1.8;
    rig.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.8 * s, 0), 1.9 * s);
  }

  setTransform(x: number, y: number, z: number, yaw: number): void {
    this.root.position.set(x, y, z);
    this.root.rotation.set(0, yaw, 0);
    this.yaw = yaw;
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  applyPose(pose: Pose): void {
    const rot = pose.rot;
    for (let b = 0; b < BONE_COUNT; b++) {
      const o = b * 4;
      this.bones[b].quaternion.set(rot[o], rot[o + 1], rot[o + 2], rot[o + 3]);
    }
    const hips = this.bones[BONE_INDEX.hips];
    const rest = this.rest[BONE_INDEX.hips];
    hips.position.set(rest.x + pose.hips[0], rest.y + pose.hips[1], rest.z + pose.hips[2]);
  }

  /**
   * Foot IK: probes the ground under each ankle, lowers the pelvis so the lower foot can reach,
   * and bends each leg so the foot keeps its animated lift above the real ground.
   * Call after applyPose. `weight` fades the effect (0 = pure animation).
   */
  plantFeet(ground: GroundQuery, weight: number, dt: number): void {
    this.root.updateMatrixWorld(true);
    const rootY = this.root.position.y;
    let lowest = 0;
    for (let i = 0; i < 2; i++) {
      const foot = this.bones[LEGS[i][2]];
      foot.getWorldPosition(ankle);
      let offset = 0;
      if (weight > 0) {
        const groundY = ground.groundHeight(
          ankle.x,
          rootY + FOOT_PROBE_UP,
          ankle.z,
          FOOT_PROBE_UP + FOOT_PROBE_DOWN,
        );
        if (groundY !== null) {
          // Keep the animated lift (swing phase) relative to the real ground instead of the root plane.
          const lift = Math.max(0, ankle.y - rootY - this.ankleHeight);
          offset = groundY + this.ankleHeight + lift - ankle.y;
          offset = Math.max(-MAX_HIPS_DROP, Math.min(0.3, offset));
        }
      }
      this.footOffset[i] = damp(this.footOffset[i], offset * weight, 18, dt);
      lowest = Math.min(lowest, this.footOffset[i]);
    }
    this.hipsDrop = damp(this.hipsDrop, lowest, 14, dt);
    if (
      Math.abs(this.hipsDrop) < 1e-4 &&
      Math.abs(this.footOffset[0]) < 1e-4 &&
      Math.abs(this.footOffset[1]) < 1e-4
    )
      return;
    const hips = this.bones[BONE_INDEX.hips];
    hips.position.y += this.hipsDrop;
    hips.updateMatrixWorld(true);
    pole.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    for (let i = 0; i < 2; i++) {
      const [u, l, f] = LEGS[i];
      const foot = this.bones[f];
      foot.getWorldPosition(ankle);
      // After the pelvis drop every ankle moved down by hipsDrop; restore each foot's own offset.
      target.copy(ankle);
      target.y += this.footOffset[i] - this.hipsDrop;
      if (Math.abs(target.y - ankle.y) < 1e-4) continue;
      solveTwoBoneIK(this.bones[u], this.bones[l], foot, target, pole);
    }
  }
}
