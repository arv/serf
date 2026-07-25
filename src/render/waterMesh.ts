import * as THREE from 'three';
import { MAP_SIZE } from '../shared/grid';
import { WATER_LEVEL } from '../sim/map';
import { palette } from './palette';

/**
 * The water surface: one plane at the waterline (river beds dip below it),
 * with an animated shimmer injected into a stock Lambert material via
 * onBeforeCompile — so it keeps lighting, fog, and tone mapping for free.
 */
export class WaterMesh {
  readonly mesh: THREE.Mesh;
  #time = { value: 0 };

  constructor() {
    const geometry = new THREE.PlaneGeometry(MAP_SIZE + 40, MAP_SIZE + 40, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(MAP_SIZE / 2, WATER_LEVEL, MAP_SIZE / 2);

    const material = new THREE.MeshLambertMaterial({ color: palette.water });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.#time;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vWorldPos;',
        )
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTime;\nvarying vec3 vWorldPos;',
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            float x = vWorldPos.x;
            float z = vWorldPos.z;
            // Long drifting swells with a second choppier field riding them.
            float swell = sin(x * 0.55 + uTime * 0.5) * sin(z * 0.7 - uTime * 0.35)
                        + sin((x + z) * 0.4 + uTime * 0.3);
            swell /= 2.0;
            float chop = sin(x * 2.1 + z * 1.3 + uTime * 1.1)
                       * sin(z * 2.7 - x * 0.9 - uTime * 0.8);
            // Broad brightness bands + faint crest glints along swell tops.
            float glint = smoothstep(0.72, 0.98, swell + chop * 0.22) * 0.22;
            diffuseColor.rgb *= 1.0 + swell * 0.16 + chop * 0.04;
            diffuseColor.rgb += vec3(0.28, 0.45, 0.5) * glint;
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
