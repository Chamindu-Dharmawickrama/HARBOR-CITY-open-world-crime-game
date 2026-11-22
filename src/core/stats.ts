export interface SampleSummary {
  count: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

/** Linear-interpolated percentile of an already sorted array (p in [0, 100]). */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const rank = (Math.min(Math.max(p, 0), 100) / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.min(lo + 1, n - 1);
  const t = rank - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

/** Summary statistics over the first `count` entries of `samples` (defaults to all). */
export function summarize(samples: ArrayLike<number>, count = samples.length): SampleSummary {
  const n = Math.min(count, samples.length);
  if (n === 0) return { count: 0, mean: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
  const sorted = Float64Array.from({ length: n }, (_, i) => samples[i]).sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  return {
    count: n,
    mean: sum / n,
    min: sorted[0],
    max: sorted[n - 1],
    p50: percentileSorted(sorted, 50),
    p95: percentileSorted(sorted, 95),
    p99: percentileSorted(sorted, 99),
  };
}

/** Fixed-size ring buffer of numbers with O(1) push and running sum. */
export class RingBuffer {
  readonly values: Float32Array;
  private head = 0;
  private filled = 0;
  private sum = 0;

  constructor(readonly capacity: number) {
    this.values = new Float32Array(capacity);
  }

  push(value: number): void {
    if (this.filled === this.capacity) this.sum -= this.values[this.head];
    else this.filled++;
    this.values[this.head] = value;
    this.sum += value;
    this.head = (this.head + 1) % this.capacity;
  }

  get size(): number {
    return this.filled;
  }

  get mean(): number {
    return this.filled === 0 ? 0 : this.sum / this.filled;
  }

  max(): number {
    let m = 0;
    for (let i = 0; i < this.filled; i++) m = Math.max(m, this.values[i]);
    return m;
  }

  /** i = 0 is the oldest sample. */
  at(i: number): number {
    const start = this.filled === this.capacity ? this.head : 0;
    return this.values[(start + i) % this.capacity];
  }

  clear(): void {
    this.head = 0;
    this.filled = 0;
    this.sum = 0;
  }
}
