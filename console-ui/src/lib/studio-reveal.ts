import { useEffect, useRef } from 'react';

/* ── A new drawing's reveal (US-57) ──
   A drawing the AI Designer just finished, in the tab that watched it being made, shows as an empty page first, then
   its parts appear inside it from top to bottom, in about 2 seconds. It plays once, when the drawing first shows: not
   when the screen is opened again, not after a reload, and not for a teammate who gets it through git. Which drawings
   were watched and which have played is kept in this page's memory only: nothing is saved anywhere. The reveal is only
   CSS inside the sealed frame (no scripts there), so it works the same for a right-to-left page, and it is left out
   when the computer asks for less motion. */

const watched = new Set<string>();
const played = new Set<string>();

/** A short mark of a drawing's HTML, so the same drawing is known again once it is saved. */
export function drawingMark(html: string): string {
  const t = html.trim();
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return `${t.length}:${(h >>> 0).toString(36)}`;
}

/** The computer asks for less motion. */
export function lessMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** This tab watched these pages being drawn: each one reveals the first time it shows. */
export function watchDrawing(pages: Record<string, string> | undefined): void {
  for (const html of Object.values(pages ?? {})) watched.add(drawingMark(html));
}

/** The drawing should reveal now: watched being made in this tab, not played yet, and motion is welcome. */
export function shouldReveal(html: string | undefined): boolean {
  if (!html || lessMotion()) return false;
  const mark = drawingMark(html);
  return watched.has(mark) && !played.has(mark);
}

export function markRevealed(html: string): void {
  played.add(drawingMark(html));
}

/** For tests: forget what this page watched and played. */
export function forgetReveals(): void {
  watched.clear();
  played.clear();
}

/** The reveal: the page's own background first, then a soft edge moving down uncovers its parts, top to bottom. */
export const REVEAL_CSS = (() => {
  const mask = 'linear-gradient(to bottom,#000 40%,transparent 60%)';
  const frame = (y: string) =>
    `-webkit-mask-image:${mask};mask-image:${mask};-webkit-mask-size:100% 250%;mask-size:100% 250%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:0 ${y};mask-position:0 ${y}`;
  return `@keyframes squad-reveal{from{${frame('100%')}}to{${frame('0%')}}}@media (prefers-reduced-motion:no-preference){html>body{animation:squad-reveal 1.8s cubic-bezier(.3,.6,.3,1) .25s backwards!important}}`;
})();

/** A drawing's HTML with the reveal in it, before anything the drawing says. */
export function revealHtml(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? '';
  return `${doctype}<style data-squad-reveal>${REVEAL_CSS}</style>${html.slice(doctype.length)}`;
}

/**
 * The HTML a frame shows: with the reveal the first time a watched drawing shows, else as it is. Decided once for each
 * drawing the frame shows (an older drawing can show for a moment before the saved one comes), and marked as played
 * once it has shown.
 */
export function useRevealed(html: string | undefined): string | undefined {
  const decided = useRef<{ html: string | undefined; reveal: boolean } | null>(null);
  if (!decided.current || decided.current.html !== html) decided.current = { html, reveal: shouldReveal(html) };
  const reveal = decided.current.reveal;
  useEffect(() => {
    if (reveal && html) markRevealed(html);
  }, [reveal, html]);
  if (html === undefined) return undefined;
  return reveal ? revealHtml(html) : html;
}
