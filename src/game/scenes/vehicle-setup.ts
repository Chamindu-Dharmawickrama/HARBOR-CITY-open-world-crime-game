import { buildClipLibrary } from '../../characters/anim/clip';
import { NpcManager } from '../../characters/npc/npc-character';
import { createCameraCollision } from '../../characters/player/physics-queries';
import { randomAppearance } from '../../characters/rig/appearance';
import { createCharacterMaterial } from '../../characters/rig/character-mesh';
import { ANIMATION_CLIPS } from '../../content/animations';
import { PARKING_RULES } from '../../content/parking';
import { ALL_VEHICLES } from '../../content/vehicles';
import { describeBinding } from '../../core/input/bindings';
import { CommandError, numberArg, toggleArg } from '../../debug/command-registry';
import type { RenderSystem } from '../../ecs/scheduler';
import { PARTICLES, ParticleSystem } from '../../rendering/particles/particle-system';
import type { QualitySettings } from '../../rendering/quality';
import { VehicleHud, type VehicleHudState } from '../../ui/hud/vehicle-hud';
import {
  createBurntMaterial,
  createGlassMaterial,
  createPaintMaterial,
} from '../../vehicles/body/vehicle-materials';
import { buildVehicleModel, vehicleModelCacheSize } from '../../vehicles/body/vehicle-mesh';
import { VehicleView, type VehicleMaterials } from '../../vehicles/body/vehicle-view';
import { VehicleDamage } from '../../vehicles/damage/vehicle-damage';
import { ParkedVehicles } from '../../vehicles/parked/parked-vehicles';
import { PlayerVehicleController } from '../../vehicles/player/player-vehicle-controller';
import { RaycastVehicle } from '../../vehicles/sim/raycast-vehicle';
import type { WaterQuery } from '../../vehicles/sim/vehicle-sim';
import { VehicleManager, type VehicleInstance } from '../../vehicles/vehicle-manager';
import type { ParkingSpot } from '../../world/gen/parking';
import type { Engine } from '../engine';
import type { PlayerHandle } from './player-setup';
import * as THREE from 'three';

export interface VehicleWorld {
  readonly manager: VehicleManager;
  readonly npcs: NpcManager;
  readonly damage: VehicleDamage;
  readonly parked: ParkedVehicles;
}

/** Budget of parked vehicles per quality preset. */
function parkedBudget(quality: QualitySettings): number {
  return quality.name === 'low' ? 14 : quality.name === 'medium' ? 24 : 36;
}

/** Vehicles, NPC drivers, damage/effects and parked cars (shared by the player and the bench). */
export function setupVehicles(
  engine: Engine,
  water: WaterQuery,
  spots: readonly ParkingSpot[],
  centre: () => { x: number; z: number },
): VehicleWorld {
  const { gfx, physics, world, scheduler, bus, rngs, params } = engine;
  const clips = buildClipLibrary(ANIMATION_CLIPS);
  const materials = {
    paint: createPaintMaterial(),
    glass: createGlassMaterial(),
    crackedGlass: createGlassMaterial(true),
    burnt: createBurntMaterial(),
    hidden: new THREE.MeshBasicMaterial({ visible: false }),
  };
  const manager = new VehicleManager(physics, world, gfx.scene, materials, water);
  const npcs = new NpcManager(physics, water, world, gfx.scene, clips, createCharacterMaterial());
  const smoke = new ParticleSystem(1600, false, 'smoke');
  const glow = new ParticleSystem(1200, true, 'glow');
  gfx.scene.add(smoke.points, glow.points);
  warmUpShaders(engine, materials, smoke, glow);
  const damage = new VehicleDamage(physics, manager, gfx.scene, smoke, glow, bus, rngs.get('vehicleFx'));
  const parked = new ParkedVehicles(
    spots,
    ALL_VEHICLES,
    PARKING_RULES,
    manager,
    physics,
    npcs,
    params.seed,
    randomAppearance,
    {
      maxVehicles: parkedBudget(gfx.settings),
      spawnRadius: Math.min(140, gfx.settings.nearRing * 0.7),
      despawnRadius: Math.min(200, gfx.settings.nearRing * 0.95),
      minSpawnDistance: 45,
    },
  );

  scheduler.addFixed(npcs.createFixedSystem());
  scheduler.addFixed(manager.createFixedSystem());
  scheduler.addFixed(damage.createFixedSystem());
  scheduler.addRender(manager.createRenderSystem());
  scheduler.addRender(npcs.createRenderSystem());
  scheduler.addRender(damage.createRenderSystem(gfx.camera, () => gfx.drawingBufferSize.height));
  let cullTimer = 0;
  const parkedSystem: RenderSystem = {
    name: 'parkedVehicles',
    phase: 'ui',
    renderUpdate: (ctx) => {
      const c = centre();
      parked.update(c.x, c.z, ctx.frameSeconds);
      cullTimer -= ctx.frameSeconds;
      if (cullTimer <= 0) {
        cullTimer = 2;
        npcs.cull(c.x, c.z, 220);
      }
    },
  };
  scheduler.addRender(parkedSystem);
  engine.overlayLines.push(
    () =>
      `vehicles ${manager.vehicles.length} (parked ${parked.parkedCount})  npcs ${npcs.npcs.length}  models ${vehicleModelCacheSize()}  particles ${smoke.alive + glow.alive}  explosions ${damage.explosions}`,
  );
  return { manager, npcs, damage, parked };
}

