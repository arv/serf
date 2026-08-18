import * as THREE from 'three';
import { glbDoodads, glbRocks, glbTrees } from './assets';

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

  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o instanceof THREE.InstancedMesh) o.dispose(); // instance attributes
    if (!shared.has(o.geometry)) o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (shared.has(m)) continue;
      const map = (m as THREE.MeshLambertMaterial).map;
      if (map && !shared.has(map)) map.dispose();
      m.dispose();
    }
  });
  root.removeFromParent();
}
