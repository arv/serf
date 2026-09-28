import type {JSX} from 'solid-js';
import type {Enum} from '../shared/enum.ts';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';
import {goodName, unitName} from './names';

type GoodId = Enum<typeof GoodId>;
type UnitTypeId = Enum<typeof UnitTypeId>;

/**
 * Tiny inline-SVG icon set — no emoji, no assets.
 */

/** The log's body and every haft: one wood tone across the tools. */
const WOOD_TONE = '#b8733f';
/** The bow's stave, stroked twice (dark rim, light core). */
const BOW_STAVE = 'M15 5Q40 24 15 43';
/** The tankard's handle, stroked twice (dark rim, light core). */
const ALE_HANDLE = 'M31 25A5 5 0 0 1 41 25V29A5 5 0 0 1 31 29Z';

/**
 * Good glyphs, from the HUD-restyle handoff: chunky fills in a 48-unit box,
 * every shape ringed in one warm brown outline (see GoodIcon), so the goods
 * read as a set on the dark HUD glass and the field guide's parchment alike.
 * Each glyph carries its own colors; a stroke or width set here overrides
 * the shared outline for that shape only.
 */
const PATHS: Record<GoodId, () => JSX.Element> = {
  // Droplet with a highlight
  [GoodId.water]: () => (
    <>
      <path
        d="M24 5C20 12 11 20 11 29A13 13 0 0 0 37 29C37 20 28 12 24 5Z"
        fill="#4f9fe6"
      />
      <ellipse cx="18.5" cy="29" rx="2.5" ry="5" fill="#c4e4ff" stroke="none" />
    </>
  ),
  // Wheat ear: stalk + five grains
  [GoodId.wheat]: () => (
    <>
      <rect x="22" y="14" width="4" height="30" rx="2" fill="#d9a52a" />
      <ellipse cx="24" cy="10" rx="4.5" ry="6.5" fill="#f5c93f" />
      <ellipse
        cx="16.5"
        cy="19"
        rx="4.5"
        ry="6.5"
        fill="#f5c93f"
        transform="rotate(-35 16.5 19)"
      />
      <ellipse
        cx="31.5"
        cy="19"
        rx="4.5"
        ry="6.5"
        fill="#f5c93f"
        transform="rotate(35 31.5 19)"
      />
      <ellipse
        cx="16.5"
        cy="29"
        rx="4.5"
        ry="6.5"
        fill="#f5c93f"
        transform="rotate(-35 16.5 29)"
      />
      <ellipse
        cx="31.5"
        cy="29"
        rx="4.5"
        ry="6.5"
        fill="#f5c93f"
        transform="rotate(35 31.5 29)"
      />
    </>
  ),
  // Log with end-grain
  [GoodId.wood]: () => (
    <>
      <rect x="5" y="15" width="34" height="18" rx="9" fill={WOOD_TONE} />
      <path d="M12 20H28" fill="none" stroke="#dc9a5e" stroke-width="2.5" />
      <ellipse cx="37" cy="24" rx="6" ry="9" fill="#f0c48a" />
      <ellipse
        cx="37"
        cy="24"
        rx="2"
        ry="3.5"
        fill="none"
        stroke="#c98a4e"
        stroke-width="2"
      />
    </>
  ),
  // Boulder, lit from above
  [GoodId.stone]: () => (
    <>
      <path d="M9 35 7 25 15 14 30 11 41 19V32L33 39H15Z" fill="#a4aaad" />
      <path d="M16 16 29 13 35 18 19 21Z" fill="#d4d8da" stroke="none" />
    </>
  ),
  // Ingot
  [GoodId.iron]: () => (
    <>
      <path d="M8 36 14 20H34L40 36Z" fill="#737c84" />
      <path d="M14 20H34L32 25H16Z" fill="#9aa3aa" stroke="none" />
    </>
  ),
  // Silver penny: milled rim and a glint
  [GoodId.silver]: () => (
    <>
      <circle cx="24" cy="24" r="17" fill="#dfe5ea" />
      <circle
        cx="24"
        cy="24"
        r="11"
        fill="none"
        stroke="#9fabb4"
        stroke-width="3"
      />
      <path
        d="M14 17Q17 12 22 10"
        fill="none"
        stroke="#ffffff"
        stroke-width="2.5"
      />
    </>
  ),
  // Stack of gold bars
  [GoodId.gold]: () => (
    <>
      <rect x="8" y="30" width="32" height="10" rx="5" fill="#e0a92a" />
      <rect x="10" y="21" width="30" height="10" rx="5" fill="#eeb92f" />
      <rect x="8" y="12" width="32" height="10" rx="5" fill="#f7cf45" />
      <path d="M14 16H28" fill="none" stroke="#fff0a8" stroke-width="2.5" />
    </>
  ),
  // Straight sword: blade, gilt crossguard, grip and pommel
  [GoodId.sword]: () => (
    <g transform="rotate(45 24 24)">
      <path d="M24 1 29 7V30H19V7Z" fill="#e3e9ed" />
      <rect x="13" y="29" width="22" height="6" rx="3" fill="#d9a52a" />
      <rect x="21.5" y="35" width="5" height="8" fill="#8a4f2a" />
      <circle cx="24" cy="45" r="3" fill="#f5c93f" />
    </g>
  ),
  // Spear: shaft + diamond head
  [GoodId.spear]: () => (
    <g transform="rotate(40 24 24)">
      <rect x="22" y="15" width="4" height="31" rx="2" fill={WOOD_TONE} />
      <path d="M24 1 31 13 24 19 17 13Z" fill="#d6dde2" />
    </g>
  ),
  // Bow: stave with string
  [GoodId.bow]: () => (
    <>
      <path d={BOW_STAVE} fill="none" stroke="#9a5e28" stroke-width="7" />
      <path d={BOW_STAVE} fill="none" stroke="#d6934a" stroke-width="3" />
      <path d="M15 6V42" fill="none" stroke="#f4ecda" stroke-width="2" />
    </>
  ),
  // Tankard: mug, handle, foam head
  [GoodId.ale]: () => (
    <>
      <path d={ALE_HANDLE} fill="none" stroke="#b8741f" stroke-width="6" />
      <path d={ALE_HANDLE} fill="none" stroke="#e39a34" stroke-width="2" />
      <rect x="10" y="15" width="24" height="27" rx="4" fill="#e39a34" />
      <path d="M16 22V36" fill="none" stroke="#f7c26b" stroke-width="2.5" />
      <circle cx="14" cy="15" r="5.5" fill="#fff6e0" />
      <circle cx="22" cy="12" r="6.5" fill="#fff6e0" />
      <circle cx="30" cy="15" r="5.5" fill="#fff6e0" />
    </>
  ),
  // Sack, tied at the neck — the mill's output, and how flour travels
  [GoodId.flour]: () => (
    <>
      <path
        d="M17 16Q10 24 10 32Q10 41 24 41Q38 41 38 32Q38 24 31 16Z"
        fill="#f4ecda"
      />
      <path d="M17 16 14 8Q19 11 24 8Q29 11 34 8L31 16Z" fill="#f4ecda" />
      <rect x="15" y="14" width="18" height="5" rx="2.5" fill="#c9a36b" />
      <path
        d="M16 30Q16 36 22 37"
        fill="none"
        stroke="#fffaf0"
        stroke-width="2.5"
      />
    </>
  ),
  // Round loaf, slashed across the crust
  [GoodId.food]: () => (
    <>
      <ellipse cx="24" cy="27" rx="18" ry="12" fill="#e39a4a" />
      <path
        d="M12 22Q24 14 36 22"
        fill="none"
        stroke="#f5c07e"
        stroke-width="2.5"
      />
      <path
        d="M15 25l3 5M22 23l3 5M29 25l3 5"
        fill="none"
        stroke="#b8672c"
        stroke-width="3"
      />
    </>
  ),
  // Felling axe: broad steel bit on a long haft. Dropped 1.5 so the tilted
  // bit's outline clears the top edge of the box.
  [GoodId.axe]: () => (
    <g transform="translate(0 1.5) rotate(-25 24 24)">
      <rect x="21" y="8" width="5" height="37" rx="2.5" fill={WOOD_TONE} />
      <path d="M25 9 38 4Q44 15 38 27L25 21Z" fill="#cdd5db" />
    </g>
  ),
  // Miner's pick: curved twin-spike head over a straight haft
  [GoodId.pickaxe]: () => (
    <>
      <rect x="21.5" y="13" width="5" height="32" rx="2.5" fill={WOOD_TONE} />
      <path d="M4 20Q24 2 44 20L41 23Q24 12 7 23Z" fill="#9aa3aa" />
    </>
  ),
  // Scythe: long snath, blade swept out from the heel. Shifted 1.5 left so
  // the blade tip's outline clears the right edge of the box.
  [GoodId.scythe]: () => (
    <g transform="translate(-1.5 0) rotate(12 24 24)">
      <rect x="21" y="7" width="5" height="38" rx="2.5" fill={WOOD_TONE} />
      <path d="M24 9Q38 1 46 13Q35 11 26 18Z" fill="#e3e9ed" />
    </g>
  ),
  // Smith's hammer: square steel head, straight haft
  [GoodId.hammer]: () => (
    <>
      <rect x="21.5" y="18" width="5" height="27" rx="2.5" fill={WOOD_TONE} />
      <rect x="10" y="6" width="28" height="14" rx="3.5" fill="#7d8b99" />
      <path d="M14 10H30" fill="none" stroke="#aab5c0" stroke-width="2.5" />
    </>
  ),
  // Cauldron: round-bottomed copper pot on legs, lipped rim
  [GoodId.cauldron]: () => (
    <>
      <rect x="12" y="33" width="5" height="10" rx="2" fill="#6e3a1f" />
      <rect x="31" y="33" width="5" height="10" rx="2" fill="#6e3a1f" />
      <path d="M9 18H39Q40 39 24 39Q8 39 9 18Z" fill="#c86a2e" />
      <rect x="6" y="13" width="36" height="7" rx="3.5" fill="#e8914f" />
      <path
        d="M14 25Q15 32 20 34"
        fill="none"
        stroke="#e8914f"
        stroke-width="2.5"
      />
    </>
  ),
  // Fishing rod: cane, line, float and hook
  [GoodId.rod]: () => (
    <>
      <rect
        x="22"
        y="3"
        width="4"
        height="44"
        rx="2"
        fill="#c9853f"
        transform="rotate(38 24 24)"
      />
      <path d="M37 8V33" fill="none" stroke="#3d1f12" stroke-width="2" />
      <path
        d="M37 33v3a3.5 3.5 0 0 1-7 0"
        fill="none"
        stroke="#b9c2c8"
        stroke-width="2.5"
      />
      <circle cx="37" cy="26" r="4" fill="#e0573a" />
    </>
  ),
};

