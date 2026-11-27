import * as THREE from 'three';
import { densityAt, targetCount } from '../../ai/density';
import { Crowd, type ArchetypeId, type CrowdPlayer } from '../../ai/pedestrians/crowd';
import { SidewalkNav } from '../../ai/pedestrians/sidewalk-nav';
import { LaneNetwork } from '../../ai/traffic/lane-network';
import { SignalLights } from '../../ai/traffic/signal-lights';
import { walkAt } from '../../ai/traffic/signals';
import { TrafficManager, type TrafficView } from '../../ai/traffic/traffic-manager';
import { randomAppearance, type CharacterAppearance } from '../../characters/rig/appearance';
import { ARCHETYPE_MIX, ARCHETYPES, DENSITY, TRAFFIC_RULES } from '../../content/population';
import { ALL_VEHICLES } from '../../content/vehicles';
import type { Rng } from '../../core/rng';
import { formatHours, parseHours } from '../../core/time-of-day';
import { CommandError, numberArg, toggleArg } from '../../debug/command-registry';
import { TrafficDebugDraw } from '../../debug/traffic-debug-draw';
import type { QualitySettings } from '../../rendering/quality';
import type { CityModel } from '../../world/gen/city-layout';
import type { DistrictId } from '../../world/gen/types';
import type { PropManager } from '../../world/props/prop-manager';
import type { Engine } from '../engine';
import type { PlayerHandle } from './player-setup';
import type { VehicleWorld } from './vehicle-setup';

export interface Population {
  readonly net: LaneNetwork;
  readonly nav: SidewalkNav;
  readonly traffic: TrafficManager;
  readonly crowd: Crowd;
  readonly signals: SignalLights;
}

/** Spawn rings per preset: traffic farther out (fog hides arrivals), pedestrians close by. */
function ringsFor(q: QualitySettings): {
  physics: number;
  carMin: number;
  carMax: number;
  pedMin: number;
  pedMax: number;
} {
  const physics = Math.min(160, q.nearRing * 0.68);
  return {
    physics,
    // Out of view cars may appear from 70 m (behind the camera, already in physics range).
    carMin: 70,
    carMax: Math.min(q.drawDistance * 0.45, physics + 110),
    pedMin: 32,
    pedMax: q.name === 'low' ? 70 : q.name === 'medium' ? 90 : 110,
  };
}

/** Archetype-specific looks: joggers in shorts, dock workers in jackets and caps, and so on. */
function appearanceFor(rng: Rng, archetype: ArchetypeId): CharacterAppearance {
  const a = randomAppearance(rng);
  switch (archetype) {
    case 'jogger':
      return { ...a, topStyle: 'tee', bottomStyle: 'shorts', shoes: 0xe6e6e6 };
    case 'dockWorker':
      return {
        ...a,
        topStyle: 'jacket',
        hairStyle: rng.chance(0.5) ? 'cap' : a.hairStyle,
        top: rng.chance(0.5) ? 0xc48a2c : a.top,
      };
    case 'nightCrowd':
      return { ...a, topStyle: rng.chance(0.6) ? 'jacket' : 'longsleeve' };
    case 'commuter':
      return { ...a, topStyle: rng.chance(0.5) ? 'jacket' : 'longsleeve', bottomStyle: 'trousers' };
    case 'shopper':
      return a;
  }
}

