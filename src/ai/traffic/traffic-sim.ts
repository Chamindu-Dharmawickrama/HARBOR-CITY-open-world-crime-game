import { Rng } from '../../core/rng';
import { approachSpeed, idmAccel, idmFree, stoppingDecel, type IdmParams } from './idm';
import { createLanePoint, type LaneNetwork, type LanePoint, type LaneProjection, Turn } from './lane-network';
import type { ObstacleField } from './obstacles';
import { Light, lightAt, timeToChange, type LightState } from './signals';

/** How one driver drives. */
export interface DriverProfile {
  /** Multiplier on the lane speed limit. */
  speedFactor: number;
  idm: IdmParams;
  /** Smallest time gap (s) accepted in front of priority traffic at junctions. */
  gap: number;
}

export interface TrafficStats {
  /** Cars that drove past a stop line on red. */
  redLightViolations: number;
  /** Stop-line crossings on amber / green. */
  amberCrossings: number;
  greenCrossings: number;
  /** Junction admissions granted, and connector entries without an admission (should stay 0). */
  admissions: number;
  forcedEntries: number;
  laneChanges: number;
  /** Longest time any car has stood still (s), and stood still while not held by a red light (s). */
  maxStationary: number;
  maxStalled: number;
  /** Cars flagged as stuck by the gridlock detector. */
  gridlocked: number;
  /** Metres driven by all cars. */
  distance: number;
}

/** Seconds stalled (standing still, not held by a red light) before a car is flagged as gridlocked. */
export const GRIDLOCK_SECONDS = 40;
/** Comfortable braking used to plan speed changes ahead (m/s²). */
const PLAN_DECEL = 2.2;
/** Amber: stop if this deceleration suffices, otherwise go (m/s²). */
const AMBER_STOP_DECEL = 4.5;
/** Admitted when the light changed: give the admission back if this deceleration stops the car. */
const RED_MAX_DECEL = 7;
const STOP_GAP = 0.6;
const LANE_SHIFT_RATE = 1.1;
const SAMPLE_STEP = 2.5;
const MAX_SAMPLES = 28;
/** Lanes planned ahead (enough to see a whole chain of junctions joined by internal links). */
const ROUTE_AHEAD = 24;
/** Junction chains joined by internal links are admitted together, up to this many connectors. */
const MAX_GATES = 12;
/** Waiting this long at the line makes a car claim its junction conflict zone (s). */
const STARVE_SECONDS = 8;

/** One car in the traffic model: a position along its lane plus the plan ahead. */
export class TrafficCar {
  /** Current lane, distance of the car's centre along it (m), speed (m/s). */
  lane = -1;
  s = 0;
  v = 0;
  /** Lateral offset from the lane centre (+ = right), and where it is heading (lane changes, pulling over). */
  lat = 0;
  latTarget = 0;
  /** Lanes to drive after the current one. */
  readonly route: number[] = [];
  /**
   * Connectors this car may enter, in route order (each counted in its occupancy until the car's
   * rear has left it). More than one when junctions are joined by internal links.
   */
  readonly admits: number[] = [];
  /** Connectors driven off whose admission is kept until the car's rear is clear of them. */
  readonly clearing: number[] = [];
  /** Committed to cross on amber at this connector. */
  amberCommit = -1;
  /** Commanded acceleration from the last decision (m/s²). */
  accel = 0;
  /** Seconds below 0.3 m/s, and seconds waiting for a junction admission at the line. */
  stationary = 0;
  /** Seconds stood still while not held by a red light (gridlock measure). */
  stalled = 0;
  waitAtLine = 0;
  /** Next junction gates on the route (chained through internal links) and their stop distances. */
  readonly gates: number[] = [];
  readonly gateDistances: number[] = [];
  /** Approach lane of the first gate. */
  gateApproach = -1;
  /** Distance from the front bumper to the stop line of the first gate (Infinity = none). */
  stopDistance = Infinity;
  /** Light ahead (for brake lights / debug). */
  light: LightState = Light.green;
  /** Physics-driven: s and v are measured by the owner (`track`), not integrated here. */
  physics = false;
  /** Must come to a stop (carjacking, shaken after a crash). */
  hold = false;
  /** Seconds left pulling over to the kerb for a siren. */
  pullOver = 0;
  /** Desired-speed multiplier (fleeing gunfire). */
  urgency = 1;
  /** Seconds stopped behind something that is not traffic (honking, giving up). */
  blockedByObstacle = 0;
  /** Whether the obstacle blocking the car is a vehicle (honk) or a person (wait). */
  obstacleIsVehicle = false;
  /** What the car is waiting for: '' | 'leader' | 'light' | 'junction' | 'obstacle' | 'hold' | 'siren'. */
  reason = '';
  /** Turn signal: −1 left, 1 right, 0 off; seconds it stays on after a lane change. */
  indicator = 0;
  indicatorTime = 0;
  stuck = false;
  laneChangeTimer = 0;
  /** Lane the front last crossed the stop line on, and the light at that moment. */
  private crossLane = -1;
  private crossLight: LightState = Light.green;
  readonly stopIdm: IdmParams;
  readonly rng: Rng;

