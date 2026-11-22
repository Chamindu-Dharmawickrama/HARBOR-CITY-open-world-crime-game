import * as THREE from 'three';
import { toggleArg } from '../../debug/command-registry';
import type { RenderContext, RenderSystem } from '../../ecs/scheduler';
import { showControlHint, type Engine } from '../engine';
import { PhysicsPlayground } from '../physics-playground';

const SKY_COLOR = 0x9ec5e8;

/** Render-phase camera that orbits the playground on a fixed path (benchmark mode). */
function createBenchOrbitCamera(camera: THREE.PerspectiveCamera): RenderSystem {
  let t = 0;
  return {
    name: 'benchOrbitCamera',
    phase: 'camera',
    renderUpdate(ctx: RenderContext): void {
      t += ctx.frameSeconds;
      const angle = (t / 20) * Math.PI * 2;
      camera.position.set(Math.cos(angle) * 46, 16 + Math.sin(angle * 2) * 4, Math.sin(angle) * 46);
      camera.lookAt(0, 4, 0);
    },
  };
}

/** M0 engine test scene: a ground slab and a stream of physics boxes. */
export function setupPlaygroundScene(engine: Engine): void {
  const { gfx, input, scheduler, commands, probes, bus } = engine;
  const benchMode = engine.params.bench === 'playground';
  gfx.scene.background = new THREE.Color(SKY_COLOR);
  gfx.scene.fog = new THREE.Fog(SKY_COLOR, 120, gfx.settings.drawDistance);
  const playground = new PhysicsPlayground(
    engine.world,
    engine.physics,
    gfx.scene,
    engine.rngs.get('playground'),
    {
      maxBoxes: 240,
      spawnInterval: benchMode ? 0.02 : 0.25,
    },
  );
  engine.flyCamera.setPose(0, 14, 52, 0, -0.2);
  const aim = { origin: new THREE.Vector3(), direction: new THREE.Vector3() };
  scheduler.addFixed(
    playground.createSystem(input, () => {
      aim.origin.copy(gfx.camera.position);
      gfx.camera.getWorldDirection(aim.direction);
      return aim;
    }),
  );
  if (benchMode) {
    engine.flyCamera.enabled = false;
    scheduler.addRender(createBenchOrbitCamera(gfx.camera));
  } else {
    showControlHint(
      engine.root,
      'Click to look · WASD move · E/Q up/down · Shift fast · Left click throws a box · P pause · F3 overlay · ` console',
    );
  }

  commands.register({
    name: 'spawn',
    usage: 'spawn [count]',
    help: 'Drop random boxes into the playground',
    run: (args) => {
      const count = Math.max(1, Math.min(500, Math.round(Number(args[0] ?? 10)) || 10));
      playground.spawnRandom(count);
      return `Spawned ${count} box(es); ${playground.boxCount} in scene.`;
    },
  });
  commands.register({
    name: 'autospawn',
    usage: 'autospawn [on|off]',
    help: 'Toggle timed box spawning in the playground',
    run: (args) => {
      playground.autoSpawn = toggleArg(args, 0, playground.autoSpawn);
      return `Auto-spawn ${playground.autoSpawn ? 'on' : 'off'}.`;
    },
  });
  commands.register({
    name: 'reset',
    help: 'Remove every box from the playground',
    run: () => {
      playground.clear();
      bus.emitNow('debug:sceneReset', { reason: 'console' });
      return 'Playground cleared.';
    },
  });
  probes.register('playground', () => playground.probe());
}