/** City traffic, crowds, live traffic lights and their debug surface. */
export function setupPopulation(
  engine: Engine,
  model: CityModel,
  vw: VehicleWorld,
  props: PropManager,
  player: PlayerHandle | null,
): Population {
  const { gfx, physics, scheduler, commands, probes, bus, timeOfDay, clock, params } = engine;
  const { layout, terrain } = model;
  const net = new LaneNetwork(layout);
  const nav = new SidewalkNav(layout, (x, z) => terrain.districtAt(x, z), net.internalEdges);
  const quality = gfx.settings;
  const rings = ringsFor(quality);
  const camera = gfx.camera;
  const dir = new THREE.Vector3();
  const view: TrafficView = { x: 0, y: 0, z: 0, fx: 0, fz: 1, cosHalfFov: 0.5 };
  const readView = (): TrafficView => {
    camera.getWorldDirection(dir);
    const len = Math.hypot(dir.x, dir.z) || 1;
    view.x = camera.position.x;
    view.y = camera.position.y;
    view.z = camera.position.z;
    view.fx = dir.x / len;
    view.fz = dir.z / len;
    const halfV = THREE.MathUtils.degToRad(camera.fov) / 2;
    const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
    view.cosHalfFov = Math.cos(Math.min(Math.PI * 0.9, halfH + 0.25));
    return view;
  };
  const district = (): DistrictId | null => terrain.districtAt(camera.position.x, camera.position.z);
  const carTarget = (): number =>
    targetCount(quality.maxTraffic, densityAt(DENSITY, 'cars', district(), timeOfDay.hours));
  const pedTarget = (): number =>
    targetCount(quality.maxPedestrians, densityAt(DENSITY, 'peds', district(), timeOfDay.hours));

  const crowdPlayer: CrowdPlayer = { x: 0, z: 0, vx: 0, vz: 0, speed: 0, onFoot: false };
  const readPlayer = (): CrowdPlayer | null => {
    if (!player) return null;
    const m = player.player.motor;
    const p = m.position;
    crowdPlayer.x = p.x;
    crowdPlayer.z = p.z;
    crowdPlayer.vx = m.velocity.x;
    crowdPlayer.vz = m.velocity.z;
    crowdPlayer.speed = m.speed;
    crowdPlayer.onFoot = !player.player.seated && player.player.alive;
    return crowdPlayer;
  };

  // Pedestrian signal per crosswalk: the approach lane on the crossed road at that junction.
  const approachOf = new Map<string, number>();
  for (const lane of layout.lanes) {
    if (lane.isConnector) continue;
    for (const e of layout.chains[lane.chain]?.edges ?? [lane.edge])
      approachOf.set(`${lane.junction}:${e}`, lane.id);
  }
  const crosswalkSignal = layout.crosswalks.map((c) => {
    const lane = approachOf.get(`${c.junction}:${c.edge}`);
    if (lane === undefined || net.signal[lane] < 0) return null;
    return { signal: net.signal[lane], phase: net.phase[lane] };
  });

  const crowd = new Crowd(
    {
      nav,
      npcs: vw.npcs,
      vehicles: vw.manager,
      physics,
      bus,
      seed: params.seed,
      archetypes: ARCHETYPES,
      pickArchetype: (d, rng) => {
        const h = timeOfDay.hours;
        const mix = ARCHETYPE_MIX[d ?? 'meridian'][h >= 7 && h < 19 ? 'day' : 'night'];
        const ids = Object.keys(mix) as ArchetypeId[];
        return rng.pickWeighted(
          ids,
          ids.map((id) => mix[id] ?? 0),
        );
      },
      appearance: appearanceFor,
      walkSignal: (cw) => {
        const s = crosswalkSignal[cw.id];
        if (!s) return null;
        return walkAt(net.signals[s.signal].timing, s.phase, clock.time);
      },
      view: readView,
      target: pedTarget,
      player: readPlayer,
    },
    {
      maxPeds: quality.maxPedestrians,
      spawnMin: rings.pedMin,
      spawnMax: rings.pedMax,
      despawn: rings.pedMax + 25,
    },
  );

  const traffic = new TrafficManager(
    {
      net,
      vehicles: vw.manager,
      npcs: vw.npcs,
      physics,
      bus,
      catalogue: ALL_VEHICLES,
      rules: TRAFFIC_RULES,
      appearance: randomAppearance,
      seed: params.seed,
      view: readView,
      target: carTarget,
      fillObstacles: (field, trafficSet) => {
        const p = readPlayer();
        if (p?.onFoot) {
          const y = player?.player.motor.position.y ?? 0;
          field.add(p.x, y, p.z, 0.45, p.vx, p.vz, false);
        }
        for (const v of vw.manager.vehicles) {
          if (trafficSet.has(v) || v.def.kind === 'boat') continue;
          // A row of circles along the body (a long vehicle is not one big circle).
          const t = v.sim.body.translation();
          const q = v.sim.body.rotation();
          const fx = 2 * (q.x * q.z + q.w * q.y);
          const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
          const lv = v.sim.body.linvel();
          const r = v.def.width / 2 + 0.05;
          const centre = v.def.length / 2 - v.def.rearOverhang - v.def.wheelbase / 2;
          const n = Math.max(2, Math.ceil(v.def.length / (r * 1.6)));
          for (let i = 0; i < n; i++) {
            const along = centre - v.def.length / 2 + r + ((v.def.length - 2 * r) * i) / (n - 1);
            field.add(t.x + fx * along, t.y, t.z + fz * along, r, lv.x, lv.z, true);
          }
        }
        crowd.forEachObstacle((x, z, vx, vz) => field.add(x, 0, z, 0.35, vx, vz, false));
      },
    },
    {
      maxCars: quality.maxTraffic,
      spawnMin: rings.carMin,
      spawnMax: rings.carMax,
      despawn: rings.carMax + 50,
      physicsRadius: rings.physics,
      driverRadius: 70,
    },
  );
  vw.npcs.maxRagdolls = quality.name === 'low' ? 5 : 8;

  scheduler.addFixed(traffic.createSystem());
  scheduler.addFixed(crowd.createSystem());
  // Drivers who ran from their cars rejoin the crowd once they calm down.
  let adoptTimer = 0;
  scheduler.addFixed({
    name: 'crowdAdopt',
    phase: 'gameplay',
    fixedUpdate: (ctx) => {
      adoptTimer -= ctx.dt;
      if (adoptTimer > 0) return;
      adoptTimer = 1;
      for (const npc of vw.npcs.npcs)
        if (npc.state === 'idle' && !npc.driven && !npc.seat) crowd.adopt(npc, 'commuter');
    },
  });

  const signals = new SignalLights(layout, net, (prop) => props.isKnocked(prop));
  gfx.scene.add(signals.mesh);
  const debugDraw = new TrafficDebugDraw(net, nav, traffic, crowd, gfx.scene);
  scheduler.addRender({
    name: 'signalLights',
    phase: 'ui',
    renderUpdate: (ctx) => {
      signals.update(clock.time);
      debugDraw.update(camera.position.x, camera.position.z, ctx.frameSeconds);
    },
  });

  // ---- debug surface ---------------------------------------------------------------------------
  engine.overlayLines.push(() => {
    const t = traffic.sim.stats;
    return `traffic ${traffic.count}/${carTarget()} (physics ${traffic.physicsCount})  red-runs ${t.redLightViolations}  stalled max ${t.maxStalled.toFixed(0)} s  peds ${crowd.count}/${pedTarget()}  ragdolls ${vw.npcs.activeRagdolls}  ${timeOfDay.format()}`;
  });
  probes.register('traffic', () => ({
    count: traffic.count,
    physics: traffic.physicsCount,
    target: carTarget(),
    cap: quality.maxTraffic,
    enabled: traffic.enabled,
    stats: { ...traffic.sim.stats },
    counters: { ...traffic.counters },
    signals: signals.count,
    junctions: net.junctions.length,
    nearest: traffic.describe(camera.position.x, camera.position.z, 8),
  }));
  probes.register('peds', () => {
    const states = crowd.summary();
    return {
      count: crowd.count,
      target: pedTarget(),
      cap: quality.maxPedestrians,
      enabled: crowd.enabled,
      stats: { ...crowd.stats },
      states,
      fleeing: (states['flee'] ?? 0) + (states['cower'] ?? 0) + (states['evade'] ?? 0),
      ragdolls: vw.npcs.activeRagdolls,
      knockedDown: vw.npcs.npcs.filter((n) => n.knockdowns > 0).length,
      nearest: crowd.peds
        .map((p) => ({
          x: p.pos.x,
          y: p.pos.y,
          z: p.pos.z,
          state: p.npc.knockedDown ? p.npc.state : p.state,
          archetype: p.archetype.id,
          d: Math.hypot(p.pos.x - camera.position.x, p.pos.z - camera.position.z),
        }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 8),
    };
  });
  probes.register('time', () => ({
    hours: timeOfDay.hours,
    clock: timeOfDay.format(),
    rate: timeOfDay.rate,
    day: timeOfDay.day,
  }));

  commands.register({
    name: 'time',
    usage: 'time [HH:MM] [minutesPerSecond]',
    help: 'Show or set the game clock (and how fast it runs)',
    run: (args) => {
      if (args[0] !== undefined) {
        const h = parseHours(args[0]);
        if (h === null) throw new CommandError('Time must be HH or HH:MM');
        timeOfDay.set(h);
      }
      if (args[1] !== undefined) timeOfDay.rate = Math.max(0, numberArg(args, 1, 'rate')) / 60;
      return `${timeOfDay.format()} (${(timeOfDay.rate * 60).toFixed(2)} game min/s)`;
    },
  });
  commands.register({
    name: 'traffic',
    usage: 'traffic [on|off|clear]',
    help: 'Toggle or clear city traffic; prints traffic statistics',
    run: (args) => {
      if (args[0] === 'clear') traffic.clear();
      else if (args[0] !== undefined) traffic.enabled = toggleArg(args, 0, traffic.enabled);
      return JSON.stringify({
        enabled: traffic.enabled,
        count: traffic.count,
        ...traffic.sim.stats,
        ...traffic.counters,
      });
    },
  });
  commands.register({
    name: 'peds',
    usage: 'peds [on|off|clear]',
    help: 'Toggle or clear pedestrians; prints crowd statistics',
    run: (args) => {
      if (args[0] === 'clear') crowd.clear();
      else if (args[0] !== undefined) crowd.enabled = toggleArg(args, 0, crowd.enabled);
      return JSON.stringify({ enabled: crowd.enabled, count: crowd.count, ...crowd.stats });
    },
  });
  commands.register({
    name: 'gunshot',
    usage: 'gunshot [x z]',
    help: 'A gunshot sound at the player (or x z): people panic, drivers flee (weapons come in M5)',
    run: (args) => {
      const base = player?.player.motor.position ?? camera.position;
      const x = numberArg(args, 0, 'x', base.x);
      const z = numberArg(args, 1, 'z', base.z);
      bus.emit('combat:shot', { x, y: base.y + 1.2, z });
      return `Bang at (${x.toFixed(0)}, ${z.toFixed(0)}).`;
    },
  });
  commands.register({
    name: 'pedtest',
    usage: 'pedtest [speed]',
    help: 'Test fixture: launch a driverless car at the nearest pedestrian (impact → ragdoll)',
    run: (args) => {
      const speed = numberArg(args, 0, 'speed', 11);
      const base = player?.player.motor.position ?? camera.position;
      let best = null as (typeof crowd.peds)[number] | null;
      let bestD = 70 * 70;
      for (const p of crowd.peds) {
        if (p.npc.knockedDown || !p.npc.driven) continue;
        const d = (p.pos.x - base.x) ** 2 + (p.pos.z - base.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (!best) throw new CommandError('No pedestrian nearby.');
      const def = ALL_VEHICLES.find((d) => d.id === 'meridian');
      if (!def) throw new CommandError('No test car model.');
      // Hold them still; the car comes from behind them (where they cannot see it).
      best.state = 'dwell';
      best.timer = 8;
      const fx = Math.sin(best.yaw);
      const fz = Math.cos(best.yaw);
      const d = 7 + def.length / 2;
      const x = best.pos.x - fx * d;
      const z = best.pos.z - fz * d;
      const v = vw.manager.spawn(def, x, best.pos.y + 0.35, z, best.yaw, { colour: def.colours[0] });
      v.spawnGrace = 0;
      v.sim.body.setLinvel({ x: fx * speed, y: 0, z: fz * speed }, true);
      return `Car #${v.id} launched at ${best.npc.appearance.body.height.toFixed(2)} m pedestrian at ${speed} m/s.`;
    },
  });
  commands.register({
    name: 'lanes',
    usage: 'lanes [on|off]',
    help: 'Debug draw of lanes, junction admissions, signals and pedestrian paths near the camera',
    run: (args) => {
      debugDraw.enabled = toggleArg(args, 0, debugDraw.enabled);
      return `Lane debug ${debugDraw.enabled ? 'on' : 'off'}.`;
    },
  });
  commands.register({
    name: 'nearsignal',
    help: 'Teleport the player to a kerb beside the nearest signalled crosswalk',
    run: () => {
      if (!player) throw new CommandError('No player in this scene.');
      const base = player.player.motor.position;
      let best = -1;
      let bestD = Infinity;
      for (const c of layout.crosswalks) {
        if (!crosswalkSignal[c.id] || !nav.links[c.a]?.includes(c.b)) continue;
        const d = (nav.x[c.a] - base.x) ** 2 + (nav.z[c.a] - base.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c.id;
        }
      }
      if (best < 0) throw new CommandError('No signalled crosswalk.');
      const c = layout.crosswalks[best];
      // A couple of metres back from the kerb, facing the crossing.
      const ax = nav.x[c.a];
      const az = nav.z[c.a];
      const yaw = Math.atan2(nav.x[c.b] - ax, nav.z[c.b] - az);
      player.placePlayer({ x: ax - Math.sin(yaw) * 2.5, y: nav.y[c.a], z: az - Math.cos(yaw) * 2.5, yaw });
      return `At crosswalk ${best} (${formatHours(timeOfDay.hours)}).`;
    },
  });
  return { net, nav, traffic, crowd, signals };
}
