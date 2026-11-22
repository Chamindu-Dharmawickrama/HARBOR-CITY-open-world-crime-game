import * as THREE from 'three';
import type { MeshData } from '../mesh/mesh-builder';

/** Bytes that will be uploaded to the GPU for this mesh. */
export function meshByteSize(mesh: MeshData): number {
  return (
    mesh.positions.byteLength +
    mesh.normals.byteLength +
    mesh.uvs.byteLength +
    mesh.colors.byteLength +
    mesh.data.byteLength +
    mesh.indices.byteLength
  );
}

/** Wraps worker-built typed arrays in a BufferGeometry (no copies) with precomputed bounds. */
export function geometryFromMeshData(mesh: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3, true));
  geometry.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3, true));
  geometry.setAttribute('aUv', new THREE.BufferAttribute(mesh.uvs, 2));
  geometry.setAttribute('aData', new THREE.BufferAttribute(mesh.data, 4));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  const b = mesh.bounds;
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(b[0], b[1], b[2]),
    new THREE.Vector3(b[3], b[4], b[5]),
  );
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  return geometry;
}

export function meshFromData(data: MeshData, material: THREE.Material, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(geometryFromMeshData(data), material);
  mesh.name = name;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
