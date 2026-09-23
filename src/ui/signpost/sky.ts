import * as THREE from 'three';

/** The sky over the valley: deep overhead, pale at the horizon, where the
 * haze fades the far ground into it. */
export const SKY = {zenith: 0x3a8ee0, horizon: 0xa6d0f0};

export interface Sky {
  mesh: THREE.Mesh;
  /** Move the clouds on by `dt` seconds. */
  drift(dt: number): void;
  /** Light the ranges and the clouds from `dir` (toward the sun), as the
   * scene's sun is set. */
  setSun(dir: THREE.Vector3): void;
}

/**
 * The sky, painted on a dome that rides with the lens: a blue gradient, and
 * mountain ranges round the horizon drawn by the shader, not modelled.
 * Being on the dome they sit at infinity, as far ranges do — they never
 * slide against each other or the valley as the lens moves.
 *
 * Three ranges, nearest lowest and darkest, each further one paler in the
 * haze. Low-poly, like the pack's own pieces: a skyline is ridged noise
 * taken at corners round a circle (so it closes on itself) and joined by
 * straight edges; under it, bands of flat triangles, each lit as one
 * face by the sun; snow above a line that wanders slowly round the range,
 * so only the peaks that reach it are capped, with a clean edge (snow on
 * whole facets zigzagged into teeth). Behind the mountains, clouds drift
 * on a flat layer overhead.
 */
