import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../../core/rng';
import { PhysicsWorld } from '../../physics/physics-world';
import { loadRapier, type Rapier } from '../../physics/rapier';
import { Pose } from '../anim/pose';
import { randomAppearance } from '../rig/appearance';
import { buildCharacter, createCharacterMaterial } from '../rig/character-mesh';
import { CharacterView } from '../rig/character-view';
import { BONE_INDEX } from '../rig/skeleton-def';
import { Ragdoll, RAGDOLL_PART_COUNT } from './ragdoll';

let rapier: Rapier;
beforeAll(async () => {
  rapier = await loadRapier();
});

function setup(): { physics: PhysicsWorld; view: CharacterView; height: number } {
  const physics = new PhysicsWorld(rapier);
  physics.createFixedBox({ halfExtents: [50, 1, 50], position: [0, -1, 0] });
  physics.world.step();
  const appearance = randomAppearance(new Rng(3));
  const view = new CharacterView(buildCharacter(appearance, createCharacterMaterial()), appearance.body);
  view.setTransform(0, 0, 0, 0.4);
  view.applyPose(new Pose());
  return { physics, view, height: appearance.body.height };
}

describe('ragdoll', () => {
  it('falls, stays jointed and inside the world, and settles', () => {
    const { physics, view, height } = setup();
    view.setTransform(0, 1.2, 0, 0.4);
    const ragdoll = new Ragdoll(physics, view, height, 1.5, 0, -2);
    expect(ragdoll.bodies).toHaveLength(RAGDOLL_PART_COUNT);
    let settledAt = Infinity;
    let worstFloor = 0;
    for (let t = 0; t < 8; t += 1 / 60) {
      physics.step();
      ragdoll.step(1 / 60);
      for (const b of ragdoll.bodies) {
        const p = b.translation();
        expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
        worstFloor = Math.min(worstFloor, p.y);
      }
      if (ragdoll.settled && settledAt === Infinity) settledAt = t;
    }
    expect(worstFloor).toBeGreaterThan(-0.12);
    expect(settledAt).toBeLessThan(6);
    // Joints hold: every child part's origin stays at its anchor on the parent.
    for (const joint of ragdoll.joints) {
      const a = joint.body1();
      const b = joint.body2();
      const anchor = joint.anchor1();
      const q = a.rotation();
      const world = new THREE.Vector3(anchor.x, anchor.y, anchor.z)
        .applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w))
        .add(new THREE.Vector3(a.translation().x, a.translation().y, a.translation().z));
      const c = b.translation();
      expect(world.distanceTo(new THREE.Vector3(c.x, c.y, c.z))).toBeLessThan(0.06);
    }
    // Lying on the floor.
    expect(ragdoll.pelvis({ x: 0, y: 0, z: 0 }).y).toBeLessThan(0.35);
    // Knees only bend backwards: the shin's relative rotation about X stays in its limits.
    const pose = new Pose();
    ragdoll.writePose(pose, 0, 0, 0, 0);
    for (const bone of ['lowerLegL', 'lowerLegR'] as const) {
      const o = BONE_INDEX[bone] * 4;
      const q = new THREE.Quaternion(pose.rot[o], pose.rot[o + 1], pose.rot[o + 2], pose.rot[o + 3]);
      const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
      expect(e.x).toBeGreaterThan(-0.25);
      expect(e.x).toBeLessThan(2.7);
    }
    ragdoll.dispose();
    expect(physics.bodyCount).toBe(0);
  });

  it('a car-speed hit throws the body and it comes to rest', () => {
    const { physics, view, height } = setup();
    const ragdoll = new Ragdoll(physics, view, height, 11, 3, 0);
    for (let t = 0; t < 1; t += 1 / 60) physics.step();
    const p = ragdoll.pelvis({ x: 0, y: 0, z: 0 });
    expect(p.x).toBeGreaterThan(4);
    for (let t = 0; t < 10; t += 1 / 60) {
      physics.step();
      ragdoll.step(1 / 60);
    }
    expect(ragdoll.settled).toBe(true);
    ragdoll.dispose();
  });
});
