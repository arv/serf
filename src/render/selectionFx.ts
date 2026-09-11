import * as THREE from 'three';
import {clamp} from '../shared/math';
import {BANDIT_TINT, factionTint} from './factionPalette';
import type {HeightField} from './heightField';
import {vermillion} from './palette';
import type {SceneSync} from './sceneSync';

/**
 * The ring's texture, in the festival aura's language: a band of light
 * with no hard edge on it anywhere, rather than the drawn circle a
 * RingGeometry gives. Two things the flat ring could not do:
 *
 * - it blurs, so it sits under a man the way his shadow does rather than
 *   like a decal laid over the grass;
 * - it has small ridges — the band's radius wobbles a little, a couple of
 *   dozen shallow scallops around the circumference — and the ring turns.
 *   A perfectly even ring turning is a ring standing still; the ridges are
 *   the only reason the eye can see it move at all.
 *
 * Computed rather than drawn, like the aura's: the render tests import
 * this module under node, where there is no canvas.
 */
const SEL_TEXTURE_SIZE = 128;
/** Where the band sits: 0 at the centre, 1 at the quad's inscribed edge.
 * Pulled in from the rim to leave the halo below somewhere to spread. */
const SEL_RADIUS = 0.6;
/** The band's solid core: out to here from its centre line it is at full
 * strength, and only past it does the blur start. A plain gaussian has no
 * core at all — it is brightest on one infinitely thin line and falling
 * off everywhere else, which is what made the first cut read as a smudge
 * rather than a ring. */
const SEL_BAND_HALF = 0.038;
/** How far it blurs past that core, to either side. */
const SEL_SOFTNESS = 0.045;
/** The ridges: how many, and how far each pushes the band in and out. */
const SEL_RIDGES = 24;
const SEL_RIDGE_DEPTH = 0.035;
/** The halo: a wide, faint haze around the band, in the festival aura's
 * own language. The band says exactly where the man is; the halo is the
 * light it sheds, and it is what keeps a hard little ring from sitting on
 * the grass like a decal. Strength is a fraction of the band's own. */
const SEL_HALO = 0.32;
const SEL_HALO_SOFTNESS = 0.2;
/** The fill: a gradient pooled on the ground the man stands on, brightest
 * under his feet and gone by the time it reaches the band. Without it the
 * ring is an outline drawn around nothing — this is what makes it read as
 * a patch of ground picked out, with him standing in it. Faint, because
 * the man himself covers the brightest of it and what shows is the spill
 * around his boots. */
const SEL_FILL = 0.2;
/** The rim fade, so a blurred band is never cut off square. Wide, because
 * it is the halo and not the band that reaches the rim now. */
