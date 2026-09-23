import {For, Show, createEffect, createSignal, on, onCleanup} from 'solid-js';
import type {ImportResult} from '../../app/fileStore';
import {
  deleteReplayFile,
  importReplayFile,
  listReplayFiles,
  type ReplayFileInfo,
} from '../../app/replayStore';
import {
  deleteSaveFile,
  importSaveFile,
  listSaveFiles,
  type SaveFileInfo,
} from '../../app/saveStore';
import {REPLAY_VERSION} from '../../shared/replayVersion';
import {WORLD_SAVE_VERSION, canReadSave} from '../../shared/saveVersion';
import {MISSION_DEFS, parseMissionId} from '../../sim/defs/missions';

/**
 * A shelf of files: the recorded matches OPFS holds under /replays, or the
 * saved villages under /saves, newest first. Pick one and Watch (or Load),
 * or double-click it; delete one, share one (where the system share sheet
 * takes files), drag one out to keep it as a file, drop one in to file it.
 * The two shelves are one piece of UI and differ only in their words, how
 * a row reads, and where a picked row leads (SHELVES).
 *
 * Nothing but this board changes the list while it is up: recordings and
 * saves are written from inside a match, which is a navigation away. So it
 * is read when the board comes round, and again after a delete or a drop.
 */

export type ShelfKind = 'replays' | 'saves';

/** One row, in the terms the list draws. */
interface Row {
  name: string;
  /** The OPFS-backed file, for the outbound drag and the share sheet. */
  file: File;
  /** Whether this build can open it — a foreign version reads but does
   * not run, and the row says so rather than disappearing. */
  ok: boolean;
  /** The disabled row's title: why not. */
  why?: string;
  /** The small print under the name. */
  meta: string;
}

interface ShelfSpec {
  title: string;
  /** "a replay" / "a saved game", and the plural, for the notes. */
  article: string;
  plural: string;
  /** The button that opens the picked row. */
  go: string;
  empty: string;
  list(): Promise<Row[]>;
  import(file: File): Promise<ImportResult>;
  remove(name: string): Promise<void>;
  /** The address a picked row launches. */
  url(name: string): string;
}

const fmtSize = (bytes: number): string =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Playback re-runs the sim, so only this build's own recordings play. */
const replayRow = (r: ReplayFileInfo): Row => {
  const ok = r.replayVersion === REPLAY_VERSION;
  return {
    name: r.name,
    file: r.file,
    ok,
    ...(ok
      ? {}
      : {
          why: `Recorded under replay version ${r.replayVersion ?? 'unknown'}; this build plays version ${REPLAY_VERSION}`,
        }),
    meta: fmtSize(r.size) + (ok ? '' : ' · older build'),
  };
};

/** A save is world state read straight back into the sim, so one written
 * in another shape cannot be loaded. The format is read from the file
 * itself: a save from an older build predates the metadata head, and it is
 * exactly the one a row has to be able to refuse. One that says nothing at
 * all is offered, and the load path screens it again. */
const saveRow = (f: SaveFileInfo): Row => {
  const ok = f.world === undefined || canReadSave(f.world);
  const missionId = parseMissionId(f.meta?.mission);
  const opponents = f.meta?.opponents ?? 0;
  const what =
    missionId !== undefined
      ? MISSION_DEFS[missionId].title
      : f.meta === undefined
        ? undefined
        : opponents > 0
          ? `${opponents} rival${opponents === 1 ? '' : 's'}`
          : 'Sandbox';
  return {
    name: f.name,
    file: f.file,
    ok,
    ...(ok
      ? {}
      : {
          why: `Written in save format ${f.world ?? 'unknown'}; this build reads format ${WORLD_SAVE_VERSION}`,
        }),
    meta: [what, fmtSize(f.size), ok ? undefined : 'older build']
      .filter(part => part !== undefined)
      .join(' · '),
  };
};

