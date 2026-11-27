import { RingBuffer } from './stats';

export interface ProfileEntry {
  name: string;
  avgMs: number;
  maxMs: number;
}

/**
 * Per-frame timing of named sections (systems). Sections get a numeric slot once; recording
 * into a slot is allocation-free. Fixed systems that run several times in a frame accumulate.
 */
export class Profiler {
  private readonly names: string[] = [];
  private readonly slotsByName = new Map<string, number>();
  private frameTotals = new Float64Array(16);
  private lastTotals = new Float64Array(16);
  /** Running totals since the last resetCumulative (benchmarks: whole-run averages per section). */
  private cumulative = new Float64Array(16);
  private cumulativeFrames = 0;
  private readonly history: RingBuffer[] = [];

  constructor(
    readonly now: () => number = () => performance.now(),
    private readonly historyLength = 120,
  ) {}

  slot(name: string): number {
    const existing = this.slotsByName.get(name);
    if (existing !== undefined) return existing;
    const slot = this.names.length;
    this.names.push(name);
    this.slotsByName.set(name, slot);
    this.history.push(new RingBuffer(this.historyLength));
    if (slot >= this.frameTotals.length) {
      const grown = new Float64Array(this.frameTotals.length * 2);
      grown.set(this.frameTotals);
      this.frameTotals = grown;
      const grownLast = new Float64Array(this.lastTotals.length * 2);
      grownLast.set(this.lastTotals);
      this.lastTotals = grownLast;
      const grownCumulative = new Float64Array(this.cumulative.length * 2);
      grownCumulative.set(this.cumulative);
      this.cumulative = grownCumulative;
    }
    return slot;
  }

  record(slot: number, milliseconds: number): void {
    this.frameTotals[slot] = this.frameTotals[slot] + milliseconds;
  }

  /** Commits this frame's totals into history and zeroes them. */
  endFrame(): void {
    for (let i = 0; i < this.names.length; i++) {
      this.history[i].push(this.frameTotals[i]);
      this.lastTotals[i] = this.frameTotals[i];
      this.cumulative[i] += this.frameTotals[i];
      this.frameTotals[i] = 0;
    }
    this.cumulativeFrames++;
  }

  /** Average and max per section over the history window, sorted by average descending. */
  report(): ProfileEntry[] {
    const entries: ProfileEntry[] = [];
    for (let i = 0; i < this.names.length; i++) {
      const ring = this.history[i];
      entries.push({ name: this.names[i], avgMs: ring.mean, maxMs: ring.max() });
    }
    return entries.sort((a, b) => b.avgMs - a.avgMs);
  }

  /** Per-section totals of the most recently committed frame, largest first (allocates; diagnostics only). */
  lastFrame(limit = 5): { name: string; ms: number }[] {
    return this.names
      .map((name, i) => ({ name, ms: this.lastTotals[i] }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, limit);
  }

  resetCumulative(): void {
    this.cumulative.fill(0);
    this.cumulativeFrames = 0;
  }

  /** Average ms per frame of each section since resetCumulative, largest first. */
  cumulativeReport(limit = 16): { name: string; avgMs: number }[] {
    const n = Math.max(1, this.cumulativeFrames);
    return this.names
      .map((name, i) => ({ name, avgMs: this.cumulative[i] / n }))
      .sort((a, b) => b.avgMs - a.avgMs)
      .slice(0, limit);
  }

  average(name: string): number {
    const slot = this.slotsByName.get(name);
    return slot === undefined ? 0 : this.history[slot].mean;
  }
}
