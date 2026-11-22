import { describe, expect, it } from 'vitest';
import { ObjectPool, SlotAllocator } from './pool';

describe('ObjectPool', () => {
  it('reuses released objects and resets them', () => {
    const pool = new ObjectPool(
      () => ({ value: 0 }),
      (o) => {
        o.value = 0;
      },
    );
    const a = pool.acquire();
    a.value = 5;
    pool.release(a);
    const b = pool.acquire();
    expect(b).toBe(a);
    expect(b.value).toBe(0);
    expect(pool.createdCount).toBe(1);
    expect(pool.activeCount).toBe(1);
  });

  it('prewarm creates objects up front', () => {
    const pool = new ObjectPool(() => ({}));
    pool.prewarm(8);
    expect(pool.freeCount).toBe(8);
    for (let i = 0; i < 8; i++) pool.acquire();
    expect(pool.createdCount).toBe(8);
  });

  it('rejects unbalanced release', () => {
    const pool = new ObjectPool(() => ({}));
    expect(() => pool.release({})).toThrow();
  });
});

describe('SlotAllocator', () => {
  it('allocates until full then returns -1', () => {
    const slots = new SlotAllocator(3);
    expect([slots.allocate(), slots.allocate(), slots.allocate()]).toEqual([0, 1, 2]);
    expect(slots.allocate()).toBe(-1);
    expect(slots.usedCount).toBe(3);
  });

  it('reuses released slots LIFO and tracks the high-water mark', () => {
    const slots = new SlotAllocator(4);
    slots.allocate();
    const b = slots.allocate();
    slots.allocate();
    slots.release(b);
    expect(slots.isUsed(b)).toBe(false);
    expect(slots.allocate()).toBe(b);
    expect(slots.highWaterMark).toBe(3);
  });

  it('rejects releasing a free slot', () => {
    const slots = new SlotAllocator(2);
    expect(() => slots.release(0)).toThrow();
    const s = slots.allocate();
    slots.release(s);
    expect(() => slots.release(s)).toThrow();
  });
});
