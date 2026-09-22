import {type JSX} from 'solid-js';
import {DocLink} from '../components';

/**
 * The terms the valley is played and shared under.
 *
 * Two questions, and they have different answers. What you may DO with
 * the game is the Apache licence, which is a grant — the code and the art
 * are given away, on conditions the page states plainly rather than
 * leaving to a file nobody opens. What the game DOES WITH YOUR PLAY is the
 * recording notice, which is not a grant and not buried: every match that
 * ends files itself with the server, silently, and a player is owed that
 * in writing somewhere they can find it.
 *
 * Deliberately not a gate. Nothing here asks to be accepted, nothing
 * blocks a launch on having read it, and the game plays identically for
 * someone who never opens this page — a click-through nobody reads is
 * worth less than a page that says the true thing.
 *
 * Kept short on purpose. The full Apache text is a file in the repository
 * and a link away; what belongs here is what a person actually wants to
 * know, in the voice the rest of the guide is written in.
 */

/** An anchor that leaves the game: new tab, no opener, no router. Same
 * shape as the Credits page's — the two pages are the only ones that
 * point outside the valley. */
function Ext(props: {href: string; children: JSX.Element}): JSX.Element {
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  );
}

export function LicensePage(): JSX.Element {
  return (
    <>
      <h1>License</h1>
      <p class="lede">
        Serf Valley is free software, and the valley keeps a record of the games
        played in it. Both of those are worth saying out loud, so this page says
        them: what you may do with the game, and what the game does with your
        play.
      </p>

      <h2>What you may do with it</h2>
      <p>
        Serf Valley — its code, its models’ arrangement, its text and its rules
        — is copyright 2026 Erik Arvidsson and licensed under the{' '}
        <Ext href="https://www.apache.org/licenses/LICENSE-2.0">
          Apache License, Version 2.0
        </Ext>
        . You may use it, change it, build on it and ship what you build,
        commercially or not. The conditions are the licence’s own and they are
        short ones: keep the copyright and licence notice with what you pass on,
        say which files you changed, and don’t use the name to imply the
        original author endorses your version. The grant covers patents too, and
        ends for anyone who sues over them.
      </p>
      <p>
        The full text is the <code>LICENSE</code> file beside the source, and{' '}
        <code>NOTICE</code> names what travels with it.
      </p>

      <h2>What is not covered</h2>
      <p>
        The work the valley is built on is not the author’s to license, and it
        keeps its own terms — the KayKit models and Kenney’s audio are CC0, the
        typefaces are under the Open Font License, and three.js and SolidJS are
        MIT. Those terms govern those pieces wherever this game goes.{' '}
        <DocLink href="/docs/credits">Credits</DocLink> names every one of them
        and links to the licence it came under.
      </p>

      <h2>What the game records</h2>
      <p>
        When a match ends — played out to a winner, or quit after the first
        half-minute — the game sends its <em>replay</em> to the server. A replay
        is the match written down: the map it was dealt, the settings it was
        played on, and every order given, yours and the computer’s alike, under
        the tick it happened on. It holds nothing about you. No account, no
        name, no address, nothing typed outside the game. In a multiplayer match
        it also holds what was said in the chat line, because that was said at a
        table other people were sitting at.
      </p>
      <p>
        It happens quietly and it is allowed to fail: there is no prompt, and a
        match played with the network off is simply never sent. Recordings are
        kept so the author can see whether anyone is playing and how the game
        actually goes — where a village stalls, which opponent is unfair, where
        people put it down — and, in time, to teach the computer players from
        real games rather than guesses. Old recordings age off the shelf as new
        ones arrive.
      </p>
      <p>
        If you would rather not send one, play with the network off — single
        player is a local simulation and needs nothing from the server, so the
        whole game works offline and nothing leaves the machine.
      </p>

      <h2>No warranty</h2>
      <p>
        This is a game given away by one person. It comes as it is, with no
        warranty of any kind, and nobody is liable for what it does or fails to
        do — the licence says so in its own words, at sections 7 and 8, and
        those words are the ones that count.
      </p>
    </>
  );
}
