/**
 * Named developer camera positions (yaw 0 looks north / -Z, positive yaw turns left/west).
 * Used by the `goto` console command, screenshot tests and the benchmark.
 */
export interface Viewpoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export const CITY_VIEWPOINTS = {
  downtown: { x: 600, y: 95, z: 960, yaw: 0.05, pitch: -0.3 },
  docks: { x: -760, y: 75, z: 930, yaw: 0, pitch: -0.32 },
  suburbs: { x: -60, y: 110, z: -140, yaw: 0.1, pitch: -0.36 },
  copperline: { x: -130, y: 32, z: 560, yaw: -0.15, pitch: -0.12 },
  halvard: { x: 470, y: 40, z: -180, yaw: Math.PI / 2, pitch: -0.16 },
  tunnel: { x: -600, y: 22, z: 175, yaw: 0, pitch: -0.32 },
  street: { x: 560, y: 4.5, z: 420, yaw: 0, pitch: 0 },
  overview: { x: -100, y: 1300, z: 1100, yaw: 0, pitch: -0.95 },
} satisfies Record<string, Viewpoint>;

/** Closed flythrough loop for the benchmark (x, y, z). */
export const FLYTHROUGH_PATH: readonly (readonly [number, number, number])[] = [
  [560, 70, 420],
  [330, 50, 60],
  [330, 45, -330],
  [-100, 60, -650],
  [-560, 40, -420],
  [-600, 45, 120],
  [-740, 55, 400],
  [-200, 40, 420],
  [200, 60, 420],
];
