import {
  ObjectStore,
  SoAStore,
  type ComponentDef,
  type ObjectDef,
  type SoADef,
  type TagDef,
} from './component';
import { EntityManager, entityIndex, type Entity } from './entity';

export const MASK_WORDS = 4;
export const MAX_COMPONENTS = MASK_WORDS * 32;

interface Registration {
  readonly id: number;
  readonly def: ComponentDef;
  readonly soa: SoAStore<string> | null;
  readonly objects: ObjectStore<unknown> | null;
  readonly queries: Query[];
}

/**
 * A cached set of entities that have all `all` components and none of `none`.
 * Membership is updated incrementally on component add/remove; iterate `entities[0..size)`.
 * Removing a component from an entity while iterating the same query reorders the dense
 * array — use `World.destroyDeferred` for destruction during iteration.
 */
export class Query {
  readonly entities: Entity[] = [];
  private readonly dense: Int32Array;

  constructor(
    readonly allMask: Uint32Array,
    readonly noneMask: Uint32Array,
    capacity: number,
  ) {
    this.dense = new Int32Array(capacity).fill(-1);
  }

  get size(): number {
    return this.entities.length;
  }

  matches(masks: Uint32Array, base: number): boolean {
    for (let w = 0; w < MASK_WORDS; w++) {
      const m = masks[base + w];
      const all = this.allMask[w];
      if ((m & all) !== all) return false;
      if ((m & this.noneMask[w]) !== 0) return false;
    }
    return true;
  }

  contains(entity: Entity): boolean {
    const d = this.dense[entityIndex(entity)];
    return d >= 0 && this.entities[d] === entity;
  }

  /** @internal */
  insert(entity: Entity): void {
    if (this.contains(entity)) return;
    this.dense[entityIndex(entity)] = this.entities.length;
    this.entities.push(entity);
  }

  /** @internal */
  remove(entity: Entity): void {
    const index = entityIndex(entity);
    const d = this.dense[index];
    if (d < 0 || this.entities[d] !== entity) return;
    const last = this.entities.length - 1;
    if (d !== last) {
      const moved = this.entities[last];
      this.entities[d] = moved;
      this.dense[entityIndex(moved)] = d;
    }
    this.entities.pop();
    this.dense[index] = -1;
  }
}

/** Entity/component container with cached, incrementally maintained queries. */
export class World {
  readonly entities: EntityManager;
  private readonly registrations = new Map<ComponentDef, Registration>();
  private readonly byId: Registration[] = [];
  private readonly masks: Uint32Array;
  private readonly queries = new Map<string, Query>();
  private readonly pendingDestroy: Entity[] = [];
  private readonly live: Entity[] = [];
  private readonly liveDense: Int32Array;

  constructor(readonly capacity = 1 << 16) {
    this.entities = new EntityManager(capacity);
    this.masks = new Uint32Array(capacity * MASK_WORDS);
    this.liveDense = new Int32Array(capacity).fill(-1);
  }

  get entityCount(): number {
    return this.entities.count;
  }

  create(): Entity {
    const entity = this.entities.create();
    this.liveDense[entityIndex(entity)] = this.live.length;
    this.live.push(entity);
    return entity;
  }

  isAlive(entity: Entity): boolean {
    return this.entities.isAlive(entity);
  }

  destroy(entity: Entity): void {
    if (!this.entities.isAlive(entity)) return;
    const index = entityIndex(entity);
    const base = index * MASK_WORDS;
    for (const reg of this.byId) {
      if (!this.bit(base, reg.id)) continue;
      reg.objects?.delete(entity);
      for (const q of reg.queries) q.remove(entity);
    }
    for (let w = 0; w < MASK_WORDS; w++) this.masks[base + w] = 0;
    const d = this.liveDense[index];
    const last = this.live.length - 1;
    if (d !== last) {
      const moved = this.live[last];
      this.live[d] = moved;
      this.liveDense[entityIndex(moved)] = d;
    }
    this.live.pop();
    this.liveDense[index] = -1;
    this.entities.destroy(entity);
  }

  /** Queues destruction until `flushDestroyed()` (safe during query iteration). */
  destroyDeferred(entity: Entity): void {
    this.pendingDestroy.push(entity);
  }

  flushDestroyed(): number {
    const n = this.pendingDestroy.length;
    for (let i = 0; i < n; i++) this.destroy(this.pendingDestroy[i]);
    this.pendingDestroy.length = 0;
    return n;
  }

