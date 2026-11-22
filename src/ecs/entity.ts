/** Entity handle: 20-bit index + 12-bit generation packed into an unsigned 32-bit integer. */
export type Entity = number & { readonly __brand: 'Entity' };

export const INDEX_BITS = 20;
export const GENERATION_BITS = 12;
export const INDEX_MASK = (1 << INDEX_BITS) - 1;
export const GENERATION_MASK = (1 << GENERATION_BITS) - 1;
/** The highest index is reserved so NULL_ENTITY can never be a live entity. */
export const MAX_ENTITIES = INDEX_MASK;
export const NULL_ENTITY = 0xffffffff as Entity;

export function entityIndex(entity: Entity): number {
  return entity & INDEX_MASK;
}

export function entityGeneration(entity: Entity): number {
  return (entity >>> INDEX_BITS) & GENERATION_MASK;
}

export function makeEntity(index: number, generation: number): Entity {
  return ((((generation & GENERATION_MASK) << INDEX_BITS) | (index & INDEX_MASK)) >>> 0) as Entity;
}

/** Allocates entity handles. Destroyed indices are recycled with a bumped generation. */
export class EntityManager {
  private readonly generations: Uint16Array;
  private readonly alive: Uint8Array;
  private readonly freeIndices: Int32Array;
  private freeTop = 0;
  private nextIndex = 0;
  private liveCount = 0;

  constructor(readonly capacity = 1 << 16) {
    if (capacity > MAX_ENTITIES) throw new Error(`EntityManager: capacity exceeds ${MAX_ENTITIES}`);
    this.generations = new Uint16Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.freeIndices = new Int32Array(capacity);
  }

  create(): Entity {
    let index: number;
    if (this.freeTop > 0) index = this.freeIndices[--this.freeTop];
    else if (this.nextIndex < this.capacity) index = this.nextIndex++;
    else throw new Error(`EntityManager: out of entities (capacity ${this.capacity})`);
    this.alive[index] = 1;
    this.liveCount++;
    return makeEntity(index, this.generations[index]);
  }

  destroy(entity: Entity): boolean {
    if (!this.isAlive(entity)) return false;
    const index = entityIndex(entity);
    this.alive[index] = 0;
    this.generations[index] = (this.generations[index] + 1) & GENERATION_MASK;
    this.freeIndices[this.freeTop++] = index;
    this.liveCount--;
    return true;
  }

  isAlive(entity: Entity): boolean {
    const index = entityIndex(entity);
    return (
      index < this.capacity && this.alive[index] === 1 && this.generations[index] === entityGeneration(entity)
    );
  }

  get count(): number {
    return this.liveCount;
  }
}
