/**
 * The goods strip unfolding into the ledger sheet, and folding back: one
 * same-document view transition, plus the choreography the browser cannot
 * infer on its own.
 *
 * What the browser does by itself: every element the strip and the sheet
 * both carry a name for (see ledgerVt) is morphed from its strip box to
 * its sheet box, and the sheet's own box grows out of the strip's. What
 * has no twin on the strip would only fade in place, so two things are
 * added here:
 *
 * - The body of columns hangs from the box's bottom edge. It starts
 *   lifted by the whole distance that edge travels, tucked up under the
 *   header row and clipped at the header's line, and slides down with
 *   the edge (the `ledger-unfold-body` keyframes in Hud, fed the numbers
 *   as custom properties on the root).
 * - The strip's goods ride that body instead of cutting straight across
 *   it. A straight flight from the strip to a row lands in the row only
 *   at the very end — before that the good is out ahead of its row and
 *   drawn over the others, which are still sliding down behind it. So a
 *   good keeps to the strip's line, moving across to its column, until
 *   its row comes down to meet it, and then goes down with the row.
 *   That path is per good and per layout, so it is measured and handed
 *   to the Web Animations API against the transition's own pseudo-
 *   elements, which is where a view transition takes custom motion.
 */

/** The morph's length and curve. Hud's stylesheet times the groups and
 * the body with these; the flights sample the same curve, so every edge
 * in the morph moves on one clock. */
export const MORPH_MS = 280;
const EASE = [0.2, 0.8, 0.2, 1] as const;
export const MORPH_EASE_CSS = `cubic-bezier(${EASE.join(', ')})`;

/** A CSS cubic-bezier timing function, as a function of time 0..1. */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (t: number) => number {
  const at = (a: number, b: number, s: number): number =>
    3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  return t => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // x(s) is monotonic for x1, x2 in [0, 1]: bisect for the s that
    // lands on t. Forty halvings is far below a pixel of any flight.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < t) lo = mid;
      else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}

const ease = cubicBezier(...EASE);

type Point = {x: number; y: number};

/** One named piece of a strip good — its icon, label or count — and the
 * two places it moves between (viewport top-left of its box), and its
 * width in the row. */
export type Flight = {name: string; strip: Point; row: Point; width: number};

type Span = {left: number; right: number};

export type LedgerPlan = {
  /** How far the sheet's bottom edge travels: sheet bottom less strip
   * bottom. The body starts lifted by this much. */
  drop: number;
  /** The box's sides on the strip and on the sheet. */
  from: Span;
  to: Span;
  flights: Flight[];
};

/**
 * Where a flight is when the sheet is `unfolded` of the way open (0 the
 * strip, 1 the sheet — already eased), and how much of it the box's sides
 * cut off.
 *
 * Down: its row's top is `drop * (1 - unfolded)` above where it will
 * rest, sliding down. The good crosses to its column along the strip's
 * line — above the header line, where no row is ever drawn — arriving
 * just as its row comes down to meet it, and then goes down with the
 * row. Crossing any later would carry it sideways over the neighbouring
 * column's rows on the way down.
 *
 * Arriving that early can put a good in an outer column outside the box,
 * which is still widening, so it is clipped by the box's sides exactly as
 * the rows around it are: the widening box uncovers it with them.
 */
export function flightAt(
  f: Flight,
  plan: LedgerPlan,
  unfolded: number,
): Point & {clipLeft: number; clipRight: number} {
  const {drop, from, to} = plan;
  const row = f.row.y - drop * (1 - unfolded);
  // How far open the sheet is when the row reaches the strip's line.
  const meet = drop > 0 ? 1 - (f.row.y - f.strip.y) / drop : 0;
  const across = meet > 0 ? Math.min(1, unfolded / meet) : 1;
  const x = f.strip.x + (f.row.x - f.strip.x) * across;
  const side = (a: number, b: number): number => a + (b - a) * unfolded;
  return {
    x,
    y: Math.max(f.strip.y, row),
    clipLeft: Math.max(0, side(from.left, to.left) - x),
    clipRight: Math.max(0, x + f.width - side(from.right, to.right)),
  };
}

/** The flight's keyframes, sampled finely enough that the straight
 * stretches between samples are invisible at this length. */
export function flightKeyframes(
  f: Flight,
  plan: LedgerPlan,
  opening: boolean,
  samples = 24,
): Keyframe[] {
  const frames: Keyframe[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const e = ease(t);
    const p = flightAt(f, plan, opening ? e : 1 - e);
    frames.push({
      offset: t,
      transform: `translate(${p.x}px, ${p.y}px)`,
      clipPath: `inset(0 ${p.clipRight}px 0 ${p.clipLeft}px)`,
    });
  }
  return frames;
}

