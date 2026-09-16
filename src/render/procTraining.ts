import * as THREE from 'three';
import {lantern, paper, vermillion, wood, woodLight} from './palette';

/**
 * The training cue: what a barracks, an archery range and the castle wear
 * while a course is actually running.
 *
 * Why it exists. A village says what it is doing without being asked — the
 * mill's sails turn while it grinds, the bakehouse smokes while a batch is
 * on the fire, the fishery's shoal swims while a fisherman works it. The
 * three buildings that make SOLDIERS said nothing at all: a barracks with
 * four knights on the fire and a barracks standing cold were the same
 * building, and in a fight that is the one fact worth reading off an
 * opponent's village at a glance.
 *
 * Four cues, deliberately different in kind, because each survives a
 * different thing:
 *
 *   windows  lit warm while the course runs (`makeWindowGlows`). Colour, so
 *            it is the first to go at village zoom — but it is also the
 *            only one that works on a building seen end-on with its yard
 *            hidden behind it, and it costs no silhouette at all.
 *   brazier  a fire in the yard, which puts the existing chimney smoke over
 *            the building (the flue mark below is the same one the bakery
 *            and the Smith carry). Motion and a column against the sky:
 *            what reads at the zoom the colour dies at.
 *   banner   run up the pole while training, down when the queue empties.
 *            A silhouette change, and the only cue that survives being
 *            looked at through a crowd of other roofs.
 *   yard     the pell rocking under blows nobody sees, arrows thudding into
 *            the range's own butts. The one cue that says WHICH course is
 *            running rather than merely that one is.
 *
 * Everything here is authored in the building's unit-square template space
 * — the space BUILDING_DECOR places in — feet on y=0, front toward +z.
 * `makeWindowGlows` is the exception and says so: it reads a pack model
 * before `normalize` and works in that model's own units.
 */

/** Iron, for the brazier's bowl and legs. Darker than the pack's timber so
 * the fire in it has something to be bright against. */
const IRON = 0x3a3733;
/**
 * Fire's heart, under the softer `lantern` the coals and the window panes
 * wear. Deeper than a flame looks on a colour picker on purpose: the
 * renderer grades ACES filmic at 1.32 exposure, and the orange this
 * started at (0xff8b3d) came out of that as a white cone — a brazier
 * burning magnesium.
 */
const FLAME = 0xc4491a;
/** The tongue above it, where a real flame pales out. */
const FLAME_TIP = 0xe0863a;

function part(geo: THREE.BufferGeometry, color: number): THREE.Mesh {
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({color}));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * A mesh that is light rather than matter: unlit, unshadowed, and starting
 * invisible. Everything that glows here is one of these, and the level
 * (see `setTrainingLevel`) is carried on the opacity.
 *
 * `depthWrite: false` because these sit a hair proud of the surfaces they
 * light and a hair behind the flames they are inside: writing depth would
 * let whichever drew first punch a hole in the other.
 */
function glow(geo: THREE.BufferGeometry, color: number): THREE.Mesh {
  const m = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }),
  );
  m.visible = false;
  return m;
}

// ——— The brazier ———

/** How tall the brazier stands, template units. A mine's wheelbarrow is
 * authored at 0.15 and reads as a wheelbarrow, so this is about chest
 * height on the serf who lights it. */
const BRAZIER_H = 0.17;

/**
 * A fire basket on three splayed legs, for the yard by the door.
 *
 * It stands there cold as well as lit — a brazier that appeared with the
 * first recruit and vanished with the last would read as a building
 * growing furniture. What changes is what is in it: `setTrainingLevel`
 * brings the coals and the flames up, and buildingSync stands its ordinary
 * chimney smoke on the `smokeFlue` mark at the bowl's mouth, which is the
 * same mark the bakehouse's oven and the Smith's forge carry.
 */
