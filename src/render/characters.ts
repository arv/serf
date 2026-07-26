import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import {
  bowInHand,
  crudeBlade,
  hatchet,
  katanaBlade,
  lathe,
  mesh,
  quiver,
  yariSpear,
} from './models';
import { palette } from './palette';

/**
 * Skinned-character pipeline: Quaternius Universal Base Characters (CC0)
 * animated by the Universal Animation Library (CC0). The base body is a
 * mannequin, so each unit kind is dressed at clone time with "clothing
 * shells" — copies of the body's skinned mesh filtered to the triangles
 * whose skin weights belong to torso/arm/thigh bones, inflated slightly
 * along their normals, and tinted per kind. The shells share the skeleton,
 * so the kimono deforms perfectly with every animation. Hats, weapons and
 * armor are rigid props parented to bones.
 */

// The ?v= busts stale HTTP caches when the assets are re-processed.
const CHARACTER_URL = '/models/character/Superhero_Male_FullBody.gltf?v=2';
const ANIMATIONS_URL = '/models/UAL1_Standard.glb?v=2';

export type AnimKey = 'idle' | 'walk' | 'jog' | 'attack' | 'shoot' | 'work';

const CLIP_NAMES: Record<AnimKey, string> = {
  idle: 'Idle_Loop',
  walk: 'Walk_Loop',
  jog: 'Jog_Fwd_Loop',
  attack: 'Sword_Attack',
  shoot: 'Spell_Simple_Shoot',
  work: 'Sword_Attack', // with a hatchet in hand it reads as the chop
};

/** Bones whose triangles make up the kimono shell (knee-length, sleeved). */
const ROBE_BONES = new Set([
  'pelvis',
  'spine_01',
  'spine_02',
  'spine_03',
  'clavicle_l',
  'clavicle_r',
  'upperarm_l',
  'upperarm_r',
  'thigh_l',
  'thigh_r',
]);
/** Bones for the obi sash band around the waist. */
const SASH_BONES = new Set(['pelvis']);

interface Wardrobe {
  robe: number;
  sash: number;
  kasa?: boolean;
  headband?: number;
  topknot?: boolean;
  armored?: boolean;
  scale?: number;
  tool?: (hand: THREE.Group) => void;
  back?: (torso: THREE.Group) => void;
  /** Soldiers jog; villagers walk. */
  jog?: boolean;
  /** Ranged units loose arrows instead of swinging. */
  ranged?: boolean;
}

const WARDROBES = new Map<number, Wardrobe>([
  [1, { robe: 0xe6d9b5, sash: 0xc86428 }],
  [2, { robe: 0xd8a868, sash: 0x6b8f3f, kasa: true, tool: hatchet }],
  [3, {
    robe: 0x6e88d0,
    sash: 0x2c3550,
    armored: true,
    topknot: true,
    jog: true,
    tool: (h) => katanaBlade(h),
  }],
  [4, { robe: 0xefe3cc, sash: 0x4a5f8e, headband: 0x4a5f8e, jog: true, tool: yariSpear }],
  [5, {
    robe: 0x7fae4a,
    sash: 0x3d5427,
    kasa: true,
    jog: true,
    ranged: true,
    tool: bowInHand(0xb8985a),
    back: quiver,
  }],
  [6, { robe: 0x5d636e, sash: 0x3a3f47, headband: 0xd85a4a, jog: true, tool: crudeBlade }],
  [7, {
    robe: 0x5d636e,
    sash: 0x3a3f47,
    headband: 0xd85a4a,
    jog: true,
    ranged: true,
    tool: bowInHand(palette.wood),
    back: quiver,
  }],
  [8, {
    robe: 0x4a5364,
    sash: 0x2a2f38,
    armored: true,
    topknot: true,
    jog: true,
    scale: 1.15,
    tool: (h) => katanaBlade(h, true),
  }],
]);

/** World-space height of a villager; matches the old procedural people. */
const TARGET_HEIGHT = 1.0;

interface CharacterAssets {
  /** Dressed template scene per unit kind, cloned per unit. */
  base: THREE.Group;
  clips: Map<AnimKey, THREE.AnimationClip>;
  /** Uniform scale applied to the wrapper to hit TARGET_HEIGHT. */
  scale: number;
  /** Vertical offset that puts the feet at y=0 (in model units). */
  footY: number;
}

export interface CharacterVisual {
  mixer: THREE.AnimationMixer;
  actions: Map<AnimKey, THREE.AnimationAction>;
  current: AnimKey | null;
  jog: boolean;
  ranged: boolean;
}

let assets: CharacterAssets | null = null;

/** Dominant-bone name per vertex, from the 4-influence skin attributes. */
function dominantBones(geo: THREE.BufferGeometry, bones: THREE.Bone[]): string[] {
  const idx = geo.getAttribute('skinIndex');
  const wgt = geo.getAttribute('skinWeight');
  const out: string[] = [];
  for (let v = 0; v < idx.count; v++) {
    let best = 0;
    let bestW = -1;
    for (let k = 0; k < 4; k++) {
      const w = wgt.getComponent(v, k);
      if (w > bestW) {
        bestW = w;
        best = idx.getComponent(v, k);
      }
    }
    out.push(bones[best]?.name ?? '');
  }
  return out;
}

