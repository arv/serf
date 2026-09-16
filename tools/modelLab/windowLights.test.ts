import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {EXTRA_VOIDS, TRAINS} from '../../src/render/assets';
import {makeWindowGlows} from '../../src/render/procTraining';
import * as BuildingTypeId from '../../src/sim/defs/buildingTypeIdEnum.ts';

/**
 * The window finder, run over the REAL pack models.
 *
 * Every other test of the finder (src/render/procTraining.test.ts) hands it
 * a synthetic plane with one UV on it, which pins the rules but proves
 * nothing about the three buildings that actually ship: an atlas change, a model swap, or a
 * re-export of the same model with its triangles welded differently could
 * take every light in the game out while all of those stayed green. The
 * counts below are the ones the feature was measured and tuned against, so
 * this is the test that notices.
 *
 * It parses the glTF itself rather than going through GLTFLoader, which
 * wants a DOM and a fetch. That is a dozen lines here and it keeps the
 * fixture honest — the bytes on disk are what the game loads. Reading them
 * is also why this lives in the lab rather than beside the code it tests:
 * `src` is typechecked as the browser half and has no node types (see the
 * root tsconfig), and this dir is where the pack models are already looked
 * at.
 */

// fileURLToPath, not `.pathname`: on Windows the latter keeps the slash in
// front of the drive letter and leaves percent-escapes encoded, so the
// fixture would simply not find the models. The .mjs scripts beside this
// one do the same.
const MODELS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../public/models/kaykit',
);

/** glTF component types, as byte widths and the DataView reader for each. */
const COMPONENTS = {
  5123: {bytes: 2, read: (v: DataView, o: number) => v.getUint16(o, true)},
  5125: {bytes: 4, read: (v: DataView, o: number) => v.getUint32(o, true)},
  5126: {bytes: 4, read: (v: DataView, o: number) => v.getFloat32(o, true)},
} as const;

const COMPONENTS_PER = {SCALAR: 1, VEC2: 2, VEC3: 3} as const;

interface Gltf {
  accessors: {
    bufferView: number;
    byteOffset?: number;
    componentType: keyof typeof COMPONENTS;
    count: number;
    type: keyof typeof COMPONENTS_PER;
  }[];
  bufferViews: {buffer: number; byteOffset?: number; byteStride?: number}[];
  buffers: {uri: string}[];
  meshes: {
    primitives: {attributes: Record<string, number>; indices: number}[];
  }[];
}

/** One accessor, flattened. */
function readAccessor(
  gltf: Gltf,
  bin: Map<string, Buffer>,
  index: number,
): number[] {
  const acc = gltf.accessors[index]!;
  const view = gltf.bufferViews[acc.bufferView]!;
  const buf = bin.get(gltf.buffers[view.buffer]!.uri)!;
  const {bytes, read} = COMPONENTS[acc.componentType];
  const n = COMPONENTS_PER[acc.type];
  const stride = view.byteStride ?? bytes * n;
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const data = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: number[] = [];
  for (let i = 0; i < acc.count; i++) {
    for (let k = 0; k < n; k++)
      out.push(read(data, base + i * stride + k * bytes));
  }
  return out;
}

/** The pack model as one mesh, positions, normals, UVs and all. */
function packModel(file: string): THREE.Mesh {
  const gltf = JSON.parse(readFileSync(join(MODELS, file), 'utf8')) as Gltf;
  const bin = new Map<string, Buffer>();
  for (const b of gltf.buffers)
    bin.set(b.uri, readFileSync(join(MODELS, b.uri)));
  // These are single-mesh, single-primitive exports; the finder walks
  // whatever it is given, but a model that grew a second primitive would
  // quietly halve these counts, so say so here.
  expect(gltf.meshes.length).toBe(1);
  expect(gltf.meshes[0]!.primitives.length).toBe(1);
  const prim = gltf.meshes[0]!.primitives[0]!;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      readAccessor(gltf, bin, prim.attributes.POSITION!),
      3,
    ),
  );
  geo.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(
      readAccessor(gltf, bin, prim.attributes.NORMAL!),
      3,
    ),
  );
  geo.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(
      readAccessor(gltf, bin, prim.attributes.TEXCOORD_0!),
      2,
    ),
  );
  geo.setIndex(readAccessor(gltf, bin, prim.indices));
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial());
}

/**
 * What each model gives up, measured. These are the numbers the cue was
 * tuned against and the ones quoted in the PR that added it; a change here
 * is a change to how much of a hall lights up, and wants looking at rather
 * than re-blessing.
 */
const EXPECTED = [
  ['barracks', 'building_barracks_green.gltf', BuildingTypeId.barracks, 13],
  ['castle', 'building_castle_green.gltf', BuildingTypeId.storehouse, 23],
  [
    'archery range',
    'building_archeryrange_green.gltf',
    BuildingTypeId.archeryRange,
    10,
  ],
] as const;

describe('the window finder on the real pack models', () => {
  for (const [name, file, type, count] of EXPECTED) {
    it(`finds ${count} openings on the ${name}`, () => {
      const glows = makeWindowGlows(packModel(file), EXTRA_VOIDS[type])!;
      expect(glows).not.toBeNull();
      const panes = glows.children.filter(o => o.name === 'windowPane');
      const spills = glows.children.filter(o => o.name === 'windowSpill');
      expect(panes.length).toBe(count);
      // One spill per pane, always: the halo is what makes a pane read as
      // light rather than as paint.
      expect(spills.length).toBe(count);
    });
  }

  it('lights the range’s tower band without lighting its straw bales', () => {
    // The range is the model that needs a second atlas cell declared, and
    // (1,6) is worn by its tower's upper windows AND by the sides of the
    // bales down in its shooting lane. Only a height floor separates them
    // (bales at model y 0.222, windows at 1.199), so this is the assertion
    // that the floor is doing its job rather than the count coming out
    // right for the wrong reason.
    const glows = makeWindowGlows(
      packModel('building_archeryrange_green.gltf'),
      EXTRA_VOIDS[BuildingTypeId.archeryRange],
    )!;
    const heights = glows.children
      .filter(o => o.name === 'windowPane')
      .map(o => o.position.y);
    expect(heights.length).toBe(10);
    // Nothing down at bale height...
    expect(Math.min(...heights)).toBeGreaterThan(0.4);
    // ...and the tower's upper band, which is the whole reason (1,6) is
    // declared at all, is in.
    expect(heights.filter(y => y > 1).length).toBe(6);
  });

  it('would light a house too — what limits the cue is TRAINS, not the paint', () => {
    // Worth pinning because it is the opposite of what it looks like: the
    // finder is not what decides which buildings light up. A house backs
    // its windows in the same dark slate and gives up panes just as
    // readily; it stays dark only because assets.ts never asks.
    const house = makeWindowGlows(packModel('building_home_A_green.gltf'));
    expect(house).not.toBeNull();
    expect(
      house!.children.filter(o => o.name === 'windowPane').length,
    ).toBeGreaterThan(0);

    // So the gate itself is the thing worth holding, and it is a gameplay
    // decision rather than a rendering one: a lit hall tells anyone who can
    // see it that you are making soldiers. Adding a building to this table
    // is a choice to give that away, and should not happen by accident.
    const byId = (x: number, y: number): number => x - y;
    expect(Object.keys(TRAINS).map(Number).sort(byId)).toEqual(
      [
        BuildingTypeId.barracks,
        BuildingTypeId.archeryRange,
        BuildingTypeId.storehouse,
      ].sort(byId),
    );
  });
});
