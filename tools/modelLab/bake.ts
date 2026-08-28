import {loadGlbAssets, makeGlbBuilding} from '../../src/render/assets';
import {BUILDING_KEYS} from '../../src/sim/defs/buildings';
import {Kit} from './kit';
import {requiredFiles, GAME_BUILDINGS} from './variants';

/**
 * The bake page: flatten everything the gallery draws into vertex-colored
 * arrays and hand the result to bake.mjs through the page. It runs in a
 * browser because that is where GLTFLoader and a canvas to sample the atlas
 * with both live.
 *
 * The four food buildings are baked from the *game's* asset pipeline rather
 * than rebuilt here, so the gallery shows exactly what a match shows —
 * surgery, decor, fish sign and all. That is the whole point of it now that
 * the models are chosen: what you iterate on has to be the real thing.
 */

declare global {
  interface Window {
    __BAKED?: string;
    __BAKE_ERROR?: string;
  }
}

const status = document.getElementById('status')!;
const K = new Kit();
try {
  await K.load(requiredFiles());
  await loadGlbAssets();
  for (const b of GAME_BUILDINGS) {
    const g = makeGlbBuilding(b.type, 0);
    if (!g) throw new Error(`no model for ${BUILDING_KEYS[b.type]}`);
    K.absorb(`game/${BUILDING_KEYS[b.type]}`, g);
  }
  window.__BAKED = JSON.stringify(K.bake());
  status.textContent = 'baked';
} catch (err) {
  window.__BAKE_ERROR = String(err);
  status.textContent = `failed: ${String(err)}`;
}
