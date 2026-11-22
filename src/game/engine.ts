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
import { CommandRegistry } from '../debug/command-registry';
import { DevConsole } from '../debug/dev-console';
import { FreeFlyCamera } from '../debug/free-fly-camera';
import { installDebugHotkeys } from '../debug/hotkeys';
import { DebugOverlay, type OverlaySnapshot } from '../debug/overlay';
import { PhysicsDebugDraw } from '../debug/physics-debug-draw';
import { ProbeRegistry } from '../debug/probe-registry';
import { installTestApi, type HarborTestApi } from '../debug/test-api';
import { Scheduler, type FixedContext, type RenderContext } from '../ecs/scheduler';
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
import { BenchRecorder, type BenchResult } from './bench';
import { registerCoreCommands } from './dev-commands';
import type { UrlParams } from './url-params';

export const GAME_VERSION = '0.3.0-m2';

export function readHeapMB(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize / (1024 * 1024) : null;
}

export type FrameHook = (frameSeconds: number, cpuMs: number) => void;

/** Engine services shared by every scene (built once by the composition root). */
export interface Engine {
  readonly params: UrlParams;
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly loading: LoadingScreen;
  readonly bus: EventBus<GameEvents>;
  readonly rngs: RngStreams;
  readonly gfx: GameRenderer;
  readonly physics: PhysicsWorld;
  readonly world: World;
  readonly keyboardMouse: KeyboardMouseDevice;
  readonly virtualInput: VirtualInputDevice;
  readonly input: InputSystem;
  readonly profiler: Profiler;
  readonly scheduler: Scheduler;
  readonly clock: SimClock;
  readonly loop: GameLoop;
  readonly flyCamera: FreeFlyCamera;
  readonly overlay: DebugOverlay;
  readonly commands: CommandRegistry;
  readonly probes: ProbeRegistry;
  readonly api: HarborTestApi | null;
  readonly bench: BenchRecorder | null;
  /** Extra overlay lines contributed by the active scene. */
  readonly overlayLines: (() => string)[];
  readonly frameHooks: FrameHook[];
  /** Handles the pause action (the city scene opens its pause menu); default toggles pause. */
  pauseAction: (() => void) | null;
  /** True while the developer console has focus. */
  readonly consoleOpen: boolean;
  setPaused(paused: boolean): void;
  /** Finishes boot: hides the loading screen, starts the loop, announces readiness. */
  start(): void;
  finishBench(scenario: string): void;
}

export async function createEngine(root: HTMLElement, params: UrlParams): Promise<Engine> {
  const loading = new LoadingScreen(root);
  loading.setStatus('Starting physics engine…');
  const rapier = await loadRapier();

  const canvas = document.createElement('canvas');
  canvas.id = 'game-canvas';
  canvas.tabIndex = 0;
  root.prepend(canvas);

  const bus = new EventBus<GameEvents>();
  const rngs = new RngStreams(params.seed);
  const gfx = new GameRenderer(canvas, getQuality(params.preset), params.gpu);
  const physics = new PhysicsWorld(rapier);
  const world = new World(1 << 16);
  const keyboardMouse = new KeyboardMouseDevice(canvas);
  keyboardMouse.attach();
  const virtualInput = new VirtualInputDevice();
  const input = new InputSystem([keyboardMouse, new GamepadDevice(), virtualInput], DEFAULT_BINDINGS);
  const profiler = new Profiler();
  const scheduler = new Scheduler(profiler);
  const clock = new SimClock(FIXED_STEP_SECONDS);
  const flyCamera = new FreeFlyCamera(gfx.camera, input);
  const physicsLines = new PhysicsDebugDraw(physics, gfx.scene);
  const benchMode = params.bench !== null;

  scheduler
    .addFixed(createTransformSnapshotSystem(world))
    .addFixed(createPhysicsStepSystem(physics))
    .addFixed(createRigidBodySyncSystem(world))
    .addRender(createRenderObjectSyncSystem(world))
    .addRender(createInstanceSyncSystem(world))
    .addRender(flyCamera)
    .addRender(physicsLines)
    .addRender({ name: 'render', phase: 'render', renderUpdate: () => gfx.render() });

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
  const overlayLines: (() => string)[] = [];
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
      extra: overlayLines.map((line) => line()),
    };
  };

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
  const bench = benchMode
    ? new BenchRecorder(params.bench === 'playground' ? 3 : 6, params.bench === 'playground' ? 15 : 70)
    : null;
  const frameHooks: FrameHook[] = [];
  if (
    bench &&
    typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes.includes('longtask')
  ) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) bench.longTask(entry.duration);
    }).observe({ type: 'longtask', buffered: false });
  }
  let api: HarborTestApi | null = null;
  let frameStart = 0;
  let frames = 0;

  const loop = new GameLoop({
    beginFrame: () => {
      frameStart = performance.now();
      input.update();
      if (input.pressedThisFrame('pause')) {
        if (engine.pauseAction) engine.pauseAction();
        else setPaused(!loop.isPaused);
      }
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
      for (const hook of frameHooks) hook(frameSeconds, cpuMs);
      if (bench && api && !bench.done && frames > 1) {
        bench.frame(frameSeconds, cpuMs, renderStats.drawCalls, renderStats.triangles, readHeapMB(), () =>
          profiler.lastFrame(5),
        );
        if (bench.done) engine.finishBench(params.bench ?? 'none');
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
        `draws ${s.drawCalls}  tris ${s.triangles}  entities ${s.entities}  bodies ${s.bodies}  colliders ${s.colliders}`,
        ...s.extra,
      ].join('\n');
    },
  });
  probes.register('stats', snapshot);
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

  const resize = (): void => gfx.resize(root.clientWidth, root.clientHeight);
  new ResizeObserver(resize).observe(root);
  resize();
  canvas.addEventListener('click', () => {
    if (!devConsole.isOpen && !benchMode) keyboardMouse.requestPointerLock();
  });

  const engine: Engine = {
    params,
    root,
    canvas,
    loading,
    bus,
    rngs,
    gfx,
    physics,
    world,
    keyboardMouse,
    virtualInput,
    input,
    profiler,
    scheduler,
    clock,
    loop,
    flyCamera,
    overlay,
    commands,
    probes,
    api,
    bench,
    overlayLines,
    frameHooks,
    pauseAction: null,
    get consoleOpen() {
      return devConsole.isOpen;
    },
    setPaused,
    start: () => {
      loading.hide();
      loop.start();
      bus.emitNow('game:ready', { seed: params.seed, preset: gfx.settings.name });
    },
    finishBench: (scenario) => {
      if (!bench || !api) return;
      const size = gfx.drawingBufferSize;
      const result: BenchResult = bench.result({
        scenario,
        preset: gfx.settings.name,
        gpu: gfx.gpuName,
        width: size.width,
        height: size.height,
        pixelRatio: size.pixelRatio,
        userAgent: navigator.userAgent,
        droppedSimSeconds: loop.accumulator.droppedSeconds,
      });
      api.bench = { done: true, result };
      console.info(`[bench] ${JSON.stringify(result)}`);
    },
  };
  return engine;
}

/** Shows a one-line control hint until the pointer is first locked. */
export function showControlHint(root: HTMLElement, text: string): void {
  const hint = document.createElement('div');
  hint.className = 'hc-hint';
  hint.textContent = text;
  root.appendChild(hint);
  document.addEventListener('pointerlockchange', () => hint.remove(), { once: true });
}
