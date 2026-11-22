import { entityIndex, type Entity } from './entity';

interface DefBase {
  readonly name: string;
}

/** Struct-of-arrays component: every field is a Float32Array indexed by entity index. */
export interface SoADef<F extends string> extends DefBase {
  readonly kind: 'soa';
  readonly fields: readonly F[];
}

/** Arbitrary object per entity, stored in a sparse set (dense iteration, O(1) lookup). */
export interface ObjectDef<T> extends DefBase {
  readonly kind: 'object';
  /** Phantom field carrying the value type; never set at runtime. */
  readonly _value?: T;
}

/** Presence-only component (no data). */
export interface TagDef extends DefBase {
  readonly kind: 'tag';
}

export type ComponentDef = SoADef<string> | ObjectDef<unknown> | TagDef;

export function defineSoA<const F extends string>(name: string, fields: readonly F[]): SoADef<F> {
  if (new Set(fields).size !== fields.length) throw new Error(`defineSoA(${name}): duplicate field`);
  return { kind: 'soa', name, fields };
}

export function defineObject<T>(name: string): ObjectDef<T> {
  return { kind: 'object', name };
}

export function defineTag(name: string): TagDef {
  return { kind: 'tag', name };
}

export class SoAStore<F extends string> {
  readonly f: Readonly<Record<F, Float32Array>>;

  constructor(
    readonly def: SoADef<F>,
    capacity: number,
  ) {
    const fields = {} as Record<F, Float32Array>;
    for (const field of def.fields) fields[field] = new Float32Array(capacity);
    this.f = fields;
  }

  zero(index: number): void {
    for (const field of this.def.fields) this.f[field][index] = 0;
  }
}

export class ObjectStore<T> {
  private readonly sparse: Int32Array;
  readonly values: T[] = [];
  readonly entities: Entity[] = [];

  constructor(
    readonly def: ObjectDef<T>,
    capacity: number,
  ) {
    this.sparse = new Int32Array(capacity).fill(-1);
  }

  get size(): number {
    return this.values.length;
  }

  has(entity: Entity): boolean {
    const dense = this.sparse[entityIndex(entity)];
    return dense >= 0 && this.entities[dense] === entity;
  }

  get(entity: Entity): T | undefined {
    const dense = this.sparse[entityIndex(entity)];
    return dense >= 0 && this.entities[dense] === entity ? this.values[dense] : undefined;
  }

  set(entity: Entity, value: T): void {
    const index = entityIndex(entity);
    const dense = this.sparse[index];
    if (dense >= 0 && this.entities[dense] === entity) {
      this.values[dense] = value;
      return;
    }
    this.sparse[index] = this.values.length;
    this.values.push(value);
    this.entities.push(entity);
  }

  delete(entity: Entity): boolean {
    const index = entityIndex(entity);
    const dense = this.sparse[index];
    if (dense < 0 || this.entities[dense] !== entity) return false;
    const last = this.values.length - 1;
    if (dense !== last) {
      const movedEntity = this.entities[last];
      this.values[dense] = this.values[last];
      this.entities[dense] = movedEntity;
      this.sparse[entityIndex(movedEntity)] = dense;
    }
    this.values.pop();
    this.entities.pop();
    this.sparse[index] = -1;
    return true;
  }
}
