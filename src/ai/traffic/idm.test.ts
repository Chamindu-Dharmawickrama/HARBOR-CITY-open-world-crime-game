import { describe, expect, it } from 'vitest';
import { approachSpeed, idmAccel, idmFree, stoppingDecel, type IdmParams } from './idm';

const P: IdmParams = { a: 2, b: 3, T: 1.4, s0: 2.5, delta: 4 };

describe('intelligent driver model', () => {
  it('accelerates toward the desired speed on a free road', () => {
    expect(idmFree(P, 0, 14)).toBeCloseTo(2);
    expect(idmFree(P, 14, 14)).toBeCloseTo(0);
    expect(idmFree(P, 18, 14)).toBeLessThan(0);
    expect(idmFree(P, 18, 14)).toBeGreaterThanOrEqual(-P.b);
  });

  it('follows a stopped leader and halts at the standstill gap without hitting it', () => {
    let v = 14;
    let x = 0;
    const leader = 120;
    const dt = 1 / 60;
    let minGap = Infinity;
    for (let t = 0; t < 40; t += dt) {
      const gap = leader - x;
      const a = idmAccel(P, v, 14, gap, v);
      v = Math.max(0, v + a * dt);
      x += v * dt;
      minGap = Math.min(minGap, leader - x);
    }
    expect(v).toBeLessThan(0.05);
    expect(minGap).toBeGreaterThan(P.s0 * 0.8);
    expect(minGap).toBeLessThan(P.s0 * 1.6);
  });

  it('keeps about the time headway behind a leader at constant speed', () => {
    let v = 10;
    let x = 0;
    let lead = 60;
    const dt = 1 / 60;
    for (let t = 0; t < 120; t += dt) {
      const a = idmAccel(P, v, 16, lead - x, v - 10);
      v = Math.max(0, v + a * dt);
      x += v * dt;
      lead += 10 * dt;
    }
    expect(v).toBeCloseTo(10, 1);
    const gap = lead - x;
    expect(gap).toBeGreaterThan(P.s0 + 10 * P.T * 0.9);
    expect(gap).toBeLessThan(P.s0 + 10 * P.T * 1.8);
  });

  it('computes stopping decelerations and approach speeds', () => {
    expect(stoppingDecel(10, 25)).toBeCloseTo(2);
    expect(stoppingDecel(0, 0)).toBe(0);
    expect(stoppingDecel(5, 0)).toBe(Infinity);
    expect(approachSpeed(7, 0, 3)).toBe(7);
    expect(approachSpeed(0, 24, 3)).toBeCloseTo(12);
  });
});
