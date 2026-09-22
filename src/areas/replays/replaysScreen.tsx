import {For, Show, createResource, createSignal, type JSX} from 'solid-js';
import {render} from 'solid-js/web';
import {
  apiOrigin,
  fetchUploadedReplays,
  type UploadedReplay,
} from '../../app/replayUpload';
import {goto} from '../../app/router';
import {REPLAY_VERSION} from '../../shared/replayVersion';
import {TICK_MS} from '../../sim/defs/balance';
import {SHELF_STYLE} from './styles';

/**
 * The uploaded-replay shelf, at /all-replays.
 *
 * Every finished match a client hands up (src/app/replayUpload.ts) lands
 * on the server, and this page is the only way to see them. It is
 * deliberately not part of the game: nothing in the menu links here, the
 * path is not in any nav, and a player who never types it in will never
 * meet it. What it is for is the question a page view cannot answer — is
 * anyone actually playing, and how — and, in time, the corpus the AI is
 * trained against.
 *
 * A row is a match: when it arrived, how long it ran, who sat at the
 * table, how many orders were given. Watching one is the ordinary replay
 * screen over a recording fetched from the server rather than off the
 * player's own shelf — ?uploaded=<id>, handled in app/main.ts, which
 * screens it through parseReplay exactly like any other replay document.
 *
 * Where the server was started with SERF_REPLAY_KEY, the listing wants
 * `?key=` to match. The key rides this page's own URL and is carried onto
 * every link it draws, so one address is the whole credential.
 */

/** Ticks as a match's length, at the sim's own rate. */
function duration(endTick: number): string {
  const total = Math.round((endTick * TICK_MS) / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return mins > 0 ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${secs}s`;
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function when(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}.${pad(d.getMinutes())}`
  );
}

/** What was played: a commission by name, or a skirmish by its table. */
function billing(row: UploadedReplay): string {
  if (row.mission !== undefined) return `Commission · ${row.mission}`;
  const humans = row.seats.filter(s => s.kind === 'human').length;
  const ai = row.seats.length - humans;
  const table =
    ai === 0 ? `${humans} human${humans === 1 ? '' : 's'}` : `${humans}v${ai}`;
  return `Skirmish · ${table}`;
}

/** The opponents, as the strategies they were dealt. An AI seat with no
 * strategy on the record is one the deal never named. */
function opponents(row: UploadedReplay): string {
  const named = row.seats
    .filter(s => s.kind === 'ai')
    .map(s => s.strategy ?? 'dealt');
  return named.length > 0 ? named.join(', ') : '—';
}

function Row(props: {row: UploadedReplay; key: string | null}): JSX.Element {
  const playable = (): boolean => props.row.replayVersion === REPLAY_VERSION;
  const href = (): string =>
    `/?uploaded=${encodeURIComponent(props.row.id)}` +
    (props.key !== null && props.key !== ''
      ? `&key=${encodeURIComponent(props.key)}`
      : '');
  return (
    <div
      class="row"
      classList={{stale: !playable(), quit: props.row.ending === 'abandoned'}}
    >
      <div class="cell when">
        <span class="strong">{when(props.row.uploadedMs)}</span>
        <span class="sub">
          {props.row.source === 'net' ? 'relay' : 'solo'}
          {/* A match walked out of is marked; one played to a winner is
              the unmarked case, since a row that says nothing about its
              ending is one that ran its course. Recordings filed before
              the shelf drew the distinction have no ending at all, and
              read as decided. */}
          {props.row.ending === 'abandoned' ? ' · quit' : ''}
        </span>
      </div>
      <div class="cell what">
        <span class="strong">{billing(props.row)}</span>
        <span class="sub">
          seed {props.row.seed}
          {props.row.difficulty !== undefined
            ? ` · ${props.row.difficulty}`
            : ''}
          {` · vs ${opponents(props.row)}`}
        </span>
      </div>
      <div class="cell num">
        <span class="strong">{duration(props.row.endTick)}</span>
        <span class="sub">{props.row.endTick} ticks</span>
      </div>
      <div class="cell num">
        <span class="strong">{props.row.commands}</span>
        <span class="sub">orders</span>
      </div>
      <div class="cell num">
        <span class="strong">{fileSize(props.row.bytes)}</span>
        <span class="sub">v{props.row.replayVersion}</span>
      </div>
      <div class="cell act">
        <Show
          when={playable()}
          fallback={
            // A recording made under another sim cannot be re-run: the
            // same orders against a retuned tick produce a different
            // match. The row stays — it still says a game was played —
            // and only the way in is withdrawn.
            <span
              class="no-watch"
              title={`This build plays v${REPLAY_VERSION}`}
            >
              other build
            </span>
          }
        >
          <a
            class="watch"
            href={href()}
            onClick={e => {
              if (
                e.button !== 0 ||
                e.metaKey ||
                e.ctrlKey ||
                e.shiftKey ||
                e.altKey
              )
                return;
              e.preventDefault();
              goto(href());
            }}
          >
            Watch
          </a>
        </Show>
        <a
          class="raw"
          href={
            `${apiOrigin()}/api/all-replays/${encodeURIComponent(props.row.id)}` +
            (props.key !== null && props.key !== ''
              ? `?key=${encodeURIComponent(props.key)}`
              : '')
          }
        >
          JSON
        </a>
      </div>
    </div>
  );
}

