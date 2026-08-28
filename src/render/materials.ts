import * as THREE from 'three';

/**
 * Visit every material on a mesh. Faction-colored buildings carry a
 * material *array* (the textured group plus the team-color group), so any
 * code that reads or edits `mesh.material` directly breaks on them — and
 * silently, since the throw usually lands inside a traverse callback.
 * Go through here instead.
 */
export function eachMaterial(
  mesh: THREE.Mesh,
  fn: (m: THREE.Material) => void,
): void {
  if (Array.isArray(mesh.material)) mesh.material.forEach(fn);
  else fn(mesh.material);
}

/** Replace every material on a mesh, preserving the array/single shape. */
export function mapMaterials(
  mesh: THREE.Mesh,
  fn: (m: THREE.Material) => THREE.Material,
): void {
  mesh.material = Array.isArray(mesh.material)
    ? mesh.material.map(fn)
    : fn(mesh.material);
}
