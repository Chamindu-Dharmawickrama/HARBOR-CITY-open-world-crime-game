# HARBOR CITY — Plan

Original-IP open-world third-person crime game for the browser. This document is the architecture, risk register,
milestone list with acceptance criteria, and the running list of known limitations. CLAUDE.md holds commands,
conventions and current milestone status.

## 0. Decisions log

| Decision | Choice | Why |
|---|---|---|
| Renderer | Three.js `WebGLRenderer` (WebGL2) + pmndrs `postprocessing` + `n8ao` | Mature effects, every browser, works in headless Playwright (owner approved) |
| Naming | Original names for genre-signature terms: **FLATLINED** (death), **CUFFED** (arrest), **Fresh Coat** (respray), **heat badges** (wanted level), **Stashes** (hidden packages), **Mayhem** (rampages) | Keeps the IP clearly original (owner approved) |
| Cadence | Continue through milestones automatically; pause once after M3 for the owner's driving hand-test | Owner approved |
| ECS | Own small ECS (generational ids, typed-array stores for hot data, sparse sets for complex components) | Full control over typing and layout, no API churn |
| Vehicle physics | Own raycast vehicle on Rapier rigid bodies (not Rapier's `DynamicRayCastVehicleController`) | Tire curves, weight transfer, drivetrain, ABS all under our control and unit-testable |
| Physics package | `@dimforge/rapier3d-compat` | WASM embedded (no Vite plugin), runs in Node so Vitest can run physics integration tests |
| Perf reference | Radeon 780M iGPU = "mid-range laptop" for Medium; RTX 3050 Laptop for High | Both are in the dev machine |
| World openness | All islands open from the start; the story sets where you go | Simpler progression, more sandbox |
| Folder additions | `src/game/` (composition root) and `src/content/` (all data) in addition to the brief's folders | Prevents sideways domain imports; data in one place |
| TypeScript | 6.0.3 (not 7.x); `noUncheckedIndexedAccess` off | typescript-eslint supports TS < 6.1; typed-array numeric code dominates (M0) |
| City rendering | Ground and buildings are merged per 128 m chunk and per LOD (one draw call each); all street furniture is one `BatchedMesh`; signs are one `InstancedMesh` | ~95 draw calls for the whole visible city on Medium (M1) |
| Ground surfaces | One procedural ground material for terrain, roads (lane markings, crosswalks, stop lines), sidewalks, plazas, seawalls, tunnel tiles; one facade material for all buildings | No textures to stream; surface chosen per vertex (M1) |
| Generation determinism | City generation avoids `Math.hypot` (lint-enforced in `world/gen`) and quantises block outlines to 10 µm | Node and Chrome produce byte-identical layouts (verified by the M1 e2e hash test) (M1) |
| Streaming uploads | Per-frame GPU upload budget in bytes (768 KB) plus compact vertex formats (i8 normals, u8 colours, u16 indices) | Avoids GPU command-buffer stalls when many chunks stream in at once (M1) |
| Benchmark pacing | `npm run bench` reports uncapped headroom; `--vsync` is the real-world hitch check | Uncapped presentation on Windows saturates the D3D present queue (60–290 ms `Present` stalls in the GPU process) — an artefact absent with vsync (M1) |
| Character animation | Own pose system: hand-keyed Euler clips (Catmull-Rom) in `src/content/animations.ts`, phase-synced 1D speed blends, frozen-pose crossfades, masked upper-body layer, additive flinch, two-bone foot IK | No art assets, tiny data, deterministic and unit-testable (M2) |
| Characters | One procedural skinned mesh per character: rounded segments, vertex colours, rigid skinning blended with the parent bone near joints | One draw call per character, no textures (M2) |
| Character controller | Rapier `KinematicCharacterController`: skin 0.05 m, normal nudge 0.05, autostep 0.42 m, snap-to-ground 0.35 m, zero vertical speed while grounded; own ledge climb from ray probes | Measured in integration tests: no single-frame stalls, kerbs step cleanly (M2) |
| Third-person camera | Spring arm in `rendering/camera` with an injected sphere-sweep collision interface; snaps in on contact, eases out; ignores props and characters; every frame audited (near-plane overlap + sight lines) | Never clips through walls; testable with Rapier in Node and in the browser (M2) |
| Settings persistence | Versioned JSON in localStorage (`harbor-city:settings`), validated and clamped on load; corrupt, legacy or newer data falls back to defaults | Rebinding and look settings survive reloads without risking a broken config (M2) |
| Vehicle integration | Implicit wheel-spin integration in 4 substeps (tire slope linearised per substep); brakes inside the implicit solve | Stable at 60 Hz for light cars and 11 t buses alike; no ABS chatter (M3) |
| Two-wheelers | Physics holds the bike upright (stiff roll PD); lean is visual from v·yaw-rate/g; wheelie/stoppie control | A leaning rigid body slides its contact patches and weaves at speed; this rides predictably (M3) |
| Vehicle rendering | One skinned mesh per vehicle (paint/glass/lights groups, bones for doors/wheels/fork); lamp states via per-vehicle uniforms | ~3 draw calls per car, no textures; dents copy the geometry on write (M3) |
| Crash damage | Contact-force listener → per-vehicle crash window (only a harder hit adds damage), per-crash cap, spawn grace | One crash never wrecks a car outright; spawn overlaps are not crashes (M3) |
| Handling targets | Plan targets for cars; heavy classes get realistic skidpad ranges (bus 0.6–0.85 g, trucks 0.6–0.95 g) | A bus at 0.8 g would tip; every range is asserted by the harness (M3) |

## 1. Product summary

You start with nothing, steal cars, take jobs from crime bosses, fight HCPD, and work through 10 story missions and
side activities. The city has three islands joined by two bridges and a tunnel:

| District | Character | Road style |
|---|---|---|
| **Meridian** (Downtown) | Towers, plazas, neon, nightlife | Perturbed grid, alleys, wide arterials |
| **Gantry Point** (Industrial Docks) | Warehouses, cranes, container yards, piers | Large lots, long arterials, service roads |
| **Linden Heights** (Suburbs) | Houses, parks, strip malls, gentle hills | Curvy streets, cul-de-sacs |

Links: **Copperline Bridge** (Docks–Downtown), **Halvard Bridge** (Downtown–Suburbs), **Undertow Tunnel**
(Docks–Suburbs). Land area ≈ 3 km² inside a world ≈ 2.6 × 2.2 km. Metres, Y up, origin at map centre.

## 2. Architecture

### Layers
Dependencies only point downward; dependency-cruiser enforces this and forbids cycles.

```
T0  core        math, seeded RNG streams, typed event bus, fixed-step loop, pools, spatial hash, input actions, sim clock
T1  ecs  physics  rendering  audio  save         (engine level, no game knowledge)
T2  world  characters  vehicles  combat           (domain simulation)
T3  ai                                            (uses world nav, characters, vehicles, combat)
T4  police  missions  ui
--  debug       may import anything; only game/ imports debug
--  content     pure typed data; imports only `type`s from domains
--  game        composition root: builds services, registers systems, wires the bus, owns game states
```

### Communication rules
- **Discrete gameplay events** (crime committed, vehicle exploded, objective complete, …) go through the typed bus in
  `core/events.ts`. Event ids are `domain:verb`; payloads use only primitives and core types. Events raised during a
  fixed step are queued and flushed at the end of the step, so handlers never run re-entrantly.
- **High-frequency state** (transforms, velocities, health) lives in ECS components and is read directly — never on the bus.
- **Cross-domain queries** use narrow read-only interfaces injected by the composition root (`PhysicsQuery`,
  `NavQuery`, `PlayerQuery`, …). No module reaches into another's internals.

### Simulation loop
- Fixed step at 60 Hz with an accumulator, max 5 substeps per frame, interpolation between previous and current
  transforms for rendering.
- Fixed-step phases: `input → ai → gameplay → prePhysics → physics → postPhysics → events flush`.
- Render frame: `interpolate → animation → camera → audio listener → UI → render`.
- Every system reports its time to the debug overlay.

### ECS
- Entity = 32-bit id: 20-bit index + 12-bit generation.
- Hot numeric components are struct-of-arrays in `Float32Array`s; complex components are sparse-set object stores.
- Queries are cached by bitmask. Scheduler order is explicit in `game/`.

### Workers
- 2–4 workers for city generation and chunk mesh building, returning transferable typed arrays.
- AudioWorklet for the engine synth.
- Rapier stays on the main thread (moving physics to a worker is a documented future option, not planned work).

### Dependencies
- Runtime: `three`, `@dimforge/rapier3d-compat`, `postprocessing`, `n8ao`.
- Dev: `typescript`, `vite`, `vitest`, `@playwright/test`, `eslint`, `typescript-eslint`, `prettier`,
  `eslint-config-prettier`, `dependency-cruiser`, `fake-indexeddb`, `@types/three`.
- Exact versions pinned in package.json.

## 3. System designs

### World generation (deterministic, seeded, in a worker)
1. **Islands:** coastline polygons from district parameters + seeded noise. Terrain is a trimesh per chunk (can carve
   the tunnel trench, unlike a heightfield). Docks flat; suburbs gently hilly.
2. **Roads:** a road generator per district writing into one planar graph. Arterials connect to the bridges and tunnel.
   Edges carry road class, lane count, speed limit.
3. **Blocks and lots:** blocks from planar-graph cycles, inset for road + sidewalk, split into lots by recursive OBB
   subdivision; land use from per-district tables (tower, midrise, shop, warehouse, house, park, plaza, pier).
4. **Buildings:** per-district rule grammar (footprint extrusion, setbacks, cornices, roof types, AC units, water tanks,
   signage, fire escapes). LOD0 full detail, LOD1 extruded shell, LOD2 merged boxes per chunk. Windows drawn by a
   procedural facade shader (`MeshStandardMaterial` + `onBeforeCompile`), per-building seed sets the window grid and
   per-window lit chance at night. Signage = canvas textures with invented business names.
5. **Road meshes:** intersection polygons, segment strips, curbs, sidewalks, crosswalks, lane markings in the road
   shader. Generated suspension/girder bridges. Tunnel with portals, lined tube, interior lights.
6. **Props:** lamps, hydrants, bins, benches, traffic lights, billboards, trees — placed by rule, drawn with
   **BatchedMesh**, culled per instance. Knockable props: past an impulse threshold the instance is hidden and a pooled
   dynamic body replaces it.
7. **Navigation data:** lane graph (turn connectors, signal ids), sidewalk graph (crosswalk edges), pedestrian POIs.
8. **Streaming:** 128 m chunks (~20 × 17). Desired set per LOD ring from predicted player position (velocity
   look-ahead). Workers build chunks; main thread uploads meshes/colliders with a 2 ms/frame budget. LRU cache of
   recently unloaded chunks. Resident global data: graph, lot list, minimap raster.
9. **Culling:** frustum culling per chunk and per instance + **CPU occlusion culling** (rasterise nearby large building
   boxes into a coarse 256×128 depth buffer, test chunk/instance AABBs). Deterministic, unit-testable, no GPU stalls.

### Player and characters
- **Rig:** procedural 18-bone skeleton, skinned mesh built per segment; variation from height, build, skin tone,
  clothing colours, hair/hat meshes, archetype outfits.
- **Animation:** own pose system (not `AnimationMixer`): TS keyframe clips, 1D blend trees, crossfades, upper-body
  layer masked to spine+arms, additive recoil/flinch, two-bone IK (steering wheel, aim, feet on slopes). States: idle,
  walk, run, sprint, crouch, jump, fall, land, climb, swim, aim, shoot, melee, enter/exit car, carjack, hit, die.
- **Controller:** Rapier `KinematicCharacterController` (capsule, autostep, ground snap, slope limit). Stamina (sprint,
  swim), fall damage by impact speed, low-ledge climb (0.5–1.8 m) via ray probes, surface swimming, cover snapping.
- **Camera:** orbit spring arm with Rapier shape-cast collision, critically damped follow, over-the-shoulder aim with
  shoulder swap. Vehicle chase/hood/interior cams; spline cinematic cam for missions.
- **Input:** action map for keyboard, mouse and Gamepad API (standard mapping); radial deadzones, sensitivity, invert,
  persisted rebinding, pointer lock. Tests drive it through a virtual device.

### Vehicles
- **Pure, unit-tested parts:** Pacejka-lite tire model (long/lat, load sensitivity, combined-slip ellipse); drivetrain
  (torque curve table, clutch, auto/manual gearbox with shift times, FWD/RWD/AWD diff); suspension (spring, bump/rebound
  damping, anti-roll bars); ABS/TCS slip limiters, optional yaw assist; drag, rolling resistance, downforce.
- **Integration:** per-wheel raycast/cylinder-cast against Rapier, forces at contact points (weight transfer emerges).
  Speed-sensitive steering. Handbrake drift = rear lock with reduced-grip curve. CCD on the player's car.
- **Classes:** compact, sedan, sports, muscle, pickup, van, bus, motorbike, + police cruiser, ambulance, taxi, SWAT van,
  armored truck. Boats (speedboat, police boat: buoyancy points, thrust, rudder). AI-only police helicopter. Motorbike =
  two raycast wheels + lean/balance controller; rider thrown off in big crashes.
- **Bodies:** procedural body generator per class: shell, glass, hinged doors, wheels, light emitters.
- **Damage:** contact impulses displace body vertices (radius, max depth), copy-on-write meshes. Glass intact →
  cracked → shattered with shards. Detachable wheels (pooled dynamic bodies). Engine health → smoke → fire → timed
  explosion (radial impulse + damage, chain reactions, burnt material).
- **Lights:** emissive headlights + additive volumetric cones + ground splats; real `SpotLight`s only for the player's
  and nearest few cars. Brake, reverse, indicators, police lightbars, sirens.
- **Enter/exit:** walk to door anchor, door opens, seat anim. Carjack pulls the occupant out (ragdoll/flee/fight).
  Locked parked cars: window smash + 2–3 s hotwire with HUD progress.

### Traffic and pedestrians
- **Traffic:** pure-pursuit lane following, Intelligent Driver Model car-following, signal controllers per
  intersection, gap acceptance/yielding on unsignalled roads, MOBIL-lite lane changes, forward sensing + emergency
  braking; honk when blocked, react to crashes, flee gunfire, pull over for sirens.
- **Traffic LOD:** full physics within ~150 m; kinematic lane-following beyond, promoted to physics when near/hit. Spawn
  and despawn in a ring outside view; gridlock detector clears cars that stay stuck.
- **Pedestrians:** sidewalk-graph A* to POIs, local avoidance via spatial hash, cross on walk signals, leader/follower
  groups, routines per archetype (commuter, shopper, jogger, dock worker, night crowd), hearing/sight → panic, flee or
  fight, witnesses report crimes, ragdoll on vehicle impact.
- **Density:** per-district, per-hour curves. Hard caps: Low 24 peds / 16 cars, Medium 48 / 30, High 80 / 45.

### Combat
- **Weapons (data-defined):** fists, bat, pistol, SMG, shotgun, assault rifle, sniper, grenade, molotov. Damage, fire
  mode, rate, magazine, reload, ammo type, spread model (base, bloom, recovery, movement/aim modifiers), recoil pattern,
  falloff, pellets, headshot multiplier.
- **Hits:** hitscan via Rapier raycasts against per-bone hitboxes (characters within 100 m; capsules beyond). Grenades
  and molotovs are physics projectiles (fuse/impact); molotov fire areas spread. Melee = shape-cast arcs, combos,
  knockdowns.
- **Aiming:** gamepad lock-on (angle/distance/threat score), optional soft assist, player cover snapping.
- **Enemy AI:** vision cone + LOS rays, time-to-notice by distance/light/crouch; hearing for gunshots, explosions,
  footsteps; last-known-position memory. Utility-scored tactics inside a hierarchical state machine: patrol,
  investigate, cover, peek-and-shoot, flank (cover-point scoring), grenade flush, rush, retreat/surrender on low morale.
  Cover points from building edges and walls; parked vehicles as dynamic cover.
- **Ragdolls:** 11 Rapier bodies, revolute joints with limits at knees/elbows, spherical elsewhere; pool of 8 active;
  settled ragdolls freeze into a static pose. Non-lethal hits: flinch/stumble.
- **Effects (pooled):** muzzle flash + short-lived light, tracers, surface-aligned decals, material sparks/dust, shell
  casings with simple particle physics, glass shards.

### Wanted and police
- **Witnessing:** crime catalogue with heat values. A crime event checks nearby peds, cops and cameras for LOS.
  Civilians report after a delay unless stopped; cops see instantly. **No witnesses → no heat.**
- **Response by level:** 1 patrol cops on foot and in cruisers · 2 pursuit cruisers, PIT and boxing · 3 roadblocks and
  spike strips on the predicted route · 4 SWAT vans + helicopter with searchlight · 5 more air units, helicopter
  sniper · 6 armored military trucks.
- **Search/evasion:** police know your position while they see you. Once LOS breaks they search a circle around the
  last known position (radius by level). Staying unseen outside it runs a timer that drops the level one step at a time.
  Switching cars unseen and hiding (crouched in an alley; parked car, engine off) speed this up. Fresh Coat clears heat
  if you weren't seen entering, for a fee.
- **CUFFED:** arrested when slow or on foot near cops (low level or stunned) → police station respawn, lose weapons,
  pay a fine. **FLATLINED:** hospital respawn, medical bill, lose armour. Both fail the active mission.

### Missions and story
- **Mission DSL:** typed TS DSL compiling to plain serialisable data (so JSON works too). Objectives (goTo, steal,
  deliver, kill, escort, follow, chase, survive, collect, evade, timed variants), triggers (area, timer, entity state,
  dialogue end, heat level), spawns, dialogue, checkpoints, fail conditions, rewards. Runner = step state machine with
  checkpoint restart. A content validator checks every referenced id.
- **Dialogue:** subtitles with speaker names and length-based timing; formant-synth babble voice per character (M9).
- **Story:** Cass Moreno arrives on the ferry with nothing; works for Marla Voss (docks smuggler), then Teo Krane
  (downtown club owner and fixer). Ruth Halloran (crooked HCPD captain) and the Tidebreakers gang get in the way. Krane
  betrays Cass; it ends with an assault on Krane Tower.

| # | Mission | Variety | District |
|---|---|---|---|
| 1 | Fresh Off the Ferry | tutorial: walk, carjack, deliver | Docks |
| 2 | Tailgate | chase and ram a snitch's car | Docks → Downtown |
| 3 | Precious Cargo | escort a contraband truck through an ambush | Docks |
| 4 | Night Shift | warehouse heist, optional stealth, escape with heat 2 | Docks |
| 5 | Wheelman | getaway driver, heat 3 pursuit, reach Fresh Coat | Downtown |
| 6 | Riptide | boat chase through the harbor | Harbor |
| 7 | Clean Shot | rooftop sniper assassination, then escape | Downtown |
| 8 | High Rise | rooftop shootout ending at a helipad | Downtown |
| 9 | Double Cross | betrayal ambush, bridge escape through roadblocks | Suburbs/bridge |
| 10 | Harbor Lights | multi-stage final assault on Krane Tower, boss, escape | Downtown |

- **Side activities:** Fare Game (taxi), Rush Delivery (timed courier), Night Watch (vigilante from a police car),
  street racing (3 checkpoint tracks vs AI racers), Export Board (deliver listed classes/colours to the dock crane),
  Mayhem (timed destroy-gang-vehicles/members challenges), 50 hidden Stashes (unlock weapons at safehouses).

### Economy, progression and save
- **Shops:** Ironside Arms (weapons/ammo), Threadline (outfits), Fresh Coat (respray).
- **Safehouses:** one per island, save point + garage for 3 cars.
- **Pickups:** health, armour, weapons, cash dropped by peds.
- **Save:** IndexedDB (native wrapper), 3 manual slots + 1 autosave. Each save has `version`; migrations are ordered
  pure functions vN→vN+1 tested against fixtures. Contents: player (position, health, armour, money, weapons, ammo,
  outfit), world (seed, time, weather), progress (missions, side activity stats, Stash bitset, export list), garages,
  stats. Settings stored separately. Autosave at mission checkpoints and completion.

### Time, weather and lighting
- **Time:** 24 h cycle, default 1 game minute per real second (adjustable); sun and moon arcs.
- **Sky:** physically based gradient, stars, animated cloud layer, height fog; PMREM environment rebuilt in stages as
  the sun moves.
- **Weather:** clear, overcast, rain, storm, fog with blended transitions. Wetness builds/dries; wet surfaces get lower
  roughness, darker albedo, world-noise puddle masks. Camera-wrapped rain streaks + ground splashes, wind tilts rain and
  sways trees, lightning flash + distance-delayed thunder event.
- **Rendering:** PBR everywhere; CSM (2/3/4 cascades for Low/Medium/High); N8AO SSAO (half-res on Medium); bloom from
  emissive > 1; AgX tone mapping; SMAA; emissive night windows and neon; volumetric headlight cones; **wet-road SSR on
  High only** (half-res depth ray march on upward-facing wet/puddle surfaces; Medium/Low use env-map reflections);
  street lamps light the ground with additive splats instead of real lights.

### Audio (procedural Web Audio)
- **Mixer:** buses sfx, vehicles, voice, radio, ambience, UI; master compressor + limiter; reverb sends with procedural
  impulse responses (street, tunnel, interior); occlusion low-pass behind buildings; HRTF near the listener; priority
  voice limiter (~32 voices).
- **Engine:** AudioWorklet synth — firing-pulse train from cylinder count and RPM, exhaust resonance, intake noise,
  load/throttle shape timbre. Nearest 4–6 cars get full voices; the rest share a traffic bed.
- **Other:** tire squeal from slip, speed-scaled wind, per-material collision synthesis (modal metal, glass, concrete),
  per-weapon gunshots with distance low-pass, speed-of-sound delay and reverb mix, per-surface footsteps, sirens with
  **manual Doppler** from radial velocity (`PannerNode` has none).
- **Ambience:** per district, time and weather: traffic rumble, horns, gulls, foghorns, water, birds, crickets,
  nightlife, rain, thunder.
- **Radio:** **NEON 88.3** (synthwave), **DRIFTWOOD 94.1** (lo-fi jazz-hop), **DEEP HARBOR 102.7** (dub). Seeded song
  generator (key, scale, tempo, chord grammar, drum patterns, bass lines, motif-based melodies) on a lookahead
  scheduler; DJ lines and invented ads as subtitles with babble voices; station position derived from the clock.

### UI and UX
- **HUD (DOM, updated only on change):** health, armour, weapon/ammo, money, heat badges, clock, mission text,
  subtitles, speedometer; rotating canvas minimap from a pre-rasterised map with blips, GPS route (A* on the road graph)
  and police search radius.
- **Screens:** full map (pan/zoom, waypoints, legend), main and pause menus, settings (presets + toggles, render scale,
  draw distance, audio buses, keyboard/gamepad rebinding), weapon wheel, loading screen + streaming indicator, CUFFED /
  FLATLINED, mission passed/failed banners.

### Debug and test hooks
- **Overlay (F3 or `?debug=1`):** FPS + frame-time graph, per-system timings, draw calls, triangles, entities, physics
  bodies, JS heap, streaming queue; toggles for physics draw, lane graph, ped paths, perception cones, vehicle telemetry.
- **Dev console (backtick):** spawn, give, time, weather, heat, teleport, mission, …
- **Test API:** `window.__HARBOR__` only in dev or `?test=1`. Tests send input through the real input layer via a
  virtual device, never via shortcuts that bypass systems.

## 4. Performance budgets (Medium, 1080p, Radeon 780M)
- Frame time average ≤ 16.6 ms, p95 ≤ 20 ms.
- Main thread ≤ 10 ms (simulation ≤ 5 ms, of which physics ≤ 2.5 ms).
- ≤ 1000 draw calls including shadows; ≤ 2.5M triangles.
- ≤ 150 active dynamic bodies.
- No allocations in hot paths; heap growth < 5 MB/s during a 60 s drive; tab < 1.2 GB.
- `npm run bench`: scripted flythrough + drive in headed Chromium on the GPU per preset → JSON results. Profile before
  optimising.

## 5. Testing strategy
- **Unit (Vitest, colocated `*.test.ts`):** pure logic of every system — core (RNG, bus, loop, ECS, pools, spatial
  hash), world gen (invariants, determinism hash, island connectivity), nav (lane graph, A*, signals, IDM), vehicles
  (tire, drivetrain, suspension), combat/police (spread, recoil, perception, morale, heat, witnesses), missions (runner),
  save (migrations), music (scales, determinism), occlusion rasteriser.
- **Physics integration (Vitest + Rapier in Node, `*.int.test.ts`):** vehicle handling harness (0–100, top speed,
  100–0, skidpad g, slalom, drift recovery, J-turn rollover, high-speed stability) per class against targets; character
  controller (steps, slopes, fall damage); ragdoll stability; projectiles.
- **Content:** every mission id reference resolves; vehicle/weapon definitions sane; **IP deny-list scan** of `src/`.
- **Playwright smoke (`/e2e`):** boot, spawn+walk, drive, shoot, save→reload→load, plus per-milestone tests. Every test
  asserts no console errors and a non-blank canvas. Screenshots → `test-results/screenshots/M<n>/`. Headless, Low
  preset, SwiftShader-safe flags.
- **Lint:** ESLint (typescript-eslint type-checked) + Prettier; dependency-cruiser layers + no cycles; `Math.random`
  banned; `TODO`/`FIXME` are lint errors.
- **CI:** `npm run ci` = typecheck → lint → test → build → e2e; `.github/workflows/ci.yml` mirrors it.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Scope is enormous | Vertical slices; each milestone ships complete features; cut-backs recorded in §8 |
| Driving feel is subjective | Objective handling harness, live telemetry tuning, owner hand-test after M3 |
| Draw calls / skinning cost | BatchedMesh + multi-draw, LOD rings, kinematic far traffic, throttled far-ped animation, bench-checked budgets |
| GC hitches | Pools, scratch objects, SoA, heap-growth check in the bench |
| Rapier limits (joint limits, tunnelling) | Limited revolute joints where it matters, joint damping, CCD on fast bodies |
| Procedural city looks bland | Per-district style tables, palettes, signage, prop density, M8 lighting pass |
| Post FX too costly on iGPU | Half-res SSAO, SSR High-only, render-scale setting |
| WebGL in headless CI | SwiftShader flags, Low preset, small viewport; perf measured only by headed bench |
| Audio autoplay policy | Click-to-start screen; Playwright clicks it |
| Accidental IP overlap | Original names only + deny-list test |
| Long autonomous run loses context | CLAUDE.md status, commit per milestone, limitations in §8 |

## 7. Milestones and acceptance criteria
Every milestone ends with the same gate: `npm run ci` passes, Playwright smoke saves screenshots, CLAUDE.md status
updated, commit `M<n>: …`, short report (what works, known-broken, how to hand-test).

**M0 — Scaffold, game loop, debug overlay, CI**
- Build: Vite + strict TS, folder layout, ESLint, Prettier, dependency-cruiser, Vitest, Playwright, CI workflow, git.
  Core: RNG, bus, fixed-step loop with interpolation, ECS + scheduler, pools, spatial hash, input action map (keyboard,
  mouse, gamepad, virtual device). Engine: renderer bootstrap with quality presets, Rapier init, debug overlay, dev
  console, test API.
- Accept: dev build shows a physics test scene (falling boxes) with the overlay; unit tests for every core module;
  Playwright boot test with screenshot and no console errors; `npm run ci` passes.

**M1 — Terrain, roads, buildings, streaming**
- Build: all of §3 World generation; basic sun, hemisphere light, single shadow, fog; free-fly debug camera; colliders
  on all static geometry.
- Accept: same seed → identical city (hash test); road graph connected across all 3 islands; no overlapping buildings
  or roads (invariant tests); free-fly over the whole city with no frame > 50 ms during streaming; Medium on the 780M
  averages ≥ 60 FPS in the flythrough bench (numbers recorded); screenshots of each district.

**M2 — Player controller, camera, animation**
- Build: all of §3 Player and characters; basic HUD for health and stamina; controls settings panel with rebinding.
- Accept: walk, sprint, crouch, jump, climb a 1.2 m wall, swim in the harbour; a 10 m fall hurts, 30 m kills; scripted
  camera-path test confirms no clipping through walls; Playwright spawn-and-walk test.

**M3 — Vehicles**
- Build: all of §3 Vehicles including boats; parked cars in streamed chunks; telemetry overlay.

| Class | 0–100 km/h | Top speed |
|---|---|---|
| Compact | 9–11 s | ≈ 165 km/h |
| Sedan / taxi | 8–9.5 s | ≈ 185 km/h |
| Sports | 3.8–4.8 s | ≈ 280 km/h |
| Muscle | 4.8–5.8 s | ≈ 250 km/h |
| Pickup | 8–10 s | ≈ 170 km/h |
| Van | 11–14 s | ≈ 150 km/h |
| Bus | 18–25 s | ≈ 110 km/h |
| Motorbike | 3.5–4.5 s | ≈ 230 km/h |
| Police | 5.5–6.5 s | ≈ 230 km/h |

  All classes: 100–0 braking 35–45 m (bus ≈ 60 m); skidpad 0.8–1.1 g (sports up to 1.25 g with downforce); drift
  recovery and J-turn tests pass.
- Accept: handling harness passes; no tunnelling at top speed; steal, carjack and hotwire flows; damage dents → fire →
  explosion; Playwright drive test. **Pause for the owner's hand-test.**

**M4 — Traffic and pedestrians**
- Build: all of §3 Traffic and pedestrians.
- Accept: 10-minute headless sim with no red-light running and no gridlock > 60 s; peds cross on walk signals and flee
  a gunshot event; car impact ragdolls a ped; density follows the hour and caps hold; bench with traffic within budget.

**M5 — Combat, weapons, enemy AI, ragdolls**
- Build: all of §3 Combat.
- Accept: all 9 weapons work with distinct handling; headshot multipliers apply; enemies take cover, flank and retreat
  in a test arena; ragdolls stable; gamepad lock-on works; Playwright shoot test.

**M6 — Wanted and police**
- Build: all of §3 Wanted and police.
- Accept: unwitnessed crime adds no heat; each level spawns its listed units; PIT, roadblocks and spike strips work
  (spikes deflate tires); helicopter searchlight tracks the player; evasion and Fresh Coat work; CUFFED and FLATLINED
  apply the correct penalties.

**M7 — Mission framework + missions 1–3**
- Build: DSL, runner, validator, mission markers, dialogue subtitles, checkpoints and retry, missions 1–3.
- Accept: runner unit tests; missions 1–3 completable by hand; Playwright starts mission 1 and completes its first
  objective.

**M8 — Day/night, weather, lighting, post-processing**
- Build: all of §3 Time, weather and lighting; graphics presets.
- Accept: screenshots for 4 times of day × 3 weather states; bench per preset, Medium within budget on the 780M.

**M9 — Audio engine + radio**
- Build: all of §3 Audio; babble voices on dialogue.
- Accept: voice limiter holds; siren Doppler audible on a pass-by; music generator tests; Playwright confirms the
  AudioContext is running with no errors.

**M10 — Full HUD, menus, map, economy, save/load**
- Build: all of §3 UI and UX; shops, safehouses, garages, pickups, money; IndexedDB saves with migrations.
- Accept: Playwright save → reload page → load → state matches; migration fixture tests.

**M11 — Missions 4–10 + side activities**
- Build: rest of the story; every side activity.
- Accept: each mission completable by hand; runner tests with scripted event sequences per mission; activity scoring
  tested.

**M12 — Optimisation, polish, bug-bash, final playtest**
- Build: profile-driven optimisation to budgets, bug-bash, camera/feel/UI polish, README, Definition-of-Done checklist.
- Accept: every Definition-of-Done item verified; bench results recorded.

## 8. Known limitations (smaller but fully working versions)
- The police helicopter is AI-only; the player can't fly.
- Swimming is on the surface only.
- Interiors are limited to shops, safehouses and mission locations; other buildings are solid.
- Buildings can't be destroyed; props can be knocked over.
- Vehicle deformation is visual only; the collider stays convex.
- Ragdoll shoulders and hips use spherical joints with damping instead of cone limits.
- SSR is on High only.
- Physics runs on the main thread.
- LOD changes pop (no cross-fade); rings and hysteresis keep them at a distance.
- Occlusion culling works per chunk piece (128 m), with nearly-rectangular buildings ≥ 14 m as occluders; it mostly helps at street level.
- Terrain surface types (lawn, lot paving, gravel) change on a 4 m grid inside blocks; kerbs and sidewalks hide the edges along streets.
- Generation is verified identical between Node and Chrome; other engines (Firefox, Safari) are not formally guaranteed identical transcendental Math results, so a city there could differ in rare details for the same seed.
- Bridges and the tunnel are always resident (not streamed); shop signs and billboards (~400) are all drawn by one instanced mesh.
- Street lamps glow at night (`night` console command) but do not light the ground until the M8 lighting pass.
- Foot IK corrects ankle height on kerbs, steps and slopes; feet do not tilt to match a slope.
- Ledge climbing covers 0.45–1.85 m on land (up to 4.6 m when pulling out of water); no ladders or vaults.
- Until weapons arrive in M5, aiming shows an unarmed guard stance with the over-the-shoulder camera; the punch clip is authored but melee hits come with combat.
- The pause menu is mouse-driven: on a gamepad, Start opens and closes it, but the controls page has no pad navigation yet (menus are reworked in M10).
- The developer obstacle course (`course` command) is a test fixture floating in open water near the docks, not part of the city.
- Glass damage is per vehicle (intact → cracked → shattered), not per window.
- Motorbikes lean visually; the physics body stays upright. Riders are thrown off in big crashes but there is no ragdoll until M5.
- Boats: flat water in physics (no waves, no planing lift); boarding works from the water or right beside the hull.
- Curb parking uses the outer metre of wide (9 m) streets; M4 traffic lanes must keep clear of that strip.
- NPC drivers of parked cars sit still with the engine running until the M4 traffic AI drives them.
- The horn/siren key toggles light bars and raises a `vehicle:horn` event; all vehicle sound arrives with M9.
- The manual gearbox (E/Q) is switched on with the `gearbox` console command until the M10 settings menu.
- Wheels can be torn off cars, not bikes; torn-off wheels are loose debris for 30 s.

(Updated as the build goes.)
