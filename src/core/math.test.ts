import { describe, expect, it } from 'vitest';
import {
  angleDelta,
  approach,
  clamp,
  damp,
  dampAngle,
  inverseLerp,
  lerp,
  remapClamped,
  smoothstep,
  stepCriticalSpring,
  wrapAngle,
} from './math';

describe('math', () => {
  it('clamp / lerp / inverseLerp / remap', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(inverseLerp(10, 20, 15)).toBe(0.5);
    expect(inverseLerp(3, 3, 3)).toBe(0);
    expect(remapClamped(150, 0, 100, 0, 1)).toBe(1);
    expect(remapClamped(50, 0, 100, 10, 20)).toBe(15);
  });

  it('smoothstep has zero slope at the edges', () => {
    expect(smoothstep(0, 1, 0)).toBe(0);
    expect(smoothstep(0, 1, 1)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(0, 1, 0.01)).toBeLessThan(0.001);
  });

  it('damp is frame-rate independent', () => {
    let a = 0;
    for (let i = 0; i < 60; i++) a = damp(a, 10, 4, 1 / 60);
    let b = 0;
    for (let i = 0; i < 30; i++) b = damp(b, 10, 4, 1 / 30);
    expect(a).toBeCloseTo(b, 6);
  });

  it('approach never overshoots', () => {
    expect(approach(0, 1, 0.3)).toBeCloseTo(0.3);
    expect(approach(0.9, 1, 0.3)).toBe(1);
    expect(approach(1, 0, 0.3)).toBeCloseTo(0.7);
  });

  it('wrapAngle maps into (-PI, PI]', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(Math.PI / 2 + 4 * Math.PI)).toBeCloseTo(Math.PI / 2);
    for (let a = -20; a < 20; a += 0.37) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThan(-Math.PI - 1e-9);
      expect(w).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });

  it('angleDelta takes the short way round', () => {
    expect(angleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
    expect(angleDelta(0.1, -0.1)).toBeCloseTo(-0.2);
    expect(dampAngle(Math.PI - 0.1, -Math.PI + 0.1, 1000, 1)).toBeCloseTo(Math.PI + 0.1);
  });

  it('critical spring converges without overshoot', () => {
    const state = { value: 0, velocity: 0 };
    let maxValue = 0;
    for (let i = 0; i < 240; i++) {
      stepCriticalSpring(state, 1, 8, 1 / 60);
      maxValue = Math.max(maxValue, state.value);
    }
    expect(state.value).toBeCloseTo(1, 4);
    expect(maxValue).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('critical spring is step-size independent', () => {
    const a = { value: 0, velocity: 0 };
    const b = { value: 0, velocity: 0 };
    for (let i = 0; i < 60; i++) stepCriticalSpring(a, 5, 6, 1 / 60);
    for (let i = 0; i < 120; i++) stepCriticalSpring(b, 5, 6, 1 / 120);
    expect(a.value).toBeCloseTo(b.value, 6);
  });
});