/**
 * `decorative` for the places the good is already named in text beside the
 * icon — a labelled icon there is read out twice ("Wood 5 Wood"). The
 * label stays on by default, since in the HUD the icon is often the only
 * name a number has.
 */
export function GoodIcon(props: {
  good: GoodId;
  size?: number;
  decorative?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={props.size ?? 14}
      height={props.size ?? 14}
      style={{'vertical-align': '-2px'}}
      role={props.decorative === true ? undefined : 'img'}
      aria-hidden={props.decorative === true ? 'true' : undefined}
      aria-label={props.decorative === true ? undefined : goodName(props.good)}
    >
      <g
        stroke="#7a4526"
        stroke-width="2.2"
        stroke-linejoin="round"
        stroke-linecap="round"
      >
        {PATHS[props.good]()}
      </g>
    </svg>
  );
}

export function LockIcon(props: {size?: number}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={props.size ?? 12}
      height={props.size ?? 12}
      style={{'vertical-align': '-1px'}}
    >
      <path
        d="M4.5 7V5.5a3.5 3.5 0 0 1 7 0V7h.8a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H3.7a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h.8Zm1.6 0h3.8V5.5a1.9 1.9 0 0 0-3.8 0V7Z"
        fill="#9a8f7a"
        fill-rule="evenodd"
      />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12">
      <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor" />
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12">
      <path d="M4 2.5v11l9-5.5-9-5.5Z" fill="currentColor" />
    </svg>
  );
}

