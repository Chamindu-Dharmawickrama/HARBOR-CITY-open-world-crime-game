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

## Developer controls (engine test scene)

| Action | Keyboard / mouse | Gamepad |
|---|---|---|
| Look | Click the view, then move the mouse | Right stick |
| Move | W A S D | Left stick |
| Up / down | E / Q (Space / Ctrl) | RB / LB |
| Fast | Shift | Left stick click |
| Throw a box | Left click | RT |
| Pause | P | Start |
| Debug overlay | F3 | |
| Physics collider lines | F4 | |
| Developer console | ` (backtick) — type `help` | |

## Quality gate

`npm run ci` runs typecheck, lint (ESLint, Prettier, layer rules), unit + physics tests, production build and
Playwright smoke tests. `npm run bench -- --presets=low,medium,high` runs the GPU benchmark.
