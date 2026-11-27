import fs from 'node:fs';
import type { BoardPaths } from './store.js';
import { isPlain } from './shape.js';
import {
  checkedStudioId,
  componentFile,
  designSystemChatsDir,
  designSystemDir,
  designSystemFile,
  designSystemVersionDir,
  designSystemsDir,
  frameFile,
  STUDIO_ID,
  screenFile,
  screensDir,
  sketchChatsDir,
  sketchDir,
  sketchFile,
  sketchThumbnailsDir,
  sketchesDir,
  tokensFile,
  variantDir,
  variantMetaFile,
  type ChatOwner,
} from './studio-paths.js';
import { dumpYaml, folders, idsIn, plainFile, writeNewVersion, writeShared } from './studio-files.js';
import { holdStudio } from './studio-lock.js';
import { checkScreenNames, nameOnDrawing } from './studio-screens.js';
import { MAX_NAME, checkSketchNameFree, checkedName, freeScreenName, freeSketchId, freeSketchName, screenNameKey, studioIdFor } from './studio-names.js';
import {
  DEFAULT_FRAMES,
  SCREEN_STATES,
  readDesignSystem,
  readSystemFile,
  readScreenFile,
  readSketch,
  readSketchFile,
  type DesignSystem,
  type ScreenFile,
  type ScreenStatus,
  type ScreenVariant,
  type Sketch,
  type SketchFile,
  type SketchScreen,
  type SystemFile,
  type VariantAskMarks,
  type VariantMetaFile,
  VARIANT_LETTER,
} from './studio-read.js';
import {
  askMarksOf,
  changeStudioItem,
  checkNotApproved,
  checkFrames,
  checkStudioStamp,
  checkedHtml,
  screenNamed,
  writeMarked,
  writeNewScreen,
  writeVariant,
  StudioChangedElsewhere,
  type EditBy,
  type VariantInput,
} from './studio-write.js';

/**
 * The Studio's store (AB-128.2): sketches and design systems saved inside the project, in `.squad/studio/`, so the
 * team gets them through git the way it gets tickets. Every Studio save, read and delete goes through this module:
 * later Studio stories import from here only. Its parts: studio-paths.ts (every location, from BoardPaths),
 * studio-read.ts (the saved shapes, the reads and the default design system), studio-files.ts (listing, the change
 * stamp and writing), studio-lock.ts (one change at a time per project), studio-names.ts (one sketch name per
 * project, and the free-name and free-id helpers, AB-138.1), studio-write.ts (the stamp check, the edit marks and the
 * writing of a variant, and the lock on an approved screen), studio-approval.ts (approving and reopening a screen,
 * US-15, with the pick and the screen delete its lock guards), studio-tokens.ts (the token check of a variant's pages,
 * US-17) and studio-local.ts (thumbnails and chats, on this computer).
 *
 * Each item (one design system, one sketch) is its own folder of plain YAML, JSON and HTML. Versions (v1, v2 …) only
 * grow: a saved version is never written again, so every variant stays pickable. Each item is read back with a change
 * stamp made from its files; every change brings the stamp it last read and is refused with "Changed elsewhere,
 * reload" when the files have changed since (AB-129.1), here, in another tab, or through a git pull.
 *
 * Every change to a sketch also writes when and by whom on the file it already saves (AB-131.1), in the same write and
 * under the same stamp check; the sketch's last edit is the newest of those marks, worked out on read.
 */

