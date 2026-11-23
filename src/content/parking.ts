import type { ParkingRules } from '../vehicles/parked/parked-vehicles';

/** Which vehicles park in each district, and how full the streets are. */
export const PARKING_RULES: ParkingRules = {
  models: {
    meridian: { brisa: 3, meridian: 4, cab: 2, vireo: 1, courier: 1, sprint: 0.6 },
    gantry: { haul: 4, courier: 3, brakker: 1.5, meridian: 1, brisa: 1 },
    linden: { brisa: 4, meridian: 2, haul: 2, brakker: 1, sprint: 1 },
    boat: { gullwing: 1 },
  },
  occupancy: { lot: 0.55, curb: 0.32, boat: 0.7 },
  locked: 0.4,
  occupied: 0.08,
};
