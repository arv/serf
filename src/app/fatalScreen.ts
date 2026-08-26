import { goto } from './router';
import { stashSet } from './stash';

/**
 * The card the app puts up when a screen cannot be built: raw DOM over
 * #fatal, with the way back on it.
 *
 * Its own module because it is the one thing every screen shares — main.ts
 * draws it for a save the sim refuses, and the match (matchScreen.ts) draws
 * it for a WebGL context the browser will not grant — and the match now
 * arrives behind a dynamic import. A second copy of `fatalShown` would undo
 * the whole point of it (see below).
 */

/**
 * Whether a screen is already up. The first failure is the one that knows
 * what happened; anything after it is that failure arriving a second time.
 * fatal() throws, so every one of these ends up at boot()'s catch as well —
 * and the plain screen that catch would draw used to replace the screen the
 * WebGL path had just put up, taking the Try again button with it and
 * leaving the player with a black page and no way out.
 */
let fatalShown = false;

/** The card's buttons, styled here because the card is raw DOM: it has to
 * be able to come up when the HUD's stylesheet — and Solid itself — is
 * exactly what failed. */
const BUTTON_CSS =
  'font:inherit;font-size:15px;padding:10px 26px;margin:10px 6px 0;cursor:pointer;' +
  'color:#f7e9c0;background:rgba(229,196,105,0.13);border:1px solid rgba(229,196,105,0.5);' +
  'border-radius:11px;';

export function showFatal(message: string, opts?: { retry?: boolean; menu?: boolean }): void {
  if (fatalShown) return;
  fatalShown = true;
  const el = document.getElementById('fatal')!;
  el.style.display = 'grid';
  const card = document.createElement('div');
  const title = document.createElement('h1');
  // "Cannot start" is the boot failure's headline and stays that way. A
  // screen that fails an hour into a session is a different sentence — and
  // the menu button is what says which this is: it is offered exactly when
  // the app is up and one screen could not be built.
  title.textContent = opts?.menu ? 'That screen could not be opened' : 'Serf Valley cannot start';
  const body = document.createElement('p');
  // Text, never markup. Relay error messages land here (runLobby's fail
  // rejects with them and boot's catch brings them straight in), and the
  // relay is not an author this page may trust with an origin that holds
  // the saves and the seat token.
  body.textContent = message;
  card.append(title, body);
  if (opts?.retry) {
    const retry = document.createElement('button');
    retry.textContent = 'Try again';
    retry.style.cssText = BUTTON_CSS;
    retry.addEventListener('click', () => {
      // Asking by hand re-arms the automatic tries: the count exists to stop
      // a reload loop running on its own, and this one is not on its own.
      stashSet('session', 'serf-gl-fails', null);
      location.reload();
    });
    card.append(retry);
  }
  if (opts?.menu) {
    // A screen that failed is no longer the end of the session: screens
    // change in this document now (app/router.ts), so the start menu is one
    // navigation away and the card comes down on the way (see clearFatal).
    // Without this a save the sim refuses — a village from an older build,
    // say — took the whole page with it and left nothing to press.
    const back = document.createElement('button');
    back.textContent = 'Back to the start menu';
    back.style.cssText = BUTTON_CSS;
    back.addEventListener('click', () => goto('/'));
    card.append(back);
  }
  el.replaceChildren(card);
}

/**
 * Take the card down. Called as each screen is built: whatever failed
 * belongs to the screen the player has just left, and a card left standing
 * would cover the one they asked for.
 */
export function clearFatal(): void {
  if (!fatalShown) return;
  fatalShown = false;
  const el = document.getElementById('fatal')!;
  el.style.display = 'none';
  el.replaceChildren();
}

/** The same screen, for the paths that must not carry on afterwards. */
export function fatal(message: string, opts?: { retry?: boolean; menu?: boolean }): never {
  showFatal(message, opts);
  throw new Error(message);
}

export function fatalFrom(err: unknown): void {
  showFatal(err instanceof Error ? err.message : String(err));
}