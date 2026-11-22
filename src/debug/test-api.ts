import type { VirtualInputDevice } from '../core/input/virtual-device';
import type { ColorProbe } from '../rendering/game-renderer';
import type { CommandRegistry, CommandResult } from './command-registry';
import type { ProbeRegistry } from './probe-registry';

/**
 * Automation surface exposed as `window.__HARBOR__` in dev builds and with `?test=1`.
 * Input goes through the virtual device → binding layer, exactly like a player's input.
 */
export interface HarborTestApi {
  readonly version: string;
  ready: boolean;
  bench: { done: boolean; result: unknown };
  tick(): number;
  run(command: string): CommandResult;
  probe(name: string): unknown;
  probes(): string[];
  canvasProbe(): ColorProbe;
  readonly input: {
    keyDown(code: string): void;
    keyUp(code: string): void;
    mouseMove(dx: number, dy: number): void;
    mouseButton(button: number, down: boolean): void;
    padAxis(index: number, value: number): void;
    padButton(index: number, value: number): void;
    releaseAll(): void;
  };
}

declare global {
  interface Window {
    __HARBOR__?: HarborTestApi;
  }
}

export interface TestApiDeps {
  version: string;
  tick: () => number;
  commands: CommandRegistry;
  probes: ProbeRegistry;
  virtualInput: VirtualInputDevice;
  canvasProbe: () => ColorProbe;
}

export function installTestApi(deps: TestApiDeps): HarborTestApi {
  const v = deps.virtualInput;
  const api: HarborTestApi = {
    version: deps.version,
    ready: false,
    bench: { done: false, result: null },
    tick: deps.tick,
    run: (command) => deps.commands.execute(command),
    probe: (name) => deps.probes.read(name),
    probes: () => deps.probes.names(),
    canvasProbe: deps.canvasProbe,
    input: {
      keyDown: (code) => v.keyDown(code),
      keyUp: (code) => v.keyUp(code),
      mouseMove: (dx, dy) => v.mouseMove(dx, dy),
      mouseButton: (button, down) => v.mouseButton(button, down),
      padAxis: (index, value) => v.padAxis(index, value),
      padButton: (index, value) => v.padButton(index, value),
      releaseAll: () => v.releaseAll(),
    },
  };
  window.__HARBOR__ = api;
  return api;
}
