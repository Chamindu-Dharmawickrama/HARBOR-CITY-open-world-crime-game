import { buildClipLibrary } from '../../characters/anim/clip';
import type { MotorEnvironment } from '../../characters/controller/character-motor';
import { PlayerCharacter } from '../../characters/player/player-character';
import {
  createPlayerFixedSystem,
  PlayerCameraSystem,
  PlayerPresentation,
} from '../../characters/player/player-systems';
import { PLAYER_APPEARANCE } from '../../characters/rig/appearance';
import { buildCharacter, createCharacterMaterial } from '../../characters/rig/character-mesh';
import { CharacterView } from '../../characters/rig/character-view';
import { addArmor, heal } from '../../characters/stats/vitals';
import { ANIMATION_CLIPS } from '../../content/animations';
import { cloneBindings } from '../../core/input/bindings';
import { CommandError, numberArg, toggleArg } from '../../debug/command-registry';
import type { RenderSystem } from '../../ecs/scheduler';
import { teleport, Transform } from '../../ecs/transform';
import { browserStorage, defaultSettings, SettingsStore, type GameSettings } from '../../save/settings-store';
import { PlayerHud } from '../../ui/hud/player-hud';
import { PauseMenu } from '../../ui/menus/pause-menu';
import { StatusScreen } from '../../ui/screens/status-screen';
import { pointInPolygon } from '../../world/gen/geometry2d';
import type { TerrainModel } from '../../world/gen/islands';
import type { CityLayout } from '../../world/gen/types';
import type { Engine } from '../engine';
import { COURSE_SPOTS, findOpenWater, TestCourse, type CourseSpot, type CourseSpotName } from './test-course';

export interface PlayerSceneContext {
  terrain: TerrainModel;
  layout: CityLayout;
  waterLevel: number;
  /** Where the course is searched for (near the docks). */
  courseNear: { x: number; z: number };
}

export interface PlayerHandle {
  readonly player: PlayerCharacter;
  readonly camera: PlayerCameraSystem;
  readonly spawn: CourseSpot;
}

const DEATH_LINES: Record<string, string> = {
  fall: 'Gravity always wins.',
  fell: 'Lost to the deep.',
  debug: 'Taken out by the developer console.',
};

/**
 * Open water = not on an island and not inside the tunnel corridor or its trenches (the tunnel
 * runs below sea level under open water, so "below the surface" alone does not mean swimming).
 */
export function createWaterTest(
  terrain: TerrainModel,
  layout: CityLayout,
): (x: number, z: number) => boolean {
  const segments: { ax: number; az: number; bx: number; bz: number; r2: number }[] = [];
  for (const edge of layout.edges) {
    if (edge.cls !== 'tunnel') continue;
    const a = layout.nodes[edge.a];
    const b = layout.nodes[edge.b];
    if (!a || !b) continue;
    const r = edge.width / 2 + 5;
    segments.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, r2: r * r });
  }
  const holes = layout.holes.map((h) => h.polygon);
  const p = { x: 0, z: 0 };
  return (x, z) => {
    if (terrain.isLand(x, z)) return false;
    for (const s of segments) {
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const len2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / len2));
      const ex = s.ax + dx * t - x;
      const ez = s.az + dz * t - z;
      if (ex * ex + ez * ez < s.r2) return false;
    }
    p.x = x;
    p.z = z;
    for (const hole of holes) if (pointInPolygon(p, hole)) return false;
    return true;
  };
}

/** Sidewalk point nearest to (x, z): a safe on-foot spawn. */
export function sidewalkSpawn(layout: CityLayout, x: number, z: number): CourseSpot {
  let best = layout.sidewalks[0];
  let bestD = Infinity;
  for (const node of layout.sidewalks) {
    const d = (node.x - x) ** 2 + (node.z - z) ** 2;
    if (d < bestD && node.links.length >= 2) {
      bestD = d;
      best = node;
    }
  }
  if (!best) throw new Error('sidewalkSpawn: the city has no sidewalks');
  return { x: best.x, y: best.y, z: best.z, yaw: Math.PI };
}

