import * as THREE from 'three';
import {glbDoodads, glbForest, glbRocks, glbTrees} from './assets';

/**
 * Free the GPU resources of a scatter-style subtree without touching the
 * shared GLB assets.
 *
 * The game never needs this: a match ends by dropping the whole WebGL
 * context (see GameRenderer.dispose), which reclaims every buffer at
 * once. The map editor is the exception — it rebuilds ScatterMesh,
 * GrassField and EdgeSkirt inside a live context whenever a stroke
 * changes what stands on the ground, and each rebuild would otherwise
 * leak the previous instance buffers and procedural geometry.
 *
 * The one footgun this helper exists to avoid: tree and rock species from
 * the GLB pack (assets.ts) are module-cached and shared by every scatter
 * instance, building yard, and skirt on the page. Disposing them would
 * break the next mesh built from them, so they are skipped by identity.
 * Everything else in these subtrees — procedural geometry, materials and
 * their canvas textures — is per-instance and freed here.
 */
export function disposeOwnedSubtree(root: THREE.Object3D): void {
  const shared = new Set<object>();
  const trees = glbTrees();
  if (trees) {
    for (const g of trees.geometries) shared.add(g);
    shared.add(trees.material);
  }
  const rocks = glbRocks();
  if (rocks) {
    for (const g of rocks.geometries) shared.add(g);
    shared.add(rocks.material);
  }
  const doodads = glbDoodads();
  if (doodads) {
    shared.add(doodads.lily);
    shared.add(doodads.reed);
    shared.add(doodads.material);
  }
  const forest = glbForest();
  if (forest) {
    for (const g of forest.bushes) shared.add(g);
    for (const g of forest.deadTrees) shared.add(g);
    shared.add(forest.material);
  }

  // What has already been freed. A subtree is a group of meshes now
  // rather than the one mesh it used to be — the ground is chunked, and so
  // is the scatter — and every chunk of a given kind carries the same
  // material and the same canvas texture. Disposing those once per chunk
  // is idempotent but pointless, and the count grows with the square of
  // the map's width, so they are freed once by identity. Geometries are
  // not deduplicated away by this: each chunk has one of its own, holding
  // its own index buffer, and each of them does need freeing.
  const freed = new Set<object>();
  const free = (thing: {dispose(): void}): void => {
    if (shared.has(thing) || freed.has(thing)) return;
    freed.add(thing);
    thing.dispose();
  };

  root.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o instanceof THREE.InstancedMesh) o.dispose(); // instance attributes
    free(o.geometry);
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      const map = (m as THREE.MeshLambertMaterial).map;
      if (map) free(map);
      free(m);
    }
  });
  root.removeFromParent();
}
