import * as THREE from 'three';
import type { CityLayout } from '../../world/gen/types';
import type { LaneNetwork } from './lane-network';
import { Light, lightAt, type LightState, type SignalTiming } from './signals';

/** Lamp heights on the traffic-light pole (prop geometry) and the lens face offset. */
const LAMP_Y: Readonly<Record<LightState, number>> = { 0: 2.68, 1: 3.0, 2: 3.32 };
const LENS_Z = 0.3;
const COLOURS: Readonly<Record<LightState, THREE.Color>> = {
  0: new THREE.Color(0.25, 3.2, 0.9),
  1: new THREE.Color(3.2, 1.7, 0.1),
  2: new THREE.Color(3.4, 0.25, 0.15),
};

interface Head {
  prop: number;
  x: number;
  y: number;
  z: number;
  rotY: number;
  signal: number;
  phase: number;
  shown: number;
}

const matrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const rotation = new THREE.Quaternion();
const scale = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * The lit lamp of every traffic light, drawn as one instanced mesh over the dark lenses of the
 * pole props: each head shows the aspect of the approach it faces. Heads facing internal links
 * (driven through without stopping) stay dark, as do knocked-over poles. Instances are only
 * rewritten when an aspect changes.
 */
export class SignalLights {
  readonly mesh: THREE.InstancedMesh;
  private readonly heads: Head[] = [];
  private readonly signals: readonly SignalTiming[];

  constructor(
    layout: CityLayout,
    net: LaneNetwork,
    private readonly knocked: (prop: number) => boolean,
  ) {
    // Approach lane per (junction, edge).
    const approach = new Map<string, number>();
    for (const lane of layout.lanes) {
      if (lane.isConnector) continue;
      for (const e of layout.chains[lane.chain]?.edges ?? [lane.edge])
        approach.set(`${lane.junction}:${e}`, lane.id);
    }
    for (const h of layout.signalHeads) {
      const prop = layout.props[h.prop];
      const lane = approach.get(`${h.junction}:${h.edge}`);
      if (!prop || lane === undefined) continue;
      this.heads.push({
        prop: h.prop,
        x: prop.x,
        y: prop.y,
        z: prop.z,
        rotY: prop.rotY,
        signal: net.signal[lane],
        phase: net.phase[lane],
        shown: -2,
      });
    }
    this.signals = net.signals.map((s) => s.timing);
    const geometry = new THREE.SphereGeometry(0.115, 10, 6);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: true });
    this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, this.heads.length));
    this.mesh.name = 'signal-lights';
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < this.heads.length; i++) {
      this.mesh.setColorAt(i, COLOURS[Light.red]);
      this.hide(i);
    }
  }

  get count(): number {
    return this.heads.length;
  }

  /** Updates the aspects for sim time `time`. */
  update(time: number): void {
    let changed = false;
    for (let i = 0; i < this.heads.length; i++) {
      const h = this.heads[i];
      const state =
        h.signal < 0 || this.knocked(h.prop) ? -1 : lightAt(this.signals[h.signal], h.phase, time);
      if (state === h.shown) continue;
      h.shown = state;
      changed = true;
      if (state < 0) {
        this.hide(i);
        continue;
      }
      const s = state as LightState;
      rotation.setFromAxisAngle(UP, h.rotY);
      position
        .set(0, LAMP_Y[s], LENS_Z)
        .applyQuaternion(rotation)
        .add(scale.set(h.x, h.y, h.z));
      matrix.compose(position, rotation, scale.set(1, 1, 1));
      this.mesh.setMatrixAt(i, matrix);
      this.mesh.setColorAt(i, COLOURS[s]);
    }
    if (changed) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Aspect currently shown by head `i` (tests): 0 green, 1 amber, 2 red, −1 dark. */
  shown(i: number): number {
    return this.heads[i]?.shown ?? -1;
  }

  private hide(i: number): void {
    matrix.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(i, matrix);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
