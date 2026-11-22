import { Group, GROUPS_CAMERA_QUERY, interactionGroups } from '../../physics/collision-groups';
import { createRayHit, type PhysicsWorld } from '../../physics/physics-world';
import type { CameraCollision } from '../../rendering/camera/orbit-camera';
import type { GroundQuery } from '../rig/character-view';

const FOOT_GROUPS = interactionGroups(0xffff, Group.WORLD | Group.PROP | Group.VEHICLE);

/** Foot-placement probes against walkable geometry (ignores characters). */
export function createGroundQuery(physics: PhysicsWorld): GroundQuery {
  const hit = createRayHit();
  return {
    groundHeight(x, fromY, z, maxDrop) {
      if (!physics.castRay(x, fromY, z, 0, -1, 0, maxDrop, hit, FOOT_GROUPS)) return null;
      return hit.ny > 0.6 ? hit.y : null;
    },
  };
}

/** Camera boom sweeps: buildings, ground, landmarks and vehicles (props and people are ignored). */
export function createCameraCollision(physics: PhysicsWorld): CameraCollision {
  return {
    sweep(ox, oy, oz, dx, dy, dz, radius, maxDistance) {
      return physics.castSphere(ox, oy, oz, dx, dy, dz, radius, maxDistance, GROUPS_CAMERA_QUERY);
    },
  };
}

/** Why a camera frame counts as clipped (0 = clear). */
export const CameraClip = { none: 0, overlap: 1, boom: 2, head: 3 } as const;
export type CameraClipReason = (typeof CameraClip)[keyof typeof CameraClip];

/**
 * Checks whether a camera at `cam` clips: its near-plane sphere overlaps geometry, or the
 * sight line pivot → camera / head → pivot passes through something. Returns the reason.
 */
export function createCameraClipCheck(
  physics: PhysicsWorld,
): (
  camX: number,
  camY: number,
  camZ: number,
  pivotX: number,
  pivotY: number,
  pivotZ: number,
  headX: number,
  headY: number,
  headZ: number,
  nearRadius: number,
) => CameraClipReason {
  const hit = createRayHit();
  const blocked = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean => {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return false;
    return physics.castRay(ax, ay, az, dx, dy, dz, len, hit, GROUPS_CAMERA_QUERY);
  };
  return (camX, camY, camZ, pivotX, pivotY, pivotZ, headX, headY, headZ, nearRadius) => {
    if (physics.overlapsSphere(camX, camY, camZ, nearRadius, GROUPS_CAMERA_QUERY)) return CameraClip.overlap;
    if (blocked(pivotX, pivotY, pivotZ, camX, camY, camZ)) return CameraClip.boom;
    if (blocked(headX, headY, headZ, pivotX, pivotY, pivotZ)) return CameraClip.head;
    return CameraClip.none;
  };
}