export function makeBrazier(withFlue = true): THREE.Group {
  const g = new THREE.Group();
  g.name = 'trainBrazier';
  const bowlY = BRAZIER_H * 0.72;
  const r = BRAZIER_H * 0.38;

  // Three legs on the diagonal rather than four square: an odd number
  // never presents a flat pair of legs to the camera, so the basket reads
  // as standing on a tripod from every yaw the rig turns through.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const leg = part(
      new THREE.CylinderGeometry(
        BRAZIER_H * 0.035,
        BRAZIER_H * 0.045,
        bowlY,
        5,
      ),
      IRON,
    );
    leg.position.set(Math.cos(a) * r * 0.55, bowlY / 2, Math.sin(a) * r * 0.55);
    // Splayed out by the same fraction they are set in by, so the feet
    // stand about a basket's width apart.
    leg.rotation.z = -Math.cos(a) * 0.22;
    leg.rotation.x = Math.sin(a) * 0.22;
    g.add(leg);
  }

  const bowl = part(
    new THREE.CylinderGeometry(r, r * 0.58, BRAZIER_H * 0.3, 8, 1, true),
    IRON,
  );
  // An open basket is seen into, so its far wall has to be drawn.
  (bowl.material as THREE.MeshLambertMaterial).side = THREE.DoubleSide;
  bowl.position.y = bowlY + BRAZIER_H * 0.15;
  g.add(bowl);

  // The coals: one shallow disc across the bowl's mouth. Flat on purpose —
  // a fire seen from the game's 35-degree pitch is mostly its bed.
  const coals = glow(new THREE.CircleGeometry(r * 0.82, 8), FLAME_TIP);
  coals.name = 'brazierCoals';
  coals.rotation.x = -Math.PI / 2;
  coals.position.y = bowlY + BRAZIER_H * 0.26;
  g.add(coals);

  // Two tongues over them, turned off one another so the pair reads as a
  // flame rather than as a cone. They are scaled per frame, which is the
  // whole of the flicker.
  const flames = new THREE.Group();
  flames.name = 'brazierFlames';
  flames.position.y = bowlY + BRAZIER_H * 0.26;
  for (let i = 0; i < 2; i++) {
    const tongue = glow(
      new THREE.ConeGeometry(
        r * (0.5 - i * 0.16),
        BRAZIER_H * (0.5 + i * 0.3),
        6,
      ),
      i === 0 ? FLAME : FLAME_TIP,
    );
    tongue.position.set(
      (i - 0.5) * r * 0.35,
      BRAZIER_H * (0.25 + i * 0.15),
      (i - 0.5) * r * 0.2,
    );
    flames.add(tongue);
  }
  g.add(flames);

  // Where buildingSync stands the smoke column. At the rim rather than over
  // the flames: the puffs are born full width and a column that starts
  // inside the basket looks like the basket is leaking.
  //
  // Optional because a building may light more than one fire (the castle
  // flanks its gate with a pair) and buildingSync stands exactly one column
  // per building, on the first mark it finds.
  if (withFlue) {
    const flue = new THREE.Group();
    flue.name = 'smokeFlue';
    flue.position.y = bowlY + BRAZIER_H * 0.55;
    g.add(flue);
  }
  return g;
}

// ——— The muster banner ———

/** Pole height, template units — about half a barracks, which is tall
 * enough to clear the yard's own clutter and short enough that the cloth
 * stays inside the building's own read rather than becoming its own. */
const POLE_H = 0.52;
/** The cloth, as a fraction of the pole. */
const CLOTH_W = 0.15;
const CLOTH_H = 0.26;
/** How far up the pole the hoist sits, struck and flying. Struck is not
 * zero: a furled banner bundled at the foot is still a thing on a pole. */
const HOIST_LOW = 0.1;
const HOIST_HIGH = 1;

/**
 * A standing pole with a banner that is run up it while a course is
 * running and struck when the queue empties.
 *
 * The cloth is ours, not the pack's: the Dungeon banner the rally flag
 * flies is authored as a WALL hanging, and what this needs is something
 * that can travel up a pole and ripple. Cream with a red band, in the
 * pack's own accent — deliberately NOT the faction color, which the roof
 * beside it is already saying and which would make this a second, quieter
 * answer to a question already answered.
 */