export function FastIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="12">
      <path d="M1.5 3v10L8 8 1.5 3Zm7 0v10L15 8 8.5 3Z" fill="currentColor" />
    </svg>
  );
}

/** Triple chevron: the replay-only speed above fast forward. */
export function FastestIcon() {
  return (
    <svg viewBox="0 0 18 16" width="15" height="12">
      <path
        d="M1 3v10l5.5-5L1 3Zm5.5 0v10L12 8 6.5 3Zm5.5 0v10l5.5-5L12 3Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Band-select: viewfinder corners, the box you are about to drag. */
export function BandIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      style={{'vertical-align': '-2px'}}
    >
      <g
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      >
        <path d="M2 5V3.5A1.5 1.5 0 0 1 3.5 2H5" />
        <path d="M11 2h1.5A1.5 1.5 0 0 1 14 3.5V5" />
        <path d="M14 11v1.5a1.5 1.5 0 0 1-1.5 1.5H11" />
        <path d="M5 14H3.5A1.5 1.5 0 0 1 2 12.5V11" />
      </g>
    </svg>
  );
}

/** Crossed swords for mustering the army. */
export function SwordsIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      style={{'vertical-align': '-2px'}}
    >
      <g fill="none" stroke-linecap="round">
        <path
          d="M3.2 2.6l8.2 8.2M12.8 2.6l-8.2 8.2"
          stroke="#aeb6bf"
          stroke-width="1.7"
        />
        <path
          d="M9.6 12.2l2.6-2.6M3.8 9.6l2.6 2.6"
          stroke="#c8a84a"
          stroke-width="1.6"
        />
        <path
          d="M12.6 13.2l1 1M3.4 13.2l-1 1"
          stroke="#8a6a42"
          stroke-width="1.8"
        />
      </g>
    </svg>
  );
}

