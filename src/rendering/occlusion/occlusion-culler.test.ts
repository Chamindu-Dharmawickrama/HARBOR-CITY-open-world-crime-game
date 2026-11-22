import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { OcclusionCuller } from './occlusion-culler';

/** Camera at the origin, eye height 2 m, looking down -Z. */
function viewProjection(): Float32Array {
  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 2000);
  camera.position.set(0, 2, 0);
  camera.lookAt(0, 2, -10);
  camera.updateMatrixWorld();
  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return new Float32Array(vp.elements);
}

function setupWithWall(): OcclusionCuller {
  const culler = new OcclusionCuller(256, 128);
  culler.begin(viewProjection());
  // A 60 m wide, 40 m tall, 10 m deep building 30 m ahead.
  culler.addOccluder(0, -35, 1, 0, 30, 5, 0, 40);
  culler.finish();
  return culler;
}

describe('OcclusionCuller', () => {
  it('rasterises occluders into the depth buffer', () => {
    const culler = setupWithWall();
    expect(culler.occluders).toBe(1);
    const covered = Array.from(culler.depth).filter((d) => Number.isFinite(d)).length;
    expect(covered).toBeGreaterThan(256 * 128 * 0.2);
  });

  it('culls a box entirely behind the wall', () => {
    const culler = setupWithWall();
    expect(culler.isOccluded(-5, 0, -80, 5, 10, -70)).toBe(true);
    expect(culler.culled).toBe(1);
  });

  it('keeps boxes in front of, beside, above or straddling the wall', () => {
    const culler = setupWithWall();
    expect(culler.isOccluded(-2, 0, -20, 2, 4, -16)).toBe(false);
    expect(culler.isOccluded(80, 0, -90, 90, 10, -80)).toBe(false);
    expect(culler.isOccluded(-5, 70, -90, 5, 140, -80)).toBe(false);
    // Spans 36°–48° to the right: partly behind the wall (to 45°), partly in clear view.
    expect(culler.isOccluded(80, 0, -110, 110, 10, -100)).toBe(false);
    expect(culler.isOccluded(25, 0, -80, 60, 10, -70)).toBe(true);
  });

  it('never culls boxes that reach behind the camera', () => {
    const culler = setupWithWall();
    expect(culler.isOccluded(-1, 0, -100, 1, 1, 5)).toBe(false);
  });

  it('with no occluders nothing is culled', () => {
    const culler = new OcclusionCuller();
    culler.begin(viewProjection());
    culler.finish();
    expect(culler.isOccluded(-5, 0, -80, 5, 10, -70)).toBe(false);
  });
});