export function makeMusterBanner(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'musterBanner';
  const pole = part(
    new THREE.CylinderGeometry(0.012, 0.016, POLE_H, 6),
    woodLight,
  );
  pole.position.y = POLE_H / 2;
  g.add(pole);
  const finial = part(new THREE.ConeGeometry(0.026, 0.06, 6), wood);
  finial.position.y = POLE_H + 0.02;
  g.add(finial);

  // Everything that travels hangs off this one group, so the hoist is a
  // single y and the cloth never has to know where on the pole it is.
  const hoist = new THREE.Group();
  hoist.name = 'bannerHoist';
  g.add(hoist);

  const yard = part(new THREE.CylinderGeometry(0.008, 0.008, CLOTH_W, 5), wood);
  yard.rotation.z = Math.PI / 2;
  yard.position.set(CLOTH_W / 2, 0, 0);
  hoist.add(yard);

  // Segmented across its width, because the ripple is a travelling wave
  // written into these vertices (see `setTrainingLevel`) rather than a
  // rotation: a banner that swung as one board would read as a signboard.
  // Segmented DOWN it too, so the band across its foot can be painted into
  // the same sheet: the band was a second quad hung a hair in front, and a
  // hair is not enough once the sheet in front of it starts to ripple —
  // the cloth swung through the band and cut it into pieces.
  const geo = new THREE.PlaneGeometry(CLOTH_W, CLOTH_H, 5, 4);
  const pos = geo.getAttribute('position');
  const rgb = new Float32Array(pos.count * 3);
  const cream = new THREE.Color(paper);
  const stripe = new THREE.Color(vermillion);
  for (let i = 0; i < pos.count; i++) {
    // The foot of the cloth, where a gonfalon carries its charge.
    const c = pos.getY(i) < -CLOTH_H * 0.18 ? stripe : cream;
    rgb[i * 3] = c.r;
    rgb[i * 3 + 1] = c.g;
    rgb[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  const cloth = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    }),
  );
  cloth.name = 'bannerCloth';
  cloth.castShadow = true;
  cloth.position.set(CLOTH_W / 2, -CLOTH_H / 2, 0);
  hoist.add(cloth);
  return g;
}

// ——— The barracks' pell ———

/** How tall the drill post stands, template units — a hair over a man, so
 * the crossarm is at head height where a pell's is. */
const PELL_H = 0.36;

/**
 * A pell: the straw-bound post a recruit beats with a wooden sword. The
 * post rocks on its own footing while the course runs, which is the whole
 * cue — nobody is modelled swinging at it, and at village zoom a post
 * taking blows and a post being beaten by an invisible man look the same.
 */
export function makePell(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'drillPell';
  // The rocking is all in this child: the base stays planted in the ground
  // it was rammed into, which is what makes the motion read as a post
  // taking a blow rather than as a whole prop sliding about.
  const post = new THREE.Group();
  post.name = 'pellPost';
  g.add(post);

  const shaft = part(
    new THREE.CylinderGeometry(PELL_H * 0.075, PELL_H * 0.095, PELL_H, 7),
    woodLight,
  );
  shaft.position.y = PELL_H / 2;
  post.add(shaft);
  // Straw binding around the striking height, in the pack's own straw.
  const wrap = part(
    new THREE.CylinderGeometry(PELL_H * 0.14, PELL_H * 0.14, PELL_H * 0.26, 8),
    0xdaae7d,
  );
  wrap.position.y = PELL_H * 0.66;
  post.add(wrap);
  // The crossarm, which is what makes a post a pell at a glance.
  const arm = part(
    new THREE.CylinderGeometry(PELL_H * 0.05, PELL_H * 0.05, PELL_H * 0.62, 6),
    wood,
  );
  arm.rotation.z = Math.PI / 2;
  arm.position.y = PELL_H * 0.86;
  post.add(arm);

  // A shield hung at chest height, which is what a post in a yard needs to
  // stop being a fence post: the only red in the composition, and the thing
  // the swing below is visibly moving.
  const shield = part(
    new THREE.CylinderGeometry(PELL_H * 0.2, PELL_H * 0.2, PELL_H * 0.035, 7),
    vermillion,
  );
  shield.rotation.set(Math.PI / 2, 0, 0);
  shield.position.set(PELL_H * 0.2, PELL_H * 0.72, PELL_H * 0.1);
  post.add(shield);

  // A scuff of trodden earth where it is rammed in, not a plinth: the
  // first one read as a pedestal, which made the post on it read as a
  // statue of a man rather than as a thing men hit.
  const heap = part(
    new THREE.CylinderGeometry(PELL_H * 0.22, PELL_H * 0.26, PELL_H * 0.025, 8),
    0x8d7146,
  );
  heap.position.y = PELL_H * 0.012;
  g.add(heap);
  return g;
}

// ——— The archery range's arrows ———