/**
 * Cut a clothing shell out of the body mesh: keep triangles fully owned by
 * `keep` bones, push vertices out along their normals so the cloth sits on
 * top of the skin.
 */
function shellGeometry(
  body: THREE.SkinnedMesh,
  keep: Set<string>,
  inflate: number,
): THREE.BufferGeometry {
  const src = body.geometry;
  const owner = dominantBones(src, body.skeleton.bones);
  const geo = src.clone();
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  for (let v = 0; v < pos.count; v++) {
    pos.setXYZ(
      v,
      pos.getX(v) + nrm.getX(v) * inflate,
      pos.getY(v) + nrm.getY(v) * inflate,
      pos.getZ(v) + nrm.getZ(v) * inflate,
    );
  }
  const srcIndex = src.getIndex();
  const kept: number[] = [];
  if (srcIndex) {
    for (let t = 0; t < srcIndex.count; t += 3) {
      const a = srcIndex.getX(t);
      const b = srcIndex.getX(t + 1);
      const c = srcIndex.getX(t + 2);
      if (keep.has(owner[a]!) && keep.has(owner[b]!) && keep.has(owner[c]!)) {
        kept.push(a, b, c);
      }
    }
  }
  geo.setIndex(kept);
  return geo;
}

const clothMaterials = new Map<number, THREE.MeshStandardMaterial>();
function clothMaterial(color: number): THREE.MeshStandardMaterial {
  let m = clothMaterials.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0 });
    clothMaterials.set(color, m);
  }
  return m;
}

// --- Rigid props, sized in world units and counter-scaled onto bones -------

function kasaHat(): THREE.Group {
  const g = new THREE.Group();
  const hat = lathe(
    [
      [0.19, 0.0],
      [0.12, 0.05],
      [0.045, 0.1],
      [0.0, 0.11],
    ],
    0xc9a86a,
    12,
  );
  g.add(hat);
  return g;
}

function topknotHair(): THREE.Group {
  const g = new THREE.Group();
  const knot = mesh(new THREE.SphereGeometry(0.035, 6, 5), 0x241a12);
  knot.scale.y = 1.4;
  knot.position.y = 0.03;
  g.add(knot);
  return g;
}

function headbandProp(color: number): THREE.Group {
  const g = new THREE.Group();
  const band = mesh(new THREE.TorusGeometry(0.088, 0.014, 5, 12), color);
  band.rotation.x = Math.PI / 2;
  band.rotation.z = 0.06; // a touch of rake so it reads as tied cloth
  g.add(band);
  return g;
}

function armorPlates(robe: number): THREE.Group {
  const g = new THREE.Group();
  const dark = new THREE.Color(robe).multiplyScalar(0.7).getHex();
  // Lacquered dō: two stacked breast bands.
  for (const [y, r] of [
    [0.02, 0.155],
    [0.09, 0.15],
  ] as const) {
    const band = mesh(new THREE.CylinderGeometry(r, r * 1.04, 0.07, 10), dark);
    band.scale.z = 0.78;
    band.position.y = y;
    g.add(band);
  }
  // Sode shoulder guards.
  for (const side of [-1, 1] as const) {
    const sode = lathe(
      [
        [0.085, -0.05],
        [0.075, 0.0],
        [0.045, 0.04],
      ],
      dark,
      8,
    );
    sode.position.set(side * 0.17, 0.13, 0);
    sode.rotation.z = side * -0.5;
    g.add(sode);
  }
  return g;
}

/**
 * Load the character + animation library once. Returns null (and the
 * renderer falls back to procedural people) if the assets can't load.
 */
