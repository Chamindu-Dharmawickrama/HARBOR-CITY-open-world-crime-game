/** Game hours advanced per simulated second by default: one game minute per real second. */
export const DEFAULT_GAME_HOURS_PER_SECOND = 1 / 60;

/**
 * The in-game 24 h clock. Advanced by the fixed step (sim time), so it pauses with the game and
 * scales with the time scale. `hours` is in [0, 24).
 */
export class TimeOfDay {
  hours: number;
  /** Game hours per simulated second (0 freezes the clock). */
  rate: number;
  /** Whole days elapsed since the start. */
  day = 0;

  constructor(hours = 9, rate = DEFAULT_GAME_HOURS_PER_SECOND) {
    this.hours = wrapHours(hours);
    this.rate = rate;
  }

  advance(dt: number): void {
    const next = this.hours + this.rate * dt;
    if (next >= 24) this.day += Math.floor(next / 24);
    this.hours = wrapHours(next);
  }

  set(hours: number): void {
    this.hours = wrapHours(hours);
  }

  /** "HH:MM". */
  format(): string {
    return formatHours(this.hours);
  }
}

export function wrapHours(hours: number): number {
  const h = hours % 24;
  return h < 0 ? h + 24 : h;
}

export function formatHours(hours: number): string {
  const total = Math.floor(wrapHours(hours) * 60 + 1e-6);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Parses "HH", "HH:MM" or a decimal hour; returns null when invalid. */
export function parseHours(text: string): number | null {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(text.trim());
  if (match) {
    const h = Number(match[1]);
    const m = match[2] === undefined ? 0 : Number(match[2]);
    if (h > 23 || m > 59) return null;
    return h + m / 60;
  }
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value < 24 ? value : null;
}

/**
 * Samples a 24-entry hourly curve (value at the start of each hour) with linear interpolation
 * between hours, wrapping at midnight.
 */
export function sampleHourly(curve: readonly number[], hours: number): number {
  if (curve.length !== 24) throw new Error('sampleHourly: curve needs 24 entries');
  const h = wrapHours(hours);
  const i = Math.floor(h);
  const t = h - i;
  return curve[i] * (1 - t) + curve[(i + 1) % 24] * t;
}
