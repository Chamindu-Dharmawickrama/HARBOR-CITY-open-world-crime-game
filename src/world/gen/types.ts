import type { Polygon, Vec2 } from './geometry2d';

/** Static city description (authored data in src/content/city.ts). */

export type DistrictId = 'meridian' | 'gantry' | 'linden';

export type RoadClass = 'arterial' | 'street' | 'alley' | 'ring' | 'bridge' | 'tunnel';

export type LandUse =
  'tower' | 'midrise' | 'shop' | 'warehouse' | 'house' | 'park' | 'plaza' | 'parking' | 'yard';

/** Facade/roof style codes understood by the building material shader. */
export const FacadeStyle = {
  glass: 0,
  office: 1,
  brick: 2,
  shopfront: 3,
  industrial: 4,
  house: 5,
} as const;
export type FacadeStyleName = keyof typeof FacadeStyle;

export type RoofKind = 'flat' | 'gable' | 'sawtooth';

export interface IslandDef {
  center: readonly [number, number];
  halfSize: readonly [number, number];
  /** Superellipse exponent: 2 = ellipse, larger = boxier. */
  exponent: number;
  rotation: number;
  /** Coastline wobble as a fraction of radius. */
  coastNoise: number;
  baseHeight: number;
  /** Peak extra height of rolling hills (0 = flat). */
  hillHeight: number;
  hillScale: number;
}

export interface RoadGridDef {
  /** Grid rotation (radians). */
  orientation: number;
  blockSizeU: readonly [number, number];
  blockSizeV: readonly [number, number];
  /** Max perpendicular warp of grid lines in metres (0 = straight). */
  warp: number;
  warpScale: number;
  /** Every Nth grid line is an arterial. */
  arterialEvery: number;
  /** Probability that a street segment between crossings is removed (merging blocks). */
  cullChance: number;
  /** Inset of the waterfront ring road from the coastline (metres). */
  ringInset: number;
  /** Probability of adding an alley through a large block. */
  alleyChance: number;
}

export interface BuildingRules {
  /** Height range for ordinary buildings. */
  height: readonly [number, number];
  /** Height range for towers. */
  towerHeight: readonly [number, number];
  /** Towers cluster within this distance of the district centre. */
  towerRadius: number;
  floorHeight: number;
  setback: readonly [number, number];
  lotArea: readonly [number, number];
  styles: Partial<Record<FacadeStyleName, number>>;
  palette: readonly number[];
  roofPalette: readonly number[];
}

export interface PropRules {
  lampSpacing: number;
  hydrantSpacing: number;
  treeSpacing: number;
  binChance: number;
  billboardChance: number;
}

export interface DistrictDef {
  id: DistrictId;
  name: string;
  island: IslandDef;
  roads: RoadGridDef;
  landUse: Partial<Record<LandUse, number>>;
  buildings: BuildingRules;
  props: PropRules;
  sidewalkWidth: number;
  /** Ground colour used for open lots in this district (hex). */
  groundSurface: GroundSurfaceName;
}

export interface CrossingDef {
  id: string;
  name: string;
  kind: 'bridge' | 'tunnel';
  from: DistrictId;
  to: DistrictId;
  /** Inland endpoint on `from` and on `to` (world XZ). */
  a: readonly [number, number];
  b: readonly [number, number];
  lanesPerDirection: number;
  style: 'suspension' | 'truss' | 'immersed';
}

export interface CityDef {
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  waterLevel: number;
  chunkSize: number;
  districts: readonly DistrictDef[];
  crossings: readonly CrossingDef[];
  businessNames: readonly string[];
  billboardSlogans: readonly string[];
}

/** Ground surface codes understood by the ground material shader. */
export const GroundSurface = {
  grass: 0,
  asphalt: 1,
  sidewalk: 2,
  concrete: 3,
  gravel: 4,
  seawall: 5,
  lot: 6,
  tunnel: 7,
  steel: 8,
  plaza: 9,
} as const;
export type GroundSurfaceName = keyof typeof GroundSurface;

/* ---------------------------------------------------------------------------------------------
 * Generated layout
 * ------------------------------------------------------------------------------------------- */

export interface IslandShape {
  district: DistrictId;
  coast: Polygon;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
}

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  y: number;
  /** Ids of incident edges. */
  edges: number[];
}

export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  cls: RoadClass;
  lanesPerDirection: number;
  /** Carriageway width (kerb to kerb), metres. */
  width: number;
  speedLimit: number;
  district: DistrictId | null;
  /** For bridges: extra deck height at mid-span (parabolic arch). */
  arch: number;
  crossing: string | null;
}

