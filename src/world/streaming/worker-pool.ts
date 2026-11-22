import type { CityDef } from '../gen/types';
import type { ChunkKey } from '../mesh/chunk-index';
import type { LandmarkMeshes } from '../mesh/landmark-mesh';
import type { ChunkPiece, PieceResult } from '../mesh/world-mesh-factory';
import type { WorkerRequest, WorkerResponse } from './protocol';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  worker: number;
}

interface Slot {
  worker: Worker;
  inFlight: number;
  ready: Promise<void>;
}

/** A small pool of world-generation workers with promise-based requests. */
export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(count: number, city: CityDef, seed: number) {
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./world-worker.ts', import.meta.url), {
        type: 'module',
        name: `world-${i}`,
      });
      let markReady: () => void = () => undefined;
      let markFailed: (e: Error) => void = () => undefined;
      const ready = new Promise<void>((resolve, reject) => {
        markReady = resolve;
        markFailed = reject;
      });
      worker.onmessage = (event: MessageEvent<WorkerResponse>): void => {
        const message = event.data;
        if (message.type === 'ready') {
          markReady();
          return;
        }
        if (message.type === 'error' && message.id < 0) {
          markFailed(new Error(message.message));
          return;
        }
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        const slot = this.slots[entry.worker];
        if (slot) slot.inFlight--;
        if (message.type === 'error') entry.reject(new Error(message.message));
        else if (message.type === 'built') entry.resolve(message.result);
        else entry.resolve(message.meshes);
      };
      worker.onerror = (event): void => markFailed(new Error(event.message || 'world worker failed'));
      const init: WorkerRequest = { type: 'init', seed, city };
      worker.postMessage(init);
      this.slots.push({ worker, inFlight: 0, ready });
    }
  }

  get size(): number {
    return this.slots.length;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  ready(): Promise<void> {
    return Promise.all(this.slots.map((s) => s.ready)).then(() => undefined);
  }

  build(key: ChunkKey, piece: ChunkPiece, colliders: boolean): Promise<PieceResult> {
    return this.send({ type: 'build', id: 0, key, piece, colliders }) as Promise<PieceResult>;
  }

  landmarks(): Promise<LandmarkMeshes> {
    return this.send({ type: 'landmarks', id: 0 }) as Promise<LandmarkMeshes>;
  }

  dispose(): void {
    for (const slot of this.slots) slot.worker.terminate();
    for (const entry of this.pending.values()) entry.reject(new Error('worker pool disposed'));
    this.pending.clear();
  }

  private send(request: Extract<WorkerRequest, { id: number }>): Promise<unknown> {
    const id = this.nextId++;
    let best = 0;
    for (let i = 1; i < this.slots.length; i++) {
      if (this.slots[i].inFlight < this.slots[best].inFlight) best = i;
    }
    const slot = this.slots[best];
    slot.inFlight++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker: best });
      slot.worker.postMessage({ ...request, id });
    });
  }
}
