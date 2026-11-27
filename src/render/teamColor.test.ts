import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {splitTeamColorGroups} from './assets';
import {makeMonument} from './procBuildings';

/**
 * Every built building gets its team-colour slot split into a draw group of
 * its own, which makeGlbBuilding then paints in the owner's colour. A mesh
 * the split misses keeps the atlas's stock swatch, and the atlas is the
 * green pack's — so a miss reads as "this belongs to the green seat".
 */
describe('splitTeamColorGroups', () => {
  /** The meshes that came out with a second material slot to paint. */
  const teamMeshes = (root: THREE.Object3D): THREE.Mesh[] => {
    const out: THREE.Mesh[] = [];
    root.traverse(o => {
      if (o instanceof THREE.Mesh && Array.isArray(o.material)) out.push(o);
    });
    return out;
  };

  it("splits the monument's blazon, which is an unindexed extrusion", () => {
    // The shield on the die is the monument's only team-coloured part, and
    // ExtrudeGeometry carries no index. It used to be skipped outright, so
    // every seat's monument flew a green shield.
    const monument = makeMonument(new THREE.MeshBasicMaterial(), null);
    splitTeamColorGroups(monument);
    const painted = teamMeshes(monument);
    expect(painted).toHaveLength(1);
    const geo = painted[0]!.geometry as THREE.BufferGeometry;
    expect(geo.getAttribute('position')).toBeDefined();
    // Every triangle of the shield lies in the slot, so the whole of it is
    // the team group and nothing is left in the plain one.
    const [plain, team] = geo.groups;
    expect(plain!.count).toBe(0);
    expect(team!.count).toBe(geo.getAttribute('position').count);
  });

  it('leaves a mesh with nothing in the slot alone', () => {
    const geo = new THREE.BoxGeometry().toNonIndexed();
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.05, 0.05);
    const material = new THREE.MeshBasicMaterial();
    const root = new THREE.Group().add(new THREE.Mesh(geo, material));
    splitTeamColorGroups(root);
    expect(teamMeshes(root)).toEqual([]);
  });
});
