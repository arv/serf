import * as THREE from 'three';
import { WATER_LEVEL, type MapView } from '../sim/map';
import { palette } from './palette';

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

  constructor(map: MapView) {
    const size = map.size;
    // Three times the map on a side: open sea past every shore, matching
    // the edge skirt's reach (skirtExtent), so the two horizons end
    // together — far enough out that a corner camera at full zoom-out
    // meets the fog band (renderer.ts) before either rim.
    const geometry = new THREE.PlaneGeometry(size * 3, size * 3, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(size / 2, WATER_LEVEL, size / 2);

    // Bed elevations as a single-channel float texture. Nearest sampling on
    // purpose: the shader does its own bilinear so it matches HeightField
    // (samples at tile centers) and never depends on float-filtering support.
    const bed = new THREE.DataTexture(
      map.height,
      size,
      size,
      THREE.RedFormat,
      THREE.FloatType,
    );
    bed.magFilter = THREE.NearestFilter;
    bed.minFilter = THREE.NearestFilter;
    bed.wrapS = THREE.ClampToEdgeWrapping;
    bed.wrapT = THREE.ClampToEdgeWrapping;
    bed.needsUpdate = true;

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
      shader.uniforms.uShallow = { value: new THREE.Color(palette.waterShore) };
      shader.uniforms.uMid = { value: new THREE.Color(palette.water) };
      shader.uniforms.uDeep = { value: new THREE.Color(palette.waterDeep) };

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
            float depth = uWaterLevel - bedHeight(p);
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
            float depth = uWaterLevel - bedHeight(p);
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
}