export async function loadCharacterAssets(): Promise<boolean> {
  try {
    const loader = new GLTFLoader();
    const [charGltf, animGltf] = await Promise.all([
      loader.loadAsync(CHARACTER_URL),
      loader.loadAsync(ANIMATIONS_URL),
    ]);

    const base = charGltf.scene;
    // Comic-book shading: drop the heavy normal/roughness maps, matte finish.
    base.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.SkinnedMesh) {
        o.castShadow = true;
        const m = o.material as THREE.MeshStandardMaterial;
        if (m && m.isMeshStandardMaterial) {
          m.normalMap = null;
          m.roughnessMap = null;
          m.roughness = 0.95;
          m.metalness = 0;
          m.needsUpdate = true;
        }
      }
    });

    // The body is the biggest skinned mesh; cut the clothing shells from it.
    let body: THREE.SkinnedMesh | null = null;
    base.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) {
        const count = o.geometry.getAttribute('position').count;
        if (!body || count > body.geometry.getAttribute('position').count) body = o;
      }
    });
    if (!body) return false;
    const bodyMesh: THREE.SkinnedMesh = body;

    // Hide the default hairstyle: our kinds bring topknots, kasa, headbands.
    base.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.SkinnedMesh) {
        const m = o.material as THREE.Material;
        if (m?.name?.toLowerCase().includes('hair')) o.visible = false;
      }
    });

    const robeGeo = shellGeometry(bodyMesh, ROBE_BONES, 0.02);
    const sashGeo = shellGeometry(bodyMesh, SASH_BONES, 0.032);
    const robeShell = new THREE.SkinnedMesh(robeGeo, clothMaterial(0xffffff));
    robeShell.name = 'robeShell';
    const sashShell = new THREE.SkinnedMesh(sashGeo, clothMaterial(0xffffff));
    sashShell.name = 'sashShell';
    for (const shell of [robeShell, sashShell]) {
      shell.castShadow = true;
      shell.bind(bodyMesh.skeleton, bodyMesh.bindMatrix);
      bodyMesh.parent!.add(shell);
    }

    // Normalize: feet on y=0, TARGET_HEIGHT tall.
    const bbox = new THREE.Box3().setFromObject(base);
    const height = bbox.max.y - bbox.min.y;
    const clips = new Map<AnimKey, THREE.AnimationClip>();
    for (const key of Object.keys(CLIP_NAMES) as AnimKey[]) {
      const clip = THREE.AnimationClip.findByName(animGltf.animations, CLIP_NAMES[key]);
      if (clip) clips.set(key, clip);
    }
    if (clips.size === 0) return false;

    assets = { base, clips, scale: TARGET_HEIGHT / height, footY: -bbox.min.y };
    return true;
  } catch (err) {
    console.warn('[characters] falling back to procedural people:', err);
    return false;
  }
}

export function charactersReady(): boolean {
  return assets !== null;
}

function attachToBone(
  root: THREE.Object3D,
  boneName: string,
  prop: THREE.Group,
  scale: number,
  offset: [number, number, number],
  rotation?: [number, number, number],
): void {
  const bone = root.getObjectByName(boneName);
  if (!bone) return;
  const holder = new THREE.Group();
  // Props are authored in world units; bones live in model units.
  holder.scale.setScalar(1 / scale);
  holder.position.set(...offset);
  if (rotation) holder.rotation.set(...rotation);
  holder.add(prop);
  bone.add(holder);
}

/**
 * A dressed, animated character for one unit. Returns null until assets
 * are loaded (callers fall back to the procedural person).
 */
export function makeCharacter(
  kindCode: number,
): { group: THREE.Group; visual: CharacterVisual } | null {
  if (!assets) return null;
  const wardrobe = WARDROBES.get(kindCode) ?? WARDROBES.get(1)!;
  const root = skeletonClone(assets.base);

  // Tint the clothing shells for this kind.
  root.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) {
      if (o.name === 'robeShell') o.material = clothMaterial(wardrobe.robe);
      if (o.name === 'sashShell') o.material = clothMaterial(wardrobe.sash);
    }
  });

  const s = assets.scale * (wardrobe.scale ?? 1);

  // Rigid props on bones. Offsets are in model units (bone space).
  if (wardrobe.tool) {
    const hand = new THREE.Group();
    wardrobe.tool(hand);
    attachToBone(root, 'hand_r', hand, s, [0, 0.05, 0.02]);
  }
  if (wardrobe.kasa) attachToBone(root, 'Head', kasaHat(), s, [0, 0.14, 0]);
  if (wardrobe.topknot) attachToBone(root, 'Head', topknotHair(), s, [0, 0.15, -0.02]);
  if (wardrobe.headband) {
    attachToBone(root, 'Head', headbandProp(wardrobe.headband), s, [0, 0.035, 0]);
  }
  if (wardrobe.armored) attachToBone(root, 'spine_03', armorPlates(wardrobe.robe), s, [0, 0, 0]);
  if (wardrobe.back) {
    const back = new THREE.Group();
    wardrobe.back(back);
    back.position.y = -0.3; // quiver builder targets a torso group's chest
    attachToBone(root, 'spine_03', back, s, [0, 0, 0]);
  }

  const inner = new THREE.Group();
  inner.position.y = assets.footY * s;
  inner.scale.setScalar(s);
  inner.add(root);
  const group = new THREE.Group();
  group.add(inner);

  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<AnimKey, THREE.AnimationAction>();
  for (const [key, clip] of assets.clips) {
    const action = mixer.clipAction(clip);
    if (key === 'attack' || key === 'shoot' || key === 'work') {
      action.setLoop(THREE.LoopRepeat, Infinity);
    }
    actions.set(key, action);
  }

  return {
    group,
    visual: {
      mixer,
      actions,
      current: null,
      jog: wardrobe.jog ?? false,
      ranged: wardrobe.ranged ?? false,
    },
  };
}

/** Crossfade to the clip for this key; no-op when already playing it. */
export function playAnimation(visual: CharacterVisual, key: AnimKey, offset: number): void {
  if (visual.current === key) return;
  const next = visual.actions.get(key) ?? visual.actions.get('idle');
  if (!next) return;
  const prev = visual.current ? visual.actions.get(visual.current) : undefined;
  next.reset();
  // Desync the crowd: start loops at a per-unit offset.
  next.time = offset * next.getClip().duration;
  next.play();
  if (prev && prev !== next) prev.crossFadeTo(next, 0.16, false);
  visual.current = key;
}