function ShelfApp(props: {key: string | null}): JSX.Element {
  // A counter the resource refetches on, so "Refresh" is one signal write
  // rather than a second copy of the fetch.
  const [nonce, setNonce] = createSignal(0);
  const [rows] = createResource(nonce, () => fetchUploadedReplays(props.key));
  const total = (): number => rows()?.length ?? 0;
  const quits = (): number =>
    rows()?.filter(r => r.ending === 'abandoned').length ?? 0;
  return (
    <>
      <style>{SHELF_STYLE}</style>
      <header class="shelf-head">
        <span class="kicker">Serf Valley · Uploaded replays</span>
        <button
          type="button"
          class="refresh"
          onClick={() => setNonce(n => n + 1)}
        >
          Refresh
        </button>
        <a
          class="back"
          href="/"
          onClick={e => {
            if (
              e.button !== 0 ||
              e.metaKey ||
              e.ctrlKey ||
              e.shiftKey ||
              e.altKey
            )
              return;
            e.preventDefault();
            goto('/');
          }}
        >
          ← Back to the game
        </a>
      </header>
      <main>
        <Show
          when={!rows.loading}
          fallback={<p class="note">Reading the shelf…</p>}
        >
          <Show
            when={rows() !== null && rows() !== undefined}
            fallback={
              <p class="note">
                The shelf could not be read. The server may be unreachable — or,
                where it was started with <code>SERF_REPLAY_KEY</code>, this
                page needs the matching <code>?key=</code> in its own URL.
              </p>
            }
          >
            <p class="note">
              {total()} recording{total() === 1 ? '' : 's'}, newest first
              {quits() > 0
                ? `, ${quits()} of them quit rather than played out`
                : ''}
              . Every match uploads itself; nothing here was filed by hand.
            </p>
            <Show
              when={total() > 0}
              fallback={
                <p class="note">
                  Nothing yet. A match uploads when it ends — played out to a
                  winner, or quit after the first half-minute.
                </p>
              }
            >
              <div class="table">
                <For each={rows()!}>
                  {row => <Row row={row} key={props.key} />}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </main>
    </>
  );
}

export function mountUploadedReplays(): {dispose(): void} {
  // Its own root, taken away again on the way out — the pattern the field
  // guide set, so a page most sessions never open touches none of the
  // game's DOM.
  const root = document.createElement('div');
  root.id = 'shelf';
  document.body.appendChild(root);
  const priorTitle = document.title;
  document.title = 'Uploaded replays · Serf Valley';
  const key = new URLSearchParams(location.search).get('key');
  const disposeApp = render(() => <ShelfApp key={key} />, root);
  return {
    dispose(): void {
      disposeApp();
      root.remove();
      document.title = priorTitle;
    },
  };
}
