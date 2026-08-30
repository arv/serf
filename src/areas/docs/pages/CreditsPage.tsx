import {For, type JSX} from 'solid-js';

/**
 * Who the valley is built on. Everything here ships inside the game —
 * models, sounds, the renderer, the UI runtime, the typeface — and every
 * card links back to the people who gave it away.
 *
 * The links are real external anchors, not DocLinks: they leave the game,
 * so they open in a new tab and never touch the router. The logos are the
 * projects' own marks where one exists (KayKit's from their brand kit,
 * three.js's and Solid's from their repositories); Kenney and Space
 * Grotesk publish no mark this page could carry, so their cards draw a
 * plain glyph in the guide's own icon language instead.
 */

/** An anchor that leaves the game: new tab, no opener, no router. */
function Ext(props: {href: string; children: JSX.Element}): JSX.Element {
  return (
    <a href={props.href} target="_blank" rel="noreferrer">
      {props.children}
    </a>
  );
}

/** The three.js mark (files/icon.svg in the three.js repository, MIT),
 * restroked in the page's ink rather than the original black. */
const ThreeLogo = (
  <svg viewBox="0 0 226.77 226.77" width="64" height="64" fill="none">
    <title>three.js</title>
    <g
      transform="translate(8.964 4.2527)"
      fill-rule="evenodd"
      stroke="currentColor"
      stroke-linecap="butt"
      stroke-linejoin="round"
      stroke-width="7"
    >
      <path d="m63.02 200.61-43.213-174.94 173.23 49.874z" />
      <path d="m106.39 50.612 21.591 87.496-86.567-24.945z" />
      <path d="m84.91 125.03-10.724-43.465 43.008 12.346z" />
      <path d="m63.458 38.153 10.724 43.465-43.008-12.346z" />
      <path d="m149.47 62.93 10.724 43.465-43.008-12.346z" />
      <path d="m84.915 125.06 10.724 43.465-43.008-12.346z" />
    </g>
  </svg>
);

/** The Solid mark (solid-site's logo.svg). Gradient ids are prefixed:
 * ids are document-global, and single letters invite a collision with
 * any other inline SVG on the page. */
const SolidLogo = (
  <svg viewBox="0 0 166 155.3" width="66" height="62">
    <title>SolidJS</title>
    <defs>
      <linearGradient
        id="cr-solid-a"
        gradientUnits="userSpaceOnUse"
        x1="27.5"
        y1="3"
        x2="152"
        y2="63.5"
      >
        <stop offset=".1" stop-color="#76b3e1" />
        <stop offset=".3" stop-color="#dcf2fd" />
        <stop offset="1" stop-color="#76b3e1" />
      </linearGradient>
      <linearGradient
        id="cr-solid-b"
        gradientUnits="userSpaceOnUse"
        x1="95.8"
        y1="32.6"
        x2="74"
        y2="105.2"
      >
        <stop offset="0" stop-color="#76b3e1" />
        <stop offset=".5" stop-color="#4377bb" />
        <stop offset="1" stop-color="#1f3b77" />
      </linearGradient>
      <linearGradient
        id="cr-solid-c"
        gradientUnits="userSpaceOnUse"
        x1="18.4"
        y1="64.2"
        x2="144.3"
        y2="149.8"
      >
        <stop offset="0" stop-color="#315aa9" />
        <stop offset=".5" stop-color="#518ac8" />
        <stop offset="1" stop-color="#315aa9" />
      </linearGradient>
      <linearGradient
        id="cr-solid-d"
        gradientUnits="userSpaceOnUse"
        x1="75.2"
        y1="74.5"
        x2="24.4"
        y2="260.8"
      >
        <stop offset="0" stop-color="#4377bb" />
        <stop offset=".5" stop-color="#1a336b" />
        <stop offset="1" stop-color="#1a336b" />
      </linearGradient>
    </defs>
    <path
      d="M163 35S110-4 69 5l-3 1c-6 2-11 5-14 9l-2 3-15 26 26 5c11 7 25 10 38 7l46 9 18-30z"
      fill="#76b3e1"
    />
    <path
      d="M163 35S110-4 69 5l-3 1c-6 2-11 5-14 9l-2 3-15 26 26 5c11 7 25 10 38 7l46 9 18-30z"
      opacity=".3"
      fill="url(#cr-solid-a)"
    />
    <path
      d="M52 35l-4 1c-17 5-22 21-13 35 10 13 31 20 48 15l62-21S92 26 52 35z"
      fill="#518ac8"
    />
    <path
      d="M52 35l-4 1c-17 5-22 21-13 35 10 13 31 20 48 15l62-21S92 26 52 35z"
      opacity=".3"
      fill="url(#cr-solid-b)"
    />
    <path
      d="M134 80a45 45 0 00-48-15L24 85 4 120l112 19 20-36c4-7 3-15-2-23z"
      fill="url(#cr-solid-c)"
    />
    <path
      d="M114 115a45 45 0 00-48-15L4 120s53 40 94 30l3-1c17-5 23-21 13-34z"
      fill="url(#cr-solid-d)"
    />
  </svg>
);

