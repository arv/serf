import type { JSX } from 'solid-js';
import { goodName } from './names';
import { GoodId } from '../sim/defs/goods';

/**
 * Tiny inline-SVG icon set — no emoji, no assets. Goods use their palette
 * color so the HUD reads like the world does.
 */

const GOOD_HEX: Record<GoodId, string> = {
  [GoodId.water]: '#6da4cc',
  [GoodId.wheat]: '#e3bd45',
  [GoodId.wood]: '#ab8354',
  [GoodId.stone]: '#a29a8a',
  [GoodId.iron]: '#8d7d72',
  [GoodId.silver]: '#c8ced6',
  [GoodId.gold]: '#e0b74f',
  [GoodId.sword]: '#c4cdd6',
  [GoodId.spear]: '#c39c62',
  [GoodId.bow]: '#b08d57',
  [GoodId.ale]: '#d2963c',
  [GoodId.flour]: '#e4dcc9',
  [GoodId.food]: '#d9a860',
  // Tools carry the color of their business end; hafts share one wood tone.
  [GoodId.axe]: '#98a2ac',
  [GoodId.pickaxe]: '#8d8078',
  [GoodId.scythe]: '#c3cad2',
  [GoodId.hammer]: '#77848e',
  [GoodId.cauldron]: '#b0763f',
  [GoodId.rod]: '#a08a5f',
};

/** Good glyphs. Some (from the glass-HUD design handoff) are authored in a
 * 24-unit box and scaled into the 16-unit one. */
