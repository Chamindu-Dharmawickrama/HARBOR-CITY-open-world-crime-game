/**
 * Simulation clock. Advances only in fixed steps; time is derived from the tick count so it
 * never drifts. Simulation code reads time from here, never from Date/performance.
 */
export class SimClock {
  tick = 0;
  time = 0;

  constructor(readonly stepSeconds: number) {}

  advance(): void {
    this.tick++;
    this.time = this.tick * this.stepSeconds;
  }

  reset(): void {
    this.tick = 0;
    this.time = 0;
  }
}
