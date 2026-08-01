import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { TILE_COUNT } from '../shared/grid';
import { HeightField } from './heightField';
import type { BuildingSnap } from '../protocol/messages';

// The KayKit buildings carry material *arrays* on their meshes (the textured
// group plus the team-color group). The real loader needs GLB files, so mock
// the surface this import graph touches and hand update() a synthetic model
// of the same shape.
vi.mock('./assets', () => ({
  glbCarryProp: () => null,
  makeGlbBuilding: () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.clearGroups();
    geo.addGroup(0, 18, 0);
    geo.addGroup(18, 18, 1);
    const mesh = new THREE.Mesh(geo, [
      new THREE.MeshStandardMaterial(),
      new THREE.MeshLambertMaterial(),
    ]);
    const group = new THREE.Group();
    group.add(mesh);
    return group;
  },
}));

const { BuildingSync } = await import('./buildingSync');

function snap(over: Partial<BuildingSnap>): BuildingSnap {
  return {
    id: 7,
    type: 'woodcutter',
    owner: 0,
    x: 10,
    y: 10,
    w: 2,
    h: 2,
    hp: 150,
    maxHp: 150,
    state: 'built',
    stock: {},
    inputs: {},
    inbound: {},
    reservedOut: {},
    ...over,
  };
}

function makeSync(): { sync: InstanceType<typeof BuildingSync>; scene: THREE.Scene } {
  const scene = new THREE.Scene();
  const sync = new BuildingSync(scene, new HeightField(new Float32Array(TILE_COUNT)), 0);
  return { sync, scene };
}

describe('a construction site with multi-material meshes', () => {
  it('survives finishing: the site visual swaps for the built model', () => {
    const { sync, scene } = makeSync();
    sync.update([snap({ state: 'site', progress01: 0.5, siteNeeds: {} })]);
    const siteRoots = scene.children.length;
    expect(siteRoots).toBeGreaterThan(0);

    // The state swap disposes the site's cloned clip materials. Before the
    // fix this threw mid-update ("material.dispose is not a function"),
    // leaving the building invisible and poisoning every later update —
    // from that frame on no visual was ever created or removed again.
    sync.update([snap({ state: 'built' })]);
    expect(scene.children.length).toBe(siteRoots);

    // The next roster still syncs: a razed building's visual leaves.
    sync.update([]);
    expect(scene.children.length).toBe(0);
  });

  it('a poisoned frame does not orphan later buildings', () => {
    const { sync, scene } = makeSync();
    sync.update([snap({ state: 'site', progress01: 0.5, siteNeeds: {} })]);
    // Completion and a brand-new site arrive in the same structural frame;
    // both must come out standing.
    sync.update([
      snap({ state: 'built' }),
      snap({ id: 8, x: 20, y: 20, state: 'site', progress01: 0, siteNeeds: {} }),
    ]);
    expect(scene.children.length).toBe(2);
  });
});