  constructor(
    readonly id: number,
    readonly length: number,
    readonly width: number,
    readonly profile: DriverProfile,
    seed: number,
  ) {
    this.stopIdm = { ...profile.idm, s0: STOP_GAP };
    this.rng = new Rng(seed);
    this.laneChangeTimer = this.rng.range(0, 1);
  }

  get front(): number {
    return this.s + this.length / 2;
  }

  get gate(): number {
    return this.gates.length > 0 ? this.gates[0] : -1;
  }

  admittedTo(connector: number): boolean {
    return this.admits.includes(connector);
  }

  /**
   * Stop-line bookkeeping: 3 = crossed on green, 2 = on amber, 1 = ran a red light (more than a
   * small overshoot past the line after reaching it on red), 0 = nothing happened.
   */
  checkStopLine(lane: number, prevFront: number, front: number, stopS: number, light: LightState): number {
    if (prevFront < stopS && front >= stopS) {
      this.crossLane = lane;
      this.crossLight = light;
      return light === Light.red ? 0 : light === Light.amber ? 2 : 3;
    }
    if (
      this.crossLane === lane &&
      this.crossLight === Light.red &&
      prevFront < stopS + 1.5 &&
      front >= stopS + 1.5
    ) {
      this.crossLight = Light.green;
      return light === Light.red ? 1 : 0;
    }
    return 0;
  }
}

interface Request {
  car: TrafficCar;
  priority: number;
}

/**
 * Microscopic traffic model on the lane network, independent of rendering and Rapier so it can
 * run headless: random route choice, Intelligent Driver Model car-following, speed planning for
 * turns, signal obedience (amber: stop if comfortable, else commit), junction admission with
 * geometric conflict sets and gap acceptance (priority road, straight before turning, first come
 * first served), "don't block the box", chained admission through internal links, MOBIL-lite
 * lane changes, sensing of external obstacles along the planned path, and red-light / gridlock
 * statistics. Kinematic cars are integrated here; physics cars are measured by their owner
 * (`track`) and only take the commanded acceleration from here.
 */
export class TrafficSim {
  readonly cars: TrafficCar[] = [];
  readonly stats: TrafficStats = {
    redLightViolations: 0,
    amberCrossings: 0,
    greenCrossings: 0,
    admissions: 0,
    forcedEntries: 0,
    laneChanges: 0,
    maxStationary: 0,
    maxStalled: 0,
    gridlocked: 0,
    distance: 0,
  };
  time = 0;
  /** The most recent red-light run (debugging / probes). */
  lastViolation: { car: number; lane: number; time: number; speed: number } | null = null;
  /** Connector occupancy: cars admitted to each connector that have not cleared it. */
  readonly occupancy: Int16Array;
  private readonly laneCars: TrafficCar[][];
  private readonly touched: number[] = [];
  private readonly reservedInto: Float32Array;
  private readonly approaching: TrafficCar[][];
  private readonly approachTouched: number[] = [];
  private readonly requests: Request[] = [];
  private readonly claimed: Uint8Array;
  private readonly claimTouched: number[] = [];
  private readonly requestPool: Request[] = [];
  private readonly point = createLanePoint();
  private readonly proj: LaneProjection = { s: 0, lat: 0, dist: 0 };
  private readonly proj2: LaneProjection = { s: 0, lat: 0, dist: 0 };
  private readonly sx = new Float64Array(MAX_SAMPLES);
  private readonly sz = new Float64Array(MAX_SAMPLES);
  private readonly sdx = new Float64Array(MAX_SAMPLES);
  private readonly sdz = new Float64Array(MAX_SAMPLES);
  private readonly sd = new Float64Array(MAX_SAMPLES);
  private nextId = 1;

  constructor(
    readonly net: LaneNetwork,
    private readonly seed: number,
    readonly obstacles: ObstacleField | null = null,
  ) {
    this.occupancy = new Int16Array(net.count);
    this.claimed = new Uint8Array(net.count);
    this.reservedInto = new Float32Array(net.count);
    this.laneCars = Array.from({ length: net.count }, () => []);
    this.approaching = Array.from({ length: net.count }, () => []);
  }

  addCar(
    lane: number,
    s: number,
    v: number,
    length: number,
    width: number,
    profile: DriverProfile,
  ): TrafficCar {
    const id = this.nextId++;
    const car = new TrafficCar(id, length, width, profile, (this.seed * 7919 + id * 104729) >>> 0);
    car.lane = lane;
    car.s = s;
    car.v = v;
    this.cars.push(car);
    this.extendRoute(car);
    return car;
  }

