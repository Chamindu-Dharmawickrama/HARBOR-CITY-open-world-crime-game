export const FIXED_STEP_SECONDS = 1 / 60;

/**
 * Pure fixed-timestep accumulator. Converts variable frame durations into a whole number of
 * fixed steps plus an interpolation factor `alpha` for rendering between the last two states.
 */
export class FixedStepAccumulator {
  accumulator = 0;
  alpha = 0;
  /** Simulation time discarded because a frame needed more than maxStepsPerFrame steps. */
  droppedSeconds = 0;

  constructor(
    readonly stepSeconds = FIXED_STEP_SECONDS,
    readonly maxStepsPerFrame = 5,
  ) {}

  /** Adds frame time and returns how many fixed steps to run now. */
  advance(frameSeconds: number): number {
    if (frameSeconds > 0) this.accumulator += frameSeconds;
    let steps = Math.floor(this.accumulator / this.stepSeconds + 1e-9);
    if (steps > this.maxStepsPerFrame) {
      const dropped = steps - this.maxStepsPerFrame;
      this.droppedSeconds += dropped * this.stepSeconds;
      this.accumulator -= dropped * this.stepSeconds;
      steps = this.maxStepsPerFrame;
    }
    this.accumulator = Math.max(0, this.accumulator - steps * this.stepSeconds);
    this.alpha = Math.min(1, this.accumulator / this.stepSeconds);
    return steps;
  }

  reset(): void {
    this.accumulator = 0;
    this.alpha = 0;
  }
}

export interface LoopCallbacks {
  /** Once per rendered frame, before any fixed steps (input sampling). */
  beginFrame(frameSeconds: number): void;
  /** Zero or more times per frame with a constant dt. */
  fixedUpdate(dt: number): void;
  /** Once per rendered frame after the fixed steps. */
  renderUpdate(alpha: number, frameSeconds: number): void;
  onError(error: unknown): void;
}

export interface FrameScheduler {
  request(callback: (timeMs: number) => void): number;
  cancel(handle: number): void;
}

export const browserFrameScheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/** Drives the accumulator from a frame scheduler. Supports pause, single-step and time scale. */
export class GameLoop {
  timeScale = 1;
  private paused = false;
  private pendingSingleSteps = 0;
  private running = false;
  private lastTimeMs: number | null = null;
  private handle = 0;
  /** Largest frame duration fed to the accumulator (avoids a burst after a tab was hidden). */
  maxFrameSeconds = 0.25;

  constructor(
    private readonly callbacks: LoopCallbacks,
    private readonly scheduler: FrameScheduler = browserFrameScheduler,
    readonly accumulator = new FixedStepAccumulator(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTimeMs = null;
    this.handle = this.scheduler.request(this.onFrame);
  }

  stop(): void {
    this.running = false;
    this.scheduler.cancel(this.handle);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.accumulator.reset();
  }

  /** While paused, runs exactly `count` fixed steps over the next frames. */
  stepOnce(count = 1): void {
    this.pendingSingleSteps += count;
  }

  /** Processes one frame at `timeMs`. Public so tests can drive the loop deterministically. */
  tick(timeMs: number): void {
    const frameSeconds =
      this.lastTimeMs === null ? 0 : Math.min((timeMs - this.lastTimeMs) / 1000, this.maxFrameSeconds);
    this.lastTimeMs = timeMs;
    const { callbacks, accumulator } = this;
    callbacks.beginFrame(frameSeconds);
    let steps: number;
    if (this.paused) {
      steps = Math.min(this.pendingSingleSteps, accumulator.maxStepsPerFrame);
      this.pendingSingleSteps -= steps;
    } else {
      steps = accumulator.advance(frameSeconds * this.timeScale);
    }
    for (let i = 0; i < steps; i++) callbacks.fixedUpdate(accumulator.stepSeconds);
    callbacks.renderUpdate(this.paused ? 1 : accumulator.alpha, frameSeconds);
  }

  private readonly onFrame = (timeMs: number): void => {
    if (!this.running) return;
    try {
      this.tick(timeMs);
    } catch (error) {
      this.running = false;
      this.callbacks.onError(error);
      return;
    }
    this.handle = this.scheduler.request(this.onFrame);
  };
}
