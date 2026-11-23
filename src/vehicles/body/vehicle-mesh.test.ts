import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ALL_VEHICLES } from '../../content/vehicles';
import {
  createBurntMaterial,
  createGlassMaterial,
  createLightMaterial,
  createPaintMaterial,
  LightCode,
} from './vehicle-materials';
import { buildVehicleModel, VehicleGroup } from './vehicle-mesh';
import { VehicleView } from './vehicle-view';

const materials = {
  paint: createPaintMaterial(),
  glass: createGlassMaterial(),
  crackedGlass: createGlassMaterial(true),
  burnt: createBurntMaterial(),
  hidden: new THREE.MeshBasicMaterial({ visible: false }),
};

describe('procedural vehicle bodies', () => {
  it.each(ALL_VEHICLES.map((d) => [d.id, d] as const))('%s builds a valid skinned model', (_id, def) => {
    const model = buildVehicleModel(def, def.colours[0]);
    const g = model.geometry;
    // Three material groups in order: paint, glass, lights.
    expect(g.groups.map((x) => x.materialIndex)).toEqual([
      VehicleGroup.paint,
      VehicleGroup.glass,
      VehicleGroup.lights,
    ]);
    const skin = g.getAttribute('skinIndex');
    for (let i = 0; i < skin.count; i++) expect(skin.getX(i)).toBeLessThan(model.bones.length);
    const wheels = def.kind === 'boat' ? 0 : def.kind === 'bike' ? 2 : 4;
    expect(model.wheelBones).toHaveLength(wheels);
    expect(model.doors).toHaveLength(def.kind === 'car' ? (def.style === 'bus' ? 2 : def.doors) : 0);
    // Body fits its spec (bounding box roughly the size of the vehicle).
    g.computeBoundingBox();
    const size = (g.boundingBox as THREE.Box3).getSize(new THREE.Vector3());
    expect(size.z).toBeGreaterThan(def.length * 0.9);
    expect(size.z).toBeLessThan(def.length * 1.25);
    expect(size.y).toBeLessThan(def.height * 1.6);
    // Lights carry their codes; head and tail lamps exist.
    const codes = new Set(Array.from(g.getAttribute('aLight').array as Float32Array));
    expect(codes.has(LightCode.head)).toBe(true);
    expect(codes.has(LightCode.tail)).toBe(true);
    if (def.lightBar) expect(codes.has(LightCode.barRed)).toBe(true);
  });

  it('caches per model and colour; views animate doors and wheels and go copy-on-write when dented', () => {
    const def = ALL_VEHICLES.find((d) => d.id === 'meridian');
    if (!def) throw new Error('meridian');
    const a = buildVehicleModel(def, 0x111111);
    expect(buildVehicleModel(def, 0x111111)).toBe(a);
    expect(buildVehicleModel(def, 0x222222)).not.toBe(a);
    const view = new VehicleView(a, def, materials);
    view.doorTarget[0] = 1;
    for (let i = 0; i < 60; i++) view.update(1 / 60);
    expect(view.doorOpen[0]).toBe(1);
    const door = view.bones[a.doors[0]?.bone ?? 0];
    expect(Math.abs(door.quaternion.y)).toBeGreaterThan(0.4);
    const geometry = view.ownGeometry();
    expect(geometry).not.toBe(a.geometry);
    expect(view.ownGeometry()).toBe(geometry);
    view.setGlass('shattered');
    expect((view.mesh.material as THREE.Material[])[1]).toBe(materials.hidden);
    view.setBurnt();
    expect((view.mesh.material as THREE.Material[])[0]).toBe(materials.burnt);
    view.dispose();
  });

  it('light material exposes per-vehicle uniforms', () => {
    const a = createLightMaterial();
    const b = createLightMaterial();
    a.uniforms.uBrake.value = 1;
    expect(b.uniforms.uBrake.value).toBe(0);
  });
});