  soa<F extends string>(def: SoADef<F>): SoAStore<F> {
    return this.register(def).soa as unknown as SoAStore<F>;
  }

  objects<T>(def: ObjectDef<T>): ObjectStore<T> {
    return this.register(def).objects as ObjectStore<T>;
  }

  /** Adds a SoA component (fields zeroed) or a tag. No-op if already present. */
  add(entity: Entity, def: SoADef<string> | TagDef): void {
    this.assertAlive(entity);
    const reg = this.register(def);
    if (this.bit(entityIndex(entity) * MASK_WORDS, reg.id)) return;
    reg.soa?.zero(entityIndex(entity));
    this.setBit(entity, reg, true);
  }

  /** Adds or replaces an object component. */
  set<T>(entity: Entity, def: ObjectDef<T>, value: T): void {
    this.assertAlive(entity);
    const reg = this.register(def);
    (reg.objects as ObjectStore<T>).set(entity, value);
    if (!this.bit(entityIndex(entity) * MASK_WORDS, reg.id)) this.setBit(entity, reg, true);
  }

  get<T>(entity: Entity, def: ObjectDef<T>): T | undefined {
    return (this.register(def).objects as ObjectStore<T>).get(entity);
  }

  remove(entity: Entity, def: ComponentDef): void {
    if (!this.entities.isAlive(entity)) return;
    const reg = this.register(def);
    if (!this.bit(entityIndex(entity) * MASK_WORDS, reg.id)) return;
    reg.objects?.delete(entity);
    this.setBit(entity, reg, false);
  }

  has(entity: Entity, def: ComponentDef): boolean {
    if (!this.entities.isAlive(entity)) return false;
    const reg = this.registrations.get(def);
    return reg !== undefined && this.bit(entityIndex(entity) * MASK_WORDS, reg.id);
  }

  /** Returns the cached query for this component combination (created on first use). */
  query(all: readonly ComponentDef[], none: readonly ComponentDef[] = []): Query {
    if (all.length === 0) throw new Error('World.query: at least one required component');
    const allRegs = all.map((d) => this.register(d));
    const noneRegs = none.map((d) => this.register(d));
    const ids = (regs: Registration[]): string =>
      regs
        .map((r) => r.id)
        .sort((a, b) => a - b)
        .join(',');
    const key = `${ids(allRegs)}|${ids(noneRegs)}`;
    const cached = this.queries.get(key);
    if (cached) return cached;
    const allMask = new Uint32Array(MASK_WORDS);
    const noneMask = new Uint32Array(MASK_WORDS);
    for (const r of allRegs) allMask[r.id >>> 5] = allMask[r.id >>> 5] | (1 << (r.id & 31));
    for (const r of noneRegs) noneMask[r.id >>> 5] = noneMask[r.id >>> 5] | (1 << (r.id & 31));
    const query = new Query(allMask, noneMask, this.capacity);
    this.queries.set(key, query);
    for (const r of [...allRegs, ...noneRegs]) r.queries.push(query);
    for (const e of this.live) {
      if (query.matches(this.masks, entityIndex(e) * MASK_WORDS)) query.insert(e);
    }
    return query;
  }

  private register(def: ComponentDef): Registration {
    const existing = this.registrations.get(def);
    if (existing) return existing;
    const id = this.byId.length;
    if (id >= MAX_COMPONENTS) throw new Error(`World: more than ${MAX_COMPONENTS} component types`);
    const reg: Registration = {
      id,
      def,
      soa: def.kind === 'soa' ? new SoAStore(def, this.capacity) : null,
      objects: def.kind === 'object' ? new ObjectStore(def, this.capacity) : null,
      queries: [],
    };
    this.registrations.set(def, reg);
    this.byId.push(reg);
    return reg;
  }

  private bit(base: number, id: number): boolean {
    return ((this.masks[base + (id >>> 5)] >>> (id & 31)) & 1) === 1;
  }

  private setBit(entity: Entity, reg: Registration, value: boolean): void {
    const base = entityIndex(entity) * MASK_WORDS;
    const word = base + (reg.id >>> 5);
    const flag = 1 << (reg.id & 31);
    this.masks[word] = value ? this.masks[word] | flag : this.masks[word] & ~flag;
    for (const q of reg.queries) {
      if (q.matches(this.masks, base)) q.insert(entity);
      else q.remove(entity);
    }
  }

  private assertAlive(entity: Entity): void {
    if (!this.entities.isAlive(entity)) throw new Error(`World: entity ${entity} is not alive`);
  }
}
