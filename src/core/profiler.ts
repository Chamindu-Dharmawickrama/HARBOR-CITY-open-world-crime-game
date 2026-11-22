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
      this.frameTotals[i] = 0;
    }
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

  average(name: string): number {
    const slot = this.slotsByName.get(name);
    return slot === undefined ? 0 : this.history[slot].mean;
  }
}
