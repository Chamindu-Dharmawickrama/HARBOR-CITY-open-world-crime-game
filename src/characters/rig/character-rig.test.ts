import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Rng } from '../../core/rng';
import { Pose } from '../anim/pose';
import { PLAYER_APPEARANCE, randomAppearance } from './appearance';
import { buildCharacter, createCharacterMaterial } from './character-mesh';
import { CharacterView, type GroundQuery } from './character-view';
import { ankleHeight, BONE_COUNT, BONE_INDEX } from './skeleton-def';

const material = createCharacterMaterial();

describe('procedural character mesh', () => {
  it('has one bone per skeleton entry and valid, normalised skin weights', () => {
    const rig = buildCharacter(PLAYER_APPEARANCE, material);
    expect(rig.bones).toHaveLength(BONE_COUNT);
    expect(rig.mesh.skeleton.bones).toHaveLength(BONE_COUNT);
    const geometry = rig.mesh.geometry;
    const index = geometry.getAttribute('skinIndex');
    const weight = geometry.getAttribute('skinWeight');
    expect(index.count).toBe(geometry.getAttribute('position').count);
    for (let v = 0; v < index.count; v++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        expect(index.getComponent(v, k)).toBeLessThan(BONE_COUNT);
        sum += weight.getComponent(v, k);
      }
      expect(sum).toBeCloseTo(1, 5);
    }
    expect(geometry.getAttribute('color').itemSize).toBe(3);
  });

  it('is as tall as the body and stands on its feet', () => {
    for (const height of [1.6, 1.8, 1.95]) {
      const rig = buildCharacter({ ...PLAYER_APPEARANCE, body: { height, build: 1 } }, material);
      const box = rig.mesh.geometry.boundingBox as THREE.Box3;
      expect(box.max.y).toBeGreaterThan(height - 0.06);
      expect(box.max.y).toBeLessThan(height + 0.06);
      expect(Math.abs(box.min.y)).toBeLessThan(0.02);
    }
  });

  it('random civilians vary but stay buildable', () => {
    const rng = new Rng('appearance-test');
    const heights = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const look = randomAppearance(rng);
      heights.add(Math.round(look.body.height * 100));
      const rig = buildCharacter(look, material);
      expect(rig.mesh.geometry.getAttribute('position').count).toBeGreaterThan(500);
      expect(rig.mesh.geometry.getAttribute('position').count).toBeLessThan(4000);
    }
    expect(heights.size).toBeGreaterThan(5);
  });
});

describe('CharacterView', () => {
  const footWorld = (view: CharacterView, bone: 'footL' | 'footR'): THREE.Vector3 =>
    view.rig.bones[BONE_INDEX[bone]].getWorldPosition(new THREE.Vector3());

  it('places and faces the rig, and applies poses to the bones', () => {
    const view = new CharacterView(buildCharacter(PLAYER_APPEARANCE, material), PLAYER_APPEARANCE.body);
    view.setTransform(10, 2, -5, Math.PI / 2);
    const pose = new Pose();
    pose.setEuler(BONE_INDEX.upperLegL, -40, 0, 0);
    pose.hips[1] = -0.1;
    view.applyPose(pose);
    view.root.updateMatrixWorld(true);
    const hips = view.rig.bones[BONE_INDEX.hips].getWorldPosition(new THREE.Vector3());
    expect(hips.x).toBeCloseTo(10, 5);
    expect(hips.y).toBeCloseTo(2 + view.rig.rest[BONE_INDEX.hips].y - 0.1, 5);
    // Facing +X (yaw 90°): the forward-swung left foot is ahead in +X.
    expect(footWorld(view, 'footL').x).toBeGreaterThan(footWorld(view, 'footR').x + 0.2);
  });

  it('foot IK plants a foot on a lower surface by dropping the hips and bending the other leg', () => {
    const body = PLAYER_APPEARANCE.body;
    const view = new CharacterView(buildCharacter(PLAYER_APPEARANCE, material), body);
    view.setTransform(0, 0.15, 0, 0);
    // Kerb edge: the left foot (+X side) hangs over a road 0.15 m lower.
    const ground: GroundQuery = { groundHeight: (x) => (x > 0 ? 0 : 0.15) };
    const pose = new Pose();
    for (let i = 0; i < 90; i++) {
      view.applyPose(pose);
      view.plantFeet(ground, 1, 1 / 60);
    }
    view.root.updateMatrixWorld(true);
    const ankle = ankleHeight(body);
    expect(footWorld(view, 'footL').y).toBeCloseTo(0 + ankle, 2);
    expect(footWorld(view, 'footR').y).toBeCloseTo(0.15 + ankle, 2);
  });

  it('weight 0 leaves the animated pose untouched', () => {
    const view = new CharacterView(buildCharacter(PLAYER_APPEARANCE, material), PLAYER_APPEARANCE.body);
    view.setTransform(0, 1, 0, 0);
    const pose = new Pose();
    view.applyPose(pose);
    view.root.updateMatrixWorld(true);
    const before = footWorld(view, 'footL');
    view.plantFeet({ groundHeight: () => 0 }, 0, 1 / 60);
    view.root.updateMatrixWorld(true);
    expect(footWorld(view, 'footL').distanceTo(before)).toBeLessThan(1e-6);
  });
});
