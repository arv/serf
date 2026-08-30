import {Match, Switch, createSignal, type Accessor, type JSX} from 'solid-js';
import {render} from 'solid-js/web';
import {buildingName, goodName, unitName} from '../../ui/names';
import {DocLink} from './components';
import {BasicsPage} from './pages/BasicsPage';
import {BuildingPage} from './pages/BuildingPage';
import {BuildingsPage} from './pages/BuildingsPage';
import {CommandsPage} from './pages/CommandsPage';
import {CreditsPage} from './pages/CreditsPage';
import {GoodPage} from './pages/GoodPage';
import {GoodsPage} from './pages/GoodsPage';
import {IndexPage} from './pages/IndexPage';
import {TechsPage} from './pages/TechsPage';
import {UnitPage} from './pages/UnitPage';
import {UnitsPage} from './pages/UnitsPage';
import {disposePreviewHub} from './preview/hub';
import {parseDocsPath, type DocsRoute} from './routes';
import {DOCS_STYLE} from './styles';

/**
 * The field guide: a wiki over the game's own defs, mounted at /docs.
 *
 * One screen for the whole wiki (screenKey() returns the constant 'docs'),
 * so page turns arrive as onRouteChange rather than dispose-and-remount.
 * That is what lets the 3D preview hub keep its one WebGL context and its
 * loaded models across every click — see preview/hub.ts for why there is
 * exactly one context.
 */

const NAV: {href: string; label: string; section: DocsRoute['page'][]}[] = [
  {
    href: '/docs/buildings',
    label: 'Buildings',
    section: ['buildings', 'building'],
  },
  {href: '/docs/units', label: 'Units', section: ['units', 'unit']},
  {href: '/docs/goods', label: 'Goods', section: ['goods', 'good']},
  {href: '/docs/techs', label: 'Research', section: ['techs']},
  {href: '/docs/commands', label: 'Commands', section: ['commands']},
  {href: '/docs/basics', label: 'Basics', section: ['basics']},
  {href: '/docs/credits', label: 'Credits', section: ['credits']},
];

function pageTitle(route: DocsRoute): string {
  switch (route.page) {
    case 'index':
      return 'Field Guide';
    case 'buildings':
      return 'Buildings';
    case 'building':
      return buildingName(route.id);
    case 'units':
      return 'Units';
    case 'unit':
      return unitName(route.id);
    case 'goods':
      return 'Goods';
    case 'good':
      return goodName(route.id);
    case 'techs':
      return 'Research';
    case 'commands':
      return 'Commands';
    case 'basics':
      return 'Basics';
    case 'credits':
      return 'Credits';
    case 'missing':
      return 'Not found';
  }
}

function MissingPage(props: {path: string}): JSX.Element {
  return (
    <div class="missing">
      <p>Nothing in the guide answers to “{props.path}”.</p>
      <DocLink href="/docs">Back to the field guide</DocLink>
    </div>
  );
}

