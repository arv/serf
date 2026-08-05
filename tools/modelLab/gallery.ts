import * as THREE from 'three';
import { galleryMarkup } from './cards';
import { mountGallery } from './viewer';

/**
 * Entry point for the published gallery: one self-contained page with every
 * model inlined as a data URI, so it runs off a phone with no network at
 * all. build-gallery.mjs bundles this file and drops the asset map into the
 * page beside it.
 */

const raw = document.getElementById('lab-assets')?.textContent ?? '{}';
const ASSETS = JSON.parse(raw) as Record<string, string>;

const manager = new THREE.LoadingManager();
manager.setURLModifier((url) => {
  // GLTFLoader resolves .bin and texture URIs against the .gltf's path, so
  // everything arrives here as an absolute /models/kaykit/... key.
  const clean = url.split('?')[0]!;
  return ASSETS[clean] ?? url;
});

const mount = document.querySelector('#gallery');
if (mount) mount.innerHTML = galleryMarkup();

void mountGallery({
  manager,
  onReady: () => document.documentElement.classList.add('lab-ready'),
});
