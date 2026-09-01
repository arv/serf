import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import {disposeOwnedSubtree} from './disposal';

// The GLB packs are the assets this helper exists to *not* free. Nothing
// loaded means nothing shared, which is the case that frees the most.
vi.mock('./assets', () => ({
  glbTrees: () => null,
  glbRocks: () => null,
  glbDoodads: () => null,
  glbForest: () => null,
}));

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

  it('takes the subtree off its parent', () => {
    const parent = new THREE.Group();
    const root = new THREE.Group();
    parent.add(root);
    disposeOwnedSubtree(root);
    expect(root.parent).toBeNull();
  });
});
