import type { JSX } from 'solid-js';
import type { GoodId } from '../sim/defs/goods';
import { goodName } from './names';

/**
 * Tiny inline-SVG icon set — no emoji, no assets. Goods use their palette
 * color so the HUD reads like the world does.
 */

const GOOD_HEX: Record<GoodId, string> = {
  water: '#6da4cc',
  wheat: '#e3bd45',
  wood: '#ab8354',
  stone: '#a29a8a',
  iron: '#8d7d72',
  silver: '#c8ced6',
  gold: '#e0b74f',
  sword: '#c4cdd6',
  spear: '#c39c62',
  bow: '#b08d57',
  ale: '#d2963c',
};

/** Good glyphs. Some (from the glass-HUD design handoff) are authored in a
 * 24-unit box and scaled into the 16-unit one. */
const PATHS: Record<GoodId, (c: string) => JSX.Element> = {
  // Droplet
  water: (c) => <path d="M8 1.5C8 1.5 3.5 7 3.5 10a4.5 4.5 0 0 0 9 0C12.5 7 8 1.5 8 1.5Z" fill={c} />,
  // Wheat ear: stalk + grain ellipses
  wheat: (c) => (
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
  wood: (c) => (
    <g transform="scale(0.667)">
      <rect x="3" y="9" width="18" height="6" rx="3" fill={c} />
      <circle cx="18" cy="12" r="3" fill="#d4af7e" />
      <circle cx="18" cy="12" r="1.3" fill={c} />
    </g>
  ),
  // Boulder
  stone: (c) => <path d="M3 12.5 2 10l2-4.5L8.5 4l4 1.5L14 9l-1.5 3.5H3Z" fill={c} />,
  // Ingot
  iron: (c) => <path d="M4.5 5.5h7L14 11.5H2L4.5 5.5Z" fill={c} />,
  // Silver penny: round coin struck with a short cross
  silver: (c) => (
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
  gold: (c) => (
    <g transform="scale(0.667)" stroke="#8a6a1e" stroke-width="0.9">
      <ellipse cx="12" cy="16.8" rx="7.4" ry="2.9" fill={c} />
      <ellipse cx="12" cy="12.6" rx="7.4" ry="2.9" fill={c} />
      <ellipse cx="12" cy="8.4" rx="7.4" ry="2.9" fill={c} />
    </g>
  ),
  // Straight sword: blade + crossguard + grip
  sword: (c) => (
    <g transform="scale(0.667)" fill="none" stroke-linecap="round">
      <path d="M19 5L9 15" stroke={c} stroke-width="2.6" />
      <path d="M6.5 12.5l5 5" stroke="#a08356" stroke-width="2.4" />
      <path d="M5 19l2.5-2.5" stroke="#a08356" stroke-width="2.4" />
    </g>
  ),
  // Spear: straight shaft + leaf tip
  spear: (c) => (
    <g>
      <path d="M7.3 6.5 8 1.5l.7 5a1.6 1.6 0 0 1-1.4 0Z" fill={c} />
      <path d="M8 6.5v8" stroke={c} stroke-width="1.4" stroke-linecap="round" />
    </g>
  ),
  // Bow arc with string
  bow: (c) => (
    <g stroke={c} stroke-width="1.4" fill="none" stroke-linecap="round">
      <path d="M4.5 1.5C10 4 10 12 4.5 14.5" />
      <path d="M4.5 1.5v13" stroke-width="0.8" />
    </g>
  ),
  // Tankard: tapered mug, handle, foam head
  ale: (c) => (
    <g transform="scale(0.667)">
      <path d="M6 7.5h9.5l-.8 12.2a1.6 1.6 0 0 1-1.6 1.5H8.4a1.6 1.6 0 0 1-1.6-1.5L6 7.5Z" fill={c} />
      <path
        d="M15.2 10.2h1.9a2.9 2.9 0 0 1 0 5.8h-1.9"
        fill="none"
        stroke={c}
        stroke-width="1.8"
      />
      <path d="M5.6 4.4h10.3a1.7 1.7 0 0 1 0 3.4H5.6a1.7 1.7 0 0 1 0-3.4Z" fill="#f4ecd8" />
      <circle cx="8.5" cy="3.9" r="2" fill="#f4ecd8" />
      <circle cx="13" cy="4.1" r="1.7" fill="#f4ecd8" />
    </g>
  ),
};

export function GoodIcon(props: { good: GoodId; size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={props.size ?? 14}
      height={props.size ?? 14}
      style={{ 'vertical-align': '-2px' }}
      aria-label={goodName(props.good)}
    >
      {PATHS[props.good](GOOD_HEX[props.good])}
    </svg>
  );
}

export function LockIcon(props: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={props.size ?? 12} height={props.size ?? 12} style={{ 'vertical-align': '-1px' }}>
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