/** One arrow, lying along -x: shaft, head and a pair of fletches. Small
 * enough that three of them in the air is a volley and not a hail. */
function makeArrow(len: number): THREE.Group {
  const a = new THREE.Group();
  const shaft = part(
    new THREE.CylinderGeometry(len * 0.03, len * 0.03, len, 4),
    woodLight,
  );
  shaft.rotation.z = Math.PI / 2;
  a.add(shaft);
  const head = part(
    new THREE.ConeGeometry(len * 0.07, len * 0.16, 4),
    0x818c91,
  );
  head.rotation.z = Math.PI / 2;
  head.position.x = -len * 0.55;
  a.add(head);
  for (const roll of [0, Math.PI / 2]) {
    const fletch = part(new THREE.PlaneGeometry(len * 0.22, len * 0.13), paper);
    (fletch.material as THREE.MeshLambertMaterial).side = THREE.DoubleSide;
    fletch.position.x = len * 0.42;
    fletch.rotation.set(roll, 0, 0);
    a.add(fletch);
  }
  return a;
}

/**
 * One shot: where a shaft starts and where it stops, in template space.
 * Both ends are authored rather than derived, because the pack's butts are
 * not a tidy row — two lean against the straw at ground level facing +x and
 * a third is mounted high on the shed's gable facing +z, so there is no one
 * lane to run and no one direction to run it in.
 */
export interface Shot {
  from: [number, number, number];
  to: [number, number, number];
}

/**
 * The range's shooting, as arrows that fly it.
 *
 * The butts are the pack's own — the cue here is only what hits them. Each
 * arrow flies its own shot on its own clock, staggered, so the yard shows a
 * loose string of shots rather than a volley in step. Nobody is modelled
 * loosing them, for the pell's reason: at village zoom an arrow arriving is
 * the whole of what reads, and an archer who would have to stand, draw and
 * be lit is a unit, not decor.
 */
export function makeArrowLane(shots: readonly Shot[]): THREE.Group {
  const g = new THREE.Group();
  g.name = 'arrowLane';
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i]!;
    // The shaft is modelled lying along -x (head at -x), so the arrow is
    // turned once, here, onto the line it flies and never again: the flight
    // below is a slide along that line.
    const from = new THREE.Vector3(...shot.from);
    const to = new THREE.Vector3(...shot.to);
    const arrow = makeArrow(0.13);
    arrow.name = 'laneArrow';
    arrow.visible = false;
    arrow.quaternion.setFromUnitVectors(
      new THREE.Vector3(-1, 0, 0),
      to.clone().sub(from).normalize(),
    );
    arrow.userData.shot = {from, to, phase: i / shots.length};
    g.add(arrow);
  }
  return g;
}

// ——— Lit windows ———

/**
 * The atlas cell the packs paint the void behind an opening in — the dark
 * slate the window and door recesses of every KayKit building wear.
 * `[row, col]` of the 8x4 grid, in procBuildings' order.
 */
const VOID_CELL: [number, number] = [0, 3];

/** How far proud of the void the pane sits, in model units — enough to
 * clear it at every depth precision we draw at, small enough that the
 * recess still shades it from the side. */
const PANE_STANDOFF = 0.008;

/** How much of the void the pane covers. Short of all of it, so the frame
 * the pack modelled around the opening still reads as a frame. */
const PANE_FILL = 0.82;

/** Voids flatter than this in y are a roof or a floor, not a window. */
const PANE_MAX_TILT = 0.4;

/**
 * Find the window and door voids in a pack model and hang an unlit pane in
 * each one.
 *
 * Reads geometry rather than names because the pack models are one mesh
 * with nothing named inside them — but they are not unstructured: every
 * opening's backing quad is painted from one atlas cell (VOID_CELL), which
 * makes the windows of a building findable by their paint. That is what
 * this walks. Called BEFORE `normalize`, so it works in the model's own
 * units and is scaled into the template along with the walls.
 *
 * Returns null when a model has no openings at all, so a caller can tell
 * "no windows" from "no glow".
 */