/** Not Kenney's logo — a speaker in the guide's own icon language, standing
 * where their card needs a picture. */
const AudioGlyph = (
  <svg
    viewBox="0 0 24 24"
    width="54"
    height="54"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M11 5 6.5 9H3v6h3.5L11 19z" />
    <path d="M15 9.5a3.5 3.5 0 0 1 0 5" />
    <path d="M17.5 7a7 7 0 0 1 0 10" />
  </svg>
);

/** The typeface's card shows the typeface: this page is already set in it. */
const TypeGlyph = <span class="c-aa">Aa</span>;

interface Credit {
  /** The mark in the card's art box. */
  art: JSX.Element;
  name: string;
  /** What of it is in the game. */
  what: string;
  license: {label: string; href: string};
  links: {label: string; href: string}[];
}

const CREDITS: Credit[] = [
  {
    art: <img src="/credits/kaykit.png" alt="KayKit" width="88" height="88" />,
    name: 'KayKit — Kay Lousberg',
    what:
      'Every roof, tree and person on the valley floor: the buildings and ' +
      'terrain are the Medieval Hexagon pack, the serfs and soldiers its ' +
      'Adventurers, and Dungeon Remastered, Forest Nature, Restaurant Bits ' +
      'and RPG Tools fill the corners.',
    license: {
      label: 'CC0',
      href: 'https://creativecommons.org/publicdomain/zero/1.0/',
    },
    links: [
      {
        label: 'kaylousberg.itch.io',
        href: 'https://kaylousberg.itch.io/kaykit-medieval-hexagon',
      },
      {label: 'kaylousberg.com', href: 'https://www.kaylousberg.com'},
    ],
  },
  {
    art: ThreeLogo,
    name: 'three.js',
    what:
      'The renderer. Everything the valley draws — the ground, the water, ' +
      'ten thousand trees and every marching serf — goes through three.js ' +
      'to WebGL.',
    license: {
      label: 'MIT',
      href: 'https://github.com/mrdoob/three.js/blob/dev/LICENSE',
    },
    links: [{label: 'threejs.org', href: 'https://threejs.org'}],
  },
  {
    art: SolidLogo,
    name: 'SolidJS',
    what:
      'The UI runtime. The start menu, the War Council, the HUD and this ' +
      'field guide are Solid components over the sim’s signals.',
    license: {
      label: 'MIT',
      href: 'https://github.com/solidjs/solid/blob/main/LICENSE',
    },
    links: [{label: 'solidjs.com', href: 'https://www.solidjs.com'}],
  },
  {
    art: AudioGlyph,
    name: 'Kenney',
    what:
      'The audio: hammers, footsteps, bells and every interface click are ' +
      'hand-picked from Kenney’s Impact, RPG, Interface and Music Jingles ' +
      'packs.',
    license: {
      label: 'CC0',
      href: 'https://creativecommons.org/publicdomain/zero/1.0/',
    },
    links: [{label: 'kenney.nl', href: 'https://kenney.nl'}],
  },
  {
    art: TypeGlyph,
    name: 'Space Grotesk — Florian Karsten',
    what:
      'The typeface. Every word in the game — this one included — is set ' +
      'in Space Grotesk.',
    license: {label: 'OFL 1.1', href: 'https://openfontlicense.org'},
    links: [
      {
        label: 'github.com/floriankarsten',
        href: 'https://github.com/floriankarsten/space-grotesk',
      },
    ],
  },
];

export function CreditsPage(): JSX.Element {
  return (
    <>
      <h1>Credits</h1>
      <p class="lede">
        Serf Valley is built on work given away whole — the models, the sounds,
        the renderer, the UI runtime and the typeface all ship inside the game.
        These are the people to thank, and where to find them.
      </p>
      <div class="credits">
        <For each={CREDITS}>
          {c => (
            <div class="credit">
              <div class="c-art">{c.art}</div>
              <div class="c-body">
                <div class="c-name">{c.name}</div>
                <p class="c-what">{c.what}</p>
                <div class="c-links">
                  <Ext href={c.license.href}>
                    <span class="chip">{c.license.label}</span>
                  </Ext>
                  <For each={c.links}>
                    {l => <Ext href={l.href}>{l.label}</Ext>}
                  </For>
                </div>
              </div>
            </div>
          )}
        </For>
      </div>
      <p class="c-note">
        The KayKit and Kenney packs are CC0 — credit is theirs by choice, not
        obligation, which is the best reason to give it. The full license texts
        travel with the assets themselves:{' '}
        <Ext href="/models/kaykit/LICENSE.txt">models</Ext>,{' '}
        <Ext href="/audio/LICENSE.txt">audio</Ext>,{' '}
        <Ext href="/fonts/OFL.txt">typeface</Ext>.
      </p>
    </>
  );
}
