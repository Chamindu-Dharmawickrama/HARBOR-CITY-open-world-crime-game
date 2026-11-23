# HARBOR CITY

An original open-world third-person crime game that runs in the browser (TypeScript, Three.js, Rapier,
Web Audio). Everything is generated in code — no external art or audio assets.

## Run it

Requires Node 22.12+ (developed on Node 24).

```
npm install
npm run dev
```

Open the printed URL (default http://localhost:5173).

Useful URL options: `?debug=1` (overlay at start) · `?preset=low|medium|high` · `?seed=<number or text>`.

## Current state

Milestone status lives in [CLAUDE.md](CLAUDE.md); the full plan, milestone acceptance criteria and known limitations
are in [PLAN.md](PLAN.md).

## Controls (on foot)

Click the view to capture the mouse. Every control can be rebound in **Esc → Controls** (saved in the browser).

| Action | Keyboard / mouse | Gamepad |
|---|---|---|
| Move | W A S D | Left stick |
| Look | Mouse | Right stick |
| Sprint (uses stamina) | Shift | Left stick click |
| Walk (hold) | Z | Tilt the stick gently |
| Jump / climb a ledge / climb out of water | Space | A |
| Crouch (toggle) | C or Left Ctrl | B |
| Aim (over the shoulder) | Right mouse | LT |
| Swap aim shoulder | X | Right stick click |
| Camera distance | V | Back |
| Pause menu | Esc or P | Start |

## Controls (vehicles)

| Action | Keyboard / mouse | Gamepad |
|---|---|---|
| Get in / out (walk up to a car; at speed this bails out) | F | Y |
| Accelerate / brake & reverse | W / S | RT / LT |
| Steer | A D | Left stick |
| Handbrake | Space | RB |
| Horn / siren (emergency vehicles) | H | Left stick click |
| Camera: chase near → far → hood → driver's seat | V | Back |
| Look around | Mouse | Right stick |
| Manual gearbox (after `gearbox manual`) | E up / Q down | B / X |

Locked cars: press F to smash the window, then hold still while it hotwires. Occupied cars: F pulls the driver out.

## Developer tools

| Tool | How |
|---|---|
| Debug overlay | F3 (or `?debug=1`) |
| Physics collider lines | F4 |
| Console | ` (backtick) — type `help` |
| Free-fly camera | `fly` (WASD, E/Q up/down, Shift fast); `goto <place>` also switches to it |
| Obstacle course | `course`, then `tpplayer wall12|wall26|tower10|tower30|water|ceiling|wallwalk` |
| Player state | `damage <n>`, `heal`, `armor`, `kill`, `respawn`, `tpplayer <x> <z>` |
| Vehicles | `spawncar <id> [enter|locked|driver]` (ids: brisa meridian cab vireo brakker haul courier linewalker sprint interceptor medic bulwark vaultline gullwing patrol), `fix`, `explode`, `vdamage <n>`, `siren`, `gearbox manual|auto`, `telemetry` (with F3) |
| Driving pad | `course`, then `tpplayer pad` (200 m pad, ramp), `tpplayer barrier` (crash wall), `tpplayer mooring` (boats) |

The M0 physics playground (`?scene=playground`) uses the fly camera; left click throws a box.

## Quality gate

`npm run ci` runs typecheck, lint (ESLint, Prettier, layer rules), unit + physics tests, production build and
Playwright smoke tests. `npm run bench -- --presets=low,medium,high` runs the GPU benchmark.
