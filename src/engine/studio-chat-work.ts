import path from 'node:path';
import type { BoardPaths } from '../board/store.js';
import { freeScreenName, screenNameKey, type Sketch } from '../board/studio.js';
import { frameFile } from '../board/studio-paths.js';
import type { ChatSort, ChatWork, ScreenFlow, ScreenPages } from './studio-chat-prompts.js';

/**
 * The screens one chat message works on (US-11, AB-136): which screen each piece of work draws or changes, the screen
 * it starts from ("start from a copy of Form"), and the flow every drawing in a sketch must match. Part of the Studio
 * chat (studio-chat.ts); it only reads.
 */

export function relative(bp: BoardPaths, file: string): string {
  return path.relative(bp.root, file).split(path.sep).join('/');
}

/** The chosen variant's pages of a screen, relative to the project folder, by frame. */
export function chosenFiles(bp: BoardPaths, sketch: Sketch, screen: string): Record<string, string> {
  const s = sketch.screens.find((x) => x.id === screen);
  const v = s?.variants.find((x) => x.version === s.chosen);
  return v ? Object.fromEntries(Object.keys(v.frames).map((f) => [f, relative(bp, frameFile(bp, sketch.id, s!.id, v.version, f))])) : {};
}

/**
 * The flow a drawing in a sketch must match (US-11): the other screens' approved pages, or, when none of them is
 * approved, the drawing each other screen uses now. `except` is the screen being drawn. It only reads.
 */
export function flowOf(bp: BoardPaths, sketch: Sketch, except?: string): ScreenFlow {
  const others = sketch.screens.filter((s) => s.id !== except && s.chosen !== null);
  const approved = others.filter((s) => s.status === 'approved');
  const pool = approved.length ? approved : others;
  return { approved: approved.length > 0, screens: pool.map((s) => ({ name: s.name, files: chosenFiles(bp, sketch, s.id) })).filter((s) => Object.keys(s.files).length) };
}

/** The screen a piece of work starts from (US-11, "start from a copy of Form"), with its current pages. */
export function startOf(bp: BoardPaths, sketch: Sketch, w: Work): { start: ScreenPages } | Record<string, never> {
  const from = w.start ? sketch.screens.find((s) => s.id === w.start) : undefined;
  return from ? { start: { name: from.name, files: chosenFiles(bp, sketch, from.id) } } : {};
}

/** One screen of the work, with the screen it changes when the sketch has it, and the screen it starts from (US-11). */
export type Work = ChatWork & { screen?: string; start?: string; naming?: boolean };

/**
 * The screens of a change, in order, each with the screen it changes when the sketch has it. With a screen not named
 * yet selected (US-11, AB-136.1), the work's first new screen (or the item naming it) goes to it, with the name the
 * AI Designer gave, to be saved once the screen is named. `from` names another screen of the sketch to start from.
 */
export function workOf(sketch: Sketch, sort: ChatSort, newScreen?: { id: string; name: string }): Work[] {
  const seen = new Set<string>();
  const names: { id: string; name: string }[] = sketch.screens.map((s) => ({ id: s.id, name: s.name }));
  let toNew = false;
  return (sort.screens ?? []).flatMap((w) => {
    const name = w.name.trim();
    const fromWord = typeof w.from === 'string' ? w.from.trim() : '';
    const isFrom = (s: { id: string; name: string }) => Boolean(fromWord) && (s.id === fromWord || screenNameKey(s.name) === screenNameKey(fromWord));
    let found = sketch.screens.find((s) => (w.id && s.id === w.id) || screenNameKey(s.name) === screenNameKey(name));
    // "A copy of Form" named "Form" is a new screen, not a change to Form.
    if (found && isFrom(found)) found = undefined;
    let naming = false;
    if (newScreen && !toNew && (!found || found.id === newScreen.id)) {
      found = sketch.screens.find((s) => s.id === newScreen.id);
      naming = toNew = Boolean(found);
    }
    const key = found?.id ?? `new:${screenNameKey(name)}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const start = sketch.screens.find((s) => s.id !== found?.id && isFrom(s));
    // The name the screen not named yet gets: the one suggested, else the item's own, else the one it copies.
    const suggested = sort.screenName?.trim() || (screenNameKey(name) === screenNameKey(newScreen?.name ?? '') ? (start?.name ?? name) : name);
    // A new screen with a name the sketch has takes a free one, "Form 2" (AB-136.1); the store names it the same way.
    // A screen not named yet that the work draws takes the item's own name: the store names it with the drawing.
    let shown = found?.unnamed ? name : (found?.name ?? name);
    if (naming) shown = freeScreenName(names, suggested, found!.id);
    else if (!found) {
      shown = freeScreenName(names, name);
      names.push({ id: `new:${names.length}`, name: shown });
    }
    return [{ name: shown, change: w.change, ...(found ? { id: found.id, screen: found.id } : {}), ...(start ? { start: start.id } : {}), ...(naming ? { naming: true } : {}) }];
  });
}