export function makeWindowGlows(scene: THREE.Object3D): THREE.Group | null {
  const [vrow, vcol] = VOID_CELL;
  /** One opening, accumulated: its triangles' bounds and facing. */
  interface Void {
    box: THREE.Box3;
    normal: THREE.Vector3;
    n: number;
  }
  const voids: Void[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const mid = new THREE.Vector3();
  scene.updateWorldMatrix(true, true);
  scene.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    const geo = o.geometry as THREE.BufferGeometry;
    const index = geo.getIndex();
    const pos = geo.getAttribute('position');
    const uv = geo.getAttribute('uv');
    const nor = geo.getAttribute('normal');
    if (!index || !uv || !nor) return;
    const inVoid = (i: number): boolean =>
      Math.floor(uv.getY(i) * 4) === vrow &&
      Math.floor(uv.getX(i) * 8) === vcol;
    for (let i = 0; i < index.count; i += 3) {
      const i0 = index.getX(i);
      const i1 = index.getX(i + 1);
      const i2 = index.getX(i + 2);
      if (!inVoid(i0) || !inVoid(i1) || !inVoid(i2)) continue;
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
      nrm.fromBufferAttribute(nor, i0).transformDirection(o.matrixWorld);
      // A void's backing is a wall plate; anything lying flat is the dark
      // slate doing its other job, on a roof or under an eave.
      if (Math.abs(nrm.y) > PANE_MAX_TILT) continue;
      mid
        .copy(a)
        .add(b)
        .add(c)
        .multiplyScalar(1 / 3);
      // Openings are a wall apart; one loose threshold gathers a window's
      // own triangles and splits it from its neighbours. Facing is in it
      // too, so the two sides of a pierced wall stay two windows.
      const hit = voids.find(
        v =>
          v.normal.dot(nrm) > 0.9 &&
          Math.abs(v.box.getCenter(new THREE.Vector3()).x - mid.x) < 0.14 &&
          Math.abs(v.box.getCenter(new THREE.Vector3()).y - mid.y) < 0.22 &&
          Math.abs(v.box.getCenter(new THREE.Vector3()).z - mid.z) < 0.14,
      );
      if (hit) {
        hit.box.expandByPoint(a).expandByPoint(b).expandByPoint(c);
        hit.n++;
      } else {
        voids.push({
          box: new THREE.Box3().setFromPoints([
            a.clone(),
            b.clone(),
            c.clone(),
          ]),
          normal: nrm.clone(),
          n: 1,
        });
      }
    }
  });
  if (voids.length === 0) return null;

  const g = new THREE.Group();
  g.name = 'windowGlow';
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  for (let i = 0; i < voids.length; i++) {
    const v = voids[i]!;
    v.box.getSize(size);
    v.box.getCenter(center);
    // The pane spans the void across the wall and up it. Which of x and z
    // is "across" depends on which way the wall faces, and a wall at 30
    // degrees (the castle's towers) is neither — the hypotenuse of the two
    // is the width in every case, including the square ones.
    const w = Math.hypot(size.x, size.z) * PANE_FILL;
    const h = size.y * PANE_FILL;
    if (w < 1e-3 || h < 1e-3) continue;
    const pane = glow(new THREE.PlaneGeometry(w, h), lantern);
    pane.name = 'windowPane';
    pane.position.copy(center).addScaledVector(v.normal, PANE_STANDOFF);
    pane.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      v.normal.clone().normalize(),
    );
    // A per-window seed, so the panes breathe out of step: one lamp
    // guttering behind every window of a keep at once is a lighthouse.
    pane.userData.seed = (i * 0.618) % 1;
    g.add(pane);
  }
  return g.children.length > 0 ? g : null;
}

/**
 * The nodes this file hangs on a building that are NOT its walls.
 *
 * buildingSync marks a building's meshes as x-ray occluders — every
 * fragment stamps a stencil bit where it wins the depth test, and a unit
 * standing behind one gets an outline. Nothing here may be marked, for two
 * separate reasons that happen to have the same answer:
 *
 *   - the glow is light, not stone. It is drawn transparent and writes no
 *     depth, and a marked pane would also have its material swapped for an
 *     occluder twin — which is a material `setTrainingLevel` is then no
 *     longer setting the opacity of. The cue would simply stop working.
 *   - the yard props stand OUTSIDE the footprint, and the occluder boxes
 *     only ever vouch for the footprint (the fishery's pier is excluded for
 *     exactly this). A banner pole that stamped the bit would draw an
 *     outline over a serf walking past it on open grass.
 */
