import { Kit } from './kit';
import { requiredFiles } from './variants';

/**
 * The bake page: load every model the compositions use, flatten each to
 * vertex-colored arrays, and hand the result to bake.mjs through the page.
 * It runs in a browser because that is where GLTFLoader and a canvas to
 * sample the atlas with both live.
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
  window.__BAKED = JSON.stringify(K.bake());
  status.textContent = `baked ${requiredFiles().length} models`;
} catch (err) {
  window.__BAKE_ERROR = String(err);
  status.textContent = `failed: ${String(err)}`;
}
