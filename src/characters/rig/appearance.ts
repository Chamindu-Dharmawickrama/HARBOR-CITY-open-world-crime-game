import type { Rng } from '../../core/rng';
import type { BodyParams } from './skeleton-def';

export type HairStyle = 'short' | 'long' | 'bald' | 'cap';
export type TopStyle = 'tee' | 'longsleeve' | 'jacket';
export type BottomStyle = 'trousers' | 'shorts';

/** Everything that makes one character look different from another (all procedural). */
export interface CharacterAppearance {
  body: BodyParams;
  skin: number;
  hair: number;
  hairStyle: HairStyle;
  top: number;
  topStyle: TopStyle;
  bottom: number;
  bottomStyle: BottomStyle;
  shoes: number;
}

export const SKIN_TONES = [0xf1c8a8, 0xe0ac84, 0xc68a62, 0xa66d48, 0x7d4e32, 0x5a3523] as const;
export const HAIR_COLOURS = [0x1b1410, 0x3b2516, 0x6a4325, 0xa77b44, 0xcfae78, 0x8c8c8c] as const;
export const TOP_COLOURS = [
  0x2f4f6f, 0x8c2d2d, 0xd9d4c7, 0x2d5a3c, 0x3a3a3f, 0xc48a2c, 0x5b3f7a, 0x1f6f78, 0xe8e2d0, 0x6b2f3f,
] as const;
export const BOTTOM_COLOURS = [0x23262e, 0x3d4a5e, 0x5a4a36, 0x2e3b2c, 0x6f6c66, 0x1d2a45] as const;
export const SHOE_COLOURS = [0x141414, 0x4a3122, 0xe6e6e6, 0x6b1f1f, 0x2a2f3a] as const;

/** The player: a fixed, readable look (dark jacket, jeans) so they stand out from crowds later. */
export const PLAYER_APPEARANCE: CharacterAppearance = {
  body: { height: 1.8, build: 1.02 },
  skin: 0xc68a62,
  hair: 0x1b1410,
  hairStyle: 'short',
  top: 0x2b3442,
  topStyle: 'jacket',
  bottom: 0x3d4a5e,
  bottomStyle: 'trousers',
  shoes: 0x141414,
};

function pick<T>(rng: Rng, list: readonly T[]): T {
  return list[rng.int(0, list.length)];
}

/** A random civilian look (used by pedestrians in M4). */
export function randomAppearance(rng: Rng): CharacterAppearance {
  return {
    body: { height: rng.range(1.6, 1.95), build: rng.range(0.85, 1.25) },
    skin: pick(rng, SKIN_TONES),
    hair: pick(rng, HAIR_COLOURS),
    hairStyle: pick(rng, ['short', 'short', 'long', 'bald', 'cap'] as const),
    top: pick(rng, TOP_COLOURS),
    topStyle: pick(rng, ['tee', 'tee', 'longsleeve', 'jacket'] as const),
    bottom: pick(rng, BOTTOM_COLOURS),
    bottomStyle: rng.chance(0.18) ? 'shorts' : 'trousers',
    shoes: pick(rng, SHOE_COLOURS),
  };
}
