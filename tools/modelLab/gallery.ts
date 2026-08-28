import {galleryMarkup} from './cards';
import type {BakedSet} from './kit';
import {mountGallery} from './viewer';

/**
 * Entry point for the published gallery. Every model arrives as plain
 * arrays inside the page, so this build issues no network requests of any
 * kind — an Artifact's CSP blocks fetch and XHR outright, data: URIs
 * included, which is what an earlier version of this page ran into.
 */

const raw = document.getElementById('lab-models')?.textContent ?? '{}';

const mount = document.querySelector('#gallery');
if (mount) mount.innerHTML = galleryMarkup();

void mountGallery({
  baked: JSON.parse(raw) as BakedSet,
  onReady: () => document.documentElement.classList.add('lab-ready'),
});