/** A head and shoulders: the population readout's glyph. */
export function PopIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      style={{'vertical-align': '-2px'}}
    >
      <circle cx="8" cy="5.4" r="3" fill="currentColor" />
      <path d="M2.6 14.4a5.4 5.4 0 0 1 10.8 0Z" fill="currentColor" />
    </svg>
  );
}

/** An open eye: the whole valley in view (replay fog toggle). */
export function EyeIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      style={{'vertical-align': '-2px'}}
    >
      <path
        d="M1.5 8C3 4.9 5.3 3.4 8 3.4S13 4.9 14.5 8C13 11.1 10.7 12.6 8 12.6S3 11.1 1.5 8Z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
      />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  );
}

/** The same eye struck out: fog of war hides what the seat never saw. */
export function EyeOffIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      style={{'vertical-align': '-2px'}}
    >
      <path
        d="M1.5 8C3 4.9 5.3 3.4 8 3.4S13 4.9 14.5 8C13 11.1 10.7 12.6 8 12.6S3 11.1 1.5 8Z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
      />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      <path
        d="M3 13L13 3"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
  );
}

/** Speaker and cone, for the sound toggle. */
export function SpeakerIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      style={{'vertical-align': '-2px'}}
    >
      <path
        d="M2.6 6.1h2.3L8.2 3.2v9.6L4.9 9.9H2.6a.9.9 0 0 1-.9-.9V7a.9.9 0 0 1 .9-.9Z"
        fill="currentColor"
      />
      <g
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      >
        <path d="M10.5 6.3a2.6 2.6 0 0 1 0 3.4" />
        <path d="M12.5 4.5a5.2 5.2 0 0 1 0 7" />
      </g>
    </svg>
  );
}