export function makeSky(radius: number): Sky {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 48, 24),
    new THREE.ShaderMaterial({
      uniforms: {
        zenith: {value: new THREE.Color(SKY.zenith)},
        horizon: {value: new THREE.Color(SKY.horizon)},
        rock: {value: new THREE.Color(0x4c5a6c)},
        snow: {value: new THREE.Color(0xf4f7fb)},
        // The sun as an azimuth round y: the renderer's own, (-28, 55,
        // 18), until setSun moves it.
        sunAz: {value: Math.atan2(18, -28)},
        // Seconds the clouds have drifted (see drift).
        time: {value: 0},
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 zenith;
        uniform vec3 horizon;
        uniform vec3 rock;
        uniform vec3 snow;
        uniform float sunAz;
        uniform float time;
        varying vec3 vDir;

        #define BANDS 4
        float hash(vec2 p) {
          // A lattice that repeats every 1024 cells: the clouds' wind moves
          // the noise forever, and unbounded coordinates times these
          // factors lose float precision after a few hours open.
          p = mod(p, 1024.0);
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i), hash(i + vec2(1, 0)), u.x),
            mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x),
            u.y);
        }
        /** Sharp crests: 1 - |n| folds every octave into a ridge. */
        float ridged(vec2 p) {
          float sum = 0.0;
          float amp = 0.55;
          for (int i = 0; i < 4; i++) {
            float n = 1.0 - abs(noise(p) * 2.0 - 1.0);
            sum += n * n * amp;
            p = p * 2.03 + vec2(17.1, 9.3);
            amp *= 0.5;
          }
          return sum;
        }
        /** A range's ridge (radians above the horizon) at corner k of n
         * round the circle. */
        float ridge(float k, float n, float seed, float scale, float base,
                    float amp) {
          float a = k / n * 6.2831853;
          vec2 c = vec2(cos(a), sin(a)) * scale + seed;
          return base + amp * ridged(c);
        }
        float fbm(vec2 p) {
          float sum = 0.0;
          float amp = 0.5;
          for (int i = 0; i < 5; i++) {
            sum += noise(p) * amp;
            p = p * 2.02 + vec2(5.2, 1.3);
            amp *= 0.5;
          }
          return sum;
        }
        /** Clouds on a flat layer overhead, drifting with the wind: soft
         * heaps cut out of noise, lit on the sun's side, blue-grey under.
         * Thinning toward the horizon, where the layer is seen edge-on. */
        vec3 clouds(vec3 dir, vec3 col) {
          if (dir.y <= 0.0) return col;
          vec2 p = dir.xz / (dir.y + 0.15) * 1.8 + vec2(time * 0.017, time * 0.006);
          float d = fbm(p);
          float cover = smoothstep(0.615, 0.665, d);
          if (cover <= 0.0) return col;
          // Toward the sun the heap thins: that side is lit.
          vec2 toSun = vec2(cos(sunAz), sin(sunAz)) * 0.12;
          float lit = clamp(0.55 + (d - fbm(p + toSun)) * 5.0, 0.0, 1.0);
          vec3 c = mix(vec3(0.66, 0.74, 0.86), vec3(1.0), lit);
          float far = smoothstep(0.03, 0.25, dir.y);
          return mix(col, c, cover * far * 0.95);
        }
        /** Row j of the face under corner k (0 the ridge, BANDS the foot):
         * evenly down it, each inner row pushed about a little. */
        float row(float j, float k, float h, float base, float seed) {
          if (j < 0.5) return h;
          if (j > float(BANDS) - 0.5) return base - 0.02;
          float share = 1.0 - j / float(BANDS)
            + (noise(vec2(k * 0.8, seed + j * 7.0)) - 0.5) * 0.3;
          return base + (h - base) * share;
        }
        /** A flat triangle's light, in a frame where x runs round the
         * horizon, y up, z toward the lens. */
        float facet(vec3 a, vec3 b, vec3 c, vec3 sun) {
          vec3 n = normalize(cross(b - a, c - a));
          if (n.z < 0.0) n = -n;
          return 0.5 + 0.62 * max(dot(n, sun), 0.0);
        }

        void main() {
          vec3 dir = normalize(vDir);
          float el = asin(clamp(dir.y, -1.0, 1.0));
          float az = atan(dir.z, dir.x);
          vec3 col = mix(horizon, zenith, pow(max(dir.y, 0.0), 0.4));
          col = clouds(dir, col);
          float turn = az / 6.2831853 + 0.5;
          // Out here, not in the loop: it skips ranges a pixel is above.
          float w = fwidth(el) * 0.75;

          // Far to near, each painted over the last.
          for (int i = 0; i < 3; i++) {
            float fi = float(i);
            float seed = 11.0 + fi * 37.0;
            float scale = 2.0 + fi * 0.7;
            float base = 0.012 - fi * 0.006;
            float amp = 0.15 - fi * 0.035;
            // Above the tallest peak the range can have (ridged tops out
            // near 1.03): nothing of it here, and no noise spent finding
            // that out.
            if (el > base + amp * 1.04 + w) continue;
            float haze = 0.5 - fi * 0.2;
            // Corners round the circle: a straight-edged, low-poly line.
            float n = 480.0 + fi * 120.0;
            float t = turn * n;
            // Corner indices wrapped round the circle: atan jumps at -x,
            // and everything seeded by a corner has to close up there.
            float f = fract(t);
            float k = mod(floor(t), n);
            float k1 = mod(k + 1.0, n);
            float h0 = ridge(k, n, seed, scale, base, amp);
            float h1 = ridge(k1, n, seed, scale, base, amp);
            float h = mix(h0, h1, f);
            float cover = smoothstep(-w, w, h - el);
            if (cover <= 0.0) continue;

            // Bands of flat triangles from the ridge down to the foot, the
            // diagonals leaning this way or that.
            float seg = 6.2831853 / n;
            float depth = amp * 0.7 / float(BANDS);
            vec3 A = vec3(0.0);
            vec3 B = vec3(1.0, 0.0, 0.0);
            vec3 C = vec3(0.0, 1.0, 0.0);
            for (int b = 0; b < BANDS; b++) {
              float j = float(b);
              float u0 = row(j, k, h0, base, seed);
              float u1 = row(j, k1, h1, base, seed);
              float l0 = row(j + 1.0, k, h0, base, seed);
              float l1 = row(j + 1.0, k1, h1, base, seed);
              if (b < BANDS - 1 && el < mix(l0, l1, f)) continue;
              vec3 p0 = vec3(0.0, u0, j * depth);
              vec3 p1 = vec3(seg, u1, j * depth);
              vec3 q0 = vec3(0.0, l0, (j + 1.0) * depth);
              vec3 q1 = vec3(seg, l1, (j + 1.0) * depth);
              if (noise(vec2(k * 0.6 + j * 3.1, seed + 5.0)) > 0.5) {
                bool top = el > mix(u0, l1, f);
                A = p0; B = top ? p1 : q1; C = top ? q1 : q0;
              } else {
                bool top = el > mix(l0, u1, f);
                A = p1; B = top ? p0 : q0; C = top ? q0 : q1;
              }
              break;
            }
            // The sun's side of the ridge, from where the lens looks.
            vec3 sun = normalize(vec3(sin(az - sunAz) * 0.9, 0.8, 0.5));
            float lit = facet(A, B, C, sun);
            float mid = (A.y + B.y + C.y) / 3.0;
            // Snow above a line that wanders slowly round the range, so
            // only the peaks that reach it are capped, with a clean edge.
            // Its wander is noise taken round a circle, so it closes up.
            vec2 around = vec2(cos(turn * 6.2831853), sin(turn * 6.2831853))
              * (n * 0.12 / 6.2831853);
            float line = base + amp * (0.66 + fi * 0.14
              + (noise(around + vec2(seed + 3.0, 0.0)) - 0.5) * 0.12);
            float capped = smoothstep(-w, w, el - line);
            vec3 c = mix(rock, snow, capped) * lit;
            // Hazier toward the foot, where the air is thickest.
            float low = 1.0 - smoothstep(base, base + amp * 0.6, mid);
            c = mix(c, horizon, clamp(haze + low * 0.3, 0.0, 1.0));
            col = mix(col, c, cover);
          }
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  // Last of the solid pass, behind everything by depth: only the pixels
  // the valley leaves open run the shader (the clear colour is its horizon).
  mesh.renderOrder = 1000;
  mesh.frustumCulled = false;
  const {time, sunAz} = (mesh.material as THREE.ShaderMaterial).uniforms;
  return {
    mesh,
    drift: dt => {
      time!.value += dt;
    },
    setSun: dir => {
      sunAz!.value = Math.atan2(dir.z, dir.x);
    },
  };
}