export {
  AI_DESIGNER,
  DEFAULT_FRAMES,
  SCREEN_STATES,
  SCREEN_STATUSES,
  byMadeOrder,
  defaultDesignSystemOf,
  readDefaultDesignSystem,
  readDesignSystem,
  readSketch,
  readStudio,
  studioItemDir,
  studioStamp,
  type BrokenStudioItem,
  type ApprovalMark,
  type DesignSystem,
  type DesignSystemVersion,
  type EditMark,
  type ScreenStatus,
  type ScreenVariant,
  type Sketch,
  type SketchScreen,
  type StudioContents,
  type StudioItem,
  type StudioKind,
  type TokenWarning,
  type VariantAskMarks,
} from './studio-read.js';
export { tokenWarnings } from './studio-tokens.js';
export { CHANGED_ELSEWHERE, StudioChangedElsewhere, StudioScreenApproved, approvedWords, changeStudioItem, checkStudioStamp, type EditBy, type VariantInput } from './studio-write.js';
export { approveScreen, deleteScreen, pickVariant, reopenScreen } from './studio-approval.js';
export { stampOfFolder } from './studio-files.js';
export { StudioExportRefused, exportPlan, type ExportChoice, type ExportOption, type ExportPage, type ExportPlan, type ExportScreen } from './studio-export.js';
export { addNewScreen, nameNewScreen } from './studio-screens.js';
export { readPrototypeFile, replacePrototypeLinks, setPrototypeLink, setPrototypeStart, prototypeMap, findButtons, tabDrawing, IN_USE_TAB, type LinkTarget, type PrototypeFile, type PrototypeLink, type PrototypeMap, type PrototypeSaved, type PrototypeTab, type PrototypeScreen, type PrototypeDrawing } from './studio-prototype.js';
export {
  NEW_SCREEN_NAME,
  StudioNameTaken,
  StudioScreenNameTaken,
  freeScreenId,
  freeScreenName,
  freeSketchId,
  freeSketchName,
  screenNameKey,
  screenUsingName,
  sketchNameKey,
  sketchUsingName,
  studioIdFor,
} from './studio-names.js';

function checkedTokens(tokens: unknown): Record<string, unknown> {
  if (tokens === undefined) return {};
  if (!isPlain(tokens)) throw new Error('The design tokens must be named values (colours, fonts, spacing …).');
  return JSON.parse(JSON.stringify(tokens)) as Record<string, unknown>;
}

function tokensText(tokens: Record<string, unknown>): string {
  return `${JSON.stringify(tokens, null, 2)}\n`;
}

function sameHtml(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a).sort();
  return keys.join('\n') === Object.keys(b).sort().join('\n') && keys.every((k) => a[k] === b[k]);
}

export interface DesignSystemInput {
  /** Left out, it is made from the name. */
  id?: string;
  name: string;
  tokens?: Record<string, unknown>;
  /** Component id → its HTML. */
  components?: Record<string, string>;
  /** Its frames (AB-133.1). Left out, a new one gets Desktop and Mobile, and a save keeps what its file has. */
  frames?: string[];
}

/** A list of frames: at least one, each a frame id (desktop, mobile …), each once, in order. */
export function checkedFrameList(frames: unknown, what: string): string[] {
  if (!Array.isArray(frames) || !frames.length || frames.some((f) => typeof f !== 'string')) throw new Error(`Give the ${what} at least one frame, like desktop.`);
  return [...new Set((frames as string[]).map((f) => checkedStudioId(f)))];
}

/** Another design system is already saved in the project, readable or not. */
function otherDesignSystemSaved(bp: BoardPaths, id: string): boolean {
  return idsIn(designSystemsDir(bp)).some((other) => other !== id && plainFile(designSystemFile(bp, other)));
}

/**
 * Saves a design system. With no stamp it is new: version 1 with its tokens and components, marked default only when
 * no other design system is saved yet (AB-158.1). With the stamp the caller read, its name is saved, and tokens or
 * components that differ from the current version become the next version; saved versions never change, and the
 * default mark and the made time stay as they were.
 */
export function saveDesignSystem(bp: BoardPaths, input: DesignSystemInput, stamp: string | null = null): DesignSystem {
  const name = checkedName(input.name, 'design system');
  const id = checkedStudioId(input.id ?? studioIdFor(name));
  const tokens = checkedTokens(input.tokens);
  const components = checkedHtml(input.components, 'component');
  const frames = input.frames === undefined ? undefined : checkedFrameList(input.frames, 'design system');
  return changeStudioItem(bp, { kind: 'design-system', id }, stamp, () => {
    const before = stamp === null ? null : readDesignSystem(bp, id);
    const current = before?.versions.find((v) => v.version === before.version);
    // Left out, the tokens or the components stay as the current version has them.
    const nextTokens = input.tokens === undefined && current ? current.tokens : tokens;
    const nextComponents = input.components === undefined && current ? current.components : components;
    const same = current !== undefined && tokensText(current.tokens) === tokensText(nextTokens) && sameHtml(current.components, nextComponents);
    let version = before?.version ?? 1;
    if (!same) {
      version = before ? Math.max(0, ...before.versions.map((v) => v.version)) + 1 : 1;
      const files: Record<string, string> = { [tokensFile(bp, id, version)]: tokensText(nextTokens) };
      for (const [c, html] of Object.entries(nextComponents)) files[componentFile(bp, id, version, c)] = html;
      writeNewVersion(designSystemVersionDir(bp, id, version), files);
    }
    // Its frames (AB-133.1): a new one starts with Desktop and Mobile; a save keeps the list its file has, and a file
    // made before the list was kept stays without one (it is read as Desktop and Mobile).
    const savedFrames = before ? readSystemFile(designSystemFile(bp, id)).frames : undefined;
    const nextFrames = frames ?? savedFrames ?? (before ? undefined : [...DEFAULT_FRAMES]);
    const system: SystemFile = before
      ? { name, default: before.markedDefault, version, madeAt: before.madeAt || new Date().toISOString(), ...(nextFrames ? { frames: nextFrames } : {}) }
      : { name, default: !otherDesignSystemSaved(bp, id), version, madeAt: new Date().toISOString(), ...(nextFrames ? { frames: nextFrames } : {}) };
    writeShared(designSystemFile(bp, id), dumpYaml(system));
    return readDesignSystem(bp, id)!;
  });
}