  removeCar(car: TrafficCar): void {
    const i = this.cars.indexOf(car);
    if (i < 0) return;
    this.cars.splice(i, 1);
    this.release(car);
  }

  /** Gives up every junction admission the car holds. */
  release(car: TrafficCar): void {
    for (const c of car.admits) this.occupancy[c]--;
    for (const c of car.clearing) this.occupancy[c]--;
    car.admits.length = 0;
    car.clearing.length = 0;
  }

  /** Gives back the admissions for the gates ahead (keeps the connector the car is on). */
  private releaseGates(car: TrafficCar): void {
    for (let i = car.admits.length - 1; i >= 0; i--) {
      const c = car.admits[i];
      if (c === car.lane) continue;
      this.occupancy[c]--;
      car.admits.splice(i, 1);
    }
  }

  /** True when a new car of `length` could be placed at (lane, s) without crowding another. */
  isClear(lane: number, s: number, length: number, margin = 10): boolean {
    for (const c of this.cars) {
      if (c.lane === lane && Math.abs(c.s - s) < (c.length + length) / 2 + margin) return false;
      if (c.route[0] === lane && s < 12 && this.net.length[c.lane] - c.s < 15) return false;
    }
    return true;
  }

  /** World pose of a car (lane point plus its lateral offset) — position and travel direction. */
  pose(car: TrafficCar, out: LanePoint): LanePoint {
    this.net.sample(car.lane, car.s, out);
    if (car.lat !== 0) {
      out.x += -out.dz * car.lat;
      out.z += out.dx * car.lat;
    }
    return out;
  }

  /** Point `ahead` metres along the planned path from the car's centre (with the lateral offset). */
  lookahead(car: TrafficCar, ahead: number, out: LanePoint): LanePoint {
    let lane = car.lane;
    let s = car.s + ahead;
    let k = 0;
    while (s > this.net.length[lane] && k < car.route.length) {
      s -= this.net.length[lane];
      lane = car.route[k++];
    }
    this.net.sample(lane, s, out);
    const lat = car.lat * Math.max(0, 1 - ahead / 25) + car.latTarget * Math.min(1, ahead / 25);
    if (lat !== 0) {
      out.x += -out.dz * lat;
      out.z += out.dx * lat;
    }
    return out;
  }

  /**
   * Physics cars: updates lane position and speed from the measured pose. Returns the lateral
   * distance from the planned path (large values mean the car has left its lane).
   */
  track(car: TrafficCar, x: number, z: number, speed: number, dt: number): number {
    const net = this.net;
    const prevFront = car.front;
    let p = net.project(car.lane, x, z, this.proj, car.s, 12);
    let guard = 0;
    while (p.s >= net.length[car.lane] - 0.05 && car.route.length > 0 && guard++ < 3) {
      const q = net.project(car.route[0], x, z, this.proj2, 0, 12);
      if (q.dist > p.dist + 0.5) break;
      this.advance(car);
      p = net.project(car.lane, x, z, this.proj, q.s, 12);
    }
    const moved = Math.max(0, p.s - car.s);
    car.s = p.s;
    car.v = speed;
    this.afterMove(car, prevFront, Math.min(moved, speed * dt + 0.5));
    return Math.abs(p.lat - car.lat);
  }

  step(dt: number, time: number): void {
    this.time = time;
    this.buildOccupancy();
    for (const car of this.cars) this.decide(car);
    this.admit();
    for (const car of this.cars) {
      if (!car.physics) this.integrate(car, dt);
      this.updateTimers(car, dt);
    }
    for (const car of this.cars) {
      car.laneChangeTimer -= dt;
      if (car.laneChangeTimer <= 0) {
        car.laneChangeTimer = 1 + car.rng.range(0, 0.5);
        this.considerLaneChange(car);
      }
    }
  }

  /** Light for an approach lane right now (green when unsignalled). */
  lightFor(lane: number): LightState {
    const signal = this.net.signal[lane];
    if (signal < 0) return Light.green;
    return lightAt(this.net.signals[signal].timing, this.net.phase[lane], this.time);
  }

  /** Seconds until the light of an approach lane changes (Infinity when unsignalled). */
  timeLeft(lane: number): number {
    const signal = this.net.signal[lane];
    if (signal < 0) return Infinity;
    return timeToChange(this.net.signals[signal].timing, this.net.phase[lane], this.time);
  }

  // ---- planning -------------------------------------------------------------------------------

  private extendRoute(car: TrafficCar): void {
    const net = this.net;
    let last = car.route.length > 0 ? car.route[car.route.length - 1] : car.lane;
    while (car.route.length < ROUTE_AHEAD) {
      const options = net.next[last];
      if (options.length === 0) break;
      let pick = options[0];
      if (options.length > 1) {
        let total = 0;
        for (const o of options) total += this.routeWeight(car, o) * this.loopFactor(car, o);
        let r = car.rng.range(0, total);
        for (const o of options) {
          r -= this.routeWeight(car, o) * this.loopFactor(car, o);
          if (r <= 0) {
            pick = o;
            break;
          }
        }
      }
      car.route.push(pick);
      last = pick;
    }
  }

