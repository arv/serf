import {
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Accessor,
} from 'solid-js';
import {render} from 'solid-js/web';
import {BUILD_CHANNEL, BUILD_LABEL} from '../../app/buildInfo';
import {missionUrl} from '../../app/gameConfig';
import {goto, routeClick} from '../../app/router';
import {clearSeatStash, type CouncilRequest} from '../../net/lobbyClient';
import {defaultLobbyConfig} from '../../protocol/lobby';
import {DIFFICULTY_KEYS, type DifficultyId} from '../../sim/defs/difficulty.ts';
import * as DifficultyIdNs from '../../sim/defs/difficultyEnum.ts';
import type {CouncilHooks} from '../councilTypes';
import {fullscreen} from '../fullscreen';
import {loadSkirmishPrefs, saveSkirmishPrefs} from '../skirmishPrefs';
import {muted, toggleMuted} from '../store';
import {CampaignBoard, MultiplayerBoard, SkirmishBoard} from './boards';
import {CouncilBoard} from './CouncilBoard';
import {listRooms, POLL_MS, type OpenRoom} from './rooms';
import type {Board, SignpostScene} from './scene';
import {ShelfBoard} from './ShelfBoard';
import {SIGNPOST_STYLE} from './style';

/**
 * The start screen: a signpost in front of the valley, one arrow per mode.
 * Opening one turns the signpost round to that arrow's board; hosting or
 * joining a room flips the Multiplayer arrow over to the War Council.
 *
 * This component is the page around the signpost — title, corner icons,
 * footer, build line — and the wiring: it starts the 3D (signpost/scene.ts,
 * fetched on first paint so three.js stays off the path to it), renders the
 * boards into the elements the scene pins to the wood, and turns their
 * buttons into launches.
 *
 * Single player is a navigation (goto); multiplayer walks into the War
 * Council in place, through the shell (MenuApp.tsx), which runs the lobby
 * and hands its hooks back down as `hooks`.
 */

/** Skirmish opponents the board offers. */
const MAX_OPPONENTS = 3;

/**
 * A fresh valley for every skirmish, rolled rather than typed: a seed means
 * nothing until you have played the map it makes. It travels in the launch
 * URL, so the match stays reproducible — a link, a reload and "Play again"
 * all come back to the same ground. Eight digits, small enough to read off
 * an address bar and share.
 */
function rollSeed(): number {
  return Math.floor(Math.random() * 9e7) + 1e7;
}

