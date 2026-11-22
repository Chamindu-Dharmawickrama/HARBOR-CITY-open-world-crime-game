/** Reusable object pool. Avoids allocation churn for short-lived objects in hot paths. */
export class ObjectPool<T> {
  private readonly free: T[] = [];
  private created = 0;
  private active = 0;

  constructor(
    private readonly factory: () => T,
    private readonly reset: (item: T) => void = () => undefined,
  ) {}

  acquire(): T {
    const item = this.free.pop() ?? this.make();
    this.active++;
    return item;
  }

  release(item: T): void {
    if (this.active === 0) throw new Error('ObjectPool.release: more releases than acquires');
    this.reset(item);
    this.free.push(item);
    this.active--;
  }

  prewarm(count: number): void {
    while (this.free.length < count) this.free.push(this.make());
  }

  get activeCount(): number {
    return this.active;
  }

  get freeCount(): number {
    return this.free.length;
  }

  get createdCount(): number {
    return this.created;
  }

  private make(): T {
    this.created++;
    return this.factory();
  }
}

/** Allocates integer slots in [0, capacity) — e.g. instance indices in an instanced mesh. */
export class SlotAllocator {
  private readonly freeSlots: Int32Array;
  private freeTop = 0;
  private readonly used: Uint8Array;
  private highWater = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.freeSlots = new Int32Array(capacity);
    this.used = new Uint8Array(capacity);
  }

  /** Returns a free slot, or -1 if full. Reuses the most recently released slot first. */
  allocate(): number {
    let slot: number;
    if (this.freeTop > 0) slot = this.freeSlots[--this.freeTop];
    else if (this.highWater < this.capacity) slot = this.highWater++;
    else return -1;
    this.used[slot] = 1;
    this.count++;
    return slot;
  }

  release(slot: number): void {
    if (slot < 0 || slot >= this.capacity || this.used[slot] === 0) {
      throw new Error(`SlotAllocator.release: slot ${slot} is not allocated`);
    }
    this.used[slot] = 0;
    this.freeSlots[this.freeTop++] = slot;
    this.count--;
  }

  isUsed(slot: number): boolean {
    return this.used[slot] === 1;
  }

  get usedCount(): number {
    return this.count;
  }

  /** One past the highest slot ever handed out (useful as an instanced draw count). */
  get highWaterMark(): number {
    return this.highWater;
  }
}
