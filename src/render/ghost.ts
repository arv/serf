import * as THREE from 'three';
import {
  buildingDef,
  gatherOrigin,
  gatherRecipeOf,
  type BuildingTypeId,
} from '../sim/defs/buildings';
import type {MapView} from '../sim/map';
import {waterFacing} from '../sim/world';
import type {HeightField} from './heightField';
import {eachMaterial} from './materials';
import {makeGhostModel} from './models';
import {verdictBad, verdictGood} from './palette';
import {fitPier, seatShoal, type PierInfo} from './pierFit';
import {ReachOutline} from './reachOutline';

const VALID = new THREE.Color(verdictGood);
const INVALID = new THREE.Color(verdictBad);

/**
 * The placement preview: a semi-transparent building model snapped to the
 * hovered tile, tinted green/red by validity.
 */
export class GhostPlacement {
  #scene: THREE.Scene;
  #heights: HeightField;
  #map: MapView;
  /** The decks already standing, asked for fresh on every aim: the preview
   * steers its own jetty clear of them, so what the player lines up is what
   * the yard will build. */
  #piers: () => readonly PierInfo[];
  /** Stands where the building would stand, as BuildingSync's root does —
   * the model hangs under it so the pier fit has the same two levels to
   * turn that a built fishery gives it. */
  #group: THREE.Group | null = null;
  #model: THREE.Group | null = null;
  /** A fishery's deck and the shoal off its end, when this is one. */
  #pier: THREE.Object3D | null = null;
  #shoal: THREE.Object3D | null = null;
  /** The decor's authored rest, to put back before each re-fit: the fit
   * pulls the deck in and shrinks it, and a cursor crossing the shore
   * re-fits on every tile, so the moves would compound into a deck ground
   * down to nothing. */
  #home: {
    obj: THREE.Object3D;
    position: THREE.Vector3;
    scale: THREE.Vector3;
  }[] = [];
  #type: BuildingTypeId | null = null;
  /** Seat whose colors the preview wears. */
  #owner: number;
  /** Each ghost material's untinted color — the tint multiplies this, so it
   * has to survive being reapplied on every hover. */
  #base = new Map<THREE.Material, THREE.Color>();
  #valid: boolean | null = null;
  /** Last footprint origin, so a cursor wandering within one tile doesn't
   * re-lay the reach outline's geometry every update. */
  #x = -1;
  #y = -1;
  #reach: ReachOutline;

  constructor(
    scene: THREE.Scene,
    heights: HeightField,
    map: MapView,
    piers: () => readonly PierInfo[] = () => [],
    owner = 0,
  ) {
    this.#scene = scene;
    this.#heights = heights;
    this.#map = map;
    this.#piers = piers;
    this.#owner = owner;
    this.#reach = new ReachOutline(scene, heights);
  }

  show(type: BuildingTypeId): void {
    if (this.#type === type) return;
    this.hide();
    this.#type = type;
    const model = makeGhostModel(type, 0.55, this.#owner);
    this.#model = model;
    this.#group = new THREE.Group();
    this.#group.add(model);
    this.#group.visible = false;
    this.#pier = model.getObjectByName('fisheryPier') ?? null;
    this.#shoal = model.getObjectByName('fisheryShoal') ?? null;
    for (const obj of [this.#pier, this.#shoal]) {
      if (obj) {
        this.#home.push({
          obj,
          position: obj.position.clone(),
          scale: obj.scale.clone(),
        });
      }
    }
    this.#group.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        eachMaterial(obj, m => {
          const lit = m as THREE.MeshLambertMaterial;
          if (lit.color) this.#base.set(m, lit.color.clone());
        });
      }
    });
    this.#scene.add(this.#group);
    const gather = gatherRecipeOf(buildingDef(type));
    if (gather) this.#reach.show(gather.radius);
  }

  /** Position at footprint origin tile (x,y); tint by validity. */
  moveTo(x: number, y: number, valid: boolean): void {
    if (!this.#group || !this.#type) return;
    // Same tile, same verdict: the ghost is already exactly this.
    if (
      x === this.#x &&
      y === this.#y &&
      valid === this.#valid &&
      this.#group.visible
    )
      return;
    this.#x = x;
    this.#y = y;
    const def = buildingDef(this.#type);
    this.#group.visible = true;
    const cx = x + def.w / 2;
    const cz = y + def.h / 2;
    this.#group.position.set(cx, this.#heights.at(cx, cz), cz);
    if (def.nearWater) this.#aimDeck(x, y, def.w, def.h, def.nearWater.radius);
    // The worker searches from the footprint's center tile, so the outline
    // is drawn around that tile's center — not the footprint's midpoint,
    // which is half a tile off for even-sized huts.
    const origin = gatherOrigin(def, x, y);
    this.#reach.moveTo(origin.x + 0.5, origin.y + 0.5, valid ? VALID : INVALID);
    if (valid === this.#valid) return;
    this.#valid = valid;
    const tint = valid ? VALID : INVALID;
    this.#group.traverse(obj => {
      if (!(obj instanceof THREE.Mesh)) return;
      eachMaterial(obj, m => {
        const lit = m as THREE.MeshLambertMaterial;
        const base = this.#base.get(m);
        // Multiply rather than add: the buildings are brightly textured, and
        // an emissive tint on top of that washes out to pale pink instead of
        // reading as "you cannot build here".
        if (base) lit.color.copy(base).multiply(tint);
        if (!lit.emissive) return; // unlit materials can't glow
        lit.emissive.copy(tint);
        lit.emissiveIntensity = 0.22;
      });
    });
  }

  /**
   * Turn the fishery so its jetty ends in the water.
   *
   * The preview is a promise about the spot under the cursor, so it is
   * aimed exactly as the built hut will be: the quarter turn the sim would
   * hand it (`waterFacing`, which runs on placement), then the same search
   * for a deck that actually reaches — turning the hut, trimming the planks
   * — that BuildingSync runs on the finished building (`fitPier`). Without
   * it the ghost wears the model's authored facing, so the player aims a
   * dock that swings somewhere else entirely the moment it is built.
   *
   * Both moves are applied to the model, and the cursor re-aims on every
   * tile it crosses, so the decor goes back to its authored rest first.
   */
  #aimDeck(x: number, y: number, w: number, h: number, radius: number): void {
    const model = this.#model;
    const root = this.#group;
    if (!this.#pier || !model || !root) return;
    for (const rest of this.#home) {
      rest.obj.position.copy(rest.position);
      rest.obj.scale.copy(rest.scale);
    }
    const facing = waterFacing(this.#map, x, y, w, h, radius);
    model.rotation.y = (facing * Math.PI) / 2;
    // The fish swim under the water plane, not at the deck height the
    // template bakes them at — the same re-seat the built fishery gets.
    if (this.#shoal) seatShoal(this.#shoal, model, root.position.y);
    fitPier(
      {
        root,
        pier: this.#pier,
        shoal: this.#shoal ?? undefined,
        facing,
      },
      this.#heights,
      this.#piers(),
    );
  }

  hide(): void {
    if (this.#group) {
      this.#scene.remove(this.#group);
      this.#group = null;
    }
    this.#model = null;
    this.#pier = null;
    this.#shoal = null;
    this.#home.length = 0;
    this.#reach.hide();
    this.#base.clear();
    this.#valid = null;
    this.#x = -1;
    this.#y = -1;
    this.#type = null;
  }
}
