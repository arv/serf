import { galleryMarkup } from './cards';
import { mountGallery } from './viewer';

/**
 * The lab as a dev page: `pnpm dev`, then /tools/modelLab/. Same cards and
 * same compositions the published gallery shows, served straight off the
 * checkout so a tweak to variants.ts is one reload away.
 */
// ?only=<variant-id> pulls one composition up to full width — how you look
// at a single candidate closely, and how the screenshot script frames one.
const only = new URLSearchParams(location.search).get('only');
if (only) document.documentElement.classList.add('solo');

document.querySelector('#app')!.innerHTML = `
  <header class="page-head">
    <h1>The food chain</h1>
    <p>Candidate looks for mill, bakery and fishery, built from the
       KayKit Medieval Hexagon pack plus the smallest number of hand-built parts
       each one can get away with.</p>
  </header>
  ${galleryMarkup()}`;

if (only) {
  for (const el of document.querySelectorAll<HTMLElement>('[data-variant]')) {
    if (el.dataset.variant !== only) el.remove();
  }
  for (const s of document.querySelectorAll<HTMLElement>('.slot')) {
    if (!s.querySelector('[data-variant]')) s.remove();
  }
}

void mountGallery();
