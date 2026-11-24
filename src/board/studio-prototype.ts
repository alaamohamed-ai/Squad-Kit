import type { BoardPaths } from './store.js';
import { isPlain } from './shape.js';
import { checkedStudioId, prototypeFile } from './studio-paths.js';
import { plainFile, readYamlFile } from './studio-files.js';
import { readSketch, type EditMark } from './studio-read.js';
import { changeStudioItem, writeMarked, type EditBy } from './studio-write.js';
import { MAX_BUTTON_NAME, buttonKey, prototypeMap, type PrototypeMap } from './studio-prototype-map.js';

export { findButtons, prototypeMap, type PrototypeMap } from './studio-prototype-map.js';

/**
 * A sketch's prototype (US-54, AB-179.1), part of the Studio store: studio.ts gives these out again. It is kept in one
 * file in the sketch's own folder, prototype.yaml, so the sketch's stamp counts it and a teammate gets it through git:
 * the start screen the person marked, and the links, each from a screen's button (by the button's name, the same on
 * Desktop and Mobile) to another screen or Back.
 *
 *   start: confirm
 *   links:
 *     - { screen: form, button: Continue, to: confirm }
 *     - { screen: confirm, button: Back, back: true }
 *
 * Approved screens stay locked (AB-140.1): links never touch a screen's own file or its drawing, so linking an approved
 * screen is not a change to it and its lock does not refuse it. Every change runs under the Studio lock with the
 * sketch's stamp the person read (AB-129.1), and is marked with who and when (AB-131.1). Reading writes nothing and
 * fixes nothing (AB-127.1): a link whose button is gone, or whose screen is not approved now, stays in the file and is
 * shown as broken (studio-prototype-map.ts). Later stories (the HTML export, linking from the chat) read and save this
 * same file through here.
 */

/** Where a link goes: one of the sketch's screens, or Back to the screen before, as a user would. */
export type LinkTarget = { screen: string } | { back: true };

export interface PrototypeLink {
  /** The screen the button is on. */
  screen: string;
  /** The button's name, as studio-prototype-map.ts names it from the drawing. */
  button: string;
  to: LinkTarget;
}

/** `prototype.yaml`. */
export interface PrototypeFile {
  /** The start screen the person marked; left out, the first approved screen in the screen order. */
  start?: string;
  links: PrototypeLink[];
  /** The last change this file saved (AB-131.1). */
  edited?: EditMark;
}

/** A button's name as it is kept: one line, short. */
export function buttonName(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const name = x.trim().replace(/\s+/g, ' ').slice(0, MAX_BUTTON_NAME).trim();
  return name || null;
}

const sameTarget = (a: LinkTarget, b: LinkTarget) => ('back' in a ? 'back' in b : 'screen' in b && a.screen === b.screen);

/** A link as written: what cannot be read is left out, so a hand edit or a merge never breaks the read. */
function readLink(x: unknown): PrototypeLink | null {
  if (!isPlain(x) || typeof x.screen !== 'string') return null;
  const button = buttonName(x.button);
  if (!button) return null;
  try {
    checkedStudioId(x.screen);
  } catch {
    return null;
  }
  if (x.back === true) return { screen: x.screen, button, to: { back: true } };
  if (typeof x.to !== 'string') return null;
  try {
    return { screen: x.screen, button, to: { screen: checkedStudioId(x.to) } };
  } catch {
    return null;
  }
}

/**
 * A sketch's prototype file, as written, or an empty one when it has none. One link per button: when a merge brings two
 * for the same button, the first one counts. Reading never writes.
 */
export function readPrototypeFile(bp: BoardPaths, sketch: string): PrototypeFile {
  const file = prototypeFile(bp, sketch);
  if (!plainFile(file)) return { links: [] };
  let raw: unknown;
  try {
    raw = readYamlFile(file);
  } catch {
    // A merge both people changed: no links until it is fixed; the next save writes a whole file again.
    return { links: [] };
  }
  if (!isPlain(raw)) return { links: [] };
  const seen = new Set<string>();
  const links: PrototypeLink[] = [];
  for (const x of Array.isArray(raw.links) ? raw.links : []) {
    const link = readLink(x);
    if (!link || seen.has(buttonKey(link.screen, link.button))) continue;
    seen.add(buttonKey(link.screen, link.button));
    links.push(link);
  }
  let start: string | undefined;
  if (typeof raw.start === 'string') {
    try {
      start = checkedStudioId(raw.start);
    } catch {
      start = undefined;
    }
  }
  return { ...(start ? { start } : {}), links };
}

/** The file as it is written: links in a steady order, so the same links make the same file on every computer. */
function fileText(p: PrototypeFile): PrototypeFile {
  return {
    ...(p.start ? { start: p.start } : {}),
    links: p.links.map((l) => ({ screen: l.screen, button: l.button, ...('back' in l.to ? { back: true } : { to: l.to.screen }) })) as unknown as PrototypeLink[],
  };
}

/** The sketch's prototype as it reads now, under the lock. */
function mapNow(bp: BoardPaths, sketch: string): PrototypeMap {
  const s = readSketch(bp, sketch);
  if (!s) throw new Error(`This project has no sketch "${sketch}".`);
  return prototypeMap(s, readPrototypeFile(bp, sketch));
}

