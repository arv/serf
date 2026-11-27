import {createSignal, onCleanup, Show} from 'solid-js';
import {grass} from '../render/palette';
import {SNOW_COLOR} from '../render/seasons';
import {COMPACT} from './breakpoints';
import {dialTurn, yearRing, yearTip, type YearReading} from './seasonClock';
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
  return `M${at(3.7)}L${at(5)}`;
}).join('');

/**
 * The year at a glance: a rim in summer's green and winter's white, and
 * the sun going round inside it — high through the summer, low through the
 * winter. The middle says which season it is in a shape as well as a
 * color; the tip says what the lakes do next, and when.
 *
 * Read off the scene's own clock (Seasons.year), so the dial turns with
 * the valley it describes: it pauses with the match and hurries with it.
 */
export function SeasonDial(props: {year: () => YearReading}) {
  const read = (): YearReading => ({...props.year()});
  const [year, setYear] = createSignal(read(), {
    // A copy each read, so equal means nothing moved.
    equals: (a, b) => a.at === b.at && a.turning === b.turning,
  });
  const timer = setInterval(() => setYear(read()), READ_MS);
  onCleanup(() => clearInterval(timer));

  const tip = () => yearTip(year());
  const winter = () => tip().title === 'Winter';

  return (
    <div
      class="season-dial panel"
      classList={{winter: winter()}}
      role="img"
      aria-label={[tip().title, tip().body].filter(Boolean).join('. ')}
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
        /* Radius 18 out, 15 in: wide enough to read the color under the
           sun from across the screen. */
        .season-dial .rim {
          position: absolute; inset: 5%; border-radius: 50%;
          -webkit-mask: radial-gradient(closest-side, transparent 83.3%, #000 calc(83.3% + 0.6px));
          mask: radial-gradient(closest-side, transparent 83.3%, #000 calc(83.3% + 0.6px));
        }
        .season-dial svg {
          position: absolute; inset: 0; width: 100%; height: 100%;
          overflow: visible;
        }
        .season-dial .core { fill: #ffcf4a; }
        .season-dial .rays { stroke: #f3b23a; stroke-width: 1.2; stroke-linecap: round; }
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
          stroke-width: 1.2; stroke-linecap: round;
        }
      `}</style>
      <div class="rim" style={{background: RING}} />
      <svg viewBox="0 0 40 40" aria-hidden="true">
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
        {/* On the road just inside the rim, so the rim's color is never
            under it: the sun points at the season rather than hiding it. */}
        <g transform={`rotate(${dialTurn(year().at) * 360} 20 20)`}>
          <g transform="translate(20 8.5)">
            <path class="rays" d={RAYS} />
            <circle class="core" r="2.7" />
          </g>
        </g>
      </svg>
    </div>
  );
}