/**
 * Compiles every vehicle/particle shader variant up front (paint, glass, cracked glass, burnt,
 * lights, skinning, both particle blends) so the first parked car or explosion does not stall a
 * frame on shader compilation.
 */
function warmUpShaders(
  engine: Engine,
  materials: VehicleMaterials,
  smoke: ParticleSystem,
  glow: ParticleSystem,
): void {
  const { gfx } = engine;
  const def = ALL_VEHICLES.find((d) => d.kind === 'car');
  if (!def) return;
  const model = buildVehicleModel(def, def.colours[0]);
  const views = [
    new VehicleView(model, def, materials),
    new VehicleView(model, def, materials),
    new VehicleView(model, def, materials),
  ];
  views[1]?.setGlass('cracked');
  views[2]?.setBurnt();
  const at = gfx.camera.position;
  views.forEach((v, i) => {
    v.root.position.set(at.x + i * 6, at.y, at.z - 12);
    gfx.scene.add(v.root);
  });
  smoke.emit(at.x, at.y, at.z - 10, 0, 0, 0, PARTICLES.smoke);
  glow.emit(at.x, at.y, at.z - 10, 0, 0, 0, PARTICLES.fire);
  smoke.update(0, gfx.camera, 1);
  glow.update(0, gfx.camera, 1);
  gfx.renderer.compile(gfx.scene, gfx.camera);
  for (const v of views) v.dispose();
  smoke.clear();
  glow.clear();
}

const DEATH_BY_EXPLOSION_RADIUS = 10;