/**
 * The checks one link must pass to be saved: its screen is in the prototype now (approved), its button is on that
 * screen's approved drawing, and it leads to another screen in the prototype, or Back.
 */
function checkLink(map: PrototypeMap, link: PrototypeLink): PrototypeLink {
  const from = map.screens.find((s) => s.id === link.screen);
  if (!from) throw new Error(`"${link.screen}" is not an approved screen of this sketch. Approve it first, then link it.`);
  const button = from.buttons.find((b) => buttonKey(from.id, b.name) === buttonKey(link.screen, link.button));
  if (!button) throw new Error(`${from.name} has no button "${link.button}". Pick one of its buttons.`);
  if ('screen' in link.to) {
    const target = link.to.screen;
    const to = map.screens.find((s) => s.id === target);
    if (!to) throw new Error(`"${target}" is not an approved screen of this sketch. Pick an approved screen, Back or no link.`);
    if (to.id === from.id) throw new Error(`A button on ${from.name} cannot lead to ${from.name} itself. Pick another screen, Back or no link.`);
  }
  // Kept with the name its drawing gives it.
  return { ...link, button: button.name };
}

function write(bp: BoardPaths, sketch: string, before: PrototypeFile, next: PrototypeFile, who: EditBy): void {
  const had = plainFile(prototypeFile(bp, sketch));
  writeMarked(prototypeFile(bp, sketch), had ? fileText(before) : null, fileText(next), who);
}

/** What a prototype change gives back: the prototype as saved, with the sketch's new stamp. */
export interface PrototypeSaved {
  map: PrototypeMap;
  stamp: string;
}

function saved(bp: BoardPaths, sketch: string): PrototypeSaved {
  return { map: mapNow(bp, sketch), stamp: readSketch(bp, sketch)!.stamp };
}

/**
 * Sets one button's link by hand (US-54): to a screen, to Back, or to no link (null). No link takes a link away, even a
 * broken one; a new link must pass checkLink. Only this button's link changes. The approved screen's lock does not
 * refuse it: the screen's own files are not touched.
 */
export function setPrototypeLink(bp: BoardPaths, sketch: string, link: { screen: string; button: string; to: LinkTarget | null }, stamp: string, who: EditBy = {}): PrototypeSaved {
  checkedStudioId(sketch);
  checkedStudioId(link.screen);
  const button = buttonName(link.button);
  if (!button) throw new Error('Pick a button first.');
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    const before = readPrototypeFile(bp, sketch);
    const key = buttonKey(link.screen, button);
    const others = before.links.filter((l) => buttonKey(l.screen, l.button) !== key);
    let links = others;
    if (link.to) {
      const next = checkLink(mapNow(bp, sketch), { screen: link.screen, button, to: link.to });
      // The link keeps its place in the file, so changing it shows as one line in git.
      const at = before.links.findIndex((l) => buttonKey(l.screen, l.button) === key);
      links = at >= 0 ? before.links.map((l, i) => (i === at ? next : l)) : [...before.links, next];
      if (at >= 0 && sameTarget(before.links[at]!.to, next.to)) links = before.links;
    }
    write(bp, sketch, before, { ...before, links }, who);
    return saved(bp, sketch);
  });
}

/** Marks the start screen (US-54): one of the approved screens. Play starts there while it is approved. */
export function setPrototypeStart(bp: BoardPaths, sketch: string, screen: string, stamp: string, who: EditBy = {}): PrototypeSaved {
  checkedStudioId(sketch);
  checkedStudioId(screen);
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    const map = mapNow(bp, sketch);
    if (!map.screens.some((s) => s.id === screen)) throw new Error(`"${screen}" is not an approved screen of this sketch. Approve it first, then make it the start.`);
    const before = readPrototypeFile(bp, sketch);
    write(bp, sketch, before, { ...before, start: screen }, who);
    return saved(bp, sketch);
  });
}

/**
 * "Generate the prototype" (US-54): the new links replace every link of the screens in the prototype now, all at once,
 * under the stamp the run read; an old stamp writes nothing ("Changed elsewhere, reload"). Every link is checked before
 * anything is written. The links of a screen that is reopened now are kept, so they come back when it is approved again.
 * The start screen stays as it was.
 */
export function replacePrototypeLinks(bp: BoardPaths, sketch: string, links: PrototypeLink[], stamp: string, who: EditBy = {}): PrototypeSaved {
  checkedStudioId(sketch);
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    const map = mapNow(bp, sketch);
    const keys = new Set<string>();
    const next: PrototypeLink[] = [];
    for (const l of links) {
      const button = buttonName(l.button);
      if (!button) throw new Error('A link has no button.');
      const link = checkLink(map, { screen: checkedStudioId(l.screen), button, to: 'back' in l.to ? { back: true } : { screen: checkedStudioId(l.to.screen) } });
      const key = buttonKey(link.screen, link.button);
      if (keys.has(key)) throw new Error(`The button "${link.button}" on one screen has two links.`);
      keys.add(key);
      next.push(link);
    }
    const inPrototype = new Set(map.screens.map((s) => s.id));
    const before = readPrototypeFile(bp, sketch);
    const kept = before.links.filter((l) => !inPrototype.has(l.screen));
    write(bp, sketch, before, { ...before, links: [...kept, ...next] }, who);
    return saved(bp, sketch);
  });
}
