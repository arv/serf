import * as THREE from 'three';
import { MAP_SIZE } from '../shared/grid';
import { WATER_LEVEL, type MapView } from '../sim/map';
import { palette } from './palette';

/** Unit vector toward the sun, matching the scene's key light. */
const SUN_DIR = new THREE.Vector3(-28, 55, 18).normalize();

/**
 * The water surface: one plane at the waterline, shaded against the terrain
 * beneath it. The bed heightfield rides along as a texture, so every pixel
 * knows how deep the water under it is — which is what makes it read as
 * water rather than a colored sheet: bright translucent shallows grading
 * into opaque depths, a foam line hugging every shore, and a sun glitter
 * that swims across the swell. Injected into a stock Lambert material via
 * onBeforeCompile, so it keeps lighting, shadows, fog, and tone mapping.
 */
export class WaterMesh {
  readonly mesh: THREE.Mesh;
  #time = { value: 0 };

  constructor(map: MapView) {
    const geometry = new THREE.PlaneGeometry(MAP_SIZE + 40, MAP_SIZE + 40, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(MAP_SIZE / 2, WATER_LEVEL, MAP_SIZE / 2);

    // Bed elevations as a single-channel float texture. Nearest sampling on
    // purpose: the shader does its own bilinear so it matches HeightField
    // (samples at tile centers) and never depends on float-filtering support.
    const bed = new THREE.DataTexture(
      map.height,
      MAP_SIZE,
      MAP_SIZE,
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
      shader.uniforms.uMapSize = { value: MAP_SIZE };
      shader.uniforms.uWaterLevel = { value: WATER_LEVEL };
      shader.uniforms.uShallow = { value: new THREE.Color(palette.waterShore) };
      shader.uniforms.uMid = { value: new THREE.Color(palette.water) };
      shader.uniforms.uDeep = { value: new THREE.Color(palette.waterDeep) };
      shader.uniforms.uFoam = { value: new THREE.Color(palette.waterFoam) };
      shader.uniforms.uSunDir = { value: SUN_DIR };

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
          uniform vec3 uFoam;
          uniform vec3 uSunDir;
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

          // Analytic surface normal of the swell + chop wave field: the
          // gradient is exact, so highlights track the crests instead of
          // sliding over them. The slope is deliberately steep — a nearly
          // flat normal never tilts far enough to catch the sun.
          vec3 waveNormal(vec2 p, float t) {
            float s1 = sin(p.x * 0.55 + t * 0.5);
            float c1 = cos(p.x * 0.55 + t * 0.5);
            float s2 = sin(p.y * 0.7 - t * 0.35);
            float c2 = cos(p.y * 0.7 - t * 0.35);
            float s3 = cos((p.x + p.y) * 0.4 + t * 0.3);
            float dx = 0.55 * c1 * s2 + 0.24 * s3;
            float dz = 0.7 * s1 * c2 + 0.24 * s3;
            // Choppier ripples riding the swell add the fine glitter.
            float u = p.x * 2.1 + p.y * 1.3 + t * 1.1;
            float v = p.y * 2.7 - p.x * 0.9 - t * 0.8;
            dx += (2.1 * cos(u) * sin(v) - 0.9 * sin(u) * cos(v)) * 0.14;
            dz += (1.3 * cos(u) * sin(v) + 2.7 * sin(u) * cos(v)) * 0.14;
            return normalize(vec3(-dx * 0.55, 1.0, -dz * 0.55));
          }`,
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
          {
            vec2 p = vWorldPos.xz;
            float depth = uWaterLevel - bedHeight(p);
            // Land: the terrain already occludes us, but bail before
            // painting foam up the hillside.
            if (depth <= 0.0) discard;
            // Normalized over the bed's actual shelving range (see the
            // lake beds in worldgen), so the whole gradient gets used.
            float d01 = clamp((depth - 0.06) / 1.15, 0.0, 1.0);

            // Shallows glow, deeps go dark and saturated.
            vec3 col = mix(uShallow, uMid, smoothstep(0.0, 0.3, d01));
            col = mix(col, uDeep, smoothstep(0.28, 0.85, d01));

            // Broad brightness banding from the swell keeps the flat plane
            // from looking like a decal.
            float swell = sin(p.x * 0.55 + uTime * 0.5) * sin(p.y * 0.7 - uTime * 0.35)
                        + sin((p.x + p.y) * 0.4 + uTime * 0.3);
            swell *= 0.5;
            col *= 1.0 + swell * 0.06;

            // Surf. Distance to the shoreline in PIXELS, not world units:
            // depth divided by its own screen-space gradient. Bed slope
            // varies wildly (a sheer mountain lake vs a shallow bay), so a
            // world-space threshold gives a band that is either invisible
            // or a flood — this keeps one constant, crisp line at every
            // zoom level.
            float grad = length(vec2(dFdx(depth), dFdy(depth)));
            float shore = grad > 1e-6 ? depth / grad : 1e6;
            float wob = sin(p.x * 3.3 + uTime * 1.2) * 0.5
                      + sin(p.y * 2.9 - uTime * 0.9) * 0.5;
            float edge = 7.0 + wob * 2.5;
            float foam = 1.0 - smoothstep(edge - 4.0, edge + 4.0, shore);
            // A second lacy line breaking further out. Two incommensurate
            // frequencies, so the crests never settle into the regular
            // chevron wallpaper a single directional sine produces.
            float band = sin(p.x * 2.2 + p.y * 1.8 - uTime * 1.6)
                       * sin(p.x * 0.9 - p.y * 1.31 + uTime * 0.7);
            float lace = (1.0 - smoothstep(12.0, 30.0, shore))
                       * smoothstep(0.35, 0.85, band);
            foam = clamp(foam + lace * 0.25, 0.0, 1.0);
            col = mix(col, uFoam, foam);

            diffuseColor.rgb = col;
            // Clear at the margins, opaque over the deeps; foam is solid.
            diffuseColor.a = mix(mix(0.3, 0.86, d01), 0.95, foam);
          }`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `#include <emissivemap_fragment>
          {
            vec2 p = vWorldPos.xz;
            vec3 n = waveNormal(p, uTime);
            vec3 viewDir = normalize(cameraPosition - vWorldPos);
            vec3 halfDir = normalize(uSunDir + viewDir);
            float ndh = max(dot(n, halfDir), 0.0);
            // A broad lobe for the sheen rolling along the swells, and a
            // tight one for glitter. The tight exponent stays modest: the
            // half-vector sits well off vertical under this fixed camera,
            // so anything sharper rounds to nothing on a near-flat surface.
            float sheen = pow(ndh, 14.0);
            float glint = pow(ndh, 26.0);
            // Broken up by a fast high-frequency field so the glitter reads
            // as scattered points of light rather than a smooth band.
            float speck = sin(p.x * 7.3 + uTime * 1.9) * sin(p.y * 6.1 - uTime * 1.4)
                        + sin((p.x - p.y) * 5.1 + uTime * 2.3);
            glint *= smoothstep(0.35, 1.25, speck + 0.7);
            totalEmissiveRadiance += vec3(1.0, 0.97, 0.88) * glint * 0.5
                                   + vec3(0.42, 0.66, 0.72) * sheen * 0.05;
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
