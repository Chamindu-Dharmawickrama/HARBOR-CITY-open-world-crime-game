import * as THREE from 'three';
import { defineObject } from '../ecs/component';
import type { RenderSystem } from '../ecs/scheduler';
import { interpolatePose, Transform, type PoseOut } from '../ecs/transform';
import type { World } from '../ecs/world';

/** A scene-graph object whose pose follows the entity's interpolated Transform. */
export const RenderObject = defineObject<THREE.Object3D>('RenderObject');

/** An instance in an InstancedMesh whose matrix follows the entity's interpolated Transform. */
export interface InstanceSlot {
  readonly mesh: THREE.InstancedMesh;
  readonly index: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
}
export const InstanceRef = defineObject<InstanceSlot>('InstanceRef');

function makePose(): PoseOut {
  return { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
}

export function createRenderObjectSyncSystem(world: World): RenderSystem {
  const transforms = world.soa(Transform);
  const objects = world.objects(RenderObject);
  const entities = world.query([Transform, RenderObject]).entities;
  const pose = makePose();
  return {
    name: 'renderObjectSync',
    phase: 'interpolate',
    renderUpdate(ctx): void {
      for (let n = 0; n < entities.length; n++) {
        const entity = entities[n];
        const object = objects.get(entity) as THREE.Object3D;
        interpolatePose(transforms, entity, ctx.alpha, pose);
        object.position.set(pose.x, pose.y, pose.z);
        object.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
      }
    },
  };
}

export function createInstanceSyncSystem(world: World): RenderSystem {
  const transforms = world.soa(Transform);
  const slots = world.objects(InstanceRef);
  const entities = world.query([Transform, InstanceRef]).entities;
  const pose = makePose();
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  return {
    name: 'instanceSync',
    phase: 'interpolate',
    renderUpdate(ctx): void {
      for (let n = 0; n < entities.length; n++) {
        const entity = entities[n];
        const slot = slots.get(entity) as InstanceSlot;
        interpolatePose(transforms, entity, ctx.alpha, pose);
        position.set(pose.x, pose.y, pose.z);
        rotation.set(pose.qx, pose.qy, pose.qz, pose.qw);
        scale.set(slot.sx, slot.sy, slot.sz);
        matrix.compose(position, rotation, scale);
        slot.mesh.setMatrixAt(slot.index, matrix);
        slot.mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}

const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

/** Collapses an instance so it renders nothing (used when its slot is released). */
export function hideInstance(mesh: THREE.InstancedMesh, index: number): void {
  mesh.setMatrixAt(index, ZERO_MATRIX);
  mesh.instanceMatrix.needsUpdate = true;
}
