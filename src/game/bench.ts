import { summarize, type SampleSummary } from '../core/stats';

export interface BenchMeta {
  scenario: string;
  preset: string;
  gpu: string;
  width: number;
  height: number;
  pixelRatio: number;
  userAgent: string;
  droppedSimSeconds: number;
}

export interface BenchResult extends BenchMeta {
  warmupSeconds: number;
  durationSeconds: number;
  frames: number;
  fps: number;
  frameMs: SampleSummary;
  cpuMs: SampleSummary;
  drawCalls: { mean: number; max: number };
  triangles: { mean: number; max: number };
  heapStartMB: number | null;
  heapEndMB: number | null;
  heapGrowthMBps: number | null;
}

type Phase = 'warmup' | 'recording' | 'done';

/** Tolerance for summed frame durations (e.g. 30 × 1/30 s is slightly below 1 s in floating point). */
const TIME_EPSILON = 1e-6;

/**
 * Records per-frame timings for a benchmark scenario: ignores a warm-up period (shader
 * compilation, streaming), then records for a fixed duration.
 */
export class BenchRecorder {
  private phase: Phase = 'warmup';
  private elapsed = 0;
  private count = 0;
  private readonly frameMs: Float32Array;
  private readonly cpuMs: Float32Array;
  private drawSum = 0;
  private drawMax = 0;
  private triSum = 0;
  private triMax = 0;
  private heapStart: number | null = null;
  private heapEnd: number | null = null;

  constructor(
    readonly warmupSeconds: number,
    readonly durationSeconds: number,
    maxFrames = 60_000,
  ) {
    this.frameMs = new Float32Array(maxFrames);
    this.cpuMs = new Float32Array(maxFrames);
  }

  get done(): boolean {
    return this.phase === 'done';
  }

  get recording(): boolean {
    return this.phase === 'recording';
  }

  frame(
    frameSeconds: number,
    cpuMs: number,
    drawCalls: number,
    triangles: number,
    heapMB: number | null,
  ): void {
    if (this.phase === 'done') return;
    this.elapsed += frameSeconds;
    if (this.phase === 'warmup') {
      if (this.elapsed >= this.warmupSeconds - TIME_EPSILON) {
        this.phase = 'recording';
        this.elapsed = 0;
        this.heapStart = heapMB;
      }
      return;
    }
    if (this.count < this.frameMs.length) {
      this.frameMs[this.count] = frameSeconds * 1000;
      this.cpuMs[this.count] = cpuMs;
      this.count++;
    }
    this.drawSum += drawCalls;
    this.drawMax = Math.max(this.drawMax, drawCalls);
    this.triSum += triangles;
    this.triMax = Math.max(this.triMax, triangles);
    if (this.elapsed >= this.durationSeconds - TIME_EPSILON) {
      this.phase = 'done';
      this.heapEnd = heapMB;
    }
  }

  result(meta: BenchMeta): BenchResult {
    const frameMs = summarize(this.frameMs, this.count);
    const n = Math.max(1, this.count);
    const heapGrowth =
      this.heapStart !== null && this.heapEnd !== null && this.elapsed > 0
        ? (this.heapEnd - this.heapStart) / this.elapsed
        : null;
    return {
      ...meta,
      warmupSeconds: this.warmupSeconds,
      durationSeconds: this.elapsed,
      frames: this.count,
      fps: frameMs.mean > 0 ? 1000 / frameMs.mean : 0,
      frameMs,
      cpuMs: summarize(this.cpuMs, this.count),
      drawCalls: { mean: this.drawSum / n, max: this.drawMax },
      triangles: { mean: this.triSum / n, max: this.triMax },
      heapStartMB: this.heapStart,
      heapEndMB: this.heapEnd,
      heapGrowthMBps: heapGrowth,
    };
  }
}
