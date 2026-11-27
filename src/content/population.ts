import type { DensityCurves } from '../ai/density';
import type { Archetype, ArchetypeId } from '../ai/pedestrians/crowd';
import type { TrafficRules } from '../ai/traffic/traffic-manager';
import type { DistrictId } from '../world/gen/types';

/**
 * How full the streets are through the day, as a fraction of the quality preset's cap
 * (hour 0 … 23, interpolated in between). Downtown never sleeps; the docks work shifts; the
 * suburbs fill up in the morning and evening.
 */
export const DENSITY: DensityCurves = {
  peds: {
    //          0     1     2     3     4     5     6     7     8     9    10    11    12    13    14    15    16    17    18    19    20    21    22    23
    meridian: [
      0.45, 0.35, 0.25, 0.15, 0.12, 0.15, 0.3, 0.6, 0.85, 0.8, 0.75, 0.85, 1.0, 0.95, 0.8, 0.8, 0.9, 1.0,
      0.95, 0.85, 0.8, 0.75, 0.7, 0.55,
    ],
    gantry: [
      0.15, 0.1, 0.08, 0.08, 0.15, 0.4, 0.75, 0.9, 0.85, 0.8, 0.8, 0.8, 0.85, 0.8, 0.8, 0.8, 0.75, 0.6, 0.35,
      0.25, 0.2, 0.18, 0.15, 0.15,
    ],
    linden: [
      0.1, 0.06, 0.04, 0.03, 0.05, 0.12, 0.35, 0.6, 0.55, 0.45, 0.5, 0.55, 0.6, 0.55, 0.5, 0.55, 0.65, 0.75,
      0.7, 0.55, 0.4, 0.3, 0.2, 0.14,
    ],
  },
  cars: {
    meridian: [
      0.4, 0.3, 0.22, 0.18, 0.2, 0.3, 0.55, 0.85, 1.0, 0.85, 0.75, 0.75, 0.8, 0.8, 0.75, 0.8, 0.9, 1.0, 0.95,
      0.8, 0.65, 0.6, 0.55, 0.45,
    ],
    gantry: [
      0.25, 0.2, 0.18, 0.2, 0.3, 0.5, 0.8, 0.95, 0.9, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.8, 0.7, 0.5,
      0.4, 0.35, 0.3, 0.28, 0.25,
    ],
    linden: [
      0.15, 0.1, 0.08, 0.08, 0.1, 0.25, 0.55, 0.85, 0.75, 0.5, 0.45, 0.45, 0.5, 0.45, 0.45, 0.55, 0.75, 0.85,
      0.7, 0.5, 0.4, 0.3, 0.22, 0.18,
    ],
  },
};

export const ARCHETYPES: Readonly<Record<ArchetypeId, Archetype>> = {
  commuter: {
    id: 'commuter',
    speed: [1.35, 1.6],
    destinations: ['work', 'home', 'shop'],
    dwell: [2, 6],
    group: 0.05,
  },
  shopper: {
    id: 'shopper',
    speed: [1.05, 1.35],
    destinations: ['shop', 'shop', 'park'],
    dwell: [5, 14],
    group: 0.3,
  },
  jogger: { id: 'jogger', speed: [2.9, 3.5], destinations: [], dwell: [1, 3], group: 0.1 },
  dockWorker: {
    id: 'dockWorker',
    speed: [1.2, 1.45],
    destinations: ['dock', 'dock', 'work'],
    dwell: [4, 12],
    group: 0.15,
  },
  nightCrowd: {
    id: 'nightCrowd',
    speed: [1.0, 1.3],
    destinations: ['nightlife', 'shop', 'park'],
    dwell: [8, 20],
    group: 0.45,
  },
};

/** Archetype mix per district, by day (07–19) and by night. */
export const ARCHETYPE_MIX: Readonly<
  Record<
    DistrictId,
    {
      day: Readonly<Partial<Record<ArchetypeId, number>>>;
      night: Readonly<Partial<Record<ArchetypeId, number>>>;
    }
  >
> = {
  meridian: {
    day: { commuter: 4, shopper: 4, jogger: 0.6 },
    night: { nightCrowd: 5, commuter: 1, shopper: 1 },
  },
  gantry: { day: { dockWorker: 6, commuter: 2, jogger: 0.3 }, night: { dockWorker: 2, commuter: 1 } },
  linden: { day: { shopper: 3, commuter: 2, jogger: 2 }, night: { commuter: 2, jogger: 1, nightCrowd: 1 } },
};

export const TRAFFIC_RULES: TrafficRules = {
  models: {
    meridian: {
      brisa: 3,
      meridian: 4,
      cab: 3,
      vireo: 0.6,
      brakker: 0.5,
      courier: 1.2,
      haul: 0.6,
      linewalker: 0.4,
    },
    gantry: { haul: 3, courier: 3, brakker: 1, meridian: 1.5, brisa: 1.5, linewalker: 0.3 },
    linden: { brisa: 4, meridian: 2.5, haul: 2, brakker: 1, vireo: 0.5, cab: 0.4 },
  },
  majorRoadOnly: ['linewalker'],
};