const PATHS: Record<GoodId, (c: string) => JSX.Element> = {
  // Droplet
  [GoodId.water]: (c) => (
    <path d="M8 1.5C8 1.5 3.5 7 3.5 10a4.5 4.5 0 0 0 9 0C12.5 7 8 1.5 8 1.5Z" fill={c} />
  ),
  // Wheat ear: stalk + grain ellipses
  [GoodId.wheat]: (c) => (
    <g transform="scale(0.667)">
      <path d="M12 22V8" stroke={c} stroke-width="2" fill="none" stroke-linecap="round" />
      <ellipse cx="12" cy="5" rx="2.6" ry="3.6" fill={c} />
      <ellipse cx="7.4" cy="10" rx="2.4" ry="3.2" transform="rotate(-38 7.4 10)" fill={c} />
      <ellipse cx="16.6" cy="10" rx="2.4" ry="3.2" transform="rotate(38 16.6 10)" fill={c} />
      <ellipse cx="7.4" cy="15.5" rx="2.4" ry="3.2" transform="rotate(-38 7.4 15.5)" fill={c} />
      <ellipse cx="16.6" cy="15.5" rx="2.4" ry="3.2" transform="rotate(38 16.6 15.5)" fill={c} />
    </g>
  ),
  // Log with end-grain
  [GoodId.wood]: (c) => (
    <g transform="scale(0.667)">
      <rect x="3" y="9" width="18" height="6" rx="3" fill={c} />
      <circle cx="18" cy="12" r="3" fill="#d4af7e" />
      <circle cx="18" cy="12" r="1.3" fill={c} />
    </g>
  ),
  // Boulder
  [GoodId.stone]: (c) => <path d="M3 12.5 2 10l2-4.5L8.5 4l4 1.5L14 9l-1.5 3.5H3Z" fill={c} />,
  // Ingot
  [GoodId.iron]: (c) => <path d="M4.5 5.5h7L14 11.5H2L4.5 5.5Z" fill={c} />,
  // Silver penny: round coin struck with a short cross
  [GoodId.silver]: (c) => (
    <g transform="scale(0.667)">
      <circle cx="12" cy="12" r="8.4" fill={c} />
      <path
        d="M12 4.4v15.2M4.4 12h15.2"
        stroke="#79818c"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </g>
  ),
  // Stack of gold coins
  [GoodId.gold]: (c) => (
    <g transform="scale(0.667)" stroke="#8a6a1e" stroke-width="0.9">
      <ellipse cx="12" cy="16.8" rx="7.4" ry="2.9" fill={c} />
      <ellipse cx="12" cy="12.6" rx="7.4" ry="2.9" fill={c} />
      <ellipse cx="12" cy="8.4" rx="7.4" ry="2.9" fill={c} />
    </g>
  ),
  // Straight sword: blade + crossguard + grip
  [GoodId.sword]: (c) => (
    <g transform="scale(0.667)" fill="none" stroke-linecap="round">
      <path d="M19 5L9 15" stroke={c} stroke-width="2.6" />
      <path d="M6.5 12.5l5 5" stroke="#a08356" stroke-width="2.4" />
      <path d="M5 19l2.5-2.5" stroke="#a08356" stroke-width="2.4" />
    </g>
  ),
  // Spear: straight shaft + leaf tip
  [GoodId.spear]: (c) => (
    <g>
      <path d="M7.3 6.5 8 1.5l.7 5a1.6 1.6 0 0 1-1.4 0Z" fill={c} />
      <path d="M8 6.5v8" stroke={c} stroke-width="1.4" stroke-linecap="round" />
    </g>
  ),
  // Bow arc with string
  [GoodId.bow]: (c) => (
    <g stroke={c} stroke-width="1.4" fill="none" stroke-linecap="round">
      <path d="M4.5 1.5C10 4 10 12 4.5 14.5" />
      <path d="M4.5 1.5v13" stroke-width="0.8" />
    </g>
  ),
  // Tankard: tapered mug, handle, foam head
  [GoodId.ale]: (c) => (
    <g transform="scale(0.667)">
      <path
        d="M6 7.5h9.5l-.8 12.2a1.6 1.6 0 0 1-1.6 1.5H8.4a1.6 1.6 0 0 1-1.6-1.5L6 7.5Z"
        fill={c}
      />
      <path d="M15.2 10.2h1.9a2.9 2.9 0 0 1 0 5.8h-1.9" fill="none" stroke={c} stroke-width="1.8" />
      <path d="M5.6 4.4h10.3a1.7 1.7 0 0 1 0 3.4H5.6a1.7 1.7 0 0 1 0-3.4Z" fill="#f4ecd8" />
      <circle cx="8.5" cy="3.9" r="2" fill="#f4ecd8" />
      <circle cx="13" cy="4.1" r="1.7" fill="#f4ecd8" />
    </g>
  ),
  // Sack, tied at the neck — the mill's output, and how flour travels
  [GoodId.flour]: (c) => (
    <g transform="scale(0.667)">
      <path
        d="M9 6.6h6c2.2 2.4 3.4 5.6 3.4 8.6 0 3-2.6 4.6-6.4 4.6s-6.4-1.6-6.4-4.6c0-3 1.2-6.2 3.4-8.6Z"
        fill={c}
      />
      <path d="M8.8 6.6c1-1.2 1.6-2.2 1.6-3.2h3.2c0 1 .6 2 1.6 3.2H8.8Z" fill="#b9ae96" />
      <path d="M9.6 14.6h4.8" stroke="#b9ae96" stroke-width="1.4" stroke-linecap="round" />
    </g>
  ),
  // Round loaf, slashed across the crust
  [GoodId.food]: (c) => (
    <g transform="scale(0.667)">
      <path
        d="M3.4 13.6c0-3.8 3.8-6.6 8.6-6.6s8.6 2.8 8.6 6.6c0 2.6-3.8 4.2-8.6 4.2s-8.6-1.6-8.6-4.2Z"
        fill={c}
      />
      <path
        d="M7.6 11.2l2 2.4M11.4 10.4l2 2.4M15.2 11.2l1.8 2.2"
        stroke="#8f6533"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </g>
  ),
  // Felling axe: broad steel bit on a long haft
  [GoodId.axe]: (c) => (
    <g transform="scale(0.667)">
      <path
        d="M8 21.5 15 8"
        stroke="#8a6a42"
        stroke-width="2.2"
        stroke-linecap="round"
        fill="none"
      />
      <path d="M12.4 3.6c3.4-1.2 6.6-.2 8.4 2-1.2 3-3.4 5-6.4 6-1.8-2.6-2.4-5.4-2-8Z" fill={c} />
    </g>
  ),
  // Miner's pick: curved twin-spike head over a straight haft
  [GoodId.pickaxe]: (c) => (
    <g transform="scale(0.667)">
      <path d="M12 7.5v14" stroke="#8a6a42" stroke-width="2.2" stroke-linecap="round" fill="none" />
      <path
        d="M3.4 8.6C6 4.4 9.6 2.6 12 2.6s6 1.8 8.6 6c-2.2-2-5.2-3-8.6-3s-6.4 1-8.6 3Z"
        fill={c}
      />
    </g>
  ),
  // Scythe: long snath, blade swept out from the heel
  [GoodId.scythe]: (c) => (
    <g transform="scale(0.667)">
      <path
        d="M9 21.5 13 4.8"
        stroke="#8a6a42"
        stroke-width="2.2"
        stroke-linecap="round"
        fill="none"
      />
      <path
        d="M12.6 4.8c2.8-2.2 6.6-2.4 9-.6-1.8 3.4-5.2 5.2-9.2 4.8-.2-1.6-.2-3 .2-4.2Z"
        fill={c}
      />
    </g>
  ),
  // Smith's hammer: square steel head, straight haft
  [GoodId.hammer]: (c) => (
    <g transform="scale(0.667)">
      <path d="M12 9v12.5" stroke="#8a6a42" stroke-width="2.2" stroke-linecap="round" fill="none" />
      <rect x="5.5" y="3.2" width="13" height="6" rx="1.4" fill={c} />
    </g>
  ),
  // Cauldron: round-bottomed copper pot on legs, dark rim
  [GoodId.cauldron]: (c) => (
    <g transform="scale(0.667)">
      <path d="M4.5 8.5c1 7 3.5 10 7.5 10s6.5-3 7.5-10Z" fill={c} />
      <ellipse cx="12" cy="8.2" rx="8.2" ry="2.1" fill="#7d5127" />
      <path
        d="M8.4 18.2 7.4 21M15.6 18.2l1 2.8"
        stroke={c}
        stroke-width="1.6"
        stroke-linecap="round"
        fill="none"
      />
    </g>
  ),
  // Fishing rod: bent cane, line and hook
  [GoodId.rod]: (c) => (
    <g fill="none" stroke-linecap="round">
      <path d="M2.5 14.5C7 12 11 7.5 13 2" stroke={c} stroke-width="1.6" />
      <path d="M13 2c.5 4 .2 7-.4 9.5" stroke="#d8d3c5" stroke-width="0.8" />
      <path d="M12.6 11.5a1.4 1.4 0 1 0 1.5 1.3" stroke="#d8d3c5" stroke-width="0.9" />
    </g>
  ),
};