export function Signpost(props: {
  /** The room being entered or sat in; null outside one. */
  council: CouncilRequest | null;
  /** The lobby's hooks once it has something to show. */
  hooks: Accessor<CouncilHooks | null>;
  /** Host or join: the shell takes it from here. */
  onCouncil(req: CouncilRequest): void;
  /** Back out of a room that has not answered yet. */
  onLeaveCouncil(): void;
}) {
  const [board, setBoard] = createSignal<Board | null>(null);
  const [scene, setScene] = createSignal<SignpostScene | null>(null);

  // ——— the skirmish setup, remembered between visits
  const setup = loadSkirmishPrefs(MAX_OPPONENTS);
  const [ai, setAi] = createSignal(setup.ai);
  const [difficulty, setDifficulty] = createSignal<DifficultyId>(
    setup.difficulty,
  );
  const [bandits, setBandits] = createSignal(setup.bandits);
  // A choice is made when the player makes it, so it is written then —
  // not at launch: someone who set hard and walked away still said it.
  const remember = (): void =>
    saveSkirmishPrefs({
      v: 1,
      ai: ai(),
      difficulty: difficulty(),
      bandits: bandits(),
    });

  // ——— online: single player is a local sim and works offline; only the
  // relay-backed half has to stand down.
  const [online, setOnline] = createSignal(navigator.onLine);

  // ——— the room list, polled while the Multiplayer board is up
  const [rooms, setRooms] = createSignal<OpenRoom[]>([]);
  let asking = false;
  const refresh = async (): Promise<void> => {
    if (asking || !online()) return; // a slow server must not stack up polls
    asking = true;
    try {
      setRooms(await listRooms());
    } catch {
      // No socket to be had: an empty list, and the next poll tries again.
      setRooms([]);
    } finally {
      asking = false;
    }
  };
  const browsing = (): boolean => board() === 'multi' && props.council === null;
  createEffect(
    on(browsing, now => {
      if (now) void refresh();
    }),
  );
  const poll = setInterval(() => {
    // Not while hidden: a backgrounded menu owes the relay no traffic.
    if (browsing() && !document.hidden) void refresh();
  }, POLL_MS);
  onCleanup(() => clearInterval(poll));
  // Back from another tab: the list is as old as the time away, so ask now
  // rather than at the next poll.
  const onShown = (): void => {
    if (!document.hidden && browsing()) void refresh();
  };
  document.addEventListener('visibilitychange', onShown);
  onCleanup(() => document.removeEventListener('visibilitychange', onShown));
  const syncOnline = (): void => {
    setOnline(navigator.onLine);
    if (navigator.onLine && browsing()) void refresh();
  };
  window.addEventListener('online', syncOnline);
  window.addEventListener('offline', syncOnline);
  onCleanup(() => {
    window.removeEventListener('online', syncOnline);
    window.removeEventListener('offline', syncOnline);
  });

  // ——— leaving for a match
  /** A single-player launch is a navigation, and the match's first act is
   * to ask for a WebGL context: give the signpost's back first. */
  const launch = (url: string): void => {
    teardown();
    goto(url);
  };
  const playMission = (id: Parameters<typeof missionUrl>[0]): void => {
    clearSeatStash(); // a menu launch is fresh intent, never a reconnect
    launch(missionUrl(id, difficulty()));
  };
  const playSkirmish = (): void => {
    clearSeatStash();
    const p = new URLSearchParams();
    if (ai() > 0) p.set('ai', String(ai()));
    p.set('seed', String(rollSeed())); // fresh every launch
    if (!bandits()) p.set('bandits', '0');
    // Only a tier that is not the printed game travels.
    if (difficulty() !== DifficultyIdNs.normal)
      p.set('difficulty', DIFFICULTY_KEYS[difficulty()]);
    launch('?' + p.toString());
  };
  const council = (mp: string, open: boolean): void => {
    clearSeatStash();
    // Seats, seed, raids and the difficulty open at their defaults and are
    // set in the council, where every joiner watches them change.
    props.onCouncil({mp, open, init: defaultLobbyConfig()});
  };

  // ——— the 3D, and the boards rendered into it
  let canvas: HTMLCanvasElement | null = null;
  let disposers: (() => void)[] = [];
  let generation = 0;
  const teardown = (): void => {
    generation++;
    for (const d of disposers) d();
    disposers = [];
    scene()?.stop();
    setScene(null);
    setBoard(null);
    canvas?.remove();
    canvas = null;
  };
  const boot = async (): Promise<void> => {
    teardown();
    const mine = generation;
    canvas = document.createElement('canvas');
    canvas.id = 'menu-canvas';
    document
      .getElementById('canvas')!
      .insertAdjacentElement('afterend', canvas);
    let s: SignpostScene;
    try {
      const {startSignpost} = await import('./scene');
      if (mine !== generation) return;
      s = await startSignpost(canvas, {onBoard: setBoard});
    } catch (err) {
      // A newer boot (or a release) superseded this one: not a failure.
      if (mine === generation) console.warn('[menu] no signpost:', err);
      return;
    }
    // Torn down while loading — the page is already on its way into a match.
    if (mine !== generation) {
      s.stop();
      return;
    }
    const close = (): void => void s.close();
    disposers = [
      render(
        () => (
          <CampaignBoard
            difficulty={difficulty()}
            onDifficulty={id => {
              setDifficulty(id);
              remember();
            }}
            onPlay={playMission}
            onBack={close}
          />
        ),
        s.faces.campaign,
      ),
      render(
        () => (
          <SkirmishBoard
            ai={ai()}
            difficulty={difficulty()}
            bandits={bandits()}
            onAi={n => {
              setAi(n);
              remember();
            }}
            onDifficulty={id => {
              setDifficulty(id);
              remember();
            }}
            onBandits={b => {
              setBandits(b);
              remember();
            }}
            onPlay={playSkirmish}
            onBack={close}
          />
        ),
        s.faces.skirmish,
      ),
      render(
        () => (
          <MultiplayerBoard
            rooms={rooms()}
            online={online()}
            onRefresh={() => void refresh()}
            onJoin={code => council(code.toUpperCase(), true)}
            onHost={() => council('new', true)}
            onBack={close}
          />
        ),
        s.faces.multi,
      ),
      render(
        () => (
          <CouncilBoard
            hooks={props.hooks()}
            onLeave={() => props.onLeaveCouncil()}
          />
        ),
        s.councilFace,
      ),
      render(
        () => (
          <ShelfBoard
            kind="replays"
            open={board() === 'replays'}
            onOpen={launch}
            onBack={close}
          />
        ),
        s.shelfFaces.replays,
      ),
      render(
        () => (
          <ShelfBoard
            kind="saves"
            open={board() === 'saves'}
            onOpen={launch}
            onBack={close}
          />
        ),
        s.shelfFaces.saves,
      ),
    ];
    setScene(s);
    // Arriving already in a room (an invite link, a reload mid-lobby): be
    // there, not on the way there.
    if (props.council) void s.enterCouncil(true);
  };

  // The room comes and goes: in, the Multiplayer arrow flips over to the
  // council; out, it flips back to the room list.
  createEffect(
    on(
      () => props.council !== null,
      (inRoom, wasInRoom) => {
        const s = scene();
        if (!s || inRoom === wasInRoom) return;
        void (inRoom ? s.enterCouncil() : s.leaveCouncil());
      },
      {defer: true},
    ),
  );

  onMount(() => void boot());
  onCleanup(teardown);

  // A page that leaves while holding a WebGL context can be parked in the
  // back/forward cache still holding it — and the match on the far side of
  // a single-player launch needs one. Give it back on the way out; build a
  // fresh one if the page comes back.
  const onHide = (): void => teardown();
  const onShow = (e: PageTransitionEvent): void => {
    if (e.persisted) void boot();
  };
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);
  onCleanup(() => {
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('pageshow', onShow);
  });

  // Esc backs out of a board. Not out of a room: that is the Leave
  // button's, and a key pressed by habit must not abandon a table.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || props.council !== null) return;
    if (board() !== null) void scene()?.close();
  };
  window.addEventListener('keydown', onKey);
  onCleanup(() => window.removeEventListener('keydown', onKey));

  // iOS Safari only applies :active to a touch when something is listening
  // for touches; without this, a finger on a board button shows no press.
  const noop = (): void => {};
  document.addEventListener('touchstart', noop, {passive: true});
  onCleanup(() => document.removeEventListener('touchstart', noop));

  const fs = fullscreen();

  return (
    <div class="sp-screen" classList={{open: board() !== null}}>
      <style>{SIGNPOST_STYLE}</style>
      <div class="sp-title">
        <h1 class="comic">Serf Valley</h1>
        <p class="comic">Settle the valley. Feed the levy. Hold the road.</p>
        <Show when={BUILD_CHANNEL === 'staging'}>
          <span class="channel">Staging</span>
        </Show>
      </div>

      {/* The arrows as buttons for a keyboard or a screen reader: the
          signpost itself is 3D and cannot take focus. */}
      <Show when={scene() !== null && board() === null}>
        <nav class="sp-arrows" aria-label="Modes">
          <button onClick={() => void scene()?.open('campaign')}>
            Campaign
          </button>
          <button onClick={() => void scene()?.open('skirmish')}>
            Skirmish
          </button>
          {/* Open offline too, as the arrow is: the board says why
              Host and Join are out. */}
          <button onClick={() => void scene()?.open('multi')}>
            Multiplayer
          </button>
        </nav>
      </Show>

      <div class="sp-opts">
        <button
          class="opt"
          aria-pressed={!muted()}
          aria-label={muted() ? 'Sound off' : 'Sound on'}
          title={muted() ? 'Sound: off' : 'Sound: on'}
          onClick={() => toggleMuted()}
        >
          <Show when={muted()} fallback={<SoundOnIcon />}>
            <SoundOffIcon />
          </Show>
        </button>
        <button
          class="opt"
          hidden={!fs.offerable()}
          aria-pressed={fs.active()}
          aria-label="Full screen"
          title={fs.active() ? 'Leave full screen' : 'Full screen'}
          onClick={() => fs.toggle()}
        >
          <Show when={fs.active()} fallback={<FullIcon />}>
            <UnfullIcon />
          </Show>
        </button>
      </div>

      <nav class="sp-footer comic">
        <button
          title="Resume a saved village"
          disabled={scene() === null}
          onClick={() => void scene()?.openShelf('saves')}
        >
          Load save
        </button>
        <button
          title="Watch a recorded match"
          disabled={scene() === null}
          onClick={() => void scene()?.openShelf('replays')}
        >
          Replays
        </button>
        <button
          title="Author a map of your own with kaleidoscope brushes, then play it"
          onClick={() => launch('?editor')}
        >
          Map editor
        </button>
        <button
          title="Every building, unit, good and research, cross-referenced"
          onClick={() => launch('/docs')}
        >
          Field guide
        </button>
      </nav>

      <div class="sp-build">
        SERF VALLEY · build {BUILD_LABEL}
        {BUILD_CHANNEL === 'staging' ? ' · staging' : ''} ·{' '}
        <a
          href="/docs/credits"
          onClick={e => routeClick(e, '/docs/credits', teardown)}
        >
          Credits
        </a>{' '}
        ·{' '}
        <a
          href="/docs/license"
          onClick={e => routeClick(e, '/docs/license', teardown)}
        >
          License
        </a>
      </div>
    </div>
  );
}

