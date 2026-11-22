import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp01 } from '../../core/math';
import type { CharacterAppearance } from './appearance';
import { BONE_INDEX, BONE_PARENT, BONES, restOffsets, type BoneName } from './skeleton-def';

type ColourSlot = 'skin' | 'hair' | 'top' | 'bottom' | 'shoes' | 'eyes' | 'cap';

interface Part {
  bone: BoneName;
  shape: 'box' | 'capsule' | 'sphere' | 'cap';
  /** box: [w, h, d]; capsule: [radius, length]; sphere/cap: [rx, ry, rz]. Reference (1.8 m) units. */
  size: readonly number[];
  /** Centre offset from the bone joint (reference units). */
  offset: readonly [number, number, number];
  colour: ColourSlot;
  /**
   * Smooth skinning near the joint: vertices within `range` of the joint (on the side the part
   * extends into, `dir` = −1 down / +1 up) share weight with the parent bone.
   */
  blend?: { range: number; dir: 1 | -1 };
}

const EYE_COLOUR = 0x1a1a1a;

/** Body parts for an appearance, in bone-local reference coordinates (character faces +Z). */
function partsFor(a: CharacterAppearance): Part[] {
  const parts: Part[] = [];
  const longSleeves = a.topStyle !== 'tee';
  const jacket = a.topStyle === 'jacket';
  const shorts = a.bottomStyle === 'shorts';
  const down = { range: 0.07, dir: -1 } as const;
  const up = { range: 0.05, dir: 1 } as const;

  // Torso.
  parts.push({ bone: 'hips', shape: 'box', size: [0.33, 0.2, 0.2], offset: [0, -0.02, 0], colour: 'bottom' });
  parts.push({
    bone: 'spine',
    shape: 'box',
    size: [jacket ? 0.33 : 0.31, 0.24, jacket ? 0.21 : 0.19],
    offset: [0, jacket ? 0.08 : 0.1, 0],
    colour: 'top',
    blend: up,
  });
  parts.push({
    bone: 'chest',
    shape: 'box',
    size: [jacket ? 0.41 : 0.39, 0.26, jacket ? 0.24 : 0.22],
    offset: [0, 0.12, 0],
    colour: 'top',
    blend: up,
  });
  if (jacket)
    parts.push({
      bone: 'chest',
      shape: 'box',
      size: [0.2, 0.06, 0.2],
      offset: [0, 0.255, -0.01],
      colour: 'top',
    });
  // Shoulders (rounded joints that overlap the chest).
  for (const side of [1, -1]) {
    parts.push({
      bone: 'chest',
      shape: 'sphere',
      size: [0.075, 0.07, 0.075],
      offset: [0.18 * side, 0.2, 0],
      colour: 'top',
    });
  }
  // Neck and head.
  parts.push({
    bone: 'neck',
    shape: 'capsule',
    size: [0.05, 0.06],
    offset: [0, 0.04, 0],
    colour: 'skin',
    blend: up,
  });
  parts.push({
    bone: 'head',
    shape: 'sphere',
    size: [0.1, 0.122, 0.112],
    offset: [0, 0.1, 0.005],
    colour: 'skin',
  });
  parts.push({
    bone: 'head',
    shape: 'box',
    size: [0.03, 0.045, 0.04],
    offset: [0, 0.085, 0.115],
    colour: 'skin',
  });
  for (const side of [1, -1]) {
    parts.push({
      bone: 'head',
      shape: 'box',
      size: [0.026, 0.014, 0.01],
      offset: [0.04 * side, 0.115, 0.104],
      colour: 'eyes',
    });
  }
  switch (a.hairStyle) {
    case 'short':
      parts.push({
        bone: 'head',
        shape: 'cap',
        size: [0.108, 0.13, 0.12],
        offset: [0, 0.112, -0.004],
        colour: 'hair',
      });
      break;
    case 'long':
      parts.push({
        bone: 'head',
        shape: 'cap',
        size: [0.11, 0.132, 0.122],
        offset: [0, 0.112, -0.006],
        colour: 'hair',
      });
      parts.push({
        bone: 'head',
        shape: 'box',
        size: [0.2, 0.2, 0.06],
        offset: [0, 0.05, -0.085],
        colour: 'hair',
      });
      break;
    case 'cap':
      parts.push({
        bone: 'head',
        shape: 'cap',
        size: [0.112, 0.12, 0.124],
        offset: [0, 0.125, -0.004],
        colour: 'cap',
      });
      parts.push({
        bone: 'head',
        shape: 'box',
        size: [0.17, 0.014, 0.1],
        offset: [0, 0.155, 0.12],
        colour: 'cap',
      });
      break;
    case 'bald':
      break;
  }
  // Arms.
  for (const side of ['L', 'R'] as const) {
    parts.push({
      bone: `upperArm${side}`,
      shape: 'capsule',
      size: [0.054, 0.22],
      offset: [0, -0.14, 0],
      colour: 'top',
      blend: down,
    });
    parts.push({
      bone: `lowerArm${side}`,
      shape: 'capsule',
      size: [0.046, 0.2],
      offset: [0, -0.125, 0],
      colour: longSleeves ? 'top' : 'skin',
      blend: down,
    });
    parts.push({
      bone: `hand${side}`,
      shape: 'box',
      size: [0.07, 0.15, 0.09],
      offset: [0, -0.065, 0.005],
      colour: 'skin',
    });
  }
  // Legs.
  for (const side of ['L', 'R'] as const) {
    parts.push({
      bone: `upperLeg${side}`,
      shape: 'capsule',
      size: [0.08, 0.32],
      offset: [0, -0.215, 0],
      colour: 'bottom',
      blend: down,
    });
    parts.push({
      bone: `lowerLeg${side}`,
      shape: 'capsule',
      size: [0.061, 0.3],
      offset: [0, -0.2, 0],
      colour: shorts ? 'skin' : 'bottom',
      blend: down,
    });
    parts.push({
      bone: `foot${side}`,
      shape: 'box',
      size: [0.105, 0.085, 0.27],
      offset: [0, -0.04, 0.055],
      colour: 'shoes',
    });
  }
  return parts;
}

