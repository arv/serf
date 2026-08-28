import * as THREE from 'three';
import { WATER_LEVEL, type MapView } from '../sim/map';
import { water, waterDeep, waterShore } from './palette';

/**
 * The water surface: one plane at the waterline, shaded against the terrain
 * beneath it. The bed heightfield rides along as a texture, so every pixel
 * knows how deep the water under it is — which is what makes it read as
 * water rather than a colored sheet: clear shallows over the shelf grading
 * into opaque depths.
 *
 * The motion is value noise drifting in two directions, not a product of
 * sines: sines beat against each other into a criss-cross grid that reads
 * as wallpaper the moment you look at a whole lake. (KayKit ships no
 * animated water — its 100-odd water assets are static hex tiles — so this
 * is ours to write.) Injected into a stock Lambert material via
 * onBeforeCompile, so it keeps lighting, shadows, fog, and tone mapping.
 */
export class WaterMesh {
  readonly mesh: THREE.Mesh;
  #time = { value: 0 };
  #bed: THREE.DataTexture;

  constructor(map: MapView) {
    const size = map.size;
    // Half a grid of slack past the grid itself: the camera is bounded to
    // the play square and barely frames past the grid edge, and the fog
    // band (renderer.ts) hazes the distance long before the plane's rim.
    const geometry = new THREE.PlaneGeometry(size * 2, size * 2, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(size / 2, WATER_LEVEL, size / 2);

    // Bed elevations as a single-channel float texture. Nearest sampling on
    // purpose: the shader does its own bilinear so it matches HeightField
    // (samples at tile centers) and never depends on float-filtering support.
    const bed = new THREE.DataTexture(map.height, size, size, THREE.RedFormat, THREE.FloatType);
    bed.magFilter = THREE.NearestFilter;
    bed.minFilter = THREE.NearestFilter;
    bed.wrapS = THREE.ClampToEdgeWrapping;
    bed.wrapT = THREE.ClampToEdgeWrapping;
    bed.needsUpdate = true;
    this.#bed = bed;

    // Alpha comes from the shader (shallow water is far clearer than deep),
    // so the material's own opacity stays out of the way. No depth write:
    // the terrain below is already drawn, and mist composites over the top
    // without sorting fights.
    const material = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.#time;
      shader.uniforms.uBed = { value: bed };
      shader.uniforms.uMapSize = { value: size };
      shader.uniforms.uWaterLevel = { value: WATER_LEVEL };
      shader.uniforms.uShallow = { value: new THREE.Color(waterShore) };
      shader.uniforms.uMid = { value: new THREE.Color(water) };
      shader.uniforms.uDeep = { value: new THREE.Color(waterDeep) };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
          uniform float uTime;
          uniform sampler2D uBed;
          uniform float uMapSize;
          uniform float uWaterLevel;
          uniform vec3 uShallow;
          uniform vec3 uMid;
          uniform vec3 uDeep;
          varying vec3 vWorldPos;

          float bedTexel(vec2 tile) {
            vec2 c = clamp(tile, vec2(0.0), vec2(uMapSize - 1.0));
            return texture2D(uBed, (c + 0.5) / uMapSize).r;
          }

          // Bilinear over tile centers — the same sampling the CPU-side
          // HeightField uses, so the surface agrees with the ground mesh.
          float bedHeight(vec2 w) {
            vec2 t = w - 0.5;
            vec2 f = floor(t);
            vec2 s = t - f;
            float a = bedTexel(f);
            float b = bedTexel(f + vec2(1.0, 0.0));
            float c = bedTexel(f + vec2(0.0, 1.0));
            float d = bedTexel(f + vec2(1.0, 1.0));
            return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
          }

          // Past the grid the bed slides to open-sea depth on its own:
          // the outermost row is not guaranteed wet (a ridge margin runs
          // rock to the last tile), and clamping a rock row outward would
          // dry up the horizon. Where the margin mesh stands above the
          // waterline it occludes this surface; where it dips, open water
          // shows.
          float bedAt(vec2 w) {
            vec2 ov = max(max(-w, w - uMapSize), vec2(0.0));
            return mix(bedHeight(w), -1.6, smoothstep(0.0, 5.0, length(ov)));
          }

          float hash21(vec2 p) {
            p = fract(p * vec2(123.34, 456.21));
            p += dot(p, p + 45.32);
            return fract(p.x * p.y);
          }

          float vnoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float a = hash21(i);
            float b = hash21(i + vec2(1.0, 0.0));
            float c = hash21(i + vec2(0.0, 1.0));
            float d = hash21(i + vec2(1.0, 1.0));
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
          }

          // Two octaves drifting on different headings, so the pattern
          // never lines up with itself.
          float ripple(vec2 p, float t) {
            float n = vnoise(p * 0.5 + vec2(t * 0.05, t * 0.033));
            n += 0.5 * vnoise(p * 1.25 - vec2(t * 0.041, t * 0.067));
            return n / 1.5;
          }`,
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
          {
            vec2 p = vWorldPos.xz;
            float depth = uWaterLevel - bedAt(p);
            // Land: the terrain already occludes us, but bail rather than
            // shade a surface that is not there.
            if (depth <= 0.0) discard;
            // Normalized over the bed's actual shelving range (see the
            // lake beds in worldgen), so the whole gradient gets used.
            float d01 = clamp((depth - 0.06) / 1.15, 0.0, 1.0);

            // Shallows glow, deeps go dark and saturated.
            vec3 col = mix(uShallow, uMid, smoothstep(0.0, 0.3, d01));
            col = mix(col, uDeep, smoothstep(0.28, 0.85, d01));

            // Soft drifting light and shade, the way sun sits on open water.
            float r = ripple(p, uTime);
            col *= 1.0 + (r - 0.5) * 0.18;

            diffuseColor.rgb = col;
            // No surf line: a bright rim traced around every lake reads as
            // an outline, not as water. The shore dissolves instead —
            // nearly clear where it laps the bank, opaque over the deeps.
            diffuseColor.a = mix(0.24, 0.88, d01);
          }`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `#include <emissivemap_fragment>
          {
            vec2 p = vWorldPos.xz;
            float depth = uWaterLevel - bedAt(p);
            float d01 = clamp((depth - 0.06) / 1.15, 0.0, 1.0);
            // Shimmer: a faster, finer field clipped near its peaks, so
            // only the crests catch the light. Fades out in the shallows,
            // where the bed shows through instead.
            float g = vnoise(p * 5.2 + vec2(uTime * 0.15, -uTime * 0.11));
            float shimmer = smoothstep(0.82, 0.99, g) * smoothstep(0.12, 0.45, d01);
            totalEmissiveRadiance += vec3(0.62, 0.82, 0.86) * shimmer * 0.11;
          }`,
        );
    };

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.receiveShadow = true;
  }

  update(nowMs: number): void {
    this.#time.value = nowMs / 1000;
  }

  /**
   * The bed texture wraps map.height itself — after the editor sculpts,
   * one re-upload is all the water needs to shade the new depths.
   */
  refreshBed(): void {
    this.#bed.needsUpdate = true;
  }

  /** Editor only: free this mesh inside a live context (the game drops the
   * whole context instead). The bed texture is ours; nothing is shared. */
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.#bed.dispose();
  }
}
