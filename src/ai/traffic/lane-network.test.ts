import { beforeAll, describe, expect, it } from 'vitest';
import { CITY } from '../../content/city';
import { generateCity } from '../../world/gen/city-layout';
import type { CityLayout } from '../../world/gen/types';
import { createLanePoint, LaneNetwork, segmentDistance, STOP_LINE_BACK, Turn } from './lane-network';

let layout: CityLayout;
let net: LaneNetwork;

beforeAll(() => {
  layout = generateCity(CITY, 74613).layout;
  net = new LaneNetwork(layout);
});

describe('lane network', () => {
  it('chains lanes end to start and samples/projects consistently', () => {
    const a = createLanePoint();
    const b = createLanePoint();
    let worst = 0;
    for (let lane = 0; lane < net.count; lane++) {
      net.sample(lane, net.length[lane], a);
      for (const next of net.next[lane]) {
        net.sample(next, 0, b);
        worst = Math.max(worst, Math.hypot(a.x - b.x, a.z - b.z));
      }
    }
    expect(worst).toBeLessThan(0.05);
    const proj = { s: 0, lat: 0, dist: 0 };
    for (const lane of net.spawnLanes.slice(0, 200)) {
      const s = net.length[lane] * 0.37;
      net.sample(lane, s, a);
      // A point 1 m to the right of travel projects back with lat = +1.
      net.project(lane, a.x - a.dz, a.z + a.dx, proj);
      expect(proj.s).toBeCloseTo(s, 1);
      expect(proj.lat).toBeCloseTo(1, 1);
    }
  });

  it('puts a stop line before every controlled junction and gives signalled approaches a phase', () => {
    let approaches = 0;
    for (let c = 0; c < net.count; c++) {
      if (!net.connector[c] || net.junction[c] < 0) continue;
      const src = net.source[c];
      expect(src).toBeGreaterThanOrEqual(0);
      if (net.internal[src]) continue; // internal links are driven through without stopping
      expect(net.stopS[src]).toBeGreaterThan(0);
      expect(net.stopS[src]).toBeLessThanOrEqual(Math.max(0.5, net.length[src] - STOP_LINE_BACK) + 1e-3);
      const control = net.junctions[net.junction[c]];
      if (control.signalized) {
        expect(net.signal[src]).toBe(control.signal);
        expect([0, 1, 2]).toContain(net.phase[src]);
        expect(net.phase[src]).toBeLessThan(net.signals[net.signal[src]].timing.green.length);
      }
      approaches++;
    }
    expect(approaches).toBeGreaterThan(1000);
    expect(net.signals.length).toBe(layout.junctions.filter((j) => j.signalized).length);
  });

  it('finds symmetric conflicts, including every pair of crossing paths', () => {
    let crossingPairs = 0;
    for (const control of net.junctions) {
      for (const a of control.connectors) {
        for (const b of net.conflicts[a]) expect(net.conflicts[b]).toContain(a);
        for (const b of control.connectors) {
          if (a >= b || net.source[a] === net.source[b]) continue;
          // Geometric crossing (segments intersect) must be a conflict.
          const pa = net.pointRange(a);
          const pb = net.pointRange(b);
          let crosses = false;
          for (let i = 0; i < pa.count - 1 && !crosses; i++) {
            for (let k = 0; k < pb.count - 1 && !crosses; k++) {
              const d = segmentDistance(
                net.pointX(pa.start + i),
                net.pointZ(pa.start + i),
                net.pointX(pa.start + i + 1),
                net.pointZ(pa.start + i + 1),
                net.pointX(pb.start + k),
                net.pointZ(pb.start + k),
                net.pointX(pb.start + k + 1),
                net.pointZ(pb.start + k + 1),
              );
              if (d === 0) crosses = true;
            }
          }
          if (crosses) {
            crossingPairs++;
            expect(net.conflicts[a]).toContain(b);
          }
        }
      }
    }
    expect(crossingPairs).toBeGreaterThan(500);
  });

  it('classifies turns and ranks straight major-road movements highest', () => {
    const turns = [0, 0, 0, 0];
    for (let c = 0; c < net.count; c++) if (net.connector[c]) turns[net.turn[c]]++;
    expect(turns[Turn.straight]).toBeGreaterThan(100);
    expect(turns[Turn.left]).toBeGreaterThan(100);
    expect(turns[Turn.right]).toBeGreaterThan(100);
    const straightMajor = [...Array(net.count).keys()].find(
      (c) => net.connector[c] && net.turn[c] === Turn.straight && net.rank[c] === 2,
    );
    const leftMinor = [...Array(net.count).keys()].find(
      (c) => net.connector[c] && net.turn[c] === Turn.left && net.rank[c] === 1,
    );
    expect(net.priority(straightMajor ?? 0)).toBeGreaterThan(net.priority(leftMinor ?? 0));
  });

  it('locates lanes near a point', () => {
    const lane = net.spawnLanes[10];
    const p = net.sample(lane, 5, createLanePoint());
    const found = net.lanesNear(p.x, p.z, 3, []);
    expect(found).toContain(lane);
  });
});
