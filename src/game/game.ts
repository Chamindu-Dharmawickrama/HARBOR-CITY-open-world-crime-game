import * as THREE from 'three';
import { EventBus, type GameEvents } from '../core/events';
import { DEFAULT_BINDINGS } from '../core/input/bindings';
import { GamepadDevice } from '../core/input/gamepad-device';
import { InputSystem } from '../core/input/input-system';
import { KeyboardMouseDevice } from '../core/input/keyboard-mouse-device';
import { VirtualInputDevice } from '../core/input/virtual-device';
import { FIXED_STEP_SECONDS, GameLoop } from '../core/loop';
import { Profiler } from '../core/profiler';
import { RngStreams } from '../core/rng';
import { SimClock } from '../core/sim-clock';
import { RingBuffer } from '../core/stats';
import { CommandRegistry, toggleArg } from '../debug/command-registry';
import { DevConsole } from '../debug/dev-console';
import { FreeFlyCamera } from '../debug/free-fly-camera';
import { installDebugHotkeys } from '../debug/hotkeys';
import { DebugOverlay, type OverlaySnapshot } from '../debug/overlay';
import { PhysicsDebugDraw } from '../debug/physics-debug-draw';
import { ProbeRegistry } from '../debug/probe-registry';
import { installTestApi, type HarborTestApi } from '../debug/test-api';
import { Scheduler, type FixedContext, type RenderContext, type RenderSystem } from '../ecs/scheduler';
import { createTransformSnapshotSystem } from '../ecs/transform';
import { World } from '../ecs/world';
import { PhysicsWorld } from '../physics/physics-world';
import { loadRapier } from '../physics/rapier';
import { createPhysicsStepSystem, createRigidBodySyncSystem } from '../physics/rigid-body-sync';
import { GameRenderer, type RenderStats } from '../rendering/game-renderer';
import { getQuality, isQualityPresetName } from '../rendering/quality';
import { createInstanceSyncSystem, createRenderObjectSyncSystem } from '../rendering/render-sync';
import { showFatalError } from '../ui/fatal-error';
import { LoadingScreen } from '../ui/loading-screen';
import { BenchRecorder } from './bench';
import { registerCoreCommands } from './dev-commands';
import { PhysicsPlayground } from './physics-playground';
import type { UrlParams } from './url-params';

export const GAME_VERSION = '0.1.0-m0';
export const BENCH_SCENARIOS = ['playground'] as const;

const SKY_COLOR = 0x9ec5e8;

function readHeapMB(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize / (1024 * 1024) : null;
}

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

