import type { RigidBody, Rotation, Vector } from '@dimforge/rapier3d-compat';
import { defineObject } from '../ecs/component';
import { entityIndex } from '../ecs/entity';
import type { FixedSystem } from '../ecs/scheduler';
import { Transform } from '../ecs/transform';
import type { World } from '../ecs/world';
import type { PhysicsWorld } from './physics-world';

/** Links an entity to a Rapier rigid body whose pose drives the entity's Transform. */
export const RigidBodyRef = defineObject<RigidBody>('RigidBodyRef');

/** Steps the Rapier world once per fixed tick. */
export function createPhysicsStepSystem(physics: PhysicsWorld): FixedSystem {
  return {
    name: 'physicsStep',
    phase: 'physics',
    fixedUpdate(): void {
      physics.step();
    },
  };
}

/** Copies body poses into Transform after the physics step. Sleeping bodies are skipped. */
export function createRigidBodySyncSystem(world: World): FixedSystem {
  const transforms = world.soa(Transform);
  const bodies = world.objects(RigidBodyRef);
  const entities = world.query([Transform, RigidBodyRef]).entities;
  const position: Vector = { x: 0, y: 0, z: 0 };
  const rotation: Rotation = { x: 0, y: 0, z: 0, w: 1 };
  const f = transforms.f;
  return {
    name: 'rigidBodySync',
    phase: 'postPhysics',
    fixedUpdate(): void {
      for (let n = 0; n < entities.length; n++) {
        const entity = entities[n];
        const body = bodies.get(entity) as RigidBody;
        if (body.isSleeping()) continue;
        body.translation(position);
        body.rotation(rotation);
        const i = entityIndex(entity);
        f.px[i] = position.x;
        f.py[i] = position.y;
        f.pz[i] = position.z;
        f.qx[i] = rotation.x;
        f.qy[i] = rotation.y;
        f.qz[i] = rotation.z;
        f.qw[i] = rotation.w;
      }
    },
  };
}