export interface ScreenInput {
  /** Left out, it is made from the name. */
  id?: string;
  name: string;
  order?: number;
  status?: ScreenStatus;
}

export interface SketchInput {
  /** Left out, it is made from the name. */
  id?: string;
  name: string;
  designSystem?: { id: string; version: number } | null;
  /** The frames each screen is drawn in: desktop, tablet, mobile … */
  frames: string[];
  /** Screens to add or rename, reorder and mark; a screen left out stays as it is. */
  screens?: ScreenInput[];
}

/**
 * Saves a sketch and its screens. With no stamp it is new. A new screen has no variant yet; its first one comes from
 * addVariant. A screen's chosen variant changes only through addVariant and pickVariant. The sketch file and each
 * screen file that changes gets the mark of who made the change, and when (AB-131.1).
 */
export function saveSketch(bp: BoardPaths, input: SketchInput, stamp: string | null = null, who: EditBy = {}): Sketch {
  const name = checkedName(input.name, 'sketch');
  const id = checkedStudioId(input.id ?? studioIdFor(name));
  if (!Array.isArray(input.frames) || !input.frames.length) throw new Error('Give the sketch at least one frame, like desktop.');
  const frames = [...new Set(input.frames.map((f) => checkedStudioId(f)))];
  const ds = input.designSystem ?? null;
  if (ds) {
    checkedStudioId(ds.id);
    if (!Number.isInteger(ds.version) || ds.version < 1 || !plainFile(tokensFile(bp, ds.id, ds.version))) {
      throw new Error(`This project has no design system "${ds.id}" version ${ds.version}.`);
    }
  }
  const screens = (input.screens ?? []).map((s, i) => {
    const screenName = checkedName(s.name, 'screen');
    const status = s.status ?? 'draft';
    if (!(SCREEN_STATES as readonly string[]).includes(status)) throw new Error(`A screen is ${SCREEN_STATES.join(', ').replace(/, (?=[^,]*$)/, ' or ')}.`);
    return { id: checkedStudioId(s.id ?? studioIdFor(screenName)), name: screenName, order: typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : i + 1, status };
  });
  if (new Set(screens.map((s) => s.id)).size !== screens.length || new Set(screens.map((s) => screenNameKey(s.name))).size !== screens.length) {
    throw new Error('Two screens in the sketch have the same name.');
  }
  return changeStudioItem(bp, { kind: 'sketch', id }, stamp, () => {
    const sketch: SketchFile = { name, designSystem: ds ? { id: ds.id, version: ds.version } : null, frames };
    const sketchBefore = stamp === null ? null : readSketchFile(sketchFile(bp, id));
    // Only a new name is checked: two "Login" sketches a merge brought both stay, until one of them is renamed.
    if (sketchBefore?.name !== name) checkSketchNameFree(bp, name, id);
    // The screen-name rule (AB-136.1), for every screen before anything is written.
    const befores = checkScreenNames(bp, id, name, screens, stamp === null);
    // The lock (US-15, AB-140.1): an approved screen stays approved until Reopen. Its name and place may change: they
    // do not change its design. Checked for every screen before anything is written. (The board and the terminal mark
    // only draft or ready; approving is its own action, approveScreen.)
    screens.forEach((s, i) => {
      const before = befores[i];
      if (before?.status === 'approved' && s.status !== 'approved') checkNotApproved({ id: s.id, ...before });
    });
    writeMarked(sketchFile(bp, id), sketchBefore, sketch, who);
    screens.forEach((s, i) => {
      const before = befores[i]!;
      // A screen not named yet keeps its mark until it gets a name of its own: a rename clears it.
      const unnamed = before?.unnamed && before.name === s.name;
      const screen: ScreenFile = { name: s.name, order: s.order, status: s.status, chosen: before?.chosen ?? null, ...(unnamed ? { unnamed: true } : {}), ...(before?.approved ? { approved: before.approved } : {}) };
      writeMarked(screenFile(bp, id, s.id), before, screen, who);
    });
    return readSketch(bp, id)!;
  });
}

