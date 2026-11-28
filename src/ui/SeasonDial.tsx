import {createSignal, onCleanup, Show} from 'solid-js';
import {grass} from '../render/palette';
import {SNOW_COLOR} from '../render/seasons';
import {COMPACT} from './breakpoints';
import {dialTurn, yearRing, yearTip} from './seasonClock';
import {TextTip, tooltip} from './tooltip';

const css = (color: number): string =>
  `#${color.toString(16).padStart(6, '0')}`;

/** The valley's own two colors: its grass, and the snow that lies on it. */
const SUMMER = css(grass);
const WINTER = css(SNOW_COLOR);

/** The ring, painted once: it is the same year every match. */
const RING = yearRing(SUMMER, WINTER);

/** How often the dial looks at the year. At the fastest replay gear the
 * sun crawls a degree and a half in this time — a third of a pixel. */
const READ_MS = 250;

/** The sun's eight rays, as one path about its middle. */
const RAYS = Array.from({length: 8}, (_, i) => {
  const a = (i * Math.PI) / 4;
  const at = (r: number): string =>
    `${+(Math.sin(a) * r).toFixed(2)} ${+(-Math.cos(a) * r).toFixed(2)}`;
  return `M${at(3.4)}L${at(4.5)}`;
}).join('');

/**
 * What the dial reads, live — assembled in matchScreen where the scene and
 * the sim's reader both are.
 */
export interface SeasonSource {
  /** The share of its year the scene has reached (Seasons.yearAt): what the
   * sun, the rim and the season's name follow, so they agree with the snow
   * on screen. */
  yearAt(): number;
  /** The sim's tick as of its latest publish (SabReader.tick): what the
   * lakes follow, since the sim alone decides who may walk on them, and
   * the scene's clock may run ahead of it. */
  simTick(): number;
}

/**
 * The year at a glance: a rim in summer's green and winter's white, and
 * the sun going round inside it — high through the summer, low through the
 * winter. The middle says which season it is in a shape as well as a
 * color; the tip says what the lakes do next, and when.
 *
 * Polled on its own clock, like the minimap: nothing upstream has to know
 * the dial exists.
 */
export function SeasonDial(props: {source: SeasonSource}) {
  const src = props.source;
  const [at, setAt] = createSignal(src.yearAt());
  const [tick, setTick] = createSignal(src.simTick());
  const timer = setInterval(() => {
    setAt(src.yearAt());
    setTick(src.simTick());
  }, READ_MS);
  onCleanup(() => clearInterval(timer));

  const tip = () => yearTip(at(), tick());
  const winter = () => tip().title === 'Winter';

  return (
    <div
      class="season-dial panel"
      classList={{winter: winter()}}
      role="img"
      aria-label={`${tip().title}. ${tip().body}`}
      {...tooltip(() => <TextTip title={tip().title} body={tip().body} />)}
    >
      <style>{`
        /* A round panel in the chrome row, as tall as the buttons beside
           it. Everything inside is drawn in one 40-unit box: the rim in
           CSS, because only CSS has a conic gradient, and the rest in
           SVG laid exactly over it. */
        #ui .season-dial.panel {
          position: relative; flex: 0 0 auto;
          box-sizing: border-box; width: 38px; height: 38px;
          padding: 0; border-radius: 50%;
          --summer: ${SUMMER}; --winter: ${WINTER};
        }
        @media ${COMPACT} {
          #ui .season-dial.panel { width: var(--touch-btn); height: var(--touch-btn); }
        }
        /* Radius 18.5 out, 16 in. The sun's road runs inside it, and
           nothing the sun draws reaches past 15.8. */
        .season-dial .rim {
          position: absolute; inset: 3.75%; border-radius: 50%;
          -webkit-mask: radial-gradient(closest-side, transparent 86.5%, #000 calc(86.5% + 0.6px));
          mask: radial-gradient(closest-side, transparent 86.5%, #000 calc(86.5% + 0.6px));
        }
        .season-dial svg {
          position: absolute; inset: 0; width: 100%; height: 100%;
          overflow: visible;
        }
        .season-dial .core { fill: #ffcf4a; }
        .season-dial .rays { stroke: #f3b23a; stroke-width: 1.1; stroke-linecap: round; }
        /* The winter sun is low and pale, as the valley's is. */
        .season-dial.winter .core { fill: #fbeed3; }
        .season-dial.winter .rays { stroke: #d9cdb5; }
        .season-dial .leaf { fill: var(--summer); }
        .season-dial .vein {
          fill: none; stroke: rgba(14, 16, 15, 0.7);
          stroke-width: 0.8; stroke-linecap: round;
        }
        .season-dial .flake {
          fill: none; stroke: var(--winter);
          stroke-width: 1.35; stroke-linecap: round;
        }
      `}</style>
      <div class="rim" style={{background: RING}} />
      <svg viewBox="0 0 40 40" aria-hidden="true">
        {/* Drawn at 0.85, so that its farthest point (the leaf's tip, 5.3
            out) clears the sun's nearest (5.7) wherever the sun is. */}
        <g transform="translate(20 20) scale(0.85) translate(-20 -20)">
          <Show
            when={winter()}
            fallback={
              <>
                <path
                  class="leaf"
                  d="M15.6 24.4C15.6 18.6 18.7 15.6 24.4 15.6 24.4 21.3 21.4 24.4 15.6 24.4Z"
                />
                <path class="vein" d="M16.6 23.4 21.6 18.4" />
              </>
            }
          >
            <path
              class="flake"
              d="M20 15v10M15.7 17.5l8.6 5M15.7 22.5l8.6-5M18.6 15.6 20 17l1.4-1.4M18.6 24.4 20 23l1.4 1.4"
            />
          </Show>
        </g>
        {/* On a road just inside the rim, 10.75 out, its rays ending short
            of the rim's inner edge: the rim's color is never under the sun,
            which points at the season rather than hiding it. */}
        <g transform={`rotate(${dialTurn(at()) * 360} 20 20)`}>
          <g transform="translate(20 9.25)">
            <path class="rays" d={RAYS} />
            <circle class="core" r="2.5" />
          </g>
        </g>
      </svg>
    </div>
  );
}
