import * as THREE from 'three';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';

const {loadAsync} = vi.hoisted(() => ({loadAsync: vi.fn()}));
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    loadAsync = loadAsync;
  },
}));

function model() {
  const scene = new THREE.Group();
  scene.add(
    new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()),
  );
  return {scene};
}

beforeEach(() => {
  vi.resetModules();
  loadAsync.mockReset().mockImplementation(async () => model());
});

describe('menu asset loading', () => {
  it('loads only the castle and scenery, then upgrades without replacing shared geometry', async () => {
    const assets = await import('./assets');
    await assets.loadMenuAssets();
    const menuFiles = loadAsync.mock.calls.map(([url]) => url as string);
    expect(menuFiles).toContain('/models/kaykit/building_castle_green.gltf');
    expect(menuFiles.filter(url => url.includes('/building_'))).toHaveLength(1);
    expect(menuFiles.some(url => url.includes('weapons/'))).toBe(false);
    expect(assets.makeGlbBuilding(BuildingTypeId.storehouse)).not.toBeNull();
    expect(assets.makeGlbBuilding(BuildingTypeId.house)).toBeNull();
    const trees = assets.glbTrees()!;
    const castle = assets.makeGlbBuilding(BuildingTypeId.storehouse)!;
    const geometries = (root: THREE.Object3D) => {
      const result: THREE.BufferGeometry[] = [];
      root.traverse(o => {
        if (o instanceof THREE.Mesh) result.push(o.geometry);
      });
      return result;
    };
    const castleGeometry = geometries(castle);
    await assets.loadGlbAssets();
    expect(assets.makeGlbBuilding(BuildingTypeId.house)).not.toBeNull();
    expect(assets.makeGlbBuilding(BuildingTypeId.bakery)).not.toBeNull();
    expect(assets.glbTrees()!.geometries).toBe(trees.geometries);
    expect(assets.glbTrees()!.material).toBe(trees.material);
    geometries(assets.makeGlbBuilding(BuildingTypeId.storehouse)!).forEach(
      (geo, i) => {
        expect(geo).toBe(castleGeometry[i]);
      },
    );
    for (const file of menuFiles) {
      expect(loadAsync.mock.calls.filter(([url]) => url === file)).toHaveLength(
        1,
      );
    }
    const count = loadAsync.mock.calls.length;
    await Promise.all([assets.loadMenuAssets(), assets.loadGlbAssets()]);
    expect(loadAsync).toHaveBeenCalledTimes(count);
  });

  it('serializes a full-pack request made while the menu batch is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    loadAsync.mockImplementation(async () => {
      await gate;
      return model();
    });
    const assets = await import('./assets');
    const menu = assets.loadMenuAssets();
    const full = assets.loadGlbAssets();
    expect(assets.loadMenuAssets()).toBe(full);
    expect(
      loadAsync.mock.calls.some(([url]) =>
        String(url).includes('building_home'),
      ),
    ).toBe(false);
    release();
    await Promise.all([menu, full]);
    expect(assets.makeGlbBuilding(BuildingTypeId.house)).not.toBeNull();
    expect(
      loadAsync.mock.calls.filter(([url]) =>
        String(url).includes('building_castle'),
      ),
    ).toHaveLength(1);
  });

  it('keeps the ready menu usable when a game-only model fails during an upgrade', async () => {
    vi.useFakeTimers();
    try {
      const assets = await import('./assets');
      await assets.loadMenuAssets();
      loadAsync.mockImplementation(async (url: string) => {
        if (url.endsWith('building_home_A_green.gltf'))
          throw new Error('offline');
        return model();
      });
      const full = assets.loadGlbAssets();
      const failed = expect(full).rejects.toThrow('asset failed');
      // Navigate back before the upgrade has settled. Its failure must not
      // take down a menu whose castle and scenery are already available.
      const menu = assets.loadMenuAssets().then(
        () => 'ready',
        () => 'failed',
      );
      await vi.runAllTimersAsync();
      await failed;
      expect(await menu).toBe('ready');
      expect(assets.makeGlbBuilding(BuildingTypeId.storehouse)).not.toBeNull();
      // The failed upgrade remains retryable after the menu has returned.
      loadAsync.mockImplementation(async () => model());
      await assets.loadGlbAssets();
      expect(assets.makeGlbBuilding(BuildingTypeId.house)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the full pack when a match loaded first', async () => {
    const assets = await import('./assets');
    const full = assets.loadGlbAssets();
    expect(assets.loadMenuAssets()).toBe(full);
    await full;
    const count = loadAsync.mock.calls.length;
    await assets.loadMenuAssets();
    expect(loadAsync).toHaveBeenCalledTimes(count);
    expect(assets.makeGlbBuilding(BuildingTypeId.house)).not.toBeNull();
  });

  it('retries a failed menu batch without refetching its successful models', async () => {
    vi.useFakeTimers();
    try {
      loadAsync.mockImplementation(async (url: string) => {
        if (url.endsWith('building_castle_green.gltf'))
          throw new Error('offline');
        return model();
      });
      const assets = await import('./assets');
      const failed = expect(assets.loadMenuAssets()).rejects.toThrow(
        'asset failed',
      );
      await vi.runAllTimersAsync();
      await failed;
      const treeLoads = loadAsync.mock.calls.filter(([url]) =>
        String(url).endsWith('tree_single_A.gltf'),
      ).length;
      loadAsync.mockImplementation(async () => model());
      await assets.loadMenuAssets();
      expect(assets.makeGlbBuilding(BuildingTypeId.storehouse)).not.toBeNull();
      expect(
        loadAsync.mock.calls.filter(([url]) =>
          String(url).endsWith('tree_single_A.gltf'),
        ),
      ).toHaveLength(treeLoads);
    } finally {
      vi.useRealTimers();
    }
  });
});
