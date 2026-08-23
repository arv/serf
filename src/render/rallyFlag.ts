import * as THREE from 'three';
import { paper, vermillion, woodLight } from './palette';
import { glbYardProp } from './assets';
import type { BuildingSnap } from '../protocol/messages';
import type { HeightField } from './heightField';

/**
 * The barracks' rally flag: a standing gonfalon planted on the muster tile,
 * drawn only while that barracks is selected. The flag is a standing order,
 * not a building — the map is not the place to remember every order on, and
 * showing it with the card that can move it is what makes the card's
 * "soldiers muster at the flag" checkable at a glance.
 *
 * The cloth is the Dungeon Remastered pack's banner (CC0, see
 * models/kaykit/dungeon/LICENSE.txt), in the owner's faction color: the
 * pack happens to dye it in the faction palette's own four, so the flag is
 * picked per seat rather than tinted. The pack authors it as a WALL
 * hanging — there is no free-standing flag in it — so the pole and
 * crossbar it hangs from here are ours, in the same wood the well's crank
 * wears.
 *
 * Same contract as SelectedReach: update() every frame with the selected
 * building (or null), and the mesh only moves when the answer changes —
 * terrain height never changes mid-match, so a planted banner can stand
 * still.
 */

/** The pack banner that wears each seat's color — factionPalette's
 * green/red/blue/gold, in the pack's own dyes, indexed by owner. */
const BANNER_OF: readonly string[] = [
  'dungeon/banner_green',
  'dungeon/banner_red',
  'dungeon/banner_blue',
  'dungeon/banner_yellow',
];

export class RallyFlag {
  #scene: THREE.Scene;
  #heights: HeightField;
  /**
   * One built standard per banner color, made on first need. In practice a
   * client only ever selects its own buildings, so one entry — the map is
   * for the day a spectator view selects across seats, and so a rebuilt
   * group never has to be torn down (its cloth shares the loaded template's
   * buffers, which must not be disposed).
   */
  #groups = new Map<string, THREE.Group>();
  #shown: THREE.Group | null = null;
  /** What is currently planted: selection id + flag tile (-1 = nothing). */
  #id = -1;
  #x = -1;
  #y = -1;

  constructor(scene: THREE.Scene, heights: HeightField) {
    this.#scene = scene;
    this.#heights = heights;
  }

  update(building: BuildingSnap | null): void {
    const rally = building?.rally;
    if (!building || !rally) {
      if (this.#shown) this.#shown.visible = false;
      this.#id = -1;
      return;
    }
    if (this.#id === building.id && this.#x === rally.x && this.#y === rally.y) return;
    this.#id = building.id;
    this.#x = rally.x;
    this.#y = rally.y;
    const stem = BANNER_OF[building.owner] ?? BANNER_OF[0]!;
    let group = this.#groups.get(stem);
    if (!group) {
      group = this.#build(stem);
      this.#groups.set(stem, group);
    }
    if (this.#shown && this.#shown !== group) this.#shown.visible = false;
    this.#shown = group;
    // Tile centers are at +0.5, the same convention units walk on.
    const cx = rally.x + 0.5;
    const cy = rally.y + 0.5;
    group.position.set(cx, this.#heights.at(cx, cy), cy);
    group.visible = true;
  }

  /** The standard plus a ground ring — built on first use and repositioned
   * ever after; three keeps the buffers for the page's life. */
  #build(stem: string): THREE.Group {
    const group = new THREE.Group();
    group.add(this.#standard(stem));

    // The ring under it borrows the selection rings' language — "this spot
    // is spoken for" — a touch wider, so a soldier standing on the tile
    // doesn't swallow it. Vermillion whatever the cloth flies: it is
    // selection feedback, not livery.
    const ringGeom = new THREE.RingGeometry(0.34, 0.44, 24);
    ringGeom.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(
      ringGeom,
      new THREE.MeshBasicMaterial({
        color: vermillion,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
      }),
    );
    ring.position.y = 0.05;
    group.add(ring);

    this.#scene.add(group);
    return group;
  }

  /** Pole, crossbar and finial of our own wood, the pack's cloth hung from
   * them — taller than a soldier, so the muster point still reads once the
   * mustered are standing on it. */
  #standard(stem: string): THREE.Group {
    const g = new THREE.Group();
    const wood = new THREE.MeshLambertMaterial({ color: woodLight });
    const part = (geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      return m;
    };

    const POLE_H = 1.55;
    const pole = part(new THREE.CylinderGeometry(0.032, 0.032, POLE_H, 6), wood);
    pole.position.y = POLE_H / 2;
    g.add(pole);
    const crossbar = part(new THREE.CylinderGeometry(0.024, 0.024, 0.56, 6), wood);
    crossbar.rotation.z = Math.PI / 2;
    crossbar.position.y = 1.44;
    g.add(crossbar);
    const finial = part(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshLambertMaterial({ color: paper }));
    finial.position.y = POLE_H + 0.04;
    g.add(finial);

    // The cloth: height-normalized with its feet on the ground (yard-prop
    // framing), then lifted so its top hangs just under the crossbar.
    // Double-sided, because a hanging cloth has two faces wherever the
    // camera stands — the pack ships it single-sided for its dungeon walls.
    const CLOTH_H = 0.9;
    const cloth = glbYardProp(stem, CLOTH_H);
    if (cloth) {
      cloth.traverse((o) => {
        if (o instanceof THREE.Mesh) (o.material as THREE.Material).side = THREE.DoubleSide;
      });
      // A war standard's cut, not a dungeon wall's: the pack cloth is a
      // slender 0.47 wide per unit of drop, and after the camera's 45°
      // foreshortening that read as a ribbon. Width only — the drop and
      // the pole it hangs from stay.
      cloth.scale.x *= 1.25;
      cloth.position.y = 1.42 - CLOTH_H;
      g.add(cloth);
    }

    // Facing +z, unrotated — the one horizontal facing that serves both
    // masters. The camera looks in from yaw +π/6 by default (cameraRig —
    // the player can turn it), so +z is 30° off broadside and the cloth
    // keeps ~87% of its width (~70% at the 45° this was chosen at); the
    // sun stands west of north (renderer seats it at -x +z), so the same
    // face still catches direct light. The corners fail: +π/4 faced the
    // 45° camera squarely but away from the sun (a near-black slab), -π/4
    // was lit and exactly edge-on to it (an invisible one).
    return g;
  }
}
