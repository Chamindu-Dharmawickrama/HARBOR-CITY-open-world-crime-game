/**
 * Collision group bits. Rapier interaction groups pack a 16-bit membership mask (high half) and
 * a 16-bit filter mask (low half); two colliders interact when each one's membership overlaps
 * the other's filter.
 */
export const Group = {
  WORLD: 1 << 0,
  PROP: 1 << 1,
  VEHICLE: 1 << 2,
  CHARACTER: 1 << 3,
  HITBOX: 1 << 4,
  RAGDOLL: 1 << 5,
  DEBRIS: 1 << 6,
  TRIGGER: 1 << 7,
  PROJECTILE: 1 << 8,
} as const;

export const ALL_GROUPS = 0xffff;

export function interactionGroups(membership: number, filter: number): number {
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

export function membershipOf(groups: number): number {
  return (groups >>> 16) & 0xffff;
}

export function filterOf(groups: number): number {
  return groups & 0xffff;
}

export function groupsInteract(a: number, b: number): boolean {
  return (membershipOf(a) & filterOf(b)) !== 0 && (membershipOf(b) & filterOf(a)) !== 0;
}

/** Common presets. */
export const GROUPS_STATIC_WORLD = interactionGroups(Group.WORLD, ALL_GROUPS);
export const GROUPS_DYNAMIC_PROP = interactionGroups(Group.PROP, ALL_GROUPS);
/** Static street furniture: solid for characters and vehicles, ignored by the camera. */
export const GROUPS_STATIC_PROP = interactionGroups(Group.PROP, ALL_GROUPS);
/** What the third-person camera collides with (buildings, ground, landmarks, vehicles). */
export const GROUPS_CAMERA_QUERY = interactionGroups(ALL_GROUPS, Group.WORLD | Group.VEHICLE);
