import * as THREE from 'three';
import { clamp } from '../../core/math';
import { CommandError, numberArg, toggleArg } from '../../debug/command-registry';
import type { RenderContext, RenderSystem } from '../../ecs/scheduler';
import { GROUPS_STATIC_WORLD } from '../../physics/collision-groups';
import { createRayHit } from '../../physics/physics-world';
import { createBuildingMaterial } from '../../rendering/materials/building-material';
import { createSharedUniforms } from '../../rendering/materials/glsl';
import { createGroundMaterial } from '../../rendering/materials/ground-material';
import {
  createWaterMaterial,
  createWaterMesh,
  type WaterHole,
} from '../../rendering/materials/water-material';
import { OcclusionCuller } from '../../rendering/occlusion/occlusion-culler';
import { SkyDome } from '../../rendering/sky';
import { generateCity, layoutHash, layoutStageHashes } from '../../world/gen/city-layout';
import { minAreaRect, area as polygonArea } from '../../world/gen/geometry2d';
import type { CityDef } from '../../world/gen/types';
import { ChunkIndex } from '../../world/mesh/chunk-index';
import { buildPropLibrary, createPropMaterial } from '../../world/props/prop-library';
import { PropManager } from '../../world/props/prop-manager';
import { buildSignAtlas, SignRenderer } from '../../world/props/sign-renderer';
import { ringsFor } from '../../world/streaming/chunk-planner';
import { ChunkStreamer } from '../../world/streaming/chunk-streamer';
import { meshFromData } from '../../world/streaming/mesh-upload';
import { WorkerPool } from '../../world/streaming/worker-pool';
import { ORBIT } from '../../rendering/camera/orbit-camera';
import { DebugBoxes } from '../debug-boxes';
import { showControlHint, type Engine } from '../engine';
import { CITY_VIEWPOINTS, FLYTHROUGH_PATH } from './city-viewpoints';
import { generateParkingSpots } from '../../world/gen/parking';
import { createWaterTest, setupPlayer, sidewalkSpawn } from './player-setup';
import { setupDriving, setupVehicles } from './vehicle-setup';

/** On-foot spawn: the downtown sidewalk nearest this point. */
const SPAWN_NEAR = { x: 560, z: 430 };
/** The developer obstacle course is placed in open water nearest this point (by the docks). */
const COURSE_NEAR = { x: -930, z: 760 };

const FOG_COLOR = 0xc3d6e4;
/** GPU upload volume per frame while streaming (keeps the command buffer from stalling). */
const UPLOAD_BYTES_PER_FRAME = 768 * 1024;
const SUN_DIRECTION = new THREE.Vector3(0.45, 0.78, 0.32).normalize();

