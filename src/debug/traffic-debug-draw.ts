import * as THREE from 'three';
import type { Crowd } from '../ai/pedestrians/crowd';
import type { SidewalkNav } from '../ai/pedestrians/sidewalk-nav';
import type { LaneNetwork } from '../ai/traffic/lane-network';
import { Light } from '../ai/traffic/signals';
import type { TrafficManager } from '../ai/traffic/traffic-manager';

const RADIUS = 130;
const MAX_SEGMENTS = 30_000;

/**
 * Debug lines around the camera: lanes (grey), junction connectors (cyan; red while occupied),
 * stop lines coloured by their light, internal links (violet), and each pedestrian's route
 * (yellow). Rebuilt a few times a second while enabled.
 */
export class TrafficDebugDraw {
  enabled = false;
  private readonly lines: THREE.LineSegments;
  private readonly positions = new Float32Array(MAX_SEGMENTS * 6);
  private readonly colors = new Float32Array(MAX_SEGMENTS * 6);
  private timer = 0;
  private readonly near: number[] = [];

  constructor(
    private readonly net: LaneNetwork,
    private readonly nav: SidewalkNav,
    private readonly traffic: TrafficManager,
    private readonly crowd: Crowd,
    scene: THREE.Scene,
  ) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 999;
    this.lines.visible = false;
    scene.add(this.lines);
  }

  update(x: number, z: number, dt: number): void {
    this.lines.visible = this.enabled;
    if (!this.enabled) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.2;
    let n = 0;
    const seg = (
      ax: number,
      ay: number,
      az: number,
      bx: number,
      by: number,
      bz: number,
      r: number,
      g: number,
      b: number,
    ): void => {
      if (n >= MAX_SEGMENTS) return;
      const o = n * 6;
      this.positions.set([ax, ay + 0.3, az, bx, by + 0.3, bz], o);
      this.colors.set([r, g, b, r, g, b], o);
      n++;
    };
    const net = this.net;
    const sim = this.traffic.sim;
    for (const lane of net.lanesNear(x, z, RADIUS, this.near)) {
      const { start, count } = net.pointRange(lane);
      const busy = net.connector[lane] && sim.occupancy[lane] > 0;
      const [r, g, b] = net.connector[lane]
        ? busy
          ? [1, 0.2, 0.2]
          : [0.2, 0.8, 0.9]
        : net.internal[lane]
          ? [0.7, 0.4, 1]
          : [0.55, 0.55, 0.55];
      for (let i = 0; i < count - 1; i++) {
        seg(
          net.pointX(start + i),
          net.pointY(start + i),
          net.pointZ(start + i),
          net.pointX(start + i + 1),
          net.pointY(start + i + 1),
          net.pointZ(start + i + 1),
          r,
          g,
          b,
        );
      }
      if (!net.connector[lane] && net.stopS[lane] > 0) {
        const p = net.sample(lane, net.stopS[lane], { x: 0, y: 0, z: 0, dx: 0, dz: 1 });
        const light = sim.lightFor(lane);
        const c =
          light === Light.green ? [0.2, 1, 0.3] : light === Light.amber ? [1, 0.7, 0.1] : [1, 0.15, 0.1];
        seg(
          p.x + p.dz * 1.5,
          p.y,
          p.z - p.dx * 1.5,
          p.x - p.dz * 1.5,
          p.y,
          p.z + p.dx * 1.5,
          c[0],
          c[1],
          c[2],
        );
      }
    }
    const nav = this.nav;
    for (const p of this.crowd.peds) {
      for (let i = Math.max(0, p.index); i < p.path.length - 1; i++) {
        const a = p.path[i];
        const b = p.path[i + 1];
        seg(nav.x[a], nav.y[a], nav.z[a], nav.x[b], nav.y[b], nav.z[b], 1, 0.9, 0.2);
      }
    }
    const geometry = this.lines.geometry;
    geometry.setDrawRange(0, n * 2);
    (geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }
}