const SEL_FEATHER = 0.3;
function makeRingTexture(): THREE.DataTexture {
  const n = SEL_TEXTURE_SIZE;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5;
      const dy = (y + 0.5) / n - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const angle = Math.atan2(dy, dx);
      // The ridges ride the band's radius, not its brightness: a scallop
      // reads as shape, where a bright patch would only read as a dashed
      // ring.
      const at = SEL_RADIUS + SEL_RIDGE_DEPTH * Math.cos(angle * SEL_RIDGES);
      // Flat-topped: the distance the falloff sees is measured from the
      // edge of the core, not from the centre line, so the core itself is
      // solid and the shoulders alone are soft.
      const d = Math.max(0, Math.abs(r - at) - SEL_BAND_HALF) / SEL_SOFTNESS;
      const band = Math.exp(-d * d);
      // The halo takes the true radius rather than the ridged one: a haze
      // this soft could not show a scallop anyway, and an even glow under
      // a ridged band is the thing that reads as light coming off it.
      const h = (r - SEL_RADIUS) / SEL_HALO_SOFTNESS;
      const halo = SEL_HALO * Math.exp(-h * h);
      // The fill runs the other way: full at the centre, nothing at the
      // band, on the true radius like the halo. Squared, so it falls away
      // from his feet quickly and does not flatten into a disc.
      const q = clamp(r / SEL_RADIUS, 0, 1);
      const fill = SEL_FILL * (1 - q * q) ** 1.5;
      const e = clamp((1 - r) / SEL_FEATHER, 0, 1);
      const a = Math.min(1, band + halo + fill) * e * e * (3 - 2 * e);
      const i = (y * n + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}
/** The ring's width across, in tiles. Wider than the band it carries —
 * the blur needs somewhere to go. */
const SEL_SIZE = 1.05;
/** One revolution, in milliseconds. Slower than the aura's star: this one
 * marks a man, it does not celebrate him. */
const SEL_SPIN_MS = 11000;
/** One pulse, in milliseconds, and how far it swells either side of the
 * ring's true size. A plain sine, not the aura's warped breath — that
 * slow in-and-out is the festival's own signature, and a selection ring
 * borrowing it would say the wrong thing. This is a quicker, shallower
 * beat: enough that a selected man reads as live at a glance, small
 * enough that a screen of them does not throb. */
const SEL_PULSE_MS = 1700;
const SEL_PULSE = 0.045;

/**
 * Rings under selected units. Rings are pooled and repositioned every
 * frame from interpolated unit positions.
 *
 * Vermillion for your own, which is every ring a live match ever draws:
 * the pointer reaches nobody else's people there. A replay lets it reach
 * every seat, and there a rival's ring flies that seat's banner (the
 * bandits' the grey they raid in) — the same language the minimap's dots
 * and the rally flag's cloth already speak, and the thing that keeps
 * "twelve units selected" from being a sentence about the wrong army.
 */
export class SelectionFx {
  #scene: THREE.Scene;
  #heights: HeightField;
  #pool: THREE.Mesh[] = [];
  #geometry = new THREE.PlaneGeometry(SEL_SIZE, SEL_SIZE);
  /** One texture for every ring, whatever its colour: the material tints
   * a white band. */
  #texture = makeRingTexture();
  /** One material per ring color, made on first need. A live match only
   * ever asks for the first of them. */
  #materials = new Map<number, THREE.MeshBasicMaterial>();
  // Scratch for the per-ring position reads: with an army selected this
  // runs hundreds of times a frame, so it must not allocate.
  #pos = {x: 0, y: 0};

  constructor(scene: THREE.Scene, heights: HeightField) {
    this.#scene = scene;
    this.#heights = heights;
    this.#geometry.rotateX(-Math.PI / 2);
  }

  #material(color: number): THREE.MeshBasicMaterial {
    let mat = this.#materials.get(color);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        color,
        map: this.#texture,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 1,
        // Straight alpha, not the aura's additive: this is a mark on a
        // man, and it has to keep its colour to say whose he is. Off the
        // depth buffer so two rings overlapping do not fight.
        depthWrite: false,
      });
      this.#materials.set(color, mat);
    }
    return mat;
  }

  /** `viewer` is the seat whose rings stay vermillion — this client's. */
  update(
    selection: ReadonlySet<number>,
    sync: SceneSync,
    now: number,
    viewer: number,
  ): void {
    let used = 0;
    const pos = this.#pos;
    // Every ring on screen turns together, on the animation clock — so
    // they stop with the match rather than turning over a frozen field.
    const spin = ((sync.animNow / SEL_SPIN_MS) * Math.PI * 2) % (Math.PI * 2);
    const pulse =
      1 + SEL_PULSE * Math.sin((sync.animNow / SEL_PULSE_MS) * Math.PI * 2);
    for (const id of selection) {
      if (!sync.positionOfInto(id, now, pos)) continue;
      const owner = sync.ownerOf(id);
      const color =
        owner === null || owner === viewer
          ? vermillion
          : (factionTint(owner) ?? BANDIT_TINT);
      let ring = this.#pool[used];
      if (!ring) {
        ring = new THREE.Mesh(this.#geometry, this.#material(color));
        this.#pool.push(ring);
        this.#scene.add(ring);
      } else {
        ring.material = this.#material(color);
      }
      ring.visible = true;
      ring.position.set(pos.x, this.#heights.at(pos.x, pos.y) + 0.05, pos.y);
      ring.rotation.y = spin;
      // Flat quad: the Y scale is along its own normal and does nothing,
      // so one scalar is the whole of it.
      ring.scale.setScalar(pulse);
      used++;
    }
    for (let i = used; i < this.#pool.length; i++)
      this.#pool[i]!.visible = false;
  }
}