export const TRAINING_NODES: ReadonlySet<string> = new Set([
  'windowGlow',
  'trainBrazier',
  'musterBanner',
  'drillPell',
  'arrowLane',
]);

// ——— Driving it ———

/**
 * Everything on one building that answers to the training level, harvested
 * from its model once. Any of it may be absent: the castle keeps no pell,
 * the range's butts are the pack's own, and a model with no openings has no
 * panes.
 */
export interface TrainingRig {
  panes: THREE.Mesh[];
  /** One per fire: a building may light more than one (the castle flanks
   * its gate with a pair), and a single slot here meant the second brazier
   * quietly took the first one's place and left it standing dark. */
  coals: THREE.Mesh[];
  flames: THREE.Object3D[];
  hoist?: THREE.Object3D;
  cloth?: THREE.Mesh;
  /** The cloth's vertices as authored, for the ripple to be written
   * against — a wave applied to the last frame's positions would walk. */
  clothRest?: Float32Array;
  pell?: THREE.Object3D;
  arrows: THREE.Object3D[];
}

/** Harvest the training cue off a built model. Returns null when the model
 * carries none of it, which is every building but the three. */
export function harvestTrainingRig(model: THREE.Object3D): TrainingRig | null {
  const rig: TrainingRig = {panes: [], coals: [], flames: [], arrows: []};
  model.traverse(o => {
    switch (o.name) {
      case 'windowPane':
        if (o instanceof THREE.Mesh) rig.panes.push(o);
        break;
      case 'brazierCoals':
        if (o instanceof THREE.Mesh) rig.coals.push(o);
        break;
      case 'brazierFlames':
        rig.flames.push(o);
        break;
      case 'bannerHoist':
        rig.hoist = o;
        break;
      case 'bannerCloth':
        if (o instanceof THREE.Mesh) rig.cloth = o;
        break;
      case 'pellPost':
        rig.pell = o;
        break;
      case 'laneArrow':
        rig.arrows.push(o);
        break;
      default:
        break;
    }
  });
  if (
    rig.panes.length === 0 &&
    rig.arrows.length === 0 &&
    rig.coals.length === 0 &&
    !rig.hoist &&
    !rig.pell
  ) {
    return null;
  }
  if (rig.cloth) {
    const pos = rig.cloth.geometry.getAttribute('position');
    rig.clothRest = Float32Array.from(pos.array);
  }
  return rig;
}

/**
 * Clone every material the rig drives, so one building's fire is its own.
 *
 * Built models share their template's materials — that is what makes a
 * village of forty huts one draw call's worth of state — and the level
 * here rides on opacity, which would otherwise be the same opacity for
 * every barracks on the map. Returns what was cloned, for disposal.
 */
export function ownTrainingMaterials(rig: TrainingRig): THREE.Material[] {
  const owned: THREE.Material[] = [];
  const own = (m: THREE.Mesh | undefined): void => {
    if (!m) return;
    const clone = (m.material as THREE.Material).clone();
    m.material = clone;
    owned.push(clone);
  };
  for (const pane of rig.panes) own(pane);
  for (const coals of rig.coals) own(coals);
  for (const flames of rig.flames)
    for (const tongue of flames.children) own(tongue as THREE.Mesh);
  return owned;
}

/** How hard the pell is struck, radians at full tilt. */
const PELL_SWING = 0.075;
/** Blows per second — a drill's beat, not a frenzy. */
const PELL_BEAT = 1.35;
/** One arrow's whole cycle, seconds: flight, stuck in the butt, gone. */
const ARROW_CYCLE = 3.4;
/** The flight, as a fraction of that cycle. */
const ARROW_FLIGHT = 0.1;
/** How long it stands in the butt afterwards, same units. */
const ARROW_STUCK = 0.62;

/**
 * Put the whole rig at `level` (0 cold, 1 a course in full swing) at time
 * `t` seconds.
 *
 * One function rather than one per part because they are one cue: the
 * level is eased by the caller (buildingSync, the same way the chimney
 * smoke's is) and everything here is a pure read of it. `t` is a running
 * clock, not a delta — every motion in here is periodic, so a building
 * picked up mid-drill carries on from where the yard would be rather than
 * restarting its beat.
 */