  /** Routes should not circle back through lanes they are about to drive (loops inside junction clusters). */
  private loopFactor(car: TrafficCar, connector: number): number {
    const exit = this.net.next[connector][0];
    if (exit === undefined) return 1;
    return exit === car.lane || car.route.includes(exit) ? 0.001 : 1;
  }

  /** Prefer going straight; avoid U-turns, and links too short for this car to queue on. */
  private routeWeight(car: TrafficCar, lane: number): number {
    const net = this.net;
    if (!net.connector[lane]) return 1;
    const exit = net.next[lane][0];
    const tooShort =
      exit !== undefined &&
      !net.internal[exit] &&
      net.stopS[exit] >= 0 &&
      net.stopS[exit] - STOP_GAP < car.length + 1.5;
    const k = tooShort ? 0.01 : 1;
    switch (net.turn[lane]) {
      case Turn.straight:
        return 2.2 * k;
      case Turn.right:
        return 1 * k;
      case Turn.left:
        return 0.8 * k;
      case Turn.uturn:
        return 0.02 * k;
      default:
        return k;
    }
  }

  private buildOccupancy(): void {
    for (const lane of this.touched) this.laneCars[lane].length = 0;
    this.touched.length = 0;
    for (const lane of this.approachTouched) this.approaching[lane].length = 0;
    this.approachTouched.length = 0;
    this.reservedInto.fill(0);
    for (const car of this.cars) {
      const list = this.laneCars[car.lane];
      if (list.length === 0) this.touched.push(car.lane);
      // Insertion by s keeps each lane list sorted (lists are short).
      let i = list.length;
      list.push(car);
      while (i > 0 && list[i - 1].s > car.s) {
        list[i] = list[i - 1];
        i--;
      }
      list[i] = car;
      for (const c of car.admits) {
        const exit = this.net.next[c][0];
        if (exit !== undefined && car.lane !== exit && !this.net.internal[exit])
          this.reservedInto[exit] += car.length + 2;
      }
    }
  }