/** The view-transition name an element carries while a morph is taken. */
const vtName = (el: Element): string =>
  el instanceof HTMLElement ? el.style.getPropertyValue('--vt').trim() : '';

const FLIGHT_NAME = /^ledger-(icon|name|num)-/;

/**
 * Measure the morph against the live layout and publish the body's
 * numbers to the stylesheet. Null where there is no docked sheet (a
 * phone's sheet opens under a strip that stays, and keeps the plain
 * morph). Must run while the sheet stands — after the update when
 * opening, before it when closing; the strip is always measurable, since
 * stowed means hidden, not gone.
 */
export function measureLedgerMorph(resources: HTMLElement): LedgerPlan | null {
  const strip = resources.querySelector('.strip');
  const sheet = resources.querySelector('.ledger-sheet');
  const body = sheet?.querySelector('.ledger-body');
  const title = sheet?.querySelector('.ledger-title');
  if (!strip || !sheet || !body || !title) return null;
  const s = strip.getBoundingClientRect();
  const b = body.getBoundingClientRect();
  const f = sheet.getBoundingClientRect();
  const drop = Math.max(0, f.bottom - s.bottom);
  const root = document.documentElement.style;
  const px = (n: number): string => `${Math.max(0, n)}px`;
  root.setProperty('--unfold-drop', `${-drop}px`);
  root.setProperty('--unfold-body-top', px(drop));
  root.setProperty('--unfold-body-left', px(s.left - b.left));
  root.setProperty('--unfold-body-right', px(b.right - s.right));
  const t = title.getBoundingClientRect();
  root.setProperty('--unfold-title-left', px(s.left - t.left));
  root.setProperty('--unfold-title-right', px(t.right - s.right));

  const rows = new Map<string, DOMRect>();
  for (const el of body.querySelectorAll('.vt')) {
    const name = vtName(el);
    if (FLIGHT_NAME.test(name)) rows.set(name, el.getBoundingClientRect());
  }
  const flights: Flight[] = [];
  for (const el of strip.querySelectorAll('.vt')) {
    const name = vtName(el);
    const row = rows.get(name);
    if (!row) continue;
    const r = el.getBoundingClientRect();
    flights.push({
      name,
      strip: {x: r.left, y: r.top},
      row: {x: row.left, y: row.top},
      width: row.width,
    });
  }
  return {
    drop,
    from: {left: s.left, right: s.right},
    to: {left: f.left, right: f.right},
    flights,
  };
}

/** Put the plan's flights on the transition's groups. Script animations
 * composite over the browser's own group animation, so this replaces its
 * straight-line transform and leaves the size morph alone. Returns them
 * so the morph can cancel them when it ends: filled animations outlive
 * the pseudo-elements they drove, and would pile up one set per morph. */
function flyLedger(plan: LedgerPlan, opening: boolean): Animation[] {
  const flying: Animation[] = [];
  for (const f of plan.flights) {
    try {
      flying.push(
        document.documentElement.animate(flightKeyframes(f, plan, opening), {
          duration: MORPH_MS,
          easing: 'linear',
          fill: 'both',
          pseudoElement: `::view-transition-group(${f.name})`,
        }),
      );
    } catch {
      // A group the browser did not make (a name it dropped) has nothing
      // to animate; the rest of the morph stands without it.
    }
  }
  return flying;
}

let running = 0;

/** Whether a morph is under way — while one is, the browser hit-tests
 * everything to the root, so pointer boundary events lie. */
export const ledgerMorphing = (): boolean => running > 0;

/**
 * Run `update` as the morph. `update` swaps the state and returns the plan
 * it measured (null for the plain morph). The root is left out of the
 * capture (`html.ledger-vt` names it `none`), which keeps the world
 * rendering live under the morph instead of freezing into a crossfaded
 * screenshot; the class is also what switches the names on. `settled`
 * runs once the last of any overlapping morphs is over.
 */
export function morphLedger(
  opening: boolean,
  update: () => LedgerPlan | null,
  settled: () => void,
): void {
  const root = document.documentElement;
  root.classList.add('ledger-vt');
  root.classList.toggle('ledger-vt-open', opening);
  running++;
  let plan: LedgerPlan | null = null;
  let flying: Animation[] = [];
  const t = document.startViewTransition(() => {
    plan = update();
  });
  t.ready.then(
    () => {
      if (plan) flying = flyLedger(plan, opening);
    },
    () => {},
  );
  void t.finished.finally(() => {
    for (const a of flying) a.cancel();
    if (--running > 0) return;
    root.classList.remove('ledger-vt', 'ledger-vt-open');
    settled();
  });
}