function colourOf(a: CharacterAppearance, slot: ColourSlot): number {
  switch (slot) {
    case 'skin':
      return a.skin;
    case 'hair':
      return a.hair;
    case 'top':
      return a.top;
    case 'bottom':
      return a.bottom;
    case 'shoes':
      return a.shoes;
    case 'eyes':
      return EYE_COLOUR;
    case 'cap':
      return a.bottom;
  }
}

function shapeGeometry(part: Part, s: number, g: number): THREE.BufferGeometry {
  const z = part.size;
  switch (part.shape) {
    case 'box':
      return new THREE.BoxGeometry(z[0] * g, z[1] * s, z[2] * g);
    case 'capsule':
      return new THREE.CapsuleGeometry(z[0] * g, z[1] * s, 3, 8);
    case 'sphere':
      return new THREE.SphereGeometry(1, 10, 8).scale(z[0] * g, z[1] * s, z[2] * g);
    case 'cap':
      // Upper part of a sphere (hair, caps).
      return new THREE.SphereGeometry(1, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.42).scale(
        z[0] * g,
        z[1] * s,
        z[2] * g,
      );
  }
}

export interface CharacterRig {
  readonly mesh: THREE.SkinnedMesh;
  /** Bones in skeleton-def order (index = BONE_INDEX). */
  readonly bones: readonly THREE.Bone[];
  /** Rest-pose local positions per bone (scaled to the body). */
  readonly rest: readonly THREE.Vector3[];
}

/**
 * Builds one skinned character: a rest skeleton scaled to the body, and a single merged
 * geometry of rounded segments (vertex-coloured, one draw call) skinned rigidly to its bone, with
 * weights shared with the parent bone near joints so elbows, knees and the waist bend smoothly.
 */
export function buildCharacter(appearance: CharacterAppearance, material: THREE.Material): CharacterRig {
  const body = appearance.body;
  const offsets = restOffsets(body);
  const s = body.height / 1.8;
  const g = s * (0.78 + 0.22 * body.build);

  // Rest-pose model-space joint positions (rest rotations are identity).
  const joint: Record<BoneName, THREE.Vector3> = {} as Record<BoneName, THREE.Vector3>;
  for (const bone of BONES) {
    const [x, y, z] = offsets[bone];
    const parent = BONE_PARENT[bone];
    joint[bone] = new THREE.Vector3(x, y, z).add(parent ? joint[parent] : new THREE.Vector3());
  }

  const pieces: THREE.BufferGeometry[] = [];
  const colour = new THREE.Color();
  for (const part of partsFor(appearance)) {
    const geometry = shapeGeometry(part, s, g);
    geometry.deleteAttribute('uv');
    const [ox, oy, oz] = part.offset;
    geometry.translate(ox * g, oy * s, oz * g);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const count = position.count;
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    const colours = new Uint8Array(count * 3);
    const self = BONE_INDEX[part.bone];
    const parentName = BONE_PARENT[part.bone];
    const parent = parentName ? BONE_INDEX[parentName] : self;
    colour.setHex(colourOf(appearance, part.colour), THREE.SRGBColorSpace);
    // Slight per-vertex shade variation (darker underneath) adds form without textures.
    for (let v = 0; v < count; v++) {
      const localY = position.getY(v);
      let parentWeight = 0;
      if (part.blend) {
        const along = localY * part.blend.dir; // distance from the joint into the part
        parentWeight = 0.5 * clamp01(1 - along / (part.blend.range * s));
      }
      skinIndex[v * 4] = self;
      skinIndex[v * 4 + 1] = parent;
      skinWeight[v * 4] = 1 - parentWeight;
      skinWeight[v * 4 + 1] = parentWeight;
      const shade = 0.92 + 0.08 * clamp01(0.5 + position.getY(v) / (0.3 * s));
      colours[v * 3] = Math.round(clamp01(colour.r * shade) * 255);
      colours[v * 3 + 1] = Math.round(clamp01(colour.g * shade) * 255);
      colours[v * 3 + 2] = Math.round(clamp01(colour.b * shade) * 255);
    }
    const j = joint[part.bone];
    geometry.translate(j.x, j.y, j.z);
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
    geometry.setAttribute('color', new THREE.Uint8BufferAttribute(colours, 3, true));
    pieces.push(geometry);
  }
  const merged = mergeGeometries(pieces, false);
  for (const piece of pieces) piece.dispose();
  if (!merged) throw new Error('buildCharacter: geometry merge failed');
  merged.computeBoundingSphere();
  merged.computeBoundingBox();

  const bones = BONES.map((name) => {
    const bone = new THREE.Bone();
    bone.name = name;
    const [x, y, z] = offsets[name];
    bone.position.set(x, y, z);
    return bone;
  });
  for (const name of BONES) {
    const parent = BONE_PARENT[name];
    if (parent) bones[BONE_INDEX[parent]].add(bones[BONE_INDEX[name]]);
  }
  const mesh = new THREE.SkinnedMesh(merged, material);
  mesh.name = 'character';
  mesh.add(bones[0]);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, bones, rest: bones.map((b) => b.position.clone()) };
}

/** Shared material for every character (vertex colours carry the look). */
export function createCharacterMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 });
}
