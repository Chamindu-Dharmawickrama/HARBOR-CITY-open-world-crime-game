import { describe, expect, it } from 'vitest';
import { FixedStepAccumulator, GameLoop, type FrameScheduler, type LoopCallbacks } from './loop';
import { SimClock } from './sim-clock';

describe('FixedStepAccumulator', () => {
  it('runs whole steps and carries the remainder as alpha', () => {
    const acc = new FixedStepAccumulator(0.01, 10);
    expect(acc.advance(0.025)).toBe(2);
    expect(acc.alpha).toBeCloseTo(0.5);
    expect(acc.advance(0.005)).toBe(1);
    expect(acc.alpha).toBeCloseTo(0, 6);
  });

  it('caps steps per frame and records dropped time', () => {
    const acc = new FixedStepAccumulator(1 / 60, 5);
    expect(acc.advance(1)).toBe(5);
    expect(acc.droppedSeconds).toBeGreaterThan(0.8);
    expect(acc.alpha).toBeLessThan(1);
  });

  it('total steps match elapsed time over many uneven frames', () => {
    const acc = new FixedStepAccumulator(1 / 60, 5);
    let steps = 0;
    const frames = [0.016, 0.017, 0.0165, 0.033, 0.008, 0.02];
    let elapsed = 0;
    for (let i = 0; i < 600; i++) {
      const f = frames[i % frames.length];
      elapsed += f;
      steps += acc.advance(f);
    }
    expect(Math.abs(steps - elapsed * 60)).toBeLessThanOrEqual(1);
  });

  it('ignores zero and negative frames', () => {
    const acc = new FixedStepAccumulator();
    expect(acc.advance(0)).toBe(0);
    expect(acc.advance(-1)).toBe(0);
  });
});

function manualScheduler(): FrameScheduler & { fire(time: number): void } {
  let pending: ((t: number) => void) | null = null;
  return {
    request(cb) {
      pending = cb;
      return 1;
    },
    cancel() {
      pending = null;
    },
    fire(time) {
      const cb = pending;
      pending = null;
      cb?.(time);
    },
  };
}

function recordingCallbacks(): LoopCallbacks & { steps: number; renders: number; errors: unknown[] } {
  return {
    steps: 0,
    renders: 0,
    errors: [],
    beginFrame() {},
    fixedUpdate() {
      this.steps++;
    },
    renderUpdate() {
      this.renders++;
    },
    onError(error) {
      this.errors.push(error);
    },
  };
}

describe('GameLoop', () => {
  it('runs steps for elapsed time and renders every frame', () => {
    const callbacks = recordingCallbacks();
    const scheduler = manualScheduler();
    const loop = new GameLoop(callbacks, scheduler);
    loop.start();
    scheduler.fire(0);
    for (let i = 1; i <= 60; i++) scheduler.fire(i * (1000 / 60));
    expect(callbacks.renders).toBe(61);
    expect(callbacks.steps).toBeGreaterThanOrEqual(59);
    expect(callbacks.steps).toBeLessThanOrEqual(60);
  });

  it('time scale slows the simulation', () => {
    const callbacks = recordingCallbacks();
    const loop = new GameLoop(callbacks, manualScheduler());
    loop.timeScale = 0.5;
    loop.tick(0);
    for (let i = 1; i <= 60; i++) loop.tick(i * (1000 / 60));
    expect(callbacks.steps).toBeGreaterThanOrEqual(29);
    expect(callbacks.steps).toBeLessThanOrEqual(30);
  });

  it('pause stops steps; stepOnce advances exactly N', () => {
    const callbacks = recordingCallbacks();
    const loop = new GameLoop(callbacks, manualScheduler());
    loop.setPaused(true);
    loop.tick(0);
    loop.tick(500);
    expect(callbacks.steps).toBe(0);
    loop.stepOnce(3);
    loop.tick(510);
    expect(callbacks.steps).toBe(3);
    loop.tick(520);
    expect(callbacks.steps).toBe(3);
    expect(callbacks.renders).toBe(4);
  });

  it('stops and reports errors from callbacks', () => {
    const scheduler = manualScheduler();
    const callbacks = recordingCallbacks();
    callbacks.renderUpdate = () => {
      throw new Error('boom');
    };
    const loop = new GameLoop(callbacks, scheduler);
    loop.start();
    scheduler.fire(0);
    expect(callbacks.errors).toHaveLength(1);
    expect(loop.isRunning).toBe(false);
  });

  it('clamps huge frame gaps (hidden tab)', () => {
    const callbacks = recordingCallbacks();
    const loop = new GameLoop(callbacks, manualScheduler());
    loop.tick(0);
    loop.tick(60_000);
    expect(callbacks.steps).toBeLessThanOrEqual(5);
  });
});

describe('SimClock', () => {
  it('derives time from ticks without drift', () => {
    const clock = new SimClock(1 / 60);
    for (let i = 0; i < 216_000; i++) clock.advance();
    expect(clock.tick).toBe(216_000);
    expect(clock.time).toBe(3600);
    clock.reset();
    expect(clock.time).toBe(0);
  });
});
