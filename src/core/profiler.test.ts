import { describe, expect, it } from 'vitest';
import { Profiler } from './profiler';

describe('Profiler', () => {
  it('accumulates within a frame and averages across frames', () => {
    let now = 0;
    const profiler = new Profiler(() => now, 4);
    const physics = profiler.slot('physics');
    const ai = profiler.slot('ai');
    expect(profiler.slot('physics')).toBe(physics);
    profiler.record(physics, 1);
    profiler.record(physics, 2);
    profiler.record(ai, 0.5);
    profiler.endFrame();
    profiler.record(physics, 1);
    profiler.endFrame();
    expect(profiler.average('physics')).toBe(2);
    expect(profiler.average('ai')).toBe(0.25);
    const report = profiler.report();
    expect(report[0]?.name).toBe('physics');
    expect(report[0]?.maxMs).toBe(3);
    now = 5;
    expect(profiler.now()).toBe(5);
  });

  it('reports the last committed frame, largest first', () => {
    const profiler = new Profiler(() => 0);
    profiler.record(profiler.slot('a'), 1);
    profiler.record(profiler.slot('b'), 4);
    profiler.endFrame();
    expect(profiler.lastFrame(1)).toEqual([{ name: 'b', ms: 4 }]);
  });

  it('grows past its initial slot capacity', () => {
    const profiler = new Profiler(() => 0);
    for (let i = 0; i < 40; i++) profiler.record(profiler.slot(`s${i}`), i);
    profiler.endFrame();
    expect(profiler.average('s39')).toBe(39);
  });
});