/** The player's driving: controller, chase camera, HUD, explosion damage, debug commands, probes. */
export function setupDriving(
  engine: Engine,
  vw: VehicleWorld,
  handle: PlayerHandle,
): PlayerVehicleController {
  const { gfx, physics, scheduler, commands, probes, bus, input, root } = engine;
  const { player, presentation, camera } = handle;
  const controller = new PlayerVehicleController(
    player,
    presentation,
    camera,
    vw.manager,
    physics,
    input,
    bus,
    gfx.camera,
    createCameraCollision(physics),
  );
  scheduler.addFixed({
    name: 'playerDriving',
    phase: 'gameplay',
    fixedUpdate: (ctx) => controller.fixedUpdate(ctx),
  });
  scheduler.addRender({
    name: 'vehicleCamera',
    phase: 'camera',
    renderUpdate: (ctx) => controller.renderUpdate(ctx),
  });

  // HUD.
  const hud = new VehicleHud(root);
  const state: VehicleHudState = {
    driving: false,
    speedKmh: 0,
    gear: 1,
    rev: 0,
    engine: 1,
    hotwire: null,
    prompt: '',
  };
  let promptTimer = 0;
  scheduler.addRender({
    name: 'vehicleHud',
    phase: 'ui',
    renderUpdate: (ctx) => {
      const v = controller.vehicle;
      const inside = controller.driving && v !== null;
      state.driving = inside;
      if (inside) {
        const t = v.sim.telemetry;
        state.speedKmh = Math.abs(t.forwardSpeed) * 3.6;
        state.gear = v.def.kind === 'boat' ? null : t.gear;
        state.rev = v.sim instanceof RaycastVehicle ? t.rpm / v.def.engine.redlineRpm : t.rpm / 6000;
        state.engine = v.engineHealth / v.def.durability;
      }
      state.hotwire = controller.phase === 'hotwire' ? controller.hotwire : null;
      promptTimer -= ctx.frameSeconds;
      if (promptTimer <= 0) {
        promptTimer = 0.2;
        state.prompt = '';
        if (controller.phase === 'foot' && player.alive && !player.placing) {
          const p = player.motor.position;
          const near = vw.manager.nearest(p.x, p.y, p.z, 5, (c) => !c.wrecked && c.driver !== 'player');
          const key = input.getBindings().interact[0];
          if (near && key) {
            const verb = near.occupant ? 'Carjack' : near.locked ? 'Break in' : 'Enter';
            state.prompt = `${describeBinding(key)}  ${verb} ${near.def.name}`;
          }
        }
      }
      hud.update(state, ctx.frameSeconds);
    },
  });
  bus.on('vehicle:entered', ({ model }) => {
    const def = ALL_VEHICLES.find((d) => d.id === model);
    if (def) hud.showName(def.name);
  });
  // Explosions hurt the player by distance (inside the vehicle is fatal).
  bus.on('vehicle:exploded', ({ vehicle, x, y, z }) => {
    if (player.dead) return;
    const inside = controller.vehicle?.id === vehicle && controller.busy;
    const p = player.motor.position;
    const d = Math.hypot(p.x - x, p.y - y, p.z - z);
    if (inside) player.damage(250, 'explosion', true);
    else if (d < DEATH_BY_EXPLOSION_RADIUS)
      player.damage(140 * (1 - d / DEATH_BY_EXPLOSION_RADIUS) ** 1.5, 'explosion');
  });

  // ---- debug commands ----------------------------------------------------------------------------
  const ids = ALL_VEHICLES.map((d) => d.id);
  const target = (args: readonly string[], index: number): VehicleInstance => {
    if (args[index] === 'nearest' || !controller.vehicle) {
      const p = player.motor.position;
      const v = vw.manager.nearest(p.x, p.y, p.z, 60);
      if (!v) throw new CommandError('No vehicle nearby.');
      return v;
    }
    return controller.vehicle;
  };
  commands.register({
    name: 'spawncar',
    usage: `spawncar <${ids.join('|')}> [locked|driver|enter|parked]`,
    help: 'Spawn a vehicle in front of the player (enter: get straight in)',
    run: (args) => {
      const id = args[0];
      const def = ALL_VEHICLES.find((d) => d.id === id);
      if (!def) throw new CommandError(`Unknown vehicle. Options: ${ids.join(', ')}`);
      const p = player.motor.position;
      const yaw = player.motor.yaw;
      const ahead = 3 + def.length / 2;
      const x = p.x + Math.sin(yaw) * ahead;
      const z = p.z + Math.cos(yaw) * ahead;
      const boat = def.kind === 'boat';
      const y = boat ? -0.3 : p.y + 0.4;
      // Side-on with the driver's door facing the player (or, to get straight in, pointing the
      // way the player looks).
      const enter = args.includes('enter');
      const v = vw.manager.spawn(def, x, y, z, enter ? yaw : yaw + Math.PI / 2, {
        colour: def.colours[0],
        locked: args.includes('locked'),
        engineOn: args.includes('driver'),
      });
      v.persistent = !args.includes('parked');
      if (args.includes('driver')) {
        const npc = vw.npcs.spawn(randomAppearance(engine.rngs.get('spawned-drivers')), x, y + 1, z);
        npc.sit({
          anchor: v.view.mesh,
          seat: v.view.model.seat.clone(),
          door: (v.view.model.doors[0]?.stand ?? v.view.model.seat).clone(),
          blend: 1,
          clip: 'sitDrive',
          steer: 0,
          hidden: false,
        });
        v.occupant = npc;
        v.driver = 'npc';
      }
      if (args.includes('enter')) controller.enterImmediately(v);
      return `Spawned ${def.name} (#${v.id}).`;
    },
  });
  commands.register({
    name: 'fix',
    usage: 'fix [nearest]',
    help: 'Repair the current (or nearest) vehicle',
    run: (args) => {
      const v = target(args, 0);
      vw.damage.repair(v);
      return `${v.def.name} repaired.`;
    },
  });
  commands.register({
    name: 'explode',
    usage: 'explode [nearest]',
    help: 'Blow up the current (or nearest) vehicle',
    run: (args) => {
      const v = target(args, 0);
      vw.damage.explode(v);
      return `${v.def.name} exploded.`;
    },
  });
  commands.register({
    name: 'vdamage',
    usage: 'vdamage <amount> [nearest]',
    help: 'Damage the engine of the current (or nearest) vehicle',
    run: (args) => {
      const v = target(args, 1);
      vw.damage.damage(v, numberArg(args, 0, 'amount'));
      return `${v.def.name}: engine ${Math.round(v.engineHealth)} / ${v.def.durability}.`;
    },
  });
  commands.register({
    name: 'siren',
    usage: 'siren [on|off]',
    help: 'Toggle the light bar of the current emergency vehicle',
    run: (args) => {
      const v = target(args, 1);
      if (!v.def.lightBar) throw new CommandError(`${v.def.name} has no light bar.`);
      v.siren = toggleArg(args, 0, v.siren);
      return `Siren ${v.siren ? 'on' : 'off'}.`;
    },
  });
  commands.register({
    name: 'viewcar',
    usage: 'viewcar [front|side|rear]',
    help: 'Free camera at a three-quarter view of the nearest vehicle',
    run: (args) => {
      const p = player.motor.position;
      const v = vw.manager.nearest(p.x, p.y, p.z, 80);
      if (!v) throw new CommandError('No vehicle nearby.');
      const angle = args[0] === 'rear' ? Math.PI * 0.8 : args[0] === 'side' ? Math.PI / 2 : Math.PI * 0.22;
      const r = v.def.length * 0.9 + 2.5;
      const q = v.sim.body.rotation();
      const heading = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
      const t = v.sim.body.translation();
      const cx = t.x + Math.sin(heading + angle) * r;
      const cz = t.z + Math.cos(heading + angle) * r;
      if (!handle.flying()) commands.execute('fly on');
      engine.flyCamera.setPose(cx, t.y + v.def.height * 0.9 + 0.6, cz, 0, 0);
      engine.flyCamera.lookAt(t.x, t.y + v.def.height * 0.45, t.z);
      return `Viewing ${v.def.name}.`;
    },
  });
  commands.register({
    name: 'gearbox',
    usage: 'gearbox [manual|auto]',
    help: 'Manual (E/Q to shift) or automatic gearbox for vehicles you drive',
    run: (args) => {
      const want = args[0];
      controller.manualGearbox = want === undefined ? !controller.manualGearbox : want === 'manual';
      const v = controller.vehicle;
      if (v && v.sim instanceof RaycastVehicle) v.sim.drivetrain.automatic = !controller.manualGearbox;
      return `Gearbox ${controller.manualGearbox ? 'manual (E up / Q down)' : 'automatic'}.`;
    },
  });
  let telemetry = false;
  commands.register({
    name: 'telemetry',
    usage: 'telemetry [on|off]',
    help: 'Vehicle telemetry in the debug overlay (F3)',
    run: (args) => {
      telemetry = toggleArg(args, 0, telemetry);
      return `Telemetry ${telemetry ? 'on' : 'off'}.`;
    },
  });
  engine.overlayLines.push(() => {
    const v = controller.vehicle;
    if (!telemetry || !v) return '';
    const t = v.sim.telemetry;
    const wheels =
      v.sim instanceof RaycastVehicle
        ? v.sim.wheels
            .map(
              (w) =>
                `${w.grounded ? 'G' : '-'}${(w.load / 1000).toFixed(1)}k κ${w.slipRatio.toFixed(2)} α${w.slipAngle.toFixed(2)}`,
            )
            .join(' | ')
        : '';
    return `${v.def.name}  ${(t.forwardSpeed * 3.6).toFixed(0)} km/h  gear ${t.gear}  ${t.rpm.toFixed(0)} rpm  thr ${t.throttle.toFixed(2)} brk ${t.brake.toFixed(2)}  lat ${t.lateralG.toFixed(2)}g  long ${t.longitudinalG.toFixed(2)}g\n${wheels}`;
  });

  probes.register('vehicle', () => {
    const v = controller.vehicle;
    const base = {
      phase: controller.phase,
      entries: controller.entries,
      hotwire: controller.hotwire,
      chase: controller.chase.mode,
    };
    if (!v) return { ...base, id: null };
    const t = v.sim.body.translation();
    return {
      ...base,
      id: v.id,
      model: v.def.id,
      kind: v.def.kind,
      x: t.x,
      y: t.y,
      z: t.z,
      speedKmh: v.sim.telemetry.forwardSpeed * 3.6,
      gear: v.sim.telemetry.gear,
      rpm: v.sim.telemetry.rpm,
      engineOn: v.sim.engineOn,
      engineHealth: v.engineHealth,
      onFire: v.onFire,
      wrecked: v.wrecked,
      glass: v.view.glass,
      locked: v.locked,
      siren: v.siren,
      detachedWheels: v.sim instanceof RaycastVehicle ? v.sim.wheels.filter((w) => w.detached).length : 0,
      dented: v.view.hasOwnGeometry,
      cameraBlocked: controller.chase.blocked,
    };
  });
  probes.register('vehicles', () => {
    const p = player.motor.position;
    const list = vw.manager.vehicles
      .map((v) => {
        const t = v.sim.body.translation();
        return {
          id: v.id,
          model: v.def.id,
          x: t.x,
          y: t.y,
          z: t.z,
          d: Math.hypot(t.x - p.x, t.z - p.z),
          driver: v.driver,
          locked: v.locked,
          occupied: v.occupant !== null,
          wrecked: v.wrecked,
          onFire: v.onFire,
          engineHealth: v.engineHealth,
          sleeping: v.sim.body.isSleeping(),
        };
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, 30);
    return {
      count: vw.manager.vehicles.length,
      parked: vw.parked.parkedCount,
      npcs: vw.npcs.npcs.length,
      fleeing: vw.npcs.npcs.filter((n) => n.state === 'flee' || n.state === 'stumble').length,
      explosions: vw.damage.explosions,
      looseWheels: vw.damage.looseWheelCount,
      list,
    };
  });
  return controller;
}