/** The same cone with the waves struck out: sound off. */
export function SpeakerOffIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      style={{'vertical-align': '-2px'}}
    >
      <path
        d="M2.6 6.1h2.3L8.2 3.2v9.6L4.9 9.9H2.6a.9.9 0 0 1-.9-.9V7a.9.9 0 0 1 .9-.9Z"
        fill="currentColor"
      />
      <g
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
      >
        <path d="M10.9 6.4l3.5 3.4" />
        <path d="M14.4 6.4l-3.5 3.4" />
      </g>
    </svg>
  );
}

/** The ledger: ruled lines with entries — the strip's "all goods" chip. */
export function LedgerIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      style={{'vertical-align': '-2px'}}
      aria-label="Ledger"
    >
      <g
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      >
        <rect x="2.5" y="1.8" width="11" height="12.4" rx="1.6" />
        <path d="M5 5.2h6M5 8h6M5 10.8h3.5" />
      </g>
    </svg>
  );
}

/** The builder's mallet, for the build menu. */
export function MalletIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      style={{'vertical-align': '-2px'}}
    >
      <path
        d="M9 8.6L3.6 14"
        stroke="#a08356"
        stroke-width="1.9"
        stroke-linecap="round"
        fill="none"
      />
      <path
        d="M6.6 4.4 11.4 9.2 14 6.6 13.2 3.4 10 2.4 6.6 4.4Z"
        fill="#9aa3ad"
      />
      <path d="M6.6 4.4 11.4 9.2" stroke="#79818c" stroke-width="1" />
    </svg>
  );
}

/**
 * ——— The people ———
 *
 * One glyph per kind of person, for the selection card: what a serf is,
 * what a knight is, and which of the two the player has just picked up.
 * Drawn as what they carry rather than as faces, because at 16px a face is
 * a smudge and a spear is a spear — and the weapon is what the model on
 * the ground is recognised by anyway (see render/characters.ts: the knight
 * has sword and shield, the ranger a bow, the barbarian a two-handed axe).
 *
 * Unlike the goods, these are not one path in one color: a spear is a wooden
 * haft with a steel head, and flattening that to a single tint loses the
 * shape at the size it is read at.
 */
const LINEN = '#c9b795';
const SKIN = '#d8b48c';
const STEEL = '#c4cdd6';
const DARK_STEEL = '#79818c';
const HAFT = '#a5824f';
const STRAW = '#d3ab5c';
const ROGUE = '#8b93a0';

/** Head and shoulders, the body every villager glyph is built on. */
function villager(cloth: string): JSX.Element {
  return (
    <>
      <circle cx="7.6" cy="5.4" r="2.9" fill={SKIN} />
      <path d="M2.4 14.6a5.2 5.2 0 0 1 10.4 0Z" fill={cloth} />
    </>
  );
}

/**
 * The bow both archers carry, in whichever wood the faction stains it. The
 * stave bows away from the archer and the string is drawn back toward him,
 * so the shot — and the arrow across the riser — goes right.
 */
function bow(stave: string, tip: string): JSX.Element {
  return (
    <>
      <path
        d="M6.2 2.4a7.5 7.5 0 0 1 0 11.2"
        stroke={stave}
        stroke-width="1.6"
        fill="none"
        stroke-linecap="round"
      />
      <path
        d="M6.2 2.4 3.8 8l2.4 5.6"
        stroke="#e0dccf"
        stroke-width="0.8"
        fill="none"
      />
      <path
        d="M3.6 8h7"
        stroke={HAFT}
        stroke-width="1.1"
        stroke-linecap="round"
      />
      <path d="M12.6 8l-2.6-1.5v3Z" fill={tip} />
    </>
  );
}