  private decide(car: TrafficCar): void {
    const net = this.net;
    const p = car.profile.idm;
    this.extendRoute(car);
    const v = car.v;
    const front = car.front;
    const urgency = car.urgency;
    const v0 = net.speed[car.lane] * car.profile.speedFactor * urgency;
    let a = idmFree(p, v, v0);
    car.reason = '';
    const horizon = Math.max(45, v * 4 + 25);

    // Leader on the current lane (distance to the nearest traffic ahead along the path).
    let leaderGap = Infinity;
    const list = this.laneCars[car.lane];
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === car || o.s <= car.s) continue;
      leaderGap = o.s - o.length / 2 - front;
      const al = idmAccel(p, v, v0, leaderGap, v - o.v);
      if (al < a) {
        a = al;
        car.reason = 'leader';
      }
      break;
    }

    // Lanes ahead: slower sections and the first leader.
    let d = net.length[car.lane] - front;
    for (let k = 0; k < car.route.length && d < horizon; k++) {
      const lane = car.route[k];
      const limit = net.speed[lane] * car.profile.speedFactor * urgency;
      if (limit < v0 && v > limit) {
        const allowed = approachSpeed(limit, d - 1, PLAN_DECEL);
        if (allowed < v) a = Math.min(a, idmFree(p, v, allowed));
      }
      const lead = leaderGap === Infinity ? this.laneCars[lane][0] : undefined;
      if (lead && lead !== car) {
        leaderGap = d + lead.s - lead.length / 2;
        const al = idmAccel(p, v, v0, leaderGap, v - lead.v);
        if (al < a) {
          a = al;
          car.reason = 'leader';
        }
        break; // nothing beyond the first leader matters
      }
      d += net.length[lane];
    }

    // Junction gates: signals and admission.
    this.findGates(car, front, horizon + 40);
    car.light = Light.green;
    const gate = car.gate;
    const gateDist = car.stopDistance;
    if (gate >= 0 && !car.admittedTo(gate)) {
      const light = this.lightFor(car.gateApproach);
      car.light = light;
      let mayGo = true;
      if (light === Light.red) mayGo = false;
      else if (light === Light.amber) {
        if (car.amberCommit === gate) mayGo = true;
        else {
          const reach = v > 0.5 ? gateDist / v : Infinity;
          mayGo = stoppingDecel(v, gateDist) > AMBER_STOP_DECEL && reach < this.timeLeft(car.gateApproach);
          // A turner waiting at the line goes as the oncoming traffic stops ("sneaking").
          const turner = net.turn[gate] !== Turn.straight;
          if (!mayGo && turner && car.waitAtLine > 2 && gateDist < 1.5 && this.timeLeft(car.gateApproach) > 1)
            mayGo = true;
          if (mayGo) car.amberCommit = gate;
        }
      }
      // Only the first car before the line asks; anyone behind it waits their turn.
      const first = leaderGap > gateDist;
      if (mayGo && first && gateDist < this.requestDistance(v)) this.request(car);
      if (mayGo && first) for (let g = 0; g < car.gates.length; g++) this.registerApproach(car, car.gates[g]);
      const as = idmAccel(car.stopIdm, v, v0, gateDist, v);
      if (as < a) {
        a = as;
        car.reason = light === Light.green ? 'junction' : 'light';
      }
    } else if (gate >= 0 && gateDist > 0) {
      // Admitted but the light changed: stop if that is still comfortably possible.
      const light = this.lightFor(car.gateApproach);
      car.light = light;
      // Already at the line when the amber comes: go now rather than lose the turn.
      const atLine = gateDist < 2.5 && this.timeLeft(car.gateApproach) > 1.2;
      const mustStop =
        (light === Light.red && stoppingDecel(v, gateDist) <= RED_MAX_DECEL) ||
        (light === Light.amber &&
          car.amberCommit !== gate &&
          !atLine &&
          stoppingDecel(v, gateDist) <= AMBER_STOP_DECEL);
      if (light === Light.amber && !mustStop) car.amberCommit = gate;
      if (mustStop) {
        this.releaseGates(car);
        const as = idmAccel(car.stopIdm, v, v0, gateDist, v);
        if (as < a) {
          a = as;
          car.reason = 'light';
        }
      }
    }

    // Obstacles along the path (people, the player, stray vehicles).
    if (this.obstacles && this.obstacles.count > 0) a = Math.min(a, this.senseObstacles(car, v0, horizon));

    if (car.pullOver > 0) {
      // Toward the kerb: past the lane edge on wide lanes, within the lane where cars park.
      const w = net.width[car.lane];
      car.latTarget = Math.max(0, w / 2 - car.width / 2 - 0.15) + (w >= 3 ? 0.8 : 0);
      a = Math.min(a, idmAccel(car.stopIdm, v, v0, 6 + v * 0.8, v));
      car.reason = 'siren';
    } else if (car.latTarget > 0) car.latTarget = 0;
    if (car.hold) {
      a = Math.min(a, v > 0.2 ? -6 : -1);
      car.reason = 'hold';
    }
    car.accel = a;
  }

  /**
   * Finds the next controlled connectors on the route: the first gate with the distance from
   * the front bumper to its stop line, plus every gate chained to it through internal links.
   */
  private findGates(car: TrafficCar, front: number, reach: number): void {
    const net = this.net;
    car.gates.length = 0;
    car.gateDistances.length = 0;
    car.gateApproach = -1;
    car.stopDistance = Infinity;
    let d = net.length[car.lane] - front;
    let prev = car.lane;
    // Once a chain has started it is followed to its end, however long.
    for (let k = 0; k < car.route.length && (d < reach || car.gates.length > 0); k++) {
      const lane = car.route[k];
      if (net.connector[lane]) {
        // Dead-end U-turns are uncontrolled; a chain that loops back on itself ends.
        if (net.junction[lane] < 0 || car.gates.length >= MAX_GATES || car.gates.includes(lane)) return;
        const stop = d - (net.length[prev] - net.stopS[prev]);
        if (car.gates.length === 0) {
          car.gateApproach = prev;
          car.stopDistance = stop;
        }
        car.gates.push(lane);
        car.gateDistances.push(stop);
      } else if (car.gates.length > 0 && !net.internal[lane]) {
        return; // a link long enough to queue on ends the chain
      }
      d += net.length[lane];
      prev = lane;
    }
  }

  private requestDistance(v: number): number {
    return Math.min(45, Math.max(8, (v * v) / (2 * PLAN_DECEL) + 6));
  }

  private request(car: TrafficCar): void {
    let r = this.requestPool[this.requests.length];
    if (!r) {
      r = { car, priority: 0 };
      this.requestPool.push(r);
    }
    r.car = car;
    r.priority = this.net.priority(car.gates[0]);
    this.requests.push(r);
  }

  private registerApproach(car: TrafficCar, connector: number): void {
    const list = this.approaching[connector];
    if (list.length === 0) this.approachTouched.push(connector);
    list.push(car);
  }

  /** Grants junction admissions: priority first, then waiting time, then distance. */
  private admit(): void {
    const reqs = this.requests;
    // Long waits raise a car's precedence, so a stream of priority traffic cannot starve it.
    // Cars already inside a junction (on a connector or an internal link) go first of all.
    for (const r of reqs) {
      r.priority += Math.min(8, r.car.waitAtLine / STARVE_SECONDS) * 3;
      if (this.insideJunction(r.car)) r.priority += 100;
    }
    reqs.sort(
      (x, y) =>
        y.priority - x.priority ||
        y.car.waitAtLine - x.car.waitAtLine ||
        x.car.stopDistance - y.car.stopDistance ||
        x.car.id - y.car.id,
    );
    for (const c of this.claimTouched) this.claimed[c] = 0;
    this.claimTouched.length = 0;
    for (const r of reqs) {
      const car = r.car;
      let ok = true;
      // Blocked only by traffic passing through (not by a full exit lane or a stopped car)?
      let passing = true;
      for (let g = 0; g < car.gates.length && ok; g++) {
        const c = car.gates[g];
        const exit = this.net.next[c][0];
        const roomAhead =
          exit !== undefined && this.net.internal[exit]
            ? this.internalClear(exit)
            : this.exitHasSpace(car, c);
        if (!roomAhead) passing = false;
        ok =
          roomAhead &&
          (this.claimed[c] === 0 || r.priority >= 100) &&
          !this.conflictOccupied(c) &&
          !this.mustYield(car, c, car.gateDistances[g], this.net.priority(c));
      }
      if (!ok) {
        // A car that has waited long claims its conflict zone: nobody new may cross it until the
        // traffic in it has passed. A car that could not move anyway (no room ahead) claims nothing.
        if (car.waitAtLine > STARVE_SECONDS && passing) {
          for (const g of car.gates) {
            for (const k of this.net.conflicts[g]) {
              if (this.claimed[k] === 0) this.claimTouched.push(k);
              this.claimed[k] = 1;
            }
          }
        }
        continue;
      }
      for (const c of car.gates) {
        this.occupancy[c]++;
        car.admits.push(c);
        this.stats.admissions++;
        const exit = this.net.next[c][0];
        if (exit !== undefined && !this.net.internal[exit]) this.reservedInto[exit] += car.length + 2;
      }
    }
    reqs.length = 0;
  }

  private insideJunction(car: TrafficCar): boolean {
    return this.net.connector[car.lane] === 1 || this.net.internal[car.lane] === 1;
  }

  private conflictOccupied(connector: number): boolean {
    for (const k of this.net.conflicts[connector]) if (this.occupancy[k] > 0) return true;
    return false;
  }

  /** An internal link may be entered only when nobody is standing on it. */
  private internalClear(lane: number): boolean {
    for (const o of this.laneCars[lane]) if (o.v < 2) return false;
    return true;
  }

  /** Gap acceptance: approaching traffic with right of way (or arriving clearly earlier) goes first. */
  private mustYield(car: TrafficCar, connector: number, dStop: number, priority: number): boolean {
    const gapTime = Math.max(1.5, car.profile.gap - 0.12 * car.waitAtLine);
    const myEta = car.v > 0.5 ? dStop / car.v : dStop / 2 + 1;
    for (const k of this.net.conflicts[connector]) {
      const list = this.approaching[k];
      if (list.length === 0) continue;
      const pk = this.net.priority(k);
      for (const o of list) {
        if (o === car || o.v < 2.5 || o.admittedTo(k)) continue;
        const g = o.gates.indexOf(k);
        const eta = (g >= 0 ? o.gateDistances[g] : o.stopDistance) / o.v;
        if (eta > gapTime + 1.5) continue;
        if (pk > priority && eta < gapTime) return true;
        if (pk === priority && eta < myEta - 0.6) return true;
      }
    }
    return false;
  }

  /** "Don't block the box": enter only if the exit lane has room for this car. */
  private exitHasSpace(car: TrafficCar, connector: number): boolean {
    const exit = this.net.next[connector][0];
    if (exit === undefined) return true;
    const list = this.laneCars[exit];
    const reserved = this.reservedInto[exit];
    if (list.length === 0 && reserved === 0) return true;
    const tail = list.length > 0 ? list[0].s - list[0].length / 2 : this.net.length[exit];
    // Room for the whole car plus its standstill gap behind the queue (its rear must clear the box).
    if (tail - reserved >= car.length + car.profile.idm.s0 + 1) return true;
    return list.length > 0 && list[0].v > 3 && reserved === 0;
  }

  private senseObstacles(car: TrafficCar, v0: number, horizon: number): number {
    const field = this.obstacles;
    if (!field) return Infinity;
    const n = this.samplePath(car, horizon);
    if (n === 0) return Infinity;
    const midX = (this.sx[0] + this.sx[n - 1]) / 2;
    const midZ = (this.sz[0] + this.sz[n - 1]) / 2;
    const reach = Math.sqrt((this.sx[n - 1] - this.sx[0]) ** 2 + (this.sz[n - 1] - this.sz[0]) ** 2) / 2 + 6;
    const near = field.near(midX, midZ, reach);
    let a = Infinity;
    const p = car.profile.idm;
    const half = car.width / 2 + 0.25;
    for (let k = 0; k < near.length; k++) {
      const o = field.items[near[k]];
      const r = half + o.radius;
      for (let i = 0; i < n; i++) {
        const dx = o.x - this.sx[i];
        const dz = o.z - this.sz[i];
        if (dx * dx + dz * dz > r * r) continue;
        // Behind the front bumper (beside or under the car) does not count.
        const along = this.sd[i] + dx * this.sdx[i] + dz * this.sdz[i] - o.radius;
        if (along < -0.5) break;
        const ov = Math.max(0, o.vx * this.sdx[i] + o.vz * this.sdz[i]);
        const al = idmAccel(p, car.v, v0, Math.max(0.1, along), car.v - ov);
        if (al < a) {
          a = al;
          car.reason = 'obstacle';
          car.obstacleIsVehicle = o.vehicle;
        }
        break;
      }
    }
    return a;
  }

  /** Fills the path sample buffers from the front bumper to `horizon`; returns the sample count. */
  private samplePath(car: TrafficCar, horizon: number): number {
    const net = this.net;
    let lane = car.lane;
    let s = car.front;
    let k = 0;
    let n = 0;
    let d = 0;
    while (n < MAX_SAMPLES && d <= horizon) {
      while (s > net.length[lane]) {
        if (k >= car.route.length) return n;
        s -= net.length[lane];
        lane = car.route[k++];
      }
      net.sample(lane, s, this.point);
      const lat = car.lat;
      this.sx[n] = this.point.x - this.point.dz * lat;
      this.sz[n] = this.point.z + this.point.dx * lat;
      this.sdx[n] = this.point.dx;
      this.sdz[n] = this.point.dz;
      this.sd[n] = d;
      n++;
      s += SAMPLE_STEP;
      d += SAMPLE_STEP;
    }
    return n;
  }

  // ---- motion ---------------------------------------------------------------------------------

  private integrate(car: TrafficCar, dt: number): void {
    const net = this.net;
    const prevFront = car.front;
    car.v = Math.max(0, car.v + car.accel * dt);
    let ds = car.v * dt;
    // Never roll into a junction without an admission.
    if (car.gate >= 0 && !car.admittedTo(car.gate) && car.stopDistance > -0.5) {
      const room = Math.max(0, car.stopDistance + 0.4);
      if (ds > room) {
        ds = room;
        car.v = Math.min(car.v, room / dt);
      }
    }
    car.s += ds;
    while (car.s > net.length[car.lane] && car.route.length > 0) this.advance(car);
    if (car.s > net.length[car.lane]) {
      car.s = net.length[car.lane];
      car.v = 0;
    }
    this.afterMove(car, prevFront, ds);
  }

  private afterMove(car: TrafficCar, prevFront: number, ds: number): void {
    const net = this.net;
    this.stats.distance += ds;
    const lane = car.lane;
    const stopS = net.stopS[lane];
    if (stopS >= 0 && net.signal[lane] >= 0) {
      // After a lane transition the previous front was on another lane: before this line.
      const before = prevFront > car.front + 0.01 ? -Infinity : prevFront;
      const result = car.checkStopLine(lane, before, car.front, stopS, this.lightFor(lane));
      if (result === 1) {
        this.stats.redLightViolations++;
        this.lastViolation = { car: car.id, lane, time: this.time, speed: car.v };
      } else if (result === 2) this.stats.amberCrossings++;
      else if (result === 3) this.stats.greenCrossings++;
    }
    // Rear clear of the connector it has driven off: release that admission.
    if (car.clearing.length > 0 && (car.s - car.length / 2 > 0.5 || net.connector[car.lane] === 1)) {
      for (const c of car.clearing) {
        this.occupancy[c]--;
        if (car.amberCommit === c) car.amberCommit = -1;
      }
      car.clearing.length = 0;
    }
  }

  private advance(car: TrafficCar): void {
    const net = this.net;
    const from = car.lane;
    car.s -= net.length[from];
    const held = car.admits.indexOf(from);
    if (held >= 0) {
      car.admits.splice(held, 1);
      // Its rear is still inside; an earlier connector is behind the car by now.
      for (const c of car.clearing) this.occupancy[c]--;
      car.clearing.length = 0;
      car.clearing.push(from);
    }
    const to = car.route.shift() as number;
    car.lane = to;
    if (net.connector[to] && net.junction[to] >= 0 && !car.admittedTo(to)) {
      // Entered without an admission (a physics car overshooting): count it in.
      this.occupancy[to]++;
      car.admits.push(to);
      this.stats.forcedEntries++;
    }
    this.extendRoute(car);
  }

  private updateTimers(car: TrafficCar, dt: number): void {
    if (car.v < 0.3) {
      car.stationary += dt;
      if (car.stationary > this.stats.maxStationary) this.stats.maxStationary = car.stationary;
      // Held at (or queued behind) a red light, stopped on purpose: not stalled.
      const held = car.light !== Light.green || car.reason === 'hold' || car.reason === 'siren';
      if (!held) {
        car.stalled += dt;
        if (car.stalled > this.stats.maxStalled) this.stats.maxStalled = car.stalled;
      }
      if (!car.stuck && car.stalled > GRIDLOCK_SECONDS) {
        car.stuck = true;
        this.stats.gridlocked++;
      }
    } else {
      car.stationary = 0;
      car.stalled = 0;
      car.stuck = false;
    }
    const atLine = car.gate >= 0 && car.stopDistance < 8 && car.v < 1;
    car.waitAtLine = atLine ? car.waitAtLine + dt : 0;
    if (car.reason === 'obstacle' && car.v < 0.5) car.blockedByObstacle += dt;
    else car.blockedByObstacle = 0;
    // Ease toward the lateral target (lane changes finish, pulling over).
    const dl = car.latTarget - car.lat;
    const step = LANE_SHIFT_RATE * dt * Math.max(0.4, Math.min(1, car.v / 4));
    car.lat = Math.abs(dl) <= step ? car.latTarget : car.lat + Math.sign(dl) * step;
    if (car.pullOver > 0) car.pullOver = Math.max(0, car.pullOver - dt);
    if (car.indicatorTime > 0) {
      car.indicatorTime -= dt;
      if (car.indicatorTime <= 0) car.indicator = 0;
    }
  }

  // ---- lane changes -----------------------------------------------------------------------------

  /** MOBIL-lite: change to a neighbouring lane when it is clearly faster and safe for its followers. */
  private considerLaneChange(car: TrafficCar): void {
    const net = this.net;
    const lane = car.lane;
    if (net.connector[lane] || car.admits.length > 0 || car.hold || car.pullOver > 0) return;
    if (car.v < 3 || Math.abs(car.lat) > 0.3) return;
    const stop = net.stopS[lane] >= 0 ? net.stopS[lane] : net.length[lane];
    if (car.front > stop - 30 || car.s < 8) return;
    const inner = net.inner[lane];
    const outer = net.outer[lane];
    if (inner < 0 && outer < 0) return;
    const p = car.profile.idm;
    const v0 = net.speed[lane] * car.profile.speedFactor * car.urgency;
    const current = this.laneAccel(car, lane, car.s, v0);
    let best = -1;
    let bestGain = 0.45;
    let bestS = 0;
    let bestLat = 0;
    this.pose(car, this.point);
    for (const target of [inner, outer]) {
      if (target < 0) continue;
      const q = net.project(target, this.point.x, this.point.z, this.proj, car.s, 25);
      if (q.dist > net.width[target] * 1.6) continue;
      const ts = q.s;
      const tStop = net.stopS[target] >= 0 ? net.stopS[target] : net.length[target];
      if (ts + car.length / 2 > tStop - 30) continue;
      // The follower on the target lane must not need to brake hard.
      let follower: TrafficCar | null = null;
      let leader: TrafficCar | null = null;
      for (const o of this.laneCars[target]) {
        if (o.s <= ts) follower = o;
        else {
          leader = o;
          break;
        }
      }
      if (follower) {
        const gap = ts - car.length / 2 - (follower.s + follower.length / 2);
        if (gap < 3) continue;
        const af = idmAccel(follower.profile.idm, follower.v, net.speed[target], gap, follower.v - car.v);
        if (af < -2.5) continue;
      }
      let gain: number;
      if (leader) {
        const gap = leader.s - leader.length / 2 - (ts + car.length / 2);
        if (gap < 3) continue;
        gain = idmAccel(p, car.v, v0, gap, car.v - leader.v) - current;
      } else gain = idmFree(p, car.v, v0) - current;
      gain += target === outer ? 0.12 : -0.12; // keep right unless passing
      if (gain > bestGain) {
        bestGain = gain;
        best = target;
        bestS = ts;
        bestLat = q.lat;
      }
    }
    if (best < 0) return;
    car.lane = best;
    car.s = bestS;
    car.lat = bestLat;
    car.latTarget = 0;
    car.route.length = 0;
    this.extendRoute(car);
    car.indicator = best === outer ? 1 : -1;
    car.indicatorTime = 3;
    this.stats.laneChanges++;
    this.buildOccupancy(); // keep lane lists consistent for the rest of this tick
  }

  private laneAccel(car: TrafficCar, lane: number, s: number, v0: number): number {
    const p = car.profile.idm;
    for (const o of this.laneCars[lane]) {
      if (o === car || o.s <= s) continue;
      return idmAccel(p, car.v, v0, o.s - o.length / 2 - (s + car.length / 2), car.v - o.v);
    }
    return idmFree(p, car.v, v0);
  }
}