export function setTrainingLevel(
  rig: TrainingRig,
  level: number,
  t: number,
): void {
  const lit = level > 0.02;

  for (const pane of rig.panes) {
    pane.visible = lit;
    if (!lit) continue;
    const seed = (pane.userData.seed as number) ?? 0;
    // A lamp behind a shutter, not a strobe: the flicker rides high and
    // narrow, so what changes is the life in the light, not whether it
    // is on.
    const flicker = 0.88 + 0.12 * Math.sin(t * 3.1 + seed * 12.9);
    (pane.material as THREE.MeshBasicMaterial).opacity = level * flicker;
  }

  for (let f = 0; f < rig.coals.length; f++) {
    const coals = rig.coals[f]!;
    coals.visible = lit;
    if (lit) {
      // Each fire on its own beat, so a flanked gate is two fires and not
      // one fire drawn twice.
      (coals.material as THREE.MeshBasicMaterial).opacity =
        level * (0.72 + 0.16 * Math.sin(t * 2.3 + f * 1.9));
    }
  }
  for (let f = 0; f < rig.flames.length; f++) {
    const flames = rig.flames[f]!;
    flames.visible = lit;
    for (let i = 0; i < flames.children.length; i++) {
      const tongue = flames.children[i] as THREE.Mesh;
      // The tongues are born hidden (`glow`), so the group's own visibility
      // is not enough — each one has to be lit as well as shown.
      tongue.visible = lit;
      if (lit) {
        // Each tongue on its own beat, so the pair licks rather than
        // pumping: height is most of it, width follows at a third.
        const w = Math.sin(t * (7.3 + i * 2.1) + i * 2.2 + f * 2.7);
        tongue.scale.set(1 + w * 0.12, level * (0.72 + 0.28 * w), 1 + w * 0.12);
        (tongue.material as THREE.MeshBasicMaterial).opacity =
          level * (0.78 + 0.16 * w);
      }
    }
  }

  if (rig.hoist) {
    // Up briskly, down the same way — a banner is hauled by hand at both
    // ends. The level itself is what eases (buildingSync), so the run up
    // the pole is the ease and this is only where it lands.
    rig.hoist.position.y =
      POLE_H * (HOIST_LOW + (HOIST_HIGH - HOIST_LOW) * level) - 0.02;
    rig.hoist.visible = level > 0.001;
  }
  if (rig.cloth && rig.clothRest) {
    const pos = rig.cloth.geometry.getAttribute('position');
    const rest = rig.clothRest;
    for (let i = 0; i < pos.count; i++) {
      const x = rest[i * 3]!;
      const y = rest[i * 3 + 1]!;
      // A travelling wave that grows toward the fly end: the hoist edge is
      // nailed to the pole and cannot move, the far edge is all it does.
      const along = (x + CLOTH_W / 2) / CLOTH_W;
      const wave =
        Math.sin(t * 3.6 - along * 5.4) * 0.014 * along * (0.35 + 0.65 * level);
      pos.setXYZ(i, x, y, wave);
    }
    pos.needsUpdate = true;
  }

  if (rig.pell) {
    // Struck, then let go: the blow is a spike the post springs back from,
    // so the beat has a shape rather than being a sine's smooth rocking.
    const beat = (t * PELL_BEAT) % 1;
    const swing = Math.sin(beat * Math.PI * 2) * Math.exp(-beat * 2.6);
    rig.pell.rotation.x = swing * PELL_SWING * level;
    rig.pell.rotation.z = swing * PELL_SWING * 0.4 * level;
  }

  for (const arrow of rig.arrows) {
    const shot = arrow.userData.shot as {
      from: THREE.Vector3;
      to: THREE.Vector3;
      phase: number;
    };
    if (!lit) {
      arrow.visible = false;
      continue;
    }
    const p = (t / ARROW_CYCLE + shot.phase) % 1;
    if (p > ARROW_STUCK) {
      // Pulled from the butt between ends — a range's arrows do not
      // accumulate forever, and the gap is what gives each butt a rhythm.
      arrow.visible = false;
      continue;
    }
    arrow.visible = true;
    const flying = Math.min(1, p / ARROW_FLIGHT);
    arrow.position.lerpVectors(shot.from, shot.to, flying);
    // A shot at this range is nearly flat; the sag is only what keeps it
    // from reading as a rail, and it is gone by the time the head lands.
    arrow.position.y += Math.sin(flying * Math.PI) * 0.02;
  }
}