const UNIT_PATHS: Record<UnitTypeId, () => JSX.Element> = {
  // A villager with a bundle on his back: the serf is the valley's legs,
  // and what he is doing is always carrying something somewhere.
  [UnitTypeId.serf]: () => (
    <>
      {villager(LINEN)}
      <rect x="11" y="7.4" width="4.2" height="4.2" rx="0.8" fill="#ab8354" />
      <path d="M11 9.5h4.2" stroke="#8a6a42" stroke-width="0.8" />
    </>
  ),
  // The same villager under a straw brim — the hat every trade in the
  // valley works in, and the one thing that tells a post from a haul.
  [UnitTypeId.worker]: () => (
    <>
      {villager('#b9a07c')}
      <ellipse cx="7.6" cy="4.2" rx="5.2" ry="1.5" fill={STRAW} />
      <path d="M5.1 4.1a2.5 2.5 0 0 1 5 0Z" fill="#e2c078" />
    </>
  ),
  // A great helm, visor and all: armor is the knight's whole point.
  [UnitTypeId.knight]: () => (
    <>
      <path
        d="M8 1.8c-2.7 0-4.4 1.8-4.4 4.4v3.4a4.4 4.4 0 0 0 8.8 0V6.2c0-2.6-1.7-4.4-4.4-4.4Z"
        fill={STEEL}
      />
      <path d="M3.8 6.4h8.4v1.6H3.8Z" fill={DARK_STEEL} />
      <path d="M8 8.6v4" stroke={DARK_STEEL} stroke-width="1" />
      <path d="M4.6 2.6h6.8" stroke={DARK_STEEL} stroke-width="1" />
    </>
  ),
  // A spear held upright: the cheap fast counter, and the only glyph that
  // is all reach.
  [UnitTypeId.spearman]: () => (
    <>
      <path
        d="M4.2 14 12 3.6"
        stroke={HAFT}
        stroke-width="1.5"
        stroke-linecap="round"
      />
      <path d="M13.9 1.4 10.6 3.1l1.5 2 2-2.1-.2-1.6Z" fill={STEEL} />
      <path d="M5.6 10.6 8 12.4" stroke={DARK_STEEL} stroke-width="1.2" />
    </>
  ),
  // A drawn bow, arrow nocked: the shape is the range.
  [UnitTypeId.archer]: () => bow(HAFT, STEEL),
  // A dagger, and the rogue's cold grey: what raids the valley rather than
  // what defends it.
  [UnitTypeId.bandit]: () => (
    <>
      <path d="M7.4 1.6 9.6 2.2 8.9 9.4 8.2 10.6 7.4 9.4Z" fill={STEEL} />
      <path d="M5.6 9.6h5.6v1.4H5.6Z" fill={ROGUE} />
      <path d="M7.6 11h1.8v3.4H7.6Z" fill="#6b4e2e" />
    </>
  ),
  // The same bow, stained the rogues' cold grey, with a spare shaft at the
  // feet: a raider who shoots, told apart from your own archer by the tone
  // rather than by a hood nobody can read at this size.
  [UnitTypeId.banditArcher]: () => (
    <>
      {bow(ROGUE, STEEL)}
      <path
        d="M1.4 14.5h2.6"
        stroke="#6b4e2e"
        stroke-width="1.1"
        stroke-linecap="round"
      />
      <path d="M5 14.5 3.6 13.8v1.4Z" fill={ROGUE} />
    </>
  ),
  // A two-handed axe, oversized on purpose: the heaviest thing that walks.
  [UnitTypeId.marauder]: () => (
    <>
      <path
        d="M10.6 3 5.4 14"
        stroke={HAFT}
        stroke-width="1.7"
        stroke-linecap="round"
      />
      <path
        d="M10.4 2.2c3 .5 4.4 2.6 3.8 5.4-2.4-1.9-4.6-1.8-6.2-.8Z"
        fill={STEEL}
      />
      <path d="M10.4 2.2 8 6.8" stroke={DARK_STEEL} stroke-width="0.9" />
    </>
  ),
};

/**
 * `decorative` for the places the kind is already named in text beside the
 * glyph — the single-unit card's head, where a labelled icon is read out
 * twice ("Knight Knight"). On the roster's tiles the icon *is* the name,
 * so the label stays on by default.
 */
export function UnitIcon(props: {
  unit: UnitTypeId;
  size?: number;
  decorative?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={props.size ?? 16}
      height={props.size ?? 16}
      style={{'vertical-align': '-2px'}}
      aria-hidden={props.decorative === true ? 'true' : undefined}
      aria-label={props.decorative === true ? undefined : unitName(props.unit)}
    >
      {UNIT_PATHS[props.unit]()}
    </svg>
  );
}
