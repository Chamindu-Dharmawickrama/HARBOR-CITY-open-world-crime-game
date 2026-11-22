import type { Clip } from './clip';
import { blendPoses, Pose } from './pose';

export interface BlendPoint {
  clip: Clip;
  /** Parameter value (e.g. ground speed in m/s) at which this clip plays at full weight. */
  at: number;
}

/**
 * 1D blend space with phase synchronisation: all cyclic clips are authored with the same
 * phase convention (left foot contact at t = 0), so a shared normalised phase keeps feet in step
 * while blending, e.g. walk ↔ run ↔ sprint.
 */
export class Blend1D {
  phase = 0;
  private readonly a = new Pose();
  private readonly b = new Pose();

  constructor(private readonly points: readonly BlendPoint[]) {
    if (points.length === 0) throw new Error('Blend1D needs at least one clip');
    for (let i = 1; i < points.length; i++) {
      if (points[i].at <= points[i - 1].at) throw new Error('Blend1D points must be increasing');
    }
  }

  /** Lower bracket index and blend weight for parameter `value`. */
  bracket(value: number): { index: number; weight: number } {
    const pts = this.points;
    if (value <= pts[0].at) return { index: 0, weight: 0 };
    for (let i = 0; i + 1 < pts.length; i++) {
      const lo = pts[i];
      const hi = pts[i + 1];
      if (value <= hi.at) return { index: i, weight: (value - lo.at) / (hi.at - lo.at) };
    }
    return { index: pts.length - 1, weight: 0 };
  }

  /** Advances the shared phase by dt and writes the blended pose. */
  update(value: number, dt: number, out: Pose): void {
    const { index, weight } = this.bracket(value);
    const lo = this.points[index];
    const hi = this.points[Math.min(index + 1, this.points.length - 1)];
    const duration = lo.clip.duration * (1 - weight) + hi.clip.duration * weight;
    if (duration > 0) this.phase = (this.phase + dt / duration) % 1;
    lo.clip.sample(this.phase * lo.clip.duration, this.a);
    if (weight <= 0 || lo === hi) {
      out.copy(this.a);
      return;
    }
    hi.clip.sample(this.phase * hi.clip.duration, this.b);
    blendPoses(this.a, this.b, weight, out);
  }
}
