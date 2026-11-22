/**
 * Typed gameplay event bus.
 *
 * - Event ids are `domain:verb`; payloads contain only primitives and core types.
 * - `emit` queues; queued events are dispatched by `flush()` at the end of each fixed step,
 *   so handlers never run re-entrantly inside the system that raised the event.
 * - `emitNow` dispatches synchronously (for UI/meta events outside the simulation).
 * - High-frequency data (transforms, contacts) must NOT go through the bus — use ECS components.
 */

/** Registry of every gameplay event and its payload. Extended as milestones land. */
export interface GameEvents {
  'game:ready': { seed: number; preset: string };
  'game:pauseChanged': { paused: boolean };
  'game:timeScaleChanged': { timeScale: number };
  'settings:qualityChanged': { preset: string };
  'debug:sceneReset': { reason: string };
  'player:landed': { impactSpeed: number; damage: number };
  'player:damaged': { amount: number; health: number; armor: number; cause: string };
  'player:died': { cause: string; x: number; y: number; z: number };
  'player:respawned': { x: number; y: number; z: number };
  'player:enteredWater': { x: number; z: number };
  'menu:opened': { menu: string };
  'menu:closed': { menu: string };
}

export type EventHandler<P> = (payload: P) => void;
type AnyHandler = (payload: unknown) => void;

export class EventBus<M extends object = GameEvents> {
  private readonly handlers = new Map<keyof M, readonly AnyHandler[]>();
  private readonly queueTypes: (keyof M)[] = [];
  private readonly queuePayloads: unknown[] = [];
  private queueLength = 0;

  /** Subscribes; returns an unsubscribe function. Subscribing allocates, dispatch does not. */
  on<K extends keyof M>(type: K, handler: EventHandler<M[K]>): () => void {
    const list = this.handlers.get(type) ?? [];
    this.handlers.set(type, [...list, handler as AnyHandler]);
    return () => this.off(type, handler);
  }

  off<K extends keyof M>(type: K, handler: EventHandler<M[K]>): void {
    const list = this.handlers.get(type);
    if (!list) return;
    const next = list.filter((h) => h !== (handler as AnyHandler));
    if (next.length === 0) this.handlers.delete(type);
    else this.handlers.set(type, next);
  }

  /** Queues an event for the next flush. */
  emit<K extends keyof M>(type: K, payload: M[K]): void {
    this.queueTypes[this.queueLength] = type;
    this.queuePayloads[this.queueLength] = payload;
    this.queueLength++;
  }

  /** Dispatches immediately. */
  emitNow<K extends keyof M>(type: K, payload: M[K]): void {
    const list = this.handlers.get(type);
    if (!list) return;
    for (const handler of list) handler(payload);
  }

  /**
   * Dispatches queued events in order, including events queued by handlers during the flush.
   * Throws if more than `maxEvents` are processed (a feedback loop between handlers).
   */
  flush(maxEvents = 10_000): number {
    let processed = 0;
    for (let i = 0; i < this.queueLength; i++) {
      if (++processed > maxEvents) {
        this.clear();
        throw new Error(`EventBus.flush: more than ${maxEvents} events — handler feedback loop?`);
      }
      const type = this.queueTypes[i];
      const payload = this.queuePayloads[i];
      this.queuePayloads[i] = undefined;
      const list = this.handlers.get(type);
      if (list) for (const handler of list) handler(payload);
    }
    this.queueLength = 0;
    return processed;
  }

  get pending(): number {
    return this.queueLength;
  }

  listenerCount(type: keyof M): number {
    return this.handlers.get(type)?.length ?? 0;
  }

  clear(): void {
    for (let i = 0; i < this.queueLength; i++) this.queuePayloads[i] = undefined;
    this.queueLength = 0;
  }
}