/**
 * `decorative` for the places the good is already named in text beside the
 * icon — a labelled icon there is read out twice ("Wood 5 Wood"). The
 * label stays on by default, since in the HUD the icon is often the only
 * name a number has.
 */
export function GoodIcon(props: { good: GoodId; size?: number; decorative?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={props.size ?? 14}
      height={props.size ?? 14}
      style={{ 'vertical-align': '-2px' }}
      aria-hidden={props.decorative === true ? 'true' : undefined}
      aria-label={props.decorative === true ? undefined : goodName(props.good)}
    >
      {PATHS[props.good](GOOD_HEX[props.good])}
    </svg>
  );
}

export function LockIcon(props: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={props.size ?? 12}
      height={props.size ?? 12}
      style={{ 'vertical-align': '-1px' }}
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
      <path d="M1 3v10l5.5-5L1 3Zm5.5 0v10L12 8 6.5 3Zm5.5 0v10l5.5-5L12 3Z" fill="currentColor" />
    </svg>
  );
}

/** Band-select: viewfinder corners, the box you are about to drag. */
export function BandIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" style={{ 'vertical-align': '-2px' }}>
      <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
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
    <svg viewBox="0 0 16 16" width="14" height="14" style={{ 'vertical-align': '-2px' }}>
      <g fill="none" stroke-linecap="round">
        <path d="M3.2 2.6l8.2 8.2M12.8 2.6l-8.2 8.2" stroke="#aeb6bf" stroke-width="1.7" />
        <path d="M9.6 12.2l2.6-2.6M3.8 9.6l2.6 2.6" stroke="#c8a84a" stroke-width="1.6" />
        <path d="M12.6 13.2l1 1M3.4 13.2l-1 1" stroke="#8a6a42" stroke-width="1.8" />
      </g>
    </svg>
  );
}

/** A head and shoulders: the population readout's glyph. */
export function PopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" style={{ 'vertical-align': '-2px' }}>
      <circle cx="8" cy="5.4" r="3" fill="currentColor" />
      <path d="M2.6 14.4a5.4 5.4 0 0 1 10.8 0Z" fill="currentColor" />
    </svg>
  );
}

/** An open eye: the whole valley in view (replay fog toggle). */
export function EyeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" style={{ 'vertical-align': '-2px' }}>
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
    <svg viewBox="0 0 16 16" width="14" height="14" style={{ 'vertical-align': '-2px' }}>
      <path
        d="M1.5 8C3 4.9 5.3 3.4 8 3.4S13 4.9 14.5 8C13 11.1 10.7 12.6 8 12.6S3 11.1 1.5 8Z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
      />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      <path d="M3 13L13 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  );
}

/** Speaker and cone, for the sound toggle. */
export function SpeakerIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" style={{ 'vertical-align': '-2px' }}>
      <path
        d="M2.6 6.1h2.3L8.2 3.2v9.6L4.9 9.9H2.6a.9.9 0 0 1-.9-.9V7a.9.9 0 0 1 .9-.9Z"
        fill="currentColor"
      />
      <g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
        <path d="M10.5 6.3a2.6 2.6 0 0 1 0 3.4" />
        <path d="M12.5 4.5a5.2 5.2 0 0 1 0 7" />
      </g>
    </svg>
  );
}

/** The same cone with the waves struck out: sound off. */
export function SpeakerOffIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" style={{ 'vertical-align': '-2px' }}>
      <path
        d="M2.6 6.1h2.3L8.2 3.2v9.6L4.9 9.9H2.6a.9.9 0 0 1-.9-.9V7a.9.9 0 0 1 .9-.9Z"
        fill="currentColor"
      />
      <g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
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
      style={{ 'vertical-align': '-2px' }}
      aria-label="Ledger"
    >
      <g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
        <rect x="2.5" y="1.8" width="11" height="12.4" rx="1.6" />
        <path d="M5 5.2h6M5 8h6M5 10.8h3.5" />
      </g>
    </svg>
  );
}

/** The builder's mallet, for the build menu. */
export function MalletIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" style={{ 'vertical-align': '-2px' }}>
      <path
        d="M9 8.6L3.6 14"
        stroke="#a08356"
        stroke-width="1.9"
        stroke-linecap="round"
        fill="none"
      />
      <path d="M6.6 4.4 11.4 9.2 14 6.6 13.2 3.4 10 2.4 6.6 4.4Z" fill="#9aa3ad" />
      <path d="M6.6 4.4 11.4 9.2" stroke="#79818c" stroke-width="1" />
    </svg>
  );
}
