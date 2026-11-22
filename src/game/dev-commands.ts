import { clamp } from '../core/math';
import { CommandError, numberArg, toggleArg, type CommandRegistry } from '../debug/command-registry';
import type { ProbeRegistry } from '../debug/probe-registry';
import { isQualityPresetName, QUALITY_PRESET_NAMES } from '../rendering/quality';

/** Everything the core dev commands are allowed to touch, injected by the composition root. */
export interface DevCommandTargets {
  seed: number;
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  stepTicks(count: number): void;
  getTimeScale(): number;
  setTimeScale(scale: number): void;
  setPreset(name: string): void;
  currentPreset(): string;
  overlayVisible(): boolean;
  setOverlayVisible(visible: boolean): void;
  physicsLinesVisible(): boolean;
  setPhysicsLinesVisible(visible: boolean): void;
  teleportCamera(x: number, y: number, z: number): void;
  clearConsole(): void;
  statsSummary(): string;
}

export function registerCoreCommands(
  commands: CommandRegistry,
  probes: ProbeRegistry,
  t: DevCommandTargets,
): void {
  commands.register({ name: 'help', help: 'List commands', run: () => commands.helpText() });
  commands.register({ name: 'clear', help: 'Clear the console', run: () => t.clearConsole() });
  commands.register({ name: 'seed', help: 'Show the world seed', run: () => `World seed: ${t.seed}` });
  commands.register({ name: 'stats', help: 'Print performance stats', run: () => t.statsSummary() });
  commands.register({
    name: 'pause',
    help: 'Pause the simulation',
    run: () => {
      t.setPaused(true);
      return 'Paused.';
    },
  });
  commands.register({
    name: 'resume',
    help: 'Resume the simulation',
    run: () => {
      t.setPaused(false);
      return 'Resumed.';
    },
  });
  commands.register({
    name: 'step',
    usage: 'step [ticks]',
    help: 'Advance a paused simulation by N fixed ticks',
    run: (args) => {
      if (!t.isPaused()) throw new CommandError('step only works while paused (type "pause").');
      const ticks = Math.round(clamp(numberArg(args, 0, 'ticks', 1), 1, 600));
      t.stepTicks(ticks);
      return `Stepping ${ticks} tick(s).`;
    },
  });
  commands.register({
    name: 'timescale',
    usage: 'timescale <0..8>',
    help: 'Slow down or speed up the simulation',
    run: (args) => {
      const scale = clamp(numberArg(args, 0, 'scale'), 0, 8);
      t.setTimeScale(scale);
      return `Time scale ${scale}.`;
    },
  });
  commands.register({
    name: 'preset',
    usage: `preset <${QUALITY_PRESET_NAMES.join('|')}>`,
    help: 'Switch graphics quality preset',
    run: (args) => {
      const name = (args[0] ?? '').toLowerCase();
      if (!isQualityPresetName(name)) {
        return `Current preset: ${t.currentPreset()}. Options: ${QUALITY_PRESET_NAMES.join(', ')}`;
      }
      t.setPreset(name);
      return `Preset ${name}.`;
    },
  });
  commands.register({
    name: 'overlay',
    usage: 'overlay [on|off]',
    help: 'Toggle the debug overlay (F3)',
    run: (args) => {
      const visible = toggleArg(args, 0, t.overlayVisible());
      t.setOverlayVisible(visible);
      return `Overlay ${visible ? 'on' : 'off'}.`;
    },
  });
  commands.register({
    name: 'physdraw',
    usage: 'physdraw [on|off]',
    help: 'Toggle physics collider lines (F4)',
    run: (args) => {
      const visible = toggleArg(args, 0, t.physicsLinesVisible());
      t.setPhysicsLinesVisible(visible);
      return `Physics lines ${visible ? 'on' : 'off'}.`;
    },
  });
  commands.register({
    name: 'tp',
    usage: 'tp <x> <y> <z>',
    help: 'Teleport the camera',
    run: (args) => {
      const x = numberArg(args, 0, 'x');
      const y = numberArg(args, 1, 'y');
      const z = numberArg(args, 2, 'z');
      t.teleportCamera(x, y, z);
      return `Camera at ${x}, ${y}, ${z}.`;
    },
  });
  commands.register({
    name: 'probe',
    usage: 'probe [name]',
    help: 'Print a state probe as JSON (no name lists probes)',
    run: (args) => {
      const name = args[0];
      if (name === undefined) return `Probes: ${probes.names().join(', ')}`;
      return JSON.stringify(probes.read(name), null, 2);
    },
  });
}