/** Maximal run of edges between junctions/dead-ends (through degree-2 nodes). */
export interface RoadChain {
  id: number;
  nodes: number[];
  edges: number[];
  cls: RoadClass;
  width: number;
  lanesPerDirection: number;
}

export interface Junction {
  node: number;
  /** Convex intersection polygon on the ground. */
  polygon: Polygon;
  radius: number;
  signalized: boolean;
  /** How far each incident edge's road surface stops short of the node centre. */
  trims: { edge: number; distance: number }[];
}

export interface Block {
  id: number;
  district: DistrictId;
  /** Curb line (road side), CCW. */
  curb: Polygon;
  /** Property line (inside the sidewalk), CCW. */
  inner: Polygon;
  /** Road edge id bordering each curb edge (curb[i] → curb[i+1]). */
  curbEdges: number[];
  use: 'lots' | 'park' | 'plaza';
  /** Ground height at the block centre (sidewalk/plaza reference). */
  y: number;
}

export interface Lot {
  id: number;
  block: number;
  polygon: Polygon;
  use: LandUse;
}

export interface BuildingTier {
  footprint: Polygon;
  /** Height of the top of this tier above the building base. */
  top: number;
}

export interface BuildingSpec {
  id: number;
  lot: number;
  district: DistrictId;
  baseY: number;
  tiers: BuildingTier[];
  height: number;
  roof: RoofKind;
  style: FacadeStyleName;
  color: number;
  roofColor: number;
  floorHeight: number;
  bayWidth: number;
  seed: number;
  /** Ground floor shop sign text index (or -1). */
  sign: number;
  center: Vec2;
}

export type PropType =
  | 'lamp'
  | 'hydrant'
  | 'bin'
  | 'bench'
  | 'trafficLight'
  | 'tree'
  | 'billboard'
  | 'acUnit'
  | 'waterTank'
  | 'container'
  | 'crane'
  | 'bollard';

export interface PropSpec {
  id: number;
  type: PropType;
  x: number;
  y: number;
  z: number;
  rotY: number;
  /** Variant / colour index (meaning depends on type). */
  variant: number;
}

export interface SignSpec {
  id: number;
  x: number;
  y: number;
  z: number;
  rotY: number;
  width: number;
  height: number;
  /** Index into the sign atlas. */
  atlas: number;
  billboard: boolean;
}

export interface Hole {
  /** Convex CCW polygon removed from the terrain (tunnel trench). */
  polygon: Polygon;
  crossing: string;
}

export interface Pier {
  polygon: Polygon;
  y: number;
}

export interface LaneNode {
  id: number;
  x: number;
  y: number;
  z: number;
}

export interface Lane {
  id: number;
  /** Polyline node ids, in driving direction. */
  points: number[];
  edge: number;
  /** Lane index from the centre line (0 = innermost). */
  index: number;
  speedLimit: number;
  /** Lane ids this lane connects to at its end (through a junction). */
  next: number[];
  /** Junction node at the end (or -1 for a dead end). */
  junction: number;
  /** For connectors inside a junction: the signal phase group (or -1). */
  signalGroup: number;
  isConnector: boolean;
  /** Road chain this lane runs along (−1 for connectors). */
  chain: number;
  /** +1 along the chain's node order, −1 against it (0 for connectors). */
  dir: number;
  /** Neighbouring lane in the same direction toward the centre line / toward the kerb (or −1). */
  inner: number;
  outer: number;
  /** Distance from the road centre line to this lane's centre (m). */
  offset: number;
  /** Lane width (m). */
  width: number;
}

/** A crosswalk link of the sidewalk graph: where pedestrians cross a junction approach. */
export interface Crosswalk {
  id: number;
  /** Sidewalk node ids at both kerbs. */
  a: number;
  b: number;
  /** Junction node and the road edge being crossed. */
  junction: number;
  edge: number;
  signalized: boolean;
}

/** A traffic-light pole (prop) and the junction approach it controls. */
export interface SignalHead {
  prop: number;
  junction: number;
  edge: number;
}

export interface SidewalkNode {
  id: number;
  x: number;
  y: number;
  z: number;
  links: number[];
  /** Crossing links that require a walk signal at this junction (or -1). */
  crossingJunction: number;
}

export interface CityLayout {
  seed: number;
  islands: IslandShape[];
  nodes: RoadNode[];
  edges: RoadEdge[];
  chains: RoadChain[];
  junctions: Junction[];
  blocks: Block[];
  lots: Lot[];
  buildings: BuildingSpec[];
  props: PropSpec[];
  signs: SignSpec[];
  holes: Hole[];
  piers: Pier[];
  lanes: Lane[];
  laneNodes: LaneNode[];
  sidewalks: SidewalkNode[];
  crosswalks: Crosswalk[];
  signalHeads: SignalHead[];
  stats: Record<string, number>;
}
