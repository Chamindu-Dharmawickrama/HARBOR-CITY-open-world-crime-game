import { describe, expect, it } from 'vitest';
import { formatHours, parseHours, sampleHourly, TimeOfDay, wrapHours } from './time-of-day';

describe('time of day', () => {
  it('advances one game minute per second by default and wraps at midnight', () => {
    const t = new TimeOfDay(23.5);
    t.advance(1);
    expect(t.hours).toBeCloseTo(23.5 + 1 / 60, 6);
    t.advance(30);
    expect(t.hours).toBeCloseTo(0.0167, 3);
    expect(t.day).toBe(1);
  });

  it('formats, parses and wraps hours', () => {
    expect(formatHours(7.25)).toBe('07:15');
    expect(formatHours(24)).toBe('00:00');
    expect(formatHours(-1)).toBe('23:00');
    expect(parseHours('17:30')).toBeCloseTo(17.5);
    expect(parseHours('3')).toBe(3);
    expect(parseHours('25:00')).toBeNull();
    expect(parseHours('noon')).toBeNull();
    expect(wrapHours(49)).toBe(1);
  });

  it('samples hourly curves with interpolation across midnight', () => {
    const curve = Array.from({ length: 24 }, (_, h) => h);
    expect(sampleHourly(curve, 5)).toBe(5);
    expect(sampleHourly(curve, 5.5)).toBeCloseTo(5.5);
    expect(sampleHourly(curve, 23.5)).toBeCloseTo(11.5);
    expect(() => sampleHourly([1, 2], 0)).toThrow();
  });
});
