import type { JSX } from 'solid-js';
import type { GoodId } from '../sim/defs/goods';
import { THEME } from '../render/medieval';
import { goodName } from './names';

/**
 * Tiny inline-SVG icon set — no emoji, no assets. Goods use their palette
 * color so the HUD reads like the world does.
 */

const MEDIEVAL = THEME === 'medieval';

const GOOD_HEX: Record<GoodId, string> = {
  water: '#6da4cc',
  rice: MEDIEVAL ? '#e3bd45' : '#e8d9a0',
  bamboo: MEDIEVAL ? '#ab8354' : '#a4c455',
  stone: '#a29a8a',
  iron: '#8d7d72',
  silver: '#c8ced6',
  gold: '#e0b74f',
  katana: MEDIEVAL ? '#c4cdd6' : '#dbe0e6',
  yari: '#c39c62',
  yumi: '#b08d57',
  sake: MEDIEVAL ? '#d2963c' : '#efe8f0',
};

/** Medieval glyphs (from the glass-HUD design handoff), authored in a
 * 24-unit box and scaled into the 16-unit one. */
const MEDIEVAL_PATHS: Partial<Record<GoodId, (c: string) => JSX.Element>> = {
  // Wheat ear: stalk + grain ellipses
  rice: (c) => (
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
  bamboo: (c) => (
    <g transform="scale(0.667)">
      <rect x="3" y="9" width="18" height="6" rx="3" fill={c} />
      <circle cx="18" cy="12" r="3" fill="#d4af7e" />
      <circle cx="18" cy="12" r="1.3" fill={c} />
    </g>
  ),
  // Straight sword: blade + crossguard + grip
  katana: (c) => (
    <g transform="scale(0.667)" fill="none" stroke-linecap="round">
      <path d="M19 5L9 15" stroke={c} stroke-width="2.6" />
      <path d="M6.5 12.5l5 5" stroke="#a08356" stroke-width="2.4" />
      <path d="M5 19l2.5-2.5" stroke="#a08356" stroke-width="2.4" />
    </g>
  ),
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
  // Tankard: tapered mug, handle, foam head
  sake: (c) => (
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

const PATHS: Record<GoodId, (c: string) => JSX.Element> = {
  // Droplet
  water: (c) => <path d="M8 1.5C8 1.5 3.5 7 3.5 10a4.5 4.5 0 0 0 9 0C12.5 7 8 1.5 8 1.5Z" fill={c} />,
  // Rice sheaf: three stalks with grains
  rice: (c) => (
    <g stroke={c} stroke-width="1.3" fill="none" stroke-linecap="round">
      <path d="M8 14V5M8 5c0-2 1.5-3 3-3.5M8 5c0-2-1.5-3-3-3.5" />
      <path d="M8 9c1.8-.3 3-1.4 3.4-3M8 9c-1.8-.3-3-1.4-3.4-3" />
    </g>
  ),
  // Two segmented culms
  bamboo: (c) => (
    <g stroke={c} stroke-width="1.8" fill="none" stroke-linecap="round">
      <path d="M6 14.5V1.5M10 14.5V3" />
      <path d="M4.8 5.5h2.4M4.8 10h2.4M8.8 7h2.4M8.8 11.5h2.4" stroke-width="1" />
    </g>
  ),
  // Boulder
  stone: (c) => <path d="M3 12.5 2 10l2-4.5L8.5 4l4 1.5L14 9l-1.5 3.5H3Z" fill={c} />,
  // Ingot
  iron: (c) => <path d="M4.5 5.5h7L14 11.5H2L4.5 5.5Z" fill={c} />,
  // Mon coin: circle with square hole
  silver: (c) => (
    <path
      d="M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8Zm-1.7 4.5h3.4v3.4H6.3V6.3Z"
      fill={c}
      fill-rule="evenodd"
    />
  ),
  // Koban: oval gold plate
  gold: (c) => (
    <g>
      <ellipse cx="8" cy="8" rx="4" ry="6.2" fill={c} />
      <ellipse cx="8" cy="8" rx="2" ry="3.6" fill="none" stroke="#8a6a1e" stroke-width="0.8" />
    </g>
  ),
  // Curved blade + hilt
  katana: (c) => (
    <g stroke={c} stroke-width="1.6" fill="none" stroke-linecap="round">
      <path d="M13.5 2.5C10 4.5 6.5 7.5 4.5 11" />
      <path d="M3 13l1.5-2M2.6 10.6 5.4 13.4" stroke-width="1.2" />
    </g>
  ),
  // Spear: straight shaft + leaf tip
  yari: (c) => (
    <g>
      <path d="M7.3 6.5 8 1.5l.7 5a1.6 1.6 0 0 1-1.4 0Z" fill={c} />
      <path d="M8 6.5v8" stroke={c} stroke-width="1.4" stroke-linecap="round" />
    </g>
  ),
  // Bow arc with string
  yumi: (c) => (
    <g stroke={c} stroke-width="1.4" fill="none" stroke-linecap="round">
      <path d="M4.5 1.5C10 4 10 12 4.5 14.5" />
      <path d="M4.5 1.5v13" stroke-width="0.8" />
    </g>
  ),
  // Tokkuri bottle
  sake: (c) => (
    <path
      d="M6.8 1.5h2.4v2.2c0 .8 2.3 1.6 2.3 4.3 0 3.2-.6 6.5-3.5 6.5S4.5 11.2 4.5 8c0-2.7 2.3-3.5 2.3-4.3V1.5Z"
      fill={c}
    />
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
      {((MEDIEVAL ? MEDIEVAL_PATHS[props.good] : undefined) ?? PATHS[props.good])(
        GOOD_HEX[props.good],
      )}
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