const SHELVES: Record<ShelfKind, ShelfSpec> = {
  replays: {
    title: 'Replays',
    article: 'a replay',
    plural: 'replays',
    go: 'Watch',
    empty: 'No replays yet. Save one from a match’s menu.',
    list: async () => (await listReplayFiles()).map(replayRow),
    import: importReplayFile,
    remove: deleteReplayFile,
    url: name => '?replay=' + encodeURIComponent(name),
  },
  saves: {
    title: 'Saved games',
    article: 'a saved game',
    plural: 'saved games',
    go: 'Load',
    empty: 'No villages saved yet. Save one from a match’s menu.',
    list: async () => (await listSaveFiles()).map(saveRow),
    import: importSaveFile,
    remove: deleteSaveFile,
    url: name => '?load=' + encodeURIComponent(name),
  },
};

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
  kind: ShelfKind;
  /** The board is in front of the lens: read the shelf. */
  open: boolean;
  /** Open a picked row: its launch address. */
  onOpen(url: string): void;
  onBack(): void;
}) {
  const spec = SHELVES[props.kind];
  const [files, setFiles] = createSignal<Row[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [picked, setPicked] = createSignal<string | null>(null);
  /** What the last drop came to. Stands until the next drop or the board
   * closes; a timer would take it away mid-read. */
  const [note, setNote] = createSignal<string | null>(null);

  /** The latest listing asked for: an older one landing after it is
   * dropped, not shown over it. */
  let asked = 0;
  const refresh = async (): Promise<void> => {
    const mine = ++asked;
    const found = await spec.list();
    if (mine !== asked) return;
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
        const r = await spec.import(f);
        if (r.ok) filed.push(r.name);
        else storage ||= r.reason === 'storage';
      }
      await refresh();
      const last = filed.at(-1);
      // Pick the newcomer, so drop-then-watch is one click — if this build
      // can play it.
      const row = files().find(f => f.name === last);
      if (row?.ok) setPicked(row.name);
      const bad = dropped.length - filed.length;
      setNote(
        filed.length === 0
          ? storage
            ? 'Import failed: storage is unavailable here'
            : dropped.length === 1
              ? `That file is not ${spec.article}`
              : `None of those files are ${spec.plural}`
          : bad === 0
            ? filed.length === 1
              ? `Filed as “${last}”`
              : `Filed ${filed.length} ${spec.plural}`
            : `Filed ${filed.length}; ${bad} ${bad === 1 ? 'is' : 'are'} not ${spec.plural}`,
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

  /** Hand one file to the share sheet, as text/plain under a .txt name
   * (see SHARE_OFFERED); the import strips the wrapper back off. */
  const share = (r: Row): void => {
    const file = new File([r.file], `${r.name}.txt`, {type: 'text/plain'});
    void navigator.share({files: [file]}).catch(() => {
      // Dismissed, or refused: the sheet has already answered the click.
    });
  };

  const watch = (): void => {
    const name = picked();
    if (name !== null) props.onOpen(spec.url(name));
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
        <h2 class="comic">{spec.title}</h2>
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
            const ok = r.ok;
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
                  title={r.why}
                  aria-pressed={picked() === r.name}
                  onClick={() => setPicked(picked() === r.name ? null : r.name)}
                  // The row's own name: the two clicks of a double-click
                  // have already toggled the pick back off.
                  onDblClick={() => ok && props.onOpen(spec.url(r.name))}
                >
                  <span class="name">{r.name}</span>
                  <span class="meta">{r.meta}</span>
                </button>
                <Show when={SHARE_OFFERED}>
                  <button
                    class="tool"
                    title={`Share ${spec.article}`}
                    aria-label={`Share ${r.name}`}
                    onClick={() => share(r)}
                  >
                    <ShareIcon />
                  </button>
                </Show>
                <button
                  class="tool"
                  title={`Delete ${spec.article}`}
                  aria-label={`Delete ${r.name}`}
                  onClick={() => void spec.remove(r.name).then(refresh)}
                >
                  <CrossIcon />
                </button>
              </div>
            );
          }}
        </For>
        <Show when={loaded() && files().length === 0}>
          <p class="none">
            {spec.empty}
            {DRAG_OFFERED ? ` Or drop ${spec.article} file here.` : ''}
          </p>
        </Show>
      </div>

      <Show when={note()}>{n => <p class="note">{n()}</p>}</Show>

      <button class="go" disabled={picked() === null} onClick={watch}>
        {spec.go}
      </button>
    </div>
  );
}