function DocsApp(props: {route: Accessor<DocsRoute>}): JSX.Element {
  return (
    <>
      <style>{DOCS_STYLE}</style>
      <header class="doc-head">
        <span class="kicker">
          <DocLink href="/docs">
            {/* The game's name is the first thing to give way on a phone:
                it is on the tab and on the page the reader came from, and
                the back link beside it must not be pushed off the edge. */}
            <span class="wide">Serf Valley · </span>Field Guide
          </DocLink>
        </span>
        <DocLink href="/" class="back">
          ← Back to the game
        </DocLink>
      </header>
      <div class="doc-body">
        <nav class="doc-nav">
          {NAV.map(n => (
            <DocLink
              href={n.href}
              class={n.section.includes(props.route().page) ? 'on' : undefined}
              current={n.section.includes(props.route().page)}
            >
              {n.label}
            </DocLink>
          ))}
        </nav>
        <main>
          <Switch>
            <Match when={props.route().page === 'index'}>
              <IndexPage />
            </Match>
            <Match when={props.route().page === 'buildings'}>
              <BuildingsPage />
            </Match>
            {/* keyed: a building->building link swaps defs, and the hero
                preview must rebuild for the new model rather than reconcile. */}
            <Match
              when={(() => {
                const r = props.route();
                return r.page === 'building' ? r : null;
              })()}
              keyed
            >
              {r => <BuildingPage id={r.id} />}
            </Match>
            <Match when={props.route().page === 'units'}>
              <UnitsPage />
            </Match>
            <Match
              when={(() => {
                const r = props.route();
                return r.page === 'unit' ? r : null;
              })()}
              keyed
            >
              {r => <UnitPage id={r.id} />}
            </Match>
            <Match when={props.route().page === 'goods'}>
              <GoodsPage />
            </Match>
            <Match
              when={(() => {
                const r = props.route();
                return r.page === 'good' ? r : null;
              })()}
              keyed
            >
              {r => <GoodPage id={r.id} />}
            </Match>
            <Match when={props.route().page === 'techs'}>
              <TechsPage />
            </Match>
            <Match when={props.route().page === 'commands'}>
              <CommandsPage />
            </Match>
            <Match when={props.route().page === 'basics'}>
              <BasicsPage />
            </Match>
            <Match when={props.route().page === 'credits'}>
              <CreditsPage />
            </Match>
            <Match
              when={(() => {
                const r = props.route();
                return r.page === 'missing' ? r : null;
              })()}
              keyed
            >
              {r => <MissingPage path={r.path} />}
            </Match>
          </Switch>
        </main>
      </div>
    </>
  );
}

export function mountDocs(): {dispose(): void; onRouteChange(): void} {
  // The wiki brings its own root and takes it away again, so the game's DOM
  // is untouched by a feature most sessions never open (the pattern
  // menuBackdrop.ts set with its canvas).
  const root = document.createElement('div');
  root.id = 'docs';
  document.body.appendChild(root);

  const [route, setRoute] = createSignal<DocsRoute>(
    parseDocsPath(location.pathname),
  );
  const priorTitle = document.title;
  document.title = `${pageTitle(route())} · Serf Valley`;
  let lastPath = location.pathname;

  const disposeApp = render(() => <DocsApp route={route} />, root);

  /**
   * Send the reader to the new content.
   *
   * A page turn here swaps the article under a nav that never moves, so
   * without this a keyboard user is left focused on the link they just
   * pressed — or, when the link was inside the page being replaced, on
   * nothing at all — and a screen reader announces no change. Focusing the
   * new heading is what turns a same-key navigation into a page change.
   *
   * tabindex="-1" because a heading is not a control: it takes focus
   * programmatically and stays out of the tab order.
   */
  const focusTarget = (el: HTMLElement | null): void => {
    if (!el) return;
    el.setAttribute('tabindex', '-1');
    // The scroll is ours to place (below); focus must not fight it.
    el.focus({preventScroll: true});
  };

  const showHashTarget = (): boolean => {
    if (location.hash === '') return false;
    const el = document.getElementById(location.hash.slice(1));
    if (!el) return false;
    el.scrollIntoView();
    focusTarget(el);
    return true;
  };
  // A deep link can name an anchor on this first page too.
  showHashTarget();

  return {
    onRouteChange(): void {
      // Solid renders synchronously on the set, so the new page's anchors
      // exist by the next line — a #tech-… link can be scrolled to at once.
      setRoute(parseDocsPath(location.pathname));
      document.title = `${pageTitle(route())} · Serf Valley`;
      if (!showHashTarget() && location.pathname !== lastPath) {
        root.scrollTop = 0;
        focusTarget(root.querySelector('main h1'));
      }
      lastPath = location.pathname;
    },
    dispose(): void {
      disposeApp();
      disposePreviewHub();
      root.remove();
      document.title = priorTitle;
    },
  };
}
