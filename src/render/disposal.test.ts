import * as THREE from 'three';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {disposeOwnedSubtree} from './disposal';

// The GLB packs are the assets this helper exists to *not* free. Which of
// them is loaded is per-test: nothing loaded is the case that frees the
// most, and a loaded pack is the case that must free the least.
const packs = vi.hoisted(() => ({
  trees: null as {
    geometries: THREE.BufferGeometry[];
    material: THREE.Material;
  } | null,
}));
vi.mock('./assets', () => ({
  glbTrees: () => packs.trees,
  glbRocks: () => null,
  glbDoodads: () => null,
  glbForest: () => null,
}));

beforeEach(() => {
  packs.trees = null;
});

/**
 * The subtrees this frees stopped being one mesh apiece: the ground is cut
 * into chunks and so is the scatter, and every chunk of a kind carries the
 * same material and the same canvas texture. Freeing those once per chunk
 * is harmless but pointless, and the chunk count grows with the square of
 * the map's width.
 */
describe('disposeOwnedSubtree', () => {
  it('frees a shared material and texture once, whatever the chunk count', () => {
    const map = new THREE.Texture();
    const material = new THREE.MeshLambertMaterial({map});
    const mapSpy = vi.spyOn(map, 'dispose');
    const materialSpy = vi.spyOn(material, 'dispose');

    const root = new THREE.Group();
    const geometries = Array.from({length: 12}, () => {
      const geo = new THREE.BufferGeometry();
      root.add(new THREE.Mesh(geo, material));
      return geo;
    });
    const geoSpies = geometries.map(g => vi.spyOn(g, 'dispose'));

    disposeOwnedSubtree(root);

    expect(materialSpy).toHaveBeenCalledTimes(1);
    expect(mapSpy).toHaveBeenCalledTimes(1);
    // Each chunk still holds an index buffer of its own, so every geometry
    // is freed — the deduplication is by identity, not by kind.
    for (const spy of geoSpies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('leaves a loaded pack\u2019s material and its texture alone', () => {
    // The regression this exists for: `shared` holds the pack's material
    // but not the palette texture hanging off it, so a disposer that
    // reaches past the material to its map frees a texture every later
    // mesh built from that material still needs — trees and rocks losing
    // their paint on the editor's second stroke.
    const map = new THREE.Texture();
    const material = new THREE.MeshLambertMaterial({map});
    const geometry = new THREE.BufferGeometry();
    packs.trees = {geometries: [geometry], material};
    const mapSpy = vi.spyOn(map, 'dispose');
    const materialSpy = vi.spyOn(material, 'dispose');
    const geoSpy = vi.spyOn(geometry, 'dispose');

    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, material));
    disposeOwnedSubtree(root);

    expect(materialSpy).not.toHaveBeenCalled();
    expect(mapSpy).not.toHaveBeenCalled();
    expect(geoSpy).not.toHaveBeenCalled();
  });

  it('takes the subtree off its parent', () => {
    const parent = new THREE.Group();
    const root = new THREE.Group();
    parent.add(root);
    disposeOwnedSubtree(root);
    expect(root.parent).toBeNull();
  });
});