/** Builds the on-foot player and everything around it: view, camera, HUD, menus, settings, debug. */
export function setupPlayer(engine: Engine, ctx: PlayerSceneContext, spawn: CourseSpot): PlayerHandle {
  const { gfx, physics, world, scheduler, commands, probes, bus, input, keyboardMouse } = engine;
  const env: MotorEnvironment = {
    waterLevel: ctx.waterLevel,
    isWater: createWaterTest(ctx.terrain, ctx.layout),
  };

  // ---- settings (bindings + look) persisted in localStorage --------------------------------------
  const store = new SettingsStore(browserStorage());
  let settings: GameSettings = store.load();
  const applySettings = (): void => {
    input.setBindings(settings.bindings);
    input.settings.mouseSensitivity = settings.controls.mouseSensitivity;
    input.settings.invertY = settings.controls.invertY;
    input.settings.padLookSpeed = settings.controls.padLookSpeed;
  };
  applySettings();
  const persist = (): void => {
    applySettings();
    store.save(settings);
  };

  // ---- player, view, camera ----------------------------------------------------------------------
  let camera: PlayerCameraSystem | null = null;
  const cameraView = {
    get yaw() {
      return camera?.yaw ?? 0;
    },
    get pitch() {
      return camera?.pitch ?? 0;
    },
  };
  const player = new PlayerCharacter(
    physics,
    env,
    input,
    bus,
    cameraView,
    spawn.x,
    spawn.y,
    spawn.z,
    () => spawn,
  );
  const entity = world.create();
  world.add(entity, Transform);
  teleport(world.soa(Transform), entity, spawn.x, spawn.y, spawn.z);
  const rig = buildCharacter(PLAYER_APPEARANCE, createCharacterMaterial());
  const view = new CharacterView(rig, PLAYER_APPEARANCE.body);
  gfx.scene.add(view.root);
  const presentation = new PlayerPresentation(
    player,
    view,
    world,
    entity,
    physics,
    buildClipLibrary(ANIMATION_CLIPS),
    cameraView,
  );
  camera = new PlayerCameraSystem(gfx.camera, physics, input, player, presentation);
  const cam = camera;
  engine.flyCamera.enabled = false;
  scheduler.addFixed(createPlayerFixedSystem(player, world, entity));
  scheduler.addRender(presentation);
  scheduler.addRender(cam);
  player.placeAt(spawn.x, spawn.z, spawn.y + 2, spawn.yaw);

  // ---- HUD, FLATLINED, pause menu ----------------------------------------------------------------
  const hud = new PlayerHud(engine.root);
  const status = new StatusScreen(engine.root);
  let flying = false;
  let menuOpen = false;
  const setControls = (): void => {
    player.controlsEnabled = !flying && !menuOpen;
  };
  const menu = new PauseMenu(
    engine.root,
    {
      getBindings: () => cloneBindings(settings.bindings),
      setBindings: (map) => {
        settings = { ...settings, bindings: cloneBindings(map) };
        persist();
      },
      getControls: () => ({ ...settings.controls }),
      setControls: (controls) => {
        settings = { ...settings, controls: { ...controls } };
        persist();
      },
      resetDefaults: () => {
        settings = defaultSettings();
        persist();
      },
    },
    {
      resume: () => closeMenu(true),
      respawn: () => player.respawn(),
    },
  );
  function openMenu(): void {
    if (menuOpen) return;
    menuOpen = true;
    menu.setOpen(true);
    setControls();
    engine.setPaused(true);
    keyboardMouse.exitPointerLock();
    bus.emitNow('menu:opened', { menu: 'pause' });
  }
  function closeMenu(relock: boolean): void {
    if (!menuOpen) return;
    menuOpen = false;
    menu.setOpen(false);
    setControls();
    engine.setPaused(false);
    if (relock && !engine.params.test) keyboardMouse.requestPointerLock();
    bus.emitNow('menu:closed', { menu: 'pause' });
  }
  engine.pauseAction = () => {
    if (menuOpen) menu.handlePauseAction();
    else openMenu();
  };
  document.addEventListener('pointerlockchange', () => {
    if (!keyboardMouse.pointerLocked && !engine.consoleOpen && !flying) openMenu();
  });

  const hudSystem: RenderSystem = {
    name: 'playerHud',
    phase: 'ui',
    renderUpdate: () => hud.update(player.vitals),
  };
  scheduler.addRender(hudSystem);
  bus.on('player:died', ({ cause }) => {
    status.show('FLATLINED', DEATH_LINES[cause] ?? 'Harbor City claims another.', 'death');
  });
  bus.on('player:respawned', () => {
    status.hide();
    cam.snapBehind();
  });
  bus.on('player:damaged', ({ amount }) => presentation.flinch(amount));

  // ---- debug: fly camera, teleports, vitals, course ----------------------------------------------
  let course: TestCourse | null = null;
  const ensureCourse = (): TestCourse => {
    if (course) return course;
    const keepOut = ctx.layout.edges
      .filter((e) => e.cls === 'bridge' || e.cls === 'tunnel')
      .flatMap((e) => [ctx.layout.nodes[e.a], ctx.layout.nodes[e.b]])
      .filter((n): n is NonNullable<typeof n> => n !== undefined)
      .map((n) => ({ x: n.x, z: n.z, radius: 70 }));
    const at = findOpenWater(ctx.terrain, ctx.courseNear.x, ctx.courseNear.z, keepOut);
    course = new TestCourse(physics, gfx.scene, at.x, at.z, ctx.waterLevel);
    return course;
  };
  const placePlayer = (spot: CourseSpot): void => {
    if (player.dead) player.respawn();
    player.placeAt(spot.x, spot.z, spot.y + 1.5, spot.yaw);
    cam.snapBehind();
  };
  const setFly = (on: boolean): void => {
    if (on === flying) return;
    flying = on;
    setControls();
    cam.enabled = !on;
    engine.flyCamera.enabled = on;
    if (on) {
      const c = gfx.camera;
      engine.flyCamera.setPose(c.position.x, c.position.y, c.position.z, cam.yaw, cam.pitch);
    } else cam.snapBehind();
  };

  commands.register({
    name: 'fly',
    usage: 'fly [on|off]',
    help: 'Toggle the free-fly debug camera (the player waits where they are)',
    run: (args) => {
      setFly(toggleArg(args, 0, flying));
      return `Fly camera ${flying ? 'on' : 'off'}.`;
    },
  });
  commands.register({
    name: 'tpplayer',
    usage: `tpplayer <spawn|cam|${COURSE_SPOTS.join('|')}> | tpplayer <x> <z>`,
    help: 'Teleport the player (course spots build the obstacle course on first use)',
    run: (args) => {
      const target = args[0];
      if (target === undefined) throw new CommandError('Missing target');
      if (target === 'spawn') placePlayer(spawn);
      else if (target === 'cam') {
        const c = gfx.camera.position;
        placePlayer({ x: c.x, y: c.y, z: c.z, yaw: player.motor.yaw });
      } else if ((COURSE_SPOTS as readonly string[]).includes(target)) {
        placePlayer(ensureCourse().spot(target as CourseSpotName));
      } else {
        const x = numberArg(args, 0, 'x');
        const z = numberArg(args, 1, 'z');
        placePlayer({ x, y: 420, z, yaw: player.motor.yaw });
      }
      if (flying) setFly(false);
      return `Player → ${target}.`;
    },
  });
  commands.register({
    name: 'course',
    help: 'Build the obstacle course (walls, towers, low tunnel, water) and go there',
    run: () => {
      placePlayer(ensureCourse().spot('start'));
      if (flying) setFly(false);
      const c = ensureCourse();
      return `Course at (${c.originX.toFixed(0)}, ${c.originZ.toFixed(0)}).`;
    },
  });
  commands.register({
    name: 'damage',
    usage: 'damage <amount> [armor|pierce]',
    help: 'Damage the player (pierce ignores armour)',
    run: (args) => {
      player.damage(numberArg(args, 0, 'amount'), 'debug', args[1] === 'pierce');
      return `Health ${player.vitals.health.toFixed(0)}, armour ${player.vitals.armor.toFixed(0)}.`;
    },
  });
  commands.register({
    name: 'heal',
    usage: 'heal [amount]',
    help: 'Heal the player',
    run: (args) => {
      heal(player.vitals, numberArg(args, 0, 'amount', 100));
      return `Health ${player.vitals.health.toFixed(0)}.`;
    },
  });
  commands.register({
    name: 'armor',
    usage: 'armor [amount]',
    help: 'Give the player armour',
    run: (args) => {
      addArmor(player.vitals, numberArg(args, 0, 'amount', 100));
      return `Armour ${player.vitals.armor.toFixed(0)}.`;
    },
  });
  commands.register({
    name: 'kill',
    help: 'Kill the player',
    run: () => {
      player.kill('debug');
      return 'FLATLINED.';
    },
  });
  commands.register({
    name: 'respawn',
    help: 'Respawn the player at the spawn point',
    run: () => {
      player.respawn();
      return 'Respawned.';
    },
  });
  commands.register({
    name: 'camlook',
    usage: 'camlook <yawDeg> [pitchDeg]',
    help: 'Point the player camera (yaw 0 = north, positive = left)',
    run: (args) => {
      cam.orbit.yaw = (numberArg(args, 0, 'yaw') * Math.PI) / 180;
      cam.orbit.pitch = (numberArg(args, 1, 'pitch', (cam.orbit.pitch * 180) / Math.PI) * Math.PI) / 180;
      return 'Camera aimed.';
    },
  });
  commands.register({
    name: 'camaudit',
    usage: 'camaudit [reset]',
    help: 'Camera clipping audit: frames checked / frames clipped',
    run: (args) => {
      if (args[0] === 'reset') cam.resetAudit();
      return `${cam.clippedFrames} clipped of ${cam.auditedFrames} frames.`;
    },
  });

  probes.register('player', () => {
    const m = player.motor;
    const p = m.position;
    const v = player.vitals;
    return {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: m.yaw,
      mode: m.mode,
      grounded: m.grounded,
      crouched: m.crouched,
      speed: m.speed,
      health: v.health,
      armor: v.armor,
      stamina: v.stamina,
      exhausted: v.exhausted,
      dead: player.dead,
      deaths: player.deaths,
      landings: m.landings,
      lastImpactSpeed: m.lastImpactSpeed,
      waterEntries: m.waterEntries,
      placing: player.placing,
      aiming: player.aiming,
      controlsEnabled: player.controlsEnabled,
      anim: presentation.animator.state,
    };
  });
  probes.register('playerCamera', () => {
    const o = cam.orbit;
    return {
      x: o.position.x,
      y: o.position.y,
      z: o.position.z,
      yaw: o.yaw,
      pitch: o.pitch,
      distance: o.distance,
      desired: o.desiredDistance,
      free: o.freeDistance,
      blocked: o.blocked,
      aiming: o.aiming,
      shoulder: o.shoulder,
      distanceIndex: o.distanceIndex,
      audited: cam.auditedFrames,
      clipped: cam.clippedFrames,
      lastClipped: cam.lastClipped,
      firstClip: cam.firstClip,
      fly: flying,
      fov: gfx.camera.fov,
    };
  });
  probes.register('menu', () => ({
    open: menuOpen,
    page: menu.currentPage,
    listening: menu.controls.isListening,
  }));
  probes.register('status', () => ({ visible: status.isVisible, text: status.text }));
  probes.register('course', () =>
    course ? Object.fromEntries(COURSE_SPOTS.map((n) => [n, course?.spot(n)])) : null,
  );
  probes.register('settings', () => store.load());
  engine.overlayLines.push(() => {
    const m = player.motor;
    return `player ${m.mode}${m.crouched ? ' crouched' : ''} ${m.speed.toFixed(1)} m/s  hp ${player.vitals.health.toFixed(0)}  stamina ${player.vitals.stamina.toFixed(0)}  anim ${presentation.animator.state}  cam ${cam.orbit.distance.toFixed(2)} m${cam.orbit.blocked ? ' (blocked)' : ''}`;
  });

  return { player, camera: cam, spawn };
}
