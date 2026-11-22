import { describe, expect, it } from 'vitest';
import { cleanFaceOutline } from './blocks';
import { area, insetPolygonRobust, rectPolygon, signedArea, v2 } from './geometry2d';

describe('cleanFaceOutline', () => {
  it('keeps a clean rectangle unchanged with edge data aligned', () => {
    const rect = rectPolygon(0, 0, 100, 80);
    const out = cleanFaceOutline(rect, [1, 2, 3, 4], [10, 11, 12, 13]);
    expect(out?.poly).toEqual(rect);
    expect(out?.halfWidths).toEqual([1, 2, 3, 4]);
    expect(out?.edges).toEqual([10, 11, 12, 13]);
  });

  it('collapses short edges, including the wrap-around edge', () => {
    const poly = [v2(0, 0), v2(100, 0), v2(100, 80), v2(2, 80), v2(0, 78)];
    const out = cleanFaceOutline(poly, [1, 2, 3, 4, 5], [10, 11, 12, 13, 14]);
    expect(out?.poly).toHaveLength(4);
    expect(out?.edges).toEqual([10, 11, 12, 14]);
    const wrap = [v2(1, 0), v2(100, 0), v2(100, 80), v2(0, 80), v2(0, 2)];
    const out2 = cleanFaceOutline(wrap, [1, 2, 3, 4, 5], [10, 11, 12, 13, 14]);
    expect(out2?.poly).toHaveLength(4);
    expect(out2?.edges).toEqual([10, 11, 12, 13]);
    expect(signedArea(out2!.poly)).toBeGreaterThan(0);
  });

  it('chamfers acute corners so the outline can be inset', () => {
    const sliver = [v2(0, 0), v2(200, 0), v2(0, 40)];
    const out = cleanFaceOutline(sliver, [7, 7, 7], [1, 2, 3]);
    expect(out!.poly.length).toBeGreaterThan(3);
    expect(out!.edges).toContain(-1);
    const curb = insetPolygonRobust(out!.poly, out!.halfWidths);
    expect(curb).not.toBeNull();
    expect(area(curb!.polygon)).toBeGreaterThan(500);
  });
});
