import { describe, expect, it } from 'vitest';
import {
  addArmor,
  applyDamage,
  canSprint,
  createVitals,
  fallDamage,
  heal,
  revive,
  STAMINA,
  updateStamina,
} from './vitals';

const G = 20;
const speedFromHeight = (h: number): number => Math.sqrt(2 * G * h);

describe('damage and armour', () => {
  it('removes health and reports death', () => {
    const v = createVitals();
    expect(applyDamage(v, 30)).toEqual({ dealt: 30, absorbed: 0, died: false });
    expect(v.health).toBe(70);
    expect(applyDamage(v, 500).died).toBe(true);
    expect(v.health).toBe(0);
    expect(applyDamage(v, 10).dealt).toBe(0);
  });

  it('armour absorbs two thirds until depleted', () => {
    const v = createVitals();
    addArmor(v, 20);
    const r = applyDamage(v, 60);
    expect(r.absorbed).toBeCloseTo(20);
    expect(r.dealt).toBeCloseTo(40);
    expect(v.armor).toBeCloseTo(0);
    addArmor(v, 500);
    expect(v.armor).toBe(100);
    expect(applyDamage(v, 30, true).absorbed).toBe(0);
  });

  it('heal is capped and cannot revive; revive restores', () => {
    const v = createVitals();
    applyDamage(v, 50);
    heal(v, 80);
    expect(v.health).toBe(100);
    applyDamage(v, 200);
    heal(v, 50);
    expect(v.health).toBe(0);
    revive(v);
    expect(v.health).toBe(100);
  });
});

describe('stamina', () => {
  it('drains, exhausts, waits, then regenerates past the recovery threshold', () => {
    const v = createVitals();
    for (let i = 0; i < 600 && v.stamina > 0; i++) updateStamina(v, 1 / 60, 20);
    expect(v.stamina).toBe(0);
    expect(v.exhausted).toBe(true);
    expect(canSprint(v)).toBe(false);
    updateStamina(v, STAMINA.regenDelay / 2, 0);
    expect(v.stamina).toBe(0);
    for (let i = 0; i < 120; i++) updateStamina(v, 1 / 60, 0);
    expect(v.stamina).toBeGreaterThanOrEqual(STAMINA.recoverThreshold);
    expect(v.exhausted).toBe(false);
    expect(canSprint(v)).toBe(true);
  });
});

describe('fall damage', () => {
  it('is zero for short drops, hurts at 10 m, kills at 30 m', () => {
    expect(fallDamage(speedFromHeight(2), G)).toBe(0);
    const ten = fallDamage(speedFromHeight(10), G);
    expect(ten).toBeGreaterThan(20);
    expect(ten).toBeLessThan(60);
    expect(fallDamage(speedFromHeight(30), G)).toBeGreaterThan(100);
    expect(fallDamage(-5, G)).toBe(0);
  });

  it('a lethal fall kills even through full armour', () => {
    const v = createVitals();
    addArmor(v, 100);
    applyDamage(v, fallDamage(speedFromHeight(30), G), true);
    expect(v.health).toBe(0);
  });
});
