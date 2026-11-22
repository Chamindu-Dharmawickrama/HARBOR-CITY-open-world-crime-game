import type { Profiler } from '../core/profiler';

/** Fixed-step phases, run in this order every simulation tick. */
export const FIXED_PHASES = [
  'input',
  'ai',
  'gameplay',
  'prePhysics',
  'physics',
  'postPhysics',
  'late',
] as const;
/** Render-frame phases, run in this order every rendered frame. */
export const RENDER_PHASES = ['interpolate', 'animation', 'camera', 'audio', 'ui', 'render'] as const;

export type FixedPhase = (typeof FIXED_PHASES)[number];
export type RenderPhase = (typeof RENDER_PHASES)[number];

export interface FixedContext {
  /** Fixed step length in seconds. */
  readonly dt: number;
  readonly tick: number;
  /** Simulation time in seconds. */
  readonly time: number;
}

export interface RenderContext {
  /** Interpolation factor between the previous and current simulation state. */
  readonly alpha: number;
  /** Wall-clock duration of this frame in seconds (clamped). */
  readonly frameSeconds: number;
  readonly time: number;
}

export interface FixedSystem {
  readonly name: string;
  readonly phase: FixedPhase;
  fixedUpdate(ctx: FixedContext): void;
}

export interface RenderSystem {
  readonly name: string;
  readonly phase: RenderPhase;
  renderUpdate(ctx: RenderContext): void;
}

interface Entry<S> {
  readonly system: S;
  readonly slot: number;
  enabled: boolean;
}

/**
 * Runs systems by phase in registration order and records each system's time in the profiler.
 * The composition root (game/) decides registration order explicitly.
 */
export class Scheduler {
  private readonly fixed = new Map<FixedPhase, Entry<FixedSystem>[]>(FIXED_PHASES.map((p) => [p, []]));
  private readonly render = new Map<RenderPhase, Entry<RenderSystem>[]>(RENDER_PHASES.map((p) => [p, []]));
  private readonly names = new Set<string>();

  constructor(private readonly profiler: Profiler) {}

  addFixed(system: FixedSystem): this {
    this.claim(system.name);
    this.fixed.get(system.phase)?.push({ system, slot: this.profiler.slot(system.name), enabled: true });
    return this;
  }

  addRender(system: RenderSystem): this {
    this.claim(system.name);
    this.render.get(system.phase)?.push({ system, slot: this.profiler.slot(system.name), enabled: true });
    return this;
  }

  setEnabled(name: string, enabled: boolean): boolean {
    for (const list of [...this.fixed.values(), ...this.render.values()]) {
      for (const entry of list) {
        if (entry.system.name === name) {
          entry.enabled = enabled;
          return true;
        }
      }
    }
    return false;
  }

  runFixed(ctx: FixedContext): void {
    const now = this.profiler.now;
    for (const phase of FIXED_PHASES) {
      const list = this.fixed.get(phase) as Entry<FixedSystem>[];
      for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        if (!entry.enabled) continue;
        const t0 = now();
        entry.system.fixedUpdate(ctx);
        this.profiler.record(entry.slot, now() - t0);
      }
    }
  }

  runRender(ctx: RenderContext): void {
    const now = this.profiler.now;
    for (const phase of RENDER_PHASES) {
      const list = this.render.get(phase) as Entry<RenderSystem>[];
      for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        if (!entry.enabled) continue;
        const t0 = now();
        entry.system.renderUpdate(ctx);
        this.profiler.record(entry.slot, now() - t0);
      }
    }
  }

  /** System names grouped by phase, in execution order. */
  describe(): { fixed: Record<FixedPhase, string[]>; render: Record<RenderPhase, string[]> } {
    const fixed = {} as Record<FixedPhase, string[]>;
    const render = {} as Record<RenderPhase, string[]>;
    for (const [phase, list] of this.fixed) fixed[phase] = list.map((e) => e.system.name);
    for (const [phase, list] of this.render) render[phase] = list.map((e) => e.system.name);
    return { fixed, render };
  }

  private claim(name: string): void {
    if (this.names.has(name)) throw new Error(`Scheduler: duplicate system name "${name}"`);
    this.names.add(name);
  }
}