/** Composition root: builds every engine service, registers systems and runs the loop. */
export async function startGame(root: HTMLElement, params: UrlParams): Promise<void> {
  if (params.bench !== null && !(BENCH_SCENARIOS as readonly string[]).includes(params.bench)) {
    throw new Error(`Unknown bench scenario "${params.bench}". Known: ${BENCH_SCENARIOS.join(', ')}`);
  }
  const loading = new LoadingScreen(root);
  loading.setStatus('Starting physics engine…');
  const rapier = await loadRapier();
  loading.setStatus('Building scene…');

  const canvas = document.createElement('canvas');
  canvas.id = 'game-canvas';
  canvas.tabIndex = 0;
  root.prepend(canvas);

  const bus = new EventBus<GameEvents>();
  const rngs = new RngStreams(params.seed);
  const gfx = new GameRenderer(canvas, getQuality(params.preset), params.gpu);
  gfx.scene.background = new THREE.Color(SKY_COLOR);
  gfx.scene.fog = new THREE.Fog(SKY_COLOR, 120, gfx.settings.drawDistance);
  const physics = new PhysicsWorld(rapier);
  const world = new World(1 << 16);
  const keyboardMouse = new KeyboardMouseDevice(canvas);
  keyboardMouse.attach();
  const virtualInput = new VirtualInputDevice();
  const input = new InputSystem([keyboardMouse, new GamepadDevice(), virtualInput], DEFAULT_BINDINGS);
  const profiler = new Profiler();
  const scheduler = new Scheduler(profiler);
  const clock = new SimClock(FIXED_STEP_SECONDS);
  const benchMode = params.bench !== null;

  const playground = new PhysicsPlayground(world, physics, gfx.scene, rngs.get('playground'), {
    maxBoxes: 240,
    spawnInterval: benchMode ? 0.02 : 0.25,
  });
  const flyCamera = new FreeFlyCamera(gfx.camera, input);
  flyCamera.setPose(0, 14, 52, 0, -0.2);
  const physicsLines = new PhysicsDebugDraw(physics, gfx.scene);
  const aim = { origin: new THREE.Vector3(), direction: new THREE.Vector3() };
  const aimFromCamera = (): typeof aim => {
    aim.origin.copy(gfx.camera.position);
    gfx.camera.getWorldDirection(aim.direction);
    return aim;
  };

  scheduler
    .addFixed(createTransformSnapshotSystem(world))
    .addFixed(playground.createSystem(input, aimFromCamera))
    .addFixed(createPhysicsStepSystem(physics))
    .addFixed(createRigidBodySyncSystem(world))
    .addRender(createRenderObjectSyncSystem(world))
    .addRender(createInstanceSyncSystem(world))
    .addRender(benchMode ? createBenchOrbitCamera(gfx.camera) : flyCamera)
    .addRender(physicsLines)
    .addRender({ name: 'render', phase: 'render', renderUpdate: () => gfx.render() });

  // ---- frame statistics -------------------------------------------------------------------
  const frameTimes = new RingBuffer(120);
  const cpuTimes = new RingBuffer(120);
  const renderStats: RenderStats = {
    drawCalls: 0,
    triangles: 0,
    lines: 0,
    geometries: 0,
    textures: 0,
    programs: 0,
  };
  const snapshot = (): OverlaySnapshot => {
    const size = gfx.drawingBufferSize;
    return {
      fps: frameTimes.mean > 0 ? 1000 / frameTimes.mean : 0,
      frameMsAvg: frameTimes.mean,
      frameMsMax: frameTimes.max(),
      cpuMsAvg: cpuTimes.mean,
      drawCalls: renderStats.drawCalls,
      triangles: renderStats.triangles,
      geometries: renderStats.geometries,
      textures: renderStats.textures,
      programs: renderStats.programs,
      entities: world.entityCount,
      bodies: physics.bodyCount,
      colliders: physics.colliderCount,
      awakeBodies: physics.countAwakeDynamic(),
      heapMB: readHeapMB(),
      tick: clock.tick,
      simTime: clock.time,
      paused: loop.isPaused,
      timeScale: loop.timeScale,
      preset: gfx.settings.name,
      gpu: gfx.gpuName,
      seed: params.seed,
      resolution: `${size.width}x${size.height} @${size.pixelRatio.toFixed(2)}`,
      systems: profiler.report(),
    };
  };

  // ---- debug tooling -----------------------------------------------------------------------
  const overlay = new DebugOverlay(root, snapshot, params.debug || benchMode);
  const commands = new CommandRegistry();
  const probes = new ProbeRegistry();
  const devConsole = new DevConsole(root, commands, (open) => {
    input.enabled = !open;
    input.clearPending();
    virtualInput.releaseAll();
    if (open) keyboardMouse.exitPointerLock();
  });
  installDebugHotkeys({
    F3: () => overlay.setVisible(!overlay.visible),
    F4: () => physicsLines.setEnabled(!physicsLines.enabled),
  });

  const fixedCtx: { dt: number; tick: number; time: number } & FixedContext = {
    dt: FIXED_STEP_SECONDS,
    tick: 0,
    time: 0,
  };
  const renderCtx: { alpha: number; frameSeconds: number; time: number } & RenderContext = {
    alpha: 0,
    frameSeconds: 0,
    time: 0,
  };
  const bench = benchMode ? new BenchRecorder(3, 15) : null;
  let api: HarborTestApi | null = null;
  let frameStart = 0;
  let frames = 0;

  const loop = new GameLoop({
    beginFrame: () => {
      frameStart = performance.now();
      input.update();
      if (input.pressedThisFrame('pause')) setPaused(!loop.isPaused);
    },
    fixedUpdate: (dt) => {
      input.beginFixedStep();
      clock.advance();
      fixedCtx.dt = dt;
      fixedCtx.tick = clock.tick;
      fixedCtx.time = clock.time;
      scheduler.runFixed(fixedCtx);
      bus.flush();
      world.flushDestroyed();
    },
    renderUpdate: (alpha, frameSeconds) => {
      renderCtx.alpha = alpha;
      renderCtx.frameSeconds = frameSeconds;
      renderCtx.time = clock.time;
      gfx.beginFrame();
      scheduler.runRender(renderCtx);
      profiler.endFrame();
      gfx.stats(renderStats);
      const cpuMs = performance.now() - frameStart;
      frames++;
      if (frames > 1) {
        frameTimes.push(frameSeconds * 1000);
        cpuTimes.push(cpuMs);
      }
      overlay.frame(frameSeconds * 1000, frameSeconds);
      if (bench && api && !bench.done && frames > 1) {
        bench.frame(frameSeconds, cpuMs, renderStats.drawCalls, renderStats.triangles, readHeapMB());
        if (bench.done) finishBench(bench, api);
      }
      if (api && !api.ready && frames >= 3) api.ready = true;
    },
    onError: (error) => {
      console.error(error);
      showFatalError(root, error);
    },
  });

  function setPaused(paused: boolean): void {
    if (paused === loop.isPaused) return;
    loop.setPaused(paused);
    input.clearPending();
    bus.emitNow('game:pauseChanged', { paused });
  }

  function finishBench(recorder: BenchRecorder, testApi: HarborTestApi): void {
    const size = gfx.drawingBufferSize;
    const result = recorder.result({
      scenario: params.bench ?? 'none',
      preset: gfx.settings.name,
      gpu: gfx.gpuName,
      width: size.width,
      height: size.height,
      pixelRatio: size.pixelRatio,
      userAgent: navigator.userAgent,
      droppedSimSeconds: loop.accumulator.droppedSeconds,
    });
    testApi.bench = { done: true, result };
    console.info(`[bench] ${JSON.stringify(result)}`);
  }

  bus.on('settings:qualityChanged', ({ preset }) => {
    if (!isQualityPresetName(preset)) return;
    gfx.applyQuality(getQuality(preset));
    if (gfx.scene.fog instanceof THREE.Fog) gfx.scene.fog.far = gfx.settings.drawDistance;
  });

  registerCoreCommands(commands, probes, {
    seed: params.seed,
    isPaused: () => loop.isPaused,
    setPaused,
    stepTicks: (count) => loop.stepOnce(count),
    getTimeScale: () => loop.timeScale,
    setTimeScale: (scale) => {
      loop.timeScale = scale;
      bus.emitNow('game:timeScaleChanged', { timeScale: scale });
    },
    setPreset: (name) => bus.emitNow('settings:qualityChanged', { preset: name }),
    currentPreset: () => gfx.settings.name,
    overlayVisible: () => overlay.visible,
    setOverlayVisible: (visible) => overlay.setVisible(visible),
    physicsLinesVisible: () => physicsLines.enabled,
    setPhysicsLinesVisible: (visible) => physicsLines.setEnabled(visible),
    teleportCamera: (x, y, z) => flyCamera.setPose(x, y, z, flyCamera.yaw, flyCamera.pitch),
    clearConsole: () => devConsole.clear(),
    statsSummary: () => {
      const s = snapshot();
      return [
        `fps ${s.fps.toFixed(1)}  frame ${s.frameMsAvg.toFixed(2)} ms  cpu ${s.cpuMsAvg.toFixed(2)} ms`,
        `draws ${s.drawCalls}  tris ${s.triangles}  entities ${s.entities}  bodies ${s.bodies}`,
      ].join('\n');
    },
  });
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

  probes.register('stats', snapshot);
  probes.register('playground', () => playground.probe());
  probes.register('camera', () => ({
    x: gfx.camera.position.x,
    y: gfx.camera.position.y,
    z: gfx.camera.position.z,
    yaw: flyCamera.yaw,
    pitch: flyCamera.pitch,
  }));
  probes.register('input', () => ({
    moveX: input.axis('moveX'),
    moveY: input.axis('moveY'),
    flyY: input.axis('flyY'),
    activeDevice: input.activeDevice,
    enabled: input.enabled,
  }));
  probes.register('scheduler', () => scheduler.describe());

  if (params.test || benchMode || import.meta.env.DEV) {
    api = installTestApi({
      version: GAME_VERSION,
      tick: () => clock.tick,
      commands,
      probes,
      virtualInput,
      canvasProbe: () => gfx.probe(),
    });
  }

  // ---- browser integration -----------------------------------------------------------------
  const resize = (): void => gfx.resize(root.clientWidth, root.clientHeight);
  new ResizeObserver(resize).observe(root);
  resize();
  canvas.addEventListener('click', () => {
    if (!devConsole.isOpen && !benchMode) keyboardMouse.requestPointerLock();
  });
  if (!benchMode) {
    const hint = document.createElement('div');
    hint.className = 'hc-hint';
    hint.textContent =
      'Click to look · WASD move · E/Q up/down · Shift fast · Left click throws a box · P pause · F3 overlay · ` console';
    root.appendChild(hint);
    document.addEventListener('pointerlockchange', () => hint.remove(), { once: true });
  }

  loading.hide();
  loop.start();
  bus.emitNow('game:ready', { seed: params.seed, preset: gfx.settings.name });
}