/** Adds a variant of a screen as its next version. Every earlier variant stays as it was. */
export function addVariant(bp: BoardPaths, sketch: string, screen: string, input: VariantInput, stamp: string): Sketch {
  checkedStudioId(sketch);
  const frames = checkedHtml(input.frames, 'frame');
  if (!Object.keys(frames).length) throw new Error('A variant needs at least one frame.');
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    checkFrames(bp, sketch, frames);
    writeVariant(bp, sketch, screen, frames, input);
    return readSketch(bp, sketch)!;
  });
}

export interface DrawnScreen {
  /** The screen it changes, when it names one the sketch has. */
  id?: string;
  name: string;
  /** Frame id → its HTML. */
  frames: Record<string, string>;
}

/**
 * Saves the screens the AI Designer drew as the sketch's new version, all at once under one stamp check: each one
 * becomes the next variant of its screen (found by id, then by name) or a new screen, and is chosen. Every earlier
 * variant stays, pickable later. An old stamp writes nothing: "Changed elsewhere, reload".
 */
export function saveDrawnScreens(bp: BoardPaths, sketch: string, drawn: DrawnScreen[], stamp: string, by: { madeBy?: string; madeFor?: string; note?: string } = {}): { sketch: Sketch; saved: { screen: string; version: number }[] } {
  checkedStudioId(sketch);
  if (!drawn.length) throw new Error('There are no screens to save.');
  const screens = drawn.map((d) => ({ id: d.id, name: checkedName(d.name, 'screen'), frames: checkedHtml(d.frames, 'frame') }));
  if (screens.some((d) => !Object.keys(d.frames).length)) throw new Error('A screen needs at least one frame.');
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    for (const d of screens) checkFrames(bp, sketch, d.frames);
    const current = readSketch(bp, sketch)!.screens;
    // Each drawing goes to the screen it names, by id then by name as the screen-name rule compares them (AB-136.1), or
    // to a new screen; two drawings for one screen are refused before anything is written.
    const found = screens.map((d) => screenNamed(current, d));
    // An approved screen is not drawn again until it is reopened (US-15, AB-140.1): refused before anything is written.
    for (const f of found) if (f) checkNotApproved(f);
    const keys = found.map((f, i) => f?.id ?? `new:${screenNameKey(screens[i]!.name)}`);
    if (new Set(keys).size !== keys.length) throw new Error('Two screens in the sketch have the same name.');
    const known: { id: string; name: string; order: number }[] = current.map((c) => ({ id: c.id, name: c.name, order: c.order }));
    const ids = screens.map((d, i) => {
      // A screen not named yet takes the name its first drawing brings, in this same save (AB-136.1).
      if (found[i]) return (nameOnDrawing(bp, sketch, found[i]!.id, d.name, { by: by.madeBy, for: by.madeFor }), found[i]!.id);
      const id = writeNewScreen(bp, sketch, known, d.name, { by: by.madeBy, for: by.madeFor });
      known.push({ id, name: d.name, order: Math.max(0, ...known.map((k) => k.order)) + 1 });
      return id;
    });
    const saved = screens.map((d, i) => {
      const id = ids[i]!;
      // A change to the chosen variant of an ask (US-17, AB-142.1) stays that variant: same ask, letter, name and idea,
      // so its card shows the new drawing while the ask's other variants stay.
      const was = current.find((c) => c.id === id);
      const ask = askMarksOf(was?.variants.find((v) => v.version === was.chosen));
      return { screen: id, version: writeVariant(bp, sketch, id, d.frames, { ...by, choose: true, ask }) };
    });
    return { sketch: readSketch(bp, sketch)!, saved };
  });
}

