import * as THREE from 'three';

const a = new THREE.Vector3();
const b = new THREE.Vector3();
const c = new THREE.Vector3();
const t = new THREE.Vector3();
const ca = new THREE.Vector3();
const ba = new THREE.Vector3();
const ab = new THREE.Vector3();
const cb = new THREE.Vector3();
const ta = new THREE.Vector3();
const axis0 = new THREE.Vector3();
const aGr = new THREE.Quaternion();
const bGr = new THREE.Quaternion();
const r0 = new THREE.Quaternion();
const r1 = new THREE.Quaternion();
const r2 = new THREE.Quaternion();
const inv = new THREE.Quaternion();
const tmpQ = new THREE.Quaternion();
const orig = new THREE.Quaternion();
const origLower = new THREE.Quaternion();
const solved = new THREE.Quaternion();

function safeAcos(x: number): number {
  return Math.acos(Math.min(1, Math.max(-1, x)));
}

/** Applies a world-space rotation `r` to a bone whose current world rotation is `gr`. */
function rotateWorld(bone: THREE.Object3D, gr: THREE.Quaternion, r: THREE.Quaternion): void {
  // local' = local * gr⁻¹ * r * gr  ⇒  world' = r * world
  inv.copy(gr).invert();
  tmpQ.copy(inv).multiply(r).multiply(gr);
  bone.quaternion.multiply(tmpQ);
}

/**
 * Analytic two-bone IK (e.g. hip-knee-ankle). Rotates `upper` and `lower` so that `end` reaches
 * `target` (or points at it fully extended when out of reach). `pole` (world direction) chooses
 * the bend plane when the chain is straight. `weight` blends from the input pose (0) to the
 * solved pose (1). World matrices must be current; they are updated on return.
 */
export function solveTwoBoneIK(
  upper: THREE.Object3D,
  lower: THREE.Object3D,
  end: THREE.Object3D,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  weight = 1,
): void {
  if (weight <= 0) return;
  upper.getWorldPosition(a);
  lower.getWorldPosition(b);
  end.getWorldPosition(c);
  t.copy(target);
  const lab = ab.subVectors(b, a).length();
  const lcb = cb.subVectors(b, c).length();
  if (lab < 1e-6 || lcb < 1e-6) return;
  const lat = Math.min(Math.max(ta.subVectors(t, a).length(), 1e-4), lab + lcb - 1e-4);

  ca.subVectors(c, a).normalize();
  ba.subVectors(b, a).normalize();
  const acAb0 = safeAcos(ca.dot(ba));
  const baBc0 = safeAcos(ab.subVectors(a, b).normalize().dot(cb.subVectors(c, b).normalize()));
  const acAb1 = safeAcos((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat));
  const baBc1 = safeAcos((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb));

  axis0.crossVectors(ca, ba);
  if (axis0.lengthSq() < 1e-10) axis0.crossVectors(ca, pole);
  if (axis0.lengthSq() < 1e-10) return;
  axis0.normalize();

  upper.getWorldQuaternion(aGr);
  lower.getWorldQuaternion(bGr);
  r0.setFromAxisAngle(axis0, acAb1 - acAb0);
  r1.setFromAxisAngle(axis0, baBc1 - baBc0);

  orig.copy(upper.quaternion);
  origLower.copy(lower.quaternion);
  // 1) Bend: set the hip and knee angles for the target distance (both about the bend axis, so
  //    the two rotations commute).
  rotateWorld(upper, aGr, r0);
  rotateWorld(lower, bGr, r1);
  // 2) Swing: rotate the whole chain so the (moved) end effector points at the target.
  upper.updateMatrixWorld(true);
  end.getWorldPosition(c);
  ca.subVectors(c, a).normalize();
  ta.subVectors(t, a).normalize();
  if (ca.dot(ta) < 0.9999999) {
    r2.setFromUnitVectors(ca, ta);
    upper.getWorldQuaternion(aGr);
    rotateWorld(upper, aGr, r2);
  }
  if (weight < 1) {
    solved.copy(upper.quaternion);
    upper.quaternion.slerpQuaternions(orig, solved, weight);
    solved.copy(lower.quaternion);
    lower.quaternion.slerpQuaternions(origLower, solved, weight);
  }
  upper.updateMatrixWorld(true);
}