interface Occluder {
  cx: number;
  cz: number;
  ax: number;
  az: number;
  hl: number;
  hw: number;
  y0: number;
  y1: number;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Builds the streamed city: generation, environment, workers, landmarks, props, culling. */
export async function setupCityScene(engine: Engine, city: CityDef): Promise<void> {
  const { gfx, physics, world, scheduler, commands, probes, params } = engine;
  engine.loading.setStatus('Generating Harbor City…');
  await nextFrame();
  const genStart = performance.now();
  const model = generateCity(city, params.seed);
  const generationMs = performance.now() - genStart;
  const { layout } = model;
  const index = new ChunkIndex(layout, model.graph, model.terrain, city.chunkSize);
  const hash = layoutHash(layout);

  // ---- environment -------------------------------------------------------------------------
  const shared = createSharedUniforms();
  const sky = new SkyDome();
  sky.setSunDirection(SUN_DIRECTION);
  gfx.scene.add(sky.mesh);
  gfx.scene.background = new THREE.Color(FOG_COLOR);
  gfx.scene.environment = sky.environment(gfx.renderer);
  gfx.scene.environmentIntensity = 0.55;
  gfx.scene.fog = new THREE.Fog(FOG_COLOR, gfx.settings.drawDistance * 0.45, gfx.settings.drawDistance);
  gfx.renderer.toneMappingExposure = 0.9;
  gfx.camera.near = ORBIT.near;
  gfx.camera.updateProjectionMatrix();
  gfx.scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x6b6255, 0.6));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.5);
  sun.castShadow = gfx.settings.shadows;
  sun.shadow.mapSize.setScalar(gfx.settings.shadowMapSize);
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.04;
  gfx.scene.add(sun, sun.target);

  const holes: WaterHole[] = layout.holes.map((h) => {
    const box = minAreaRect(h.polygon);
    return {
      centerX: box.center.x,
      centerZ: box.center.z,
      axisX: box.axis.x,
      axisZ: box.axis.z,
      halfLength: box.halfLength,
      halfWidth: box.halfWidth,
    };
  });
  const { minX, minZ, maxX, maxZ } = city.bounds;
  gfx.scene.add(
    createWaterMesh(
      createWaterMaterial(shared, holes),
      minX - 3000,
      minZ - 3000,
      maxX + 3000,
      maxZ + 3000,
      city.waterLevel,
    ),
  );

  const groundMaterial = createGroundMaterial(shared);
  const buildingMaterial = createBuildingMaterial(shared);
  const propMaterial = createPropMaterial(shared.uNight);

  // ---- workers & landmarks -------------------------------------------------------------------
  engine.loading.setStatus('Starting world workers…');
  const workers = clamp((navigator.hardwareConcurrency || 4) - 2, 1, 4);
  const pool = new WorkerPool(workers, city, params.seed);
  await pool.ready();
  const landmarks = await pool.landmarks();
  const landmarkSolid = meshFromData(landmarks.solid, groundMaterial, 'landmarks:solid');
  const landmarkDetail = meshFromData(landmarks.detail, groundMaterial, 'landmarks:detail');
  for (const m of [landmarkSolid, landmarkDetail]) {
    m.castShadow = true;
    m.receiveShadow = true;
    gfx.scene.add(m);
  }
  physics.world.createCollider(
    physics.rapier.ColliderDesc.trimesh(
      landmarks.solid.positions,
      Uint32Array.from(landmarks.solid.indices),
    ).setCollisionGroups(GROUPS_STATIC_WORLD),
  );

  // ---- props, signs, streaming, occlusion ----------------------------------------------------
  const props = new PropManager(layout.props, buildPropLibrary(), propMaterial, physics, world, gfx.scene);
  scheduler.addFixed(props.createSystem());
  gfx.scene.add(
    new SignRenderer(layout.signs, buildSignAtlas(city.businessNames, city.billboardSlogans), shared.uNight)
      .mesh,
  );
  const streamer = new ChunkStreamer(
    {
      pool,
      index,
      scene: gfx.scene,
      physics,
      groundMaterial,
      buildingMaterial,
      props,
      now: () => performance.now(),
    },
    ringsFor(gfx.settings.drawDistance, gfx.settings.nearRing),
  );
  const culler = new OcclusionCuller(256, 128);
  let occlusionEnabled = true;
  const occluders: Occluder[] = layout.buildings
    .filter((b) => b.height >= 14)
    .flatMap((b) => {
      const footprint = b.tiers[0]?.footprint;
      if (!footprint) return [];
      const box = minAreaRect(footprint);
      // Only nearly rectangular footprints, shrunk slightly, so the occluder is inside the building.
      if (polygonArea(footprint) < 0.9 * 4 * box.halfLength * box.halfWidth) return [];
      return [
        {
          cx: box.center.x,
          cz: box.center.z,
          ax: box.axis.x,
          az: box.axis.z,
          hl: box.halfLength * 0.92,
          hw: box.halfWidth * 0.92,
          y0: b.baseY,
          y1: b.baseY + (b.tiers[0]?.top ?? b.height) * 0.98,
        },
      ];
    });
  const boxes = new DebugBoxes(world, physics, gfx.scene);

  // ---- per-frame world update ----------------------------------------------------------------
  const camera = gfx.camera;
  const viewProjection = new THREE.Matrix4();
  const lastPropUpdate = new THREE.Vector3(Infinity, 0, 0);
  let propTimer = 0;
  const candidates: { o: Occluder; score: number }[] = [];
  const forward = new THREE.Vector3();
  const cityWorld: RenderSystem = {
    name: 'cityWorld',
    phase: 'ui',
    renderUpdate(ctx: RenderContext): void {
      shared.uTime.value += ctx.frameSeconds;
      sky.follow(camera);
      // Sun shadow frustum follows the camera, snapped to shadow texels to avoid shimmering.
      const extent = gfx.settings.shadowExtent;
      camera.getWorldDirection(forward);
      const texel = (extent * 2) / gfx.settings.shadowMapSize;
      const fx = Math.round((camera.position.x + forward.x * extent * 0.5) / texel) * texel;
      const fz = Math.round((camera.position.z + forward.z * extent * 0.5) / texel) * texel;
      sun.target.position.set(fx, 0, fz);
      sun.position.set(fx + SUN_DIRECTION.x * 400, SUN_DIRECTION.y * 400, fz + SUN_DIRECTION.z * 400);
      const sc = sun.shadow.camera;
      if (sc.right !== extent) {
        sc.left = -extent;
        sc.right = extent;
        sc.top = extent;
        sc.bottom = -extent;
        sc.near = 10;
        sc.far = 900;
        sc.updateProjectionMatrix();
      }
      streamer.update(camera.position.x, camera.position.z, 3, UPLOAD_BYTES_PER_FRAME);
      propTimer += ctx.frameSeconds;
      if (propTimer > 0.4 || lastPropUpdate.distanceToSquared(camera.position) > 64) {
        propTimer = 0;
        lastPropUpdate.copy(camera.position);
        props.updateVisibility(camera.position.x, camera.position.z, gfx.settings.propDistance);
      }
      if (occlusionEnabled) runOcclusion();
    },
  };
  function runOcclusion(): void {
    camera.updateMatrixWorld();
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    culler.begin(viewProjection.elements);
    candidates.length = 0;
    const cx = camera.position.x;
    const cz = camera.position.z;
    for (const o of occluders) {
      const dx = o.cx - cx;
      const dz = o.cz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > 320 * 320 || dx * forward.x + dz * forward.z < -o.hl - o.hw) continue;
      candidates.push({ o, score: (o.hl * o.hw * (o.y1 - o.y0)) / Math.max(25, d2) });
    }
    candidates.sort((a, b) => b.score - a.score);
    for (let i = 0; i < Math.min(48, candidates.length); i++) {
      const o = (candidates[i] as { o: Occluder }).o;
      culler.addOccluder(o.cx, o.cz, o.ax, o.az, o.hl, o.hw, o.y0, o.y1);
    }
    culler.finish();
    for (const mesh of streamer.shownMeshes) {
      const b = mesh.geometry.boundingBox;
      if (b) mesh.visible = !culler.isOccluded(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z);
    }
  }
  scheduler.addRender(cityWorld);

  // ---- camera, bench ---------------------------------------------------------------------------
  const start = CITY_VIEWPOINTS.downtown;
  engine.flyCamera.setPose(start.x, start.y, start.z, start.yaw, start.pitch);
  engine.flyCamera.baseSpeed = 30;
  // Vehicles (parked cars follow the streaming centre — also during the benchmark).
  const parkingSpots = generateParkingSpots(layout, model.terrain);
  const vehicleWorld = setupVehicles(
    engine,
    { waterLevel: city.waterLevel, isWater: createWaterTest(model.terrain, layout) },
    parkingSpots,
    () => camera.position,
  );
  probes.register('parking', () => ({
    spots: parkingSpots.length,
    lot: parkingSpots.filter((s) => s.kind === 'lot').length,
    curb: parkingSpots.filter((s) => s.kind === 'curb').length,
    boat: parkingSpots.filter((s) => s.kind === 'boat').length,
  }));
  if (params.bench === 'flythrough') {
    engine.flyCamera.enabled = false;
    scheduler.addRender(createFlythroughCamera(camera));
  } else {
    const spawn = sidewalkSpawn(layout, SPAWN_NEAR.x, SPAWN_NEAR.z);
    const playerHandle = setupPlayer(
      engine,
      { terrain: model.terrain, layout, waterLevel: city.waterLevel, courseNear: COURSE_NEAR },
      spawn,
    );
    setupDriving(engine, vehicleWorld, playerHandle);
    // Stream around the spawn before the first frame (the player camera takes over from here).
    camera.position.set(spawn.x, spawn.y + 2.5, spawn.z + 4);
    showControlHint(
      engine.root,
      'Click to play · WASD move · Shift sprint · Space jump/climb · C crouch · RMB aim · F enter car · V camera · Esc menu · ` console',
    );
  }

  // ---- prime streaming around the start position before showing the world -------------------
  const primeStart = performance.now();
  for (;;) {
    streamer.update(camera.position.x, camera.position.z, 40);
    const progress = streamer.progress();
    engine.loading.setStatus(`Streaming the city… ${Math.round(progress * 100)}%`);
    if (progress >= 0.999 || performance.now() - primeStart > 30_000) break;
    await nextFrame();
  }
  props.updateVisibility(camera.position.x, camera.position.z, gfx.settings.propDistance);

  // ---- debug surface -------------------------------------------------------------------------
  engine.overlayLines.push(() => {
    const s = streamer.stats();
    return `streaming ${Math.round(streamer.progress() * 100)}%  meshes ${s.meshes}  pending ${s.pending}  queued ${s.queued}  colliderChunks ${s.colliderChunks}  failed ${s.failed}`;
  });
  engine.overlayLines.push(() => {
    const p = props.stats;
    return `props ${p.visible} visible  ${p.colliders} colliders  ${p.knocked} knocked  occlusion ${occlusionEnabled ? `${culler.culled}/${culler.tested} culled (${culler.occluders} occluders)` : 'off'}`;
  });
  probes.register('city', () => ({
    hash,
    stages: layoutStageHashes(layout),
    generationMs: Math.round(generationMs),
    stats: layout.stats,
    workers,
    landmarkTriangles: (landmarks.solid.indices.length + landmarks.detail.indices.length) / 3,
  }));
  probes.register('streaming', () => ({
    ...streamer.stats(),
    progress: streamer.progress(),
    x: streamer.lastX,
    z: streamer.lastZ,
    rings: streamer.rings,
    occlusion: {
      enabled: occlusionEnabled,
      tested: culler.tested,
      culled: culler.culled,
      occluders: culler.occluders,
    },
  }));
  probes.register('props', () => props.stats);
  probes.register('boxes', () => boxes.positions());

  commands.register({
    name: 'goto',
    usage: `goto <${Object.keys(CITY_VIEWPOINTS).join('|')}>`,
    help: 'Fly the camera to a named viewpoint',
    run: (args) => {
      const name = (args[0] ?? '') as keyof typeof CITY_VIEWPOINTS;
      const view = CITY_VIEWPOINTS[name];
      if (!view) throw new CommandError(`Unknown place. Options: ${Object.keys(CITY_VIEWPOINTS).join(', ')}`);
      if (engine.commands.has('fly') && !engine.flyCamera.enabled) engine.commands.execute('fly on');
      engine.flyCamera.setPose(view.x, view.y, view.z, view.yaw, view.pitch);
      return `Camera at ${name}.`;
    },
  });
  commands.register({
    name: 'night',
    usage: 'night [0..1]',
    help: 'Preview night lighting (lit windows, signs, lamps)',
    run: (args) => {
      shared.uNight.value = clamp(numberArg(args, 0, 'amount', shared.uNight.value > 0.5 ? 0 : 1), 0, 1);
      return `Night ${shared.uNight.value}.`;
    },
  });
  commands.register({
    name: 'occlusion',
    usage: 'occlusion [on|off]',
    help: 'Toggle software occlusion culling',
    run: (args) => {
      occlusionEnabled = toggleArg(args, 0, occlusionEnabled);
      return `Occlusion culling ${occlusionEnabled ? 'on' : 'off'}.`;
    },
  });
  commands.register({
    name: 'raycast',
    usage: 'raycast [x z]',
    help: 'Ray down at (x, z) (default: camera); reports collider hit vs terrain height',
    run: (args) => {
      const x = numberArg(args, 0, 'x', camera.position.x);
      const z = numberArg(args, 1, 'z', camera.position.z);
      const hit = createRayHit();
      const ok = physics.castRay(x, 400, z, 0, -1, 0, 800, hit);
      const terrain = model.terrain.heightAt(x, z);
      return JSON.stringify({
        hit: ok,
        y: ok ? Number(hit.y.toFixed(3)) : null,
        terrain: Number(terrain.toFixed(3)),
      });
    },
  });
  commands.register({
    name: 'drop',
    usage: 'drop [count]',
    help: 'Drop crates 20 m in front of the camera',
    run: (args) => {
      const count = Math.round(clamp(numberArg(args, 0, 'count', 1), 1, 32));
      camera.getWorldDirection(forward);
      for (let i = 0; i < count; i++) {
        boxes.drop(
          camera.position.x + forward.x * 20 + (i % 4) * 1.5,
          camera.position.y + 2 + Math.floor(i / 4) * 1.5,
          camera.position.z + forward.z * 20,
          1,
        );
      }
      return `Dropped ${count} crate(s).`;
    },
  });
  commands.register({
    name: 'knocktest',
    help: 'Drop a heavy crate onto the nearest knockable prop',
    run: () => {
      const id = props.nearestKnockable(camera.position.x, camera.position.z, 160);
      if (id < 0) throw new CommandError('No knockable prop nearby.');
      const prop = layout.props[id];
      if (!prop || !props.hasCollider(id))
        throw new CommandError('Nearest prop has no collider yet (stream closer).');
      boxes.drop(prop.x, prop.y + 9, prop.z, 1.4, -18, 2500);
      return JSON.stringify({ prop: id, type: prop.type });
    },
  });
  commands.register({
    name: 'streaming',
    help: 'Print streaming statistics',
    run: () => JSON.stringify({ ...streamer.stats(), progress: Number(streamer.progress().toFixed(3)) }),
  });
  probes.register('knocked', () => layout.props.map((_, i) => i).filter((i) => props.isKnocked(i)));
}

/** Benchmark camera: a fixed loop over all three islands, both bridges and the tunnel. */
function createFlythroughCamera(camera: THREE.PerspectiveCamera): RenderSystem {
  const points = FLYTHROUGH_PATH.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal');
  const length = curve.getLength();
  const speed = 55;
  const warmup = 6;
  let t = 0;
  const target = new THREE.Vector3();
  return {
    name: 'benchFlythrough',
    phase: 'camera',
    renderUpdate(ctx: RenderContext): void {
      t += ctx.frameSeconds;
      const travelled = Math.max(0, t - warmup) * speed;
      const u = (travelled / length) % 1;
      curve.getPointAt(u, camera.position);
      curve.getPointAt((u + 60 / length) % 1, target);
      target.y -= 18;
      camera.lookAt(target);
    },
  };
}
