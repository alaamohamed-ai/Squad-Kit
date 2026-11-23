import type { BoardPaths } from './store.js';
import { checkedStudioId, screenFile } from './studio-paths.js';
import { plainFile } from './studio-files.js';
import { NEW_SCREEN_NAME, checkScreenNameFree, checkedName, freeScreenName, screenNameKey, screenNames } from './studio-names.js';
import { SCREEN_STATES, readScreenFile, readSketch, type ScreenFile, type ScreenStatus, type Sketch } from './studio-read.js';
import { changeStudioItem, existingScreen, writeMarked, writeNewScreen, type EditBy } from './studio-write.js';

/**
 * The screens of a sketch (US-11, AB-136.1): adding one, and naming one that is not named yet. Part of the Studio store:
 * studio.ts gives these out again, and its saves call the helpers here under the lock and the stamp check of the save
 * (AB-129.1). A screen name is unique in its sketch, compared without capital letters or spaces at the ends; since a
 * sketch's name is unique in the project (AB-138.1), "Sketch / Screen" is unique in the project too.
 */

/**
 * The screen-name rule for a save that names screens (saveSketch), checked for every screen before anything is written:
 * only a new or changed name is checked, so two "Form" screens a merge brought both stay until one of them is renamed.
 * Gives back each screen's file as it was, or null for a new one. Runs under the lock.
 */
export function checkScreenNames(bp: BoardPaths, sketch: string, sketchName: string, screens: { id: string; name: string }[], isNew: boolean): (ScreenFile | null)[] {
  const named = isNew ? [] : screenNames(bp, sketch);
  return screens.map((s) => {
    const file = screenFile(bp, sketch, s.id);
    const before = plainFile(file) ? readScreenFile(file) : null;
    if (before?.name !== s.name) checkScreenNameFree(sketchName, named, s.name, s.id);
    const at = named.findIndex((n) => n.id === s.id);
    if (at >= 0) named[at] = { id: s.id, name: s.name };
    else named.push({ id: s.id, name: s.name });
    return before;
  });
}

/**
 * A screen not named yet gets the name its first drawing brings (AB-136.1), in the same save as that drawing, under the
 * lock: the AI Designer's name from the description, or a free one ("Form 2") when another screen of the sketch has it.
 * The mark is cleared. A drawing that brings no name of its own ("New screen" again) leaves the name and the mark, so a
 * later drawing still names it. A screen that has a name already is left as it is. Gives back the screen's name now.
 */
export function nameOnDrawing(bp: BoardPaths, sketch: string, screen: string, wanted: string, who: EditBy): string {
  const before = existingScreen(bp, sketch, screen);
  if (!before.unnamed || !wanted.trim() || screenNameKey(wanted) === screenNameKey(before.name)) return before.name;
  const { unnamed: _unnamed, ...rest } = before;
  const name = freeScreenName(screenNames(bp, sketch), checkedName(wanted, 'screen'), screen);
  writeMarked(screenFile(bp, sketch, screen), before, { ...rest, name }, who);
  return name;
}

/**
 * Adds a screen to a sketch (US-11, AB-136.1), under the stamp the caller read. A name is checked against the sketch's
 * other screens: a used one is refused with 'A screen called "Form" already exists in Booking', and nothing is saved.
 * With no name it is "New screen" (then "New screen 2" …) with the "not named yet" mark on its own screen.yaml, so the
 * AI Designer's first drawing of it gives it a name from the description. It has no variant until one is drawn. Marked
 * with who added it (AB-131.1).
 */
export function addNewScreen(bp: BoardPaths, sketch: string, input: { name?: string; order?: number; status?: ScreenStatus }, stamp: string, who: EditBy = {}): { sketch: Sketch; screen: string } {
  checkedStudioId(sketch);
  const wanted = typeof input.name === 'string' && input.name.trim() ? checkedName(input.name, 'screen') : null;
  const status = input.status ?? 'draft';
  if (!(SCREEN_STATES as readonly string[]).includes(status)) throw new Error(`A screen is ${SCREEN_STATES.join(', ').replace(/, (?=[^,]*$)/, ' or ')}.`);
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    const current = readSketch(bp, sketch)!.screens;
    const name = wanted ?? freeScreenName(current, NEW_SCREEN_NAME);
    const order = typeof input.order === 'number' && Number.isFinite(input.order) ? input.order : undefined;
    const screen = writeNewScreen(bp, sketch, current, name, who, { unnamed: wanted === null, status, ...(order !== undefined ? { order } : {}) });
    return { sketch: readSketch(bp, sketch)!, screen };
  });
}

/**
 * Names a screen that is not named yet (AB-136.1), on its own, under the stamp the caller read: the name given, or a free
 * one ("Form 2") when another screen of the sketch has it, and the mark is cleared. The AI Designer's drawings name a
 * screen in the same save instead (nameOnDrawing). A screen that has a name already is left as it is.
 */
export function nameNewScreen(bp: BoardPaths, sketch: string, screen: string, wanted: string, stamp: string, who: EditBy = {}): { sketch: Sketch; name: string } {
  checkedStudioId(sketch);
  const suggested = checkedName(wanted, 'screen');
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    const name = nameOnDrawing(bp, sketch, screen, suggested, who);
    return { sketch: readSketch(bp, sketch)!, name };
  });
}
