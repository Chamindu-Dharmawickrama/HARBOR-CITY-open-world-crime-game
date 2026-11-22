import { generateCity } from '../gen/city-layout';
import { meshTransferables } from '../mesh/mesh-builder';
import { colliderTransferables, WorldMeshFactory } from '../mesh/world-mesh-factory';
import type { WorkerRequest, WorkerResponse } from './protocol';

/**
 * World-generation worker: regenerates the (deterministic) city model from the seed, then
 * builds chunk geometry on request and transfers the typed arrays back without copying.
 */
interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;
let factory: WorldMeshFactory | null = null;

scope.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const request = event.data;
  try {
    switch (request.type) {
      case 'init': {
        factory = new WorldMeshFactory(generateCity(request.city, request.seed), request.city);
        scope.postMessage({ type: 'ready' });
        break;
      }
      case 'build': {
        if (!factory) throw new Error('worker not initialised');
        const result = factory.build(request.key, request.piece, request.colliders);
        const transfer = [
          ...meshTransferables(result.mesh),
          ...(result.colliders ? colliderTransferables(result.colliders) : []),
        ];
        scope.postMessage({ type: 'built', id: request.id, result }, transfer);
        break;
      }
      case 'landmarks': {
        if (!factory) throw new Error('worker not initialised');
        const meshes = factory.landmarks();
        scope.postMessage({ type: 'landmarks', id: request.id, meshes }, [
          ...meshTransferables(meshes.solid),
          ...meshTransferables(meshes.detail),
        ]);
        break;
      }
    }
  } catch (error) {
    const id = 'id' in request ? request.id : -1;
    scope.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    });
  }
};