/**
 * Saves several variants of one screen in one change, under one stamp check (US-08): the AI Designer's first screen of
 * a sketch started from the start page, drawn once per variant. The screen is found by id, then by name, or made new.
 * Each variant becomes its next version, and the first of them is picked; the others stay, pickable later. An old
 * stamp writes nothing: "Changed elsewhere, reload".
 */
export function saveScreenVariants(
  bp: BoardPaths,
  sketch: string,
  screen: { id?: string; name: string },
  variants: Record<string, string>[],
  stamp: string,
  by: { madeBy?: string; madeFor?: string; note?: string } = {},
): { sketch: Sketch; screen: string; versions: number[] } {
  checkedStudioId(sketch);
  const name = checkedName(screen.name, 'screen');
  if (!variants.length) throw new Error('There are no variants to save.');
  const drawn = variants.map((v) => checkedHtml(v, 'frame'));
  if (drawn.some((d) => !Object.keys(d).length)) throw new Error('A variant needs at least one frame.');
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    for (const d of drawn) checkFrames(bp, sketch, d);
    const current = readSketch(bp, sketch)!.screens;
    const found = screenNamed(current, { ...(screen.id ? { id: screen.id } : {}), name });
    if (found) checkNotApproved(found);
    const id = found?.id ?? writeNewScreen(bp, sketch, current, name, { by: by.madeBy, for: by.madeFor });
    const versions = drawn.map((frames, i) => writeVariant(bp, sketch, id, frames, { ...by, choose: i === 0 }));
    return { sketch: readSketch(bp, sketch)!, screen: id, versions };
  });
}

/** One variant drawn for an ask (US-17): its letter in the ask, its short name, its one-line idea and its pages. */
export interface AskVariant {
  letter: string;
  name: string;
  idea: string;
  /** Frame id → its HTML. */
  frames: Record<string, string>;
}

/** The finished variants of one screen in an ask, A first. The screen is found by id, then by name, or made new. */
export interface AskScreen {
  id?: string;
  name: string;
  variants: AskVariant[];
}

/**
 * The variant a letter names on a screen (US-17), as "Use B" means it: the newest version of that letter in the ask of
 * the screen's chosen variant, or else in its newest ask with that letter. Null when it has none.
 */
export function variantOfLetter(screen: SketchScreen, letter: string): ScreenVariant | null {
  const chosen = screen.variants.find((v) => v.version === screen.chosen);
  const lettered = screen.variants.filter((v) => v.ask && v.letter === letter);
  const inAsk = chosen?.ask ? lettered.filter((v) => v.ask === chosen.ask) : [];
  const pool = inAsk.length ? inAsk : lettered;
  return pool.reduce<ScreenVariant | null>((newest, v) => (!newest || v.version > newest.version ? v : newest), null);
}

