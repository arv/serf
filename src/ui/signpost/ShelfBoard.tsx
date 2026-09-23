import {For, Show, createEffect, createSignal, on, onCleanup} from 'solid-js';
import {
  deleteReplayFile,
  importReplayFile,
  listReplayFiles,
  type ReplayFileInfo,
} from '../../app/replayStore';
import {REPLAY_VERSION} from '../../shared/replayVersion';

/**
 * The shelf of recorded matches: what OPFS holds under /replays, newest
 * first. Pick one and Watch, or double-click it; delete one, share one
 * (where the system share sheet takes files), drag one out to keep it as a
 * file, drop one in to file it.
 *
 * Nothing but this board changes the list while it is up: recordings are
 * written from inside a match, which is a navigation away. So it is read
 * when the board comes round, and again after a delete or a drop.
 */

/** Whether drag-and-drop is worth words: a fine pointer is the desktop
 * tell. The rows are draggable and the board catches drops regardless;
 * this gates only the hint. */
const DRAG_OFFERED =
  window.matchMedia?.('(any-pointer: fine)').matches ?? false;

/** Whether a row can go to the system share sheet — the phone's half of
 * what the drag does on a desktop. The probe is a .txt because the payload
 * is: Chromium shares only an allowlist of file types, .json is not on it,
 * so a replay rides the sheet as text/plain and the import strips the
 * wrapper back off. */
const SHARE_OFFERED =
  typeof navigator.canShare === 'function' &&
  navigator.canShare({
    files: [new File(['probe'], 'probe.txt', {type: 'text/plain'})],
  });

const fmtSize = (bytes: number): string =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Playback re-runs the sim, so only this build's own recordings play. */
const playable = (r: ReplayFileInfo): boolean =>
  r.replayVersion === REPLAY_VERSION;

const ShareIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="18" cy="5" r="2.5" />
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="19" r="2.5" />
    <path d="M8.2 10.9l7.6-4.3M8.2 13.1l7.6 4.3" />
  </svg>
);

const CrossIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="3.4"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export function ShelfBoard(props: {
  /** The board is in front of the lens: read the shelf. */
  open: boolean;
  onWatch(name: string): void;
  onBack(): void;
}) {
  const [files, setFiles] = createSignal<ReplayFileInfo[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [picked, setPicked] = createSignal<string | null>(null);
  /** What the last drop came to. Stands until the next drop or the board
   * closes; a timer would take it away mid-read. */
  const [note, setNote] = createSignal<string | null>(null);

  const refresh = async (): Promise<void> => {
    const found = await listReplayFiles();
    setFiles(found);
    setLoaded(true);
    // A picked row that is no longer there must not stay behind Watch.
    if (!found.some(f => f.name === picked())) setPicked(null);
  };
  createEffect(
    on(
      () => props.open,
      open => {
        if (open) void refresh();
        else {
          setPicked(null);
          setNote(null);
        }
      },
    ),
  );

  // ——— drag and drop
  /** True while one of the board's own rows is in flight: it must not
   * catch its own outbound drag and file a duplicate. */
  let dragOut = false;
  /** dragenter minus dragleave: crossing into a row fires both, so a
   * boolean would flicker the highlight. */
  const [depth, setDepth] = createSignal(0);
  const fileDrag = (e: DragEvent): boolean =>
    !dragOut && (e.dataTransfer?.types.includes('Files') ?? false);
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDepth(0);
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (dragOut || dropped.length === 0) return;
    void (async () => {
      // One at a time: parallel imports of same-named files would race the
      // free-name check where Web Locks is absent.
      const filed: string[] = [];
      let storage = false;
      for (const f of dropped) {
        const r = await importReplayFile(f);
        if (r.ok) filed.push(r.name);
        else storage ||= r.reason === 'storage';
      }
      await refresh();
      const last = filed.at(-1);
      // Pick the newcomer, so drop-then-watch is one click — if this build
      // can play it.
      const row = files().find(f => f.name === last);
      if (row && playable(row)) setPicked(row.name);
      const bad = dropped.length - filed.length;
      setNote(
        filed.length === 0
          ? storage
            ? 'Import failed: storage is unavailable here'
            : dropped.length === 1
              ? 'That file is not a replay'
              : 'None of those files are replays'
          : bad === 0
            ? filed.length === 1
              ? `Filed as “${last}”`
              : `Filed ${filed.length} replays`
            : `Filed ${filed.length}; ${bad} ${bad === 1 ? 'is' : 'are'} not replays`,
      );
    })();
  };
  // A file dropped anywhere else must not become a navigation (the
  // browser's default opens it, replacing the game with a page of JSON).
  // Only drags carrying files: a text drag into the room-code box needs
  // its default.
  const swallow = (e: DragEvent): void => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  };
  window.addEventListener('dragover', swallow);
  window.addEventListener('drop', swallow);
  onCleanup(() => {
    window.removeEventListener('dragover', swallow);
    window.removeEventListener('drop', swallow);
  });

  /** Hand one replay to the share sheet, as text/plain under a .txt name
   * (see SHARE_OFFERED); the import strips the wrapper back off. */
  const share = (r: ReplayFileInfo): void => {
    const file = new File([r.file], `${r.name}.txt`, {type: 'text/plain'});
    void navigator.share({files: [file]}).catch(() => {
      // Dismissed, or refused: the sheet has already answered the click.
    });
  };

  const watch = (): void => {
    const name = picked();
    if (name !== null) props.onWatch(name);
  };

  return (
    <div
      class="main"
      classList={{dropping: depth() > 0}}
      onDragEnter={e => {
        if (!fileDrag(e)) return;
        e.preventDefault();
        setDepth(d => d + 1);
      }}
      onDragLeave={() => setDepth(d => Math.max(0, d - 1))}
      onDragOver={e => {
        if (!fileDrag(e) || !e.dataTransfer) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={onDrop}
    >
      <header>
        <h2 class="comic">Replays</h2>
        <Show when={files().length > 0}>
          <span class="sub">{files().length} saved</span>
        </Show>
        <button class="back" onClick={() => props.onBack()}>
          Back
        </button>
      </header>

      <div class="files">
        <For each={files()}>
          {r => {
            // Minted with the row and revoked with it: a drag must hand the
            // URL over synchronously at dragstart, and dragend is too soon
            // to revoke — a desktop drop may still be reading from it.
            const url = URL.createObjectURL(r.file);
            onCleanup(() => URL.revokeObjectURL(url));
            const ok = playable(r);
            return (
              <div
                class="file"
                draggable={true}
                onDragStart={e => {
                  dragOut = true;
                  const dt = e.dataTransfer;
                  if (!dt) return;
                  // Two spellings of "this file": the item for a web drop
                  // target, DownloadURL for Chromium's drop onto a desktop.
                  dt.items.add(r.file);
                  dt.setData(
                    'DownloadURL',
                    `application/json:${r.file.name}:${url}`,
                  );
                  dt.effectAllowed = 'copy';
                }}
                onDragEnd={() => {
                  dragOut = false;
                }}
              >
                <button
                  class="pick"
                  classList={{sel: picked() === r.name}}
                  // Disabled, not hidden: a file this build cannot play is
                  // the one most worth deleting.
                  disabled={!ok}
                  title={
                    ok
                      ? undefined
                      : `Recorded under replay version ${r.replayVersion ?? 'unknown'}; this build plays version ${REPLAY_VERSION}`
                  }
                  aria-pressed={picked() === r.name}
                  onClick={() => setPicked(picked() === r.name ? null : r.name)}
                  // The row's own name: the two clicks of a double-click
                  // have already toggled the pick back off.
                  onDblClick={() => props.onWatch(r.name)}
                >
                  <span class="name">{r.name}</span>
                  <span class="meta">
                    {fmtSize(r.size)}
                    {ok ? '' : ' · older build'}
                  </span>
                </button>
                <Show when={SHARE_OFFERED}>
                  <button
                    class="tool"
                    title="Share this replay"
                    aria-label={`Share replay ${r.name}`}
                    onClick={() => share(r)}
                  >
                    <ShareIcon />
                  </button>
                </Show>
                <button
                  class="tool"
                  title="Delete this replay"
                  aria-label={`Delete replay ${r.name}`}
                  onClick={() => void deleteReplayFile(r.name).then(refresh)}
                >
                  <CrossIcon />
                </button>
              </div>
            );
          }}
        </For>
        <Show when={loaded() && files().length === 0}>
          <p class="none">
            No replays yet. Save one from a match’s menu.
            {DRAG_OFFERED ? ' Or drop a replay file here.' : ''}
          </p>
        </Show>
      </div>

      <Show when={note()}>{n => <p class="note">{n()}</p>}</Show>

      <button class="go" disabled={picked() === null} onClick={watch}>
        Watch
      </button>
    </div>
  );
}