// ——— the corner icons, drawn like the lettering: every line laid twice, a
// wide ink stroke under a cream one, so the outline is even all round.

function Outlined(props: {d: string; width: number}) {
  return (
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d={props.d} stroke="var(--ink)" stroke-width={props.width + 2.2} />
      <path d={props.d} stroke="var(--cream)" stroke-width={props.width} />
    </g>
  );
}
function Icon(props: {children: unknown}) {
  return (
    <svg viewBox="-1 -1 18 18" width="34" height="34" aria-hidden="true">
      {props.children as never}
    </svg>
  );
}
const SPEAKER =
  'M2.6 6.1h2.3L8.2 3.2v9.6L4.9 9.9H2.6a.9.9 0 0 1-.9-.9V7a.9.9 0 0 1 .9-.9Z';
function Speaker() {
  return (
    <path
      d={SPEAKER}
      fill="var(--cream)"
      stroke="var(--ink)"
      stroke-width="2.2"
      stroke-linejoin="round"
      paint-order="stroke"
    />
  );
}
function SoundOnIcon() {
  return (
    <Icon>
      <Speaker />
      <Outlined
        d="M10.5 6.3a2.6 2.6 0 0 1 0 3.4M12.6 4.4a5.3 5.3 0 0 1 0 7.2"
        width={1.4}
      />
    </Icon>
  );
}
function SoundOffIcon() {
  return (
    <Icon>
      <Speaker />
      <Outlined d="M10.9 6.2l3.6 3.6M14.5 6.2l-3.6 3.6" width={1.5} />
    </Icon>
  );
}
/** Four corners pointing out: go full screen. */
function FullIcon() {
  return (
    <Icon>
      <Outlined
        d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"
        width={1.7}
      />
    </Icon>
  );
}
/** Pointing in: come back. */
function UnfullIcon() {
  return (
    <Icon>
      <Outlined
        d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"
        width={1.7}
      />
    </Icon>
  );
}