/** A new ask's id: every variant drawn for one message shares it (US-17). */
export function newAskId(): string {
  return `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const oneLine = (x: unknown, max: number, what: string): string => {
  if (typeof x !== 'string' || !x.trim()) throw new Error(`Give each variant ${what}.`);
  return x.trim().replace(/\s+/g, ' ').slice(0, max);
};

/**
 * Saves every finished variant of one ask (US-17, AB-142.1) in one change, under one stamp check: each becomes the next
 * version of its screen, with the ask, its letter, its short name and its idea on its own meta.yaml, and the token
 * check of its pages against the sketch's design system made now (or the "no design system" mark). Each screen's
 * variant A is chosen; the others stay, pickable with "Use this one". Every earlier variant stays as it was. An old
 * stamp writes nothing: "Changed elsewhere, reload".
 */
export function saveAskVariants(
  bp: BoardPaths,
  sketch: string,
  ask: { id: string; words?: string },
  screens: AskScreen[],
  stamp: string,
  by: { madeBy?: string; madeFor?: string; note?: string } = {},
): { sketch: Sketch; saved: { screen: string; version: number; letter: string; name: string }[] } {
  checkedStudioId(sketch);
  const askId = oneLine(ask.id, 80, 'an ask');
  const asked = typeof ask.words === 'string' && ask.words.trim() ? ask.words.trim().replace(/\s+/g, ' ').slice(0, 500) : undefined;
  const drawn = screens
    .filter((s) => s.variants.length)
    .map((s) => ({
      id: s.id,
      name: checkedName(s.name, 'screen'),
      variants: s.variants.map((v) => {
        if (typeof v.letter !== 'string' || !VARIANT_LETTER.test(v.letter)) throw new Error('A variant\'s letter is one capital letter: A, B or C.');
        const frames = checkedHtml(v.frames, 'frame');
        if (!Object.keys(frames).length) throw new Error('A variant needs at least one frame.');
        return { letter: v.letter, name: oneLine(v.name, 120, 'a short name'), idea: oneLine(v.idea, 300, 'an idea'), frames };
      }),
    }));
  if (!drawn.length) throw new Error('There are no variants to save.');
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    for (const s of drawn) for (const v of s.variants) checkFrames(bp, sketch, v.frames);
    // An approved screen gets no new variant until it is reopened (US-15, AB-140.1): refused before anything is written.
    const before = readSketch(bp, sketch)!.screens;
    for (const s of drawn) {
      const found = screenNamed(before, { ...(s.id ? { id: s.id } : {}), name: s.name });
      if (found) checkNotApproved(found);
    }
    const saved: { screen: string; version: number; letter: string; name: string }[] = [];
    for (const s of drawn) {
      const current = readSketch(bp, sketch)!.screens;
      const found = screenNamed(current, { ...(s.id ? { id: s.id } : {}), name: s.name });
      // A screen not named yet takes the name its first drawing brings, in this same save (AB-136.1).
      if (found) nameOnDrawing(bp, sketch, found.id, s.name, { by: by.madeBy, for: by.madeFor });
      const id = found?.id ?? writeNewScreen(bp, sketch, current, s.name, { by: by.madeBy, for: by.madeFor });
      s.variants.forEach((v, i) => {
        const version = writeVariant(bp, sketch, id, v.frames, { ...by, choose: i === 0, ask: { ask: askId, ...(asked ? { asked } : {}), letter: v.letter, name: v.name, idea: v.idea } });
        saved.push({ screen: id, version, letter: v.letter, name: v.name });
      });
    }
    return { sketch: readSketch(bp, sketch)!, saved };
  });
}

/**
 * Names a sketch started from the start page and its first screen, as the AI Designer suggests them (US-08), in one
 * change under the stamp the turn read. The sketch's name goes through the one free-name helper (AB-138.1): "Booking"
 * becomes "Booking 2" when another sketch has it. The first screen is the sketch's first one when it has one (renamed),
 * or a new one with no drawing yet. Both files are marked with who did it (AB-131.1). Each can be renamed later.
 */
export function nameSketchAndFirstScreen(bp: BoardPaths, sketch: string, names: { sketch: string; screen: string }, stamp: string, who: EditBy = {}): { sketch: Sketch; screen: string } {
  checkedStudioId(sketch);
  const wanted = checkedName(names.sketch, 'sketch');
  const screenName = checkedName(names.screen, 'screen');
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    const before = readSketchFile(sketchFile(bp, sketch));
    const name = freeSketchName(bp, wanted, sketch);
    writeMarked(sketchFile(bp, sketch), before, { ...before, name }, who);
    const current = readSketch(bp, sketch)!.screens;
    const first = current[0];
    let screen: string;
    if (first) {
      screen = first.id;
      const file = screenFile(bp, sketch, first.id);
      const before = readScreenFile(file);
      const { unnamed: _unnamed, ...was } = before;
      // The screen-name rule (AB-136.1): a name another screen of the sketch has becomes a free one, "Form 2".
      writeMarked(file, before, { ...was, name: freeScreenName(current, screenName, first.id) }, who);
    } else screen = writeNewScreen(bp, sketch, current, screenName, who);
    return { sketch: readSketch(bp, sketch)!, screen };
  });
}

/* ── Deletes: for good, with no bin ─────────────────────── */

/** A design system that sketches still follow is not deleted. Nothing was written. */
export class StudioInUse extends Error {
  constructor(
    readonly designSystem: string,
    /** The sketches that follow it, by id and name. */
    readonly sketches: { id: string; name: string }[],
  ) {
    const names = sketches.map((s) => `"${s.name}"`);
    const listed = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    super(`${names.length > 1 ? 'The sketches' : 'The sketch'} ${listed} ${names.length > 1 ? 'follow' : 'follows'} this design system. Move ${names.length > 1 ? 'them' : 'it'} to another design system first, then delete it.`);
    this.name = 'StudioInUse';
  }
}

/** The sketches in the project that follow a design system, any version of it. A sketch that cannot be read is left out. */
export function sketchesFollowing(bp: BoardPaths, designSystem: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const id of idsIn(sketchesDir(bp))) {
    const file = sketchFile(bp, id);
    if (!plainFile(file)) continue;
    try {
      const sketch = readSketchFile(file);
      if (sketch.designSystem?.id === designSystem) out.push({ id, name: sketch.name });
    } catch {
      // readStudio lists it as broken.
    }
  }
  return out;
}

/**
 * Deletes a design system and every version of it, for good, with this computer's chats about it, with the stamp the
 * caller read. Refused with
 * StudioInUse, naming the sketches, while any sketch follows it.
 */
export function deleteDesignSystem(bp: BoardPaths, id: string, stamp: string): void {
  changeStudioItem(bp, { kind: 'design-system', id }, stamp, () => {
    const following = sketchesFollowing(bp, id);
    if (following.length) throw new StudioInUse(id, following);
    fs.rmSync(designSystemDir(bp, id), { recursive: true, force: true });
    fs.rmSync(designSystemChatsDir(bp, id), { recursive: true, force: true });
  });
}

/**
 * Deletes a sketch, its screens and every variant for good, with this computer's thumbnails and chats for it. Gives
 * back how many screens it removed, counted under the lock.
 */
export function deleteSketch(bp: BoardPaths, id: string, stamp: string): { screens: number } {
  return changeStudioItem(bp, { kind: 'sketch', id }, stamp, () => {
    const screens = folders(screensDir(bp, id)).filter((s) => STUDIO_ID.test(s) && plainFile(screenFile(bp, id, s))).length;
    fs.rmSync(sketchDir(bp, id), { recursive: true, force: true });
    fs.rmSync(sketchThumbnailsDir(bp, id), { recursive: true, force: true });
    fs.rmSync(sketchChatsDir(bp, id), { recursive: true, force: true });
    return { screens };
  });
}

/**
 * Duplicates a sketch (US-13, AB-138), with the stamp of the source the caller read: a new sketch named "Booking copy"
 * (then "Booking copy 2" …, AB-138.1) with the same design system and frames, and each screen with the same name and
 * order, as Draft, with the drawing it shows now saved as its version 1. Older variants, thumbnails and the
 * conversation are not copied. The copy is marked as made by `who` (AB-131.1); the source is not touched.
 */
export function duplicateSketch(bp: BoardPaths, source: string, stamp: string, who: EditBy = {}): Sketch {
  checkedStudioId(source);
  return holdStudio(bp, () => {
    checkStudioStamp(bp, { kind: 'sketch', id: source }, stamp);
    const from = readSketch(bp, source);
    if (!from) throw new StudioChangedElsewhere();
    const name = freeSketchName(bp, `${from.name.slice(0, MAX_NAME - ' copy'.length).trimEnd()} copy`);
    const id = freeSketchId(bp, name);
    // The screens first and the sketch file last: a copy cut short is never read as a sketch.
    for (const s of from.screens) {
      const drawn = s.variants.find((v) => v.version === s.chosen);
      if (drawn) {
        const meta: VariantMetaFile = { madeAt: drawn.madeAt, ...(drawn.madeBy ? { madeBy: drawn.madeBy } : {}), ...(drawn.madeFor ? { madeFor: drawn.madeFor } : {}), ...(drawn.note ? { note: drawn.note } : {}) };
        const files: Record<string, string> = { [variantMetaFile(bp, id, s.id, 1)]: dumpYaml(meta) };
        for (const [f, html] of Object.entries(drawn.frames)) files[frameFile(bp, id, s.id, 1, f)] = html;
        writeNewVersion(variantDir(bp, id, s.id, 1), files);
      }
      writeMarked<ScreenFile>(screenFile(bp, id, s.id), null, { name: s.name, order: s.order, status: 'draft', chosen: drawn ? 1 : null, ...(s.unnamed ? { unnamed: true } : {}) }, who);
    }
    writeMarked<SketchFile>(sketchFile(bp, id), null, { name, designSystem: from.designSystem, frames: from.frames }, who);
    return readSketch(bp, id)!;
  });
}

/* ── This computer's part: thumbnails and AI Designer chats (studio-local.ts) ── */

export { readChat, readThumbnail, saveChat, saveThumbnail, type ApprovalLine, type ChatOwner, type ChatReplyKind, type ChatStepMark, type UnsavedMark, type PickMark, type StartMark, type StudioChat, type StudioChatMessage } from './studio-local.js';
