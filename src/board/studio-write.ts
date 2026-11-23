import type { BoardPaths } from './store.js';
import { isPlain } from './shape.js';
import { checkedStudioId, frameFile, screenDir, screenFile, sketchFile, variantDir, variantMetaFile } from './studio-paths.js';
import { dumpYaml, plainFile, versionsIn, writeNewVersion, writeShared } from './studio-files.js';
import { holdStudio } from './studio-lock.js';
import { MAX_NAME, checkScreenNameFree, freeScreenId, screenNameKey } from './studio-names.js';
import { readDesignSystem, readScreenFile, readSketchFile, studioStamp, type EditMark, type ScreenFile, type ScreenStatus, type SketchScreen, type StudioItem, type StudioKind, type VariantAskMarks, type VariantMetaFile } from './studio-read.js';
import { tokenWarnings } from './studio-tokens.js';

/**
 * How a Studio change is checked and written (AB-128.2, AB-129.1): the stamp check under the project's Studio lock,
 * the mark of who made a change (AB-131.1), and the writing of a screen's next variant, with its ask marks and the
 * token check made as it is saved (US-17, AB-142.1). Part of the Studio store: studio.ts is the one module later
 * stories import, and it gives these out again.
 */

/* ── Changes ────────────────────────────────────────────── */

/** What a change says when the files changed since the caller read them (AB-129.1). */
export const CHANGED_ELSEWHERE = 'Changed elsewhere, reload';

/** A change brought an old stamp: someone else changed the item first. Nothing was written. */
export class StudioChangedElsewhere extends Error {
  constructor() {
    super(CHANGED_ELSEWHERE);
    this.name = 'StudioChangedElsewhere';
  }
}

const KIND_WORDS: Record<StudioKind, string> = { 'design-system': 'design system', sketch: 'sketch' };

/**
 * The one check every Studio change makes, saves, variant picks and later deletes alike. `stamp` is the one the
 * caller last read; null means a brand-new item, refused when the project already has one by that id.
 */
export function checkStudioStamp(bp: BoardPaths, item: StudioItem, stamp: string | null): void {
  const now = studioStamp(bp, item);
  if (stamp === null) {
    if (now !== null) throw new Error(`This project already has a ${KIND_WORDS[item.kind]} called "${item.id}". Reload to see it.`);
    return;
  }
  if (now !== stamp) throw new StudioChangedElsewhere();
}

/**
 * Runs one change to one item under the project's Studio lock: works out the stamp again, stops with "Changed
 * elsewhere, reload" before writing anything when it differs, then writes. Later Studio changes (delete, archive) go
 * through here too.
 */
export function changeStudioItem<T>(bp: BoardPaths, item: StudioItem, stamp: string | null, write: () => T): T {
  checkedStudioId(item.id);
  return holdStudio(bp, () => {
    checkStudioStamp(bp, item, stamp);
    return write();
  });
}

export function checkedHtml(files: unknown, what: string): Record<string, string> {
  if (files === undefined) return {};
  if (!isPlain(files)) throw new Error(`The ${what} must be HTML by id.`);
  const out: Record<string, string> = {};
  for (const [id, html] of Object.entries(files)) {
    if (typeof html !== 'string') throw new Error(`The ${what} "${id.slice(0, 40)}" must be HTML text.`);
    out[checkedStudioId(id)] = html;
  }
  return out;
}

/** Who makes a change (AB-131.1): the person, or the AI Designer for the person who asked. */
export interface EditBy {
  by?: string;
  for?: string;
}

/** The mark a change writes on the file it saves, made now. */
export function markNow(who: EditBy): EditMark {
  const name = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME) : undefined);
  const by = name(who.by);
  const forWhom = name(who.for);
  return { at: new Date().toISOString(), ...(by ? { by } : {}), ...(forWhom ? { for: forWhom } : {}) };
}

/** A saved file's text without its mark, to tell whether a save changes anything. */
function withoutMark<T extends { edited?: EditMark }>(file: T): string {
  const { edited: _edited, ...rest } = file;
  return dumpYaml(rest);
}

/**
 * Writes a sketch or screen file with a new mark, only when what it says changes (or it is new): a save that changes
 * nothing leaves the file, its mark and the stamp as they were.
 */
export function writeMarked<T extends { edited?: EditMark }>(file: string, before: T | null, next: T, who: EditBy): void {
  if (before && withoutMark(before) === withoutMark(next)) return;
  writeShared(file, dumpYaml({ ...next, edited: markNow(who) }));
}

export interface VariantInput {
  /** Frame id → its HTML; every frame must be one of the sketch's frames. */
  frames: Record<string, string>;
  /** Who drew it: a person, or "AI Designer". */
  madeBy?: string;
  /** The person the AI Designer drew it for. */
  madeFor?: string;
  note?: string;
  /** Mark it as the chosen variant. The first variant of a screen is always chosen. */
  choose?: boolean;
}

export function existingScreen(bp: BoardPaths, sketch: string, screen: string): ScreenFile {
  checkedStudioId(screen);
  const file = screenFile(bp, sketch, screen);
  if (!plainFile(file)) throw new Error(`The sketch "${sketch}" has no screen "${screen}".`);
  return readScreenFile(file);
}

/** What a change to an approved screen is refused with (US-15, AB-140.1): "Form is approved. Reopen it first." */
export function approvedWords(screenName: string): string {
  return `${screenName} is approved. Reopen it first.`;
}

/**
 * A change to an approved screen (US-15, AB-140.1): a new drawing, a pick, a delete or a new status. Refused by the
 * Studio store itself, so the board, the terminal and the AI Designer all meet the same lock. Nothing was written.
 */
export class StudioScreenApproved extends Error {
  constructor(
    readonly screen: string,
    readonly screenName: string,
  ) {
    super(approvedWords(screenName));
    this.name = 'StudioScreenApproved';
  }
}

/** The lock (AB-140.1): refuses a change to a screen while it is approved. Call it before anything is written. */
export function checkNotApproved(screen: { id: string; name: string; status: ScreenStatus }): void {
  if (screen.status === 'approved') throw new StudioScreenApproved(screen.id, screen.name);
}

/** Every frame must be one of the sketch's frames. */
export function checkFrames(bp: BoardPaths, sketch: string, frames: Record<string, string>): void {
  const allowed = readSketchFile(sketchFile(bp, sketch)).frames;
  const other = Object.keys(frames).find((f) => !allowed.includes(f));
  if (other) throw new Error(`The sketch "${sketch}" has no frame "${other}". Add it to the sketch first.`);
}

/**
 * The token check of a variant's pages (US-17, AB-142.1), made once, when squad-kit saves it, under the lock: the
 * design system the sketch follows, what the pages use that its tokens lack, or the "no design system" mark.
 */
function checkedAgainstTokens(bp: BoardPaths, sketch: string, frames: Record<string, string>): Pick<VariantAskMarks, 'checkedWith' | 'warnings' | 'noDesignSystem'> {
  const follows = readSketchFile(sketchFile(bp, sketch)).designSystem;
  const ds = follows ? readDesignSystem(bp, follows.id) : null;
  const version = ds?.versions.find((v) => v.version === follows!.version);
  if (!follows || !ds || !version) return { noDesignSystem: true };
  const warnings = tokenWarnings(Object.values(frames), version.tokens);
  return { checkedWith: { id: ds.id, version: version.version, name: ds.name }, ...(warnings.length ? { warnings } : {}) };
}

/** The marks that say which ask a variant answers (US-17): a plain change to the chosen variant keeps them. */
export function askMarksOf(v: VariantAskMarks | undefined): Pick<VariantAskMarks, 'ask' | 'asked' | 'letter' | 'name' | 'idea'> | null {
  if (!v?.ask || !v.letter) return null;
  return { ask: v.ask, letter: v.letter, ...(v.asked ? { asked: v.asked } : {}), ...(v.name ? { name: v.name } : {}), ...(v.idea ? { idea: v.idea } : {}) };
}

/**
 * Writes a screen's next variant, under the lock and after the stamp was checked. Returns its version. Its meta.yaml is
 * the drawing's mark (AB-131.1): when, who drew it and for whom. A variant of an ask (US-17) also keeps its ask, letter,
 * name and idea, and the token check made now.
 */
export function writeVariant(bp: BoardPaths, sketch: string, screen: string, frames: Record<string, string>, input: Omit<VariantInput, 'frames'> & { ask?: VariantAskMarks | null }): number {
  const before = existingScreen(bp, sketch, screen);
  // An approved screen keeps its version until it is reopened (US-15, AB-140.1).
  checkNotApproved({ id: screen, ...before });
  const version = Math.max(0, ...versionsIn(screenDir(bp, sketch, screen))) + 1;
  const meta: VariantMetaFile = { madeAt: new Date().toISOString() };
  if (typeof input.madeBy === 'string' && input.madeBy.trim()) meta.madeBy = input.madeBy.trim().slice(0, MAX_NAME);
  if (typeof input.madeFor === 'string' && input.madeFor.trim()) meta.madeFor = input.madeFor.trim().slice(0, MAX_NAME);
  if (typeof input.note === 'string' && input.note.trim()) meta.note = input.note.trim();
  if (input.ask) Object.assign(meta, input.ask, checkedAgainstTokens(bp, sketch, frames));
  const files: Record<string, string> = { [variantMetaFile(bp, sketch, screen, version)]: dumpYaml(meta) };
  for (const [f, html] of Object.entries(frames)) files[frameFile(bp, sketch, screen, version, f)] = html;
  writeNewVersion(variantDir(bp, sketch, screen, version), files);
  if (input.choose || before.chosen === null) writeShared(screenFile(bp, sketch, screen), dumpYaml({ ...before, chosen: version }));
  return version;
}

/**
 * The screen of a sketch a drawing goes to: found by id, then by name (as the screen-name rule compares them, AB-136.1),
 * or null when it is new.
 */
export function screenNamed(current: SketchScreen[], screen: { id?: string; name: string }): SketchScreen | null {
  const key = screenNameKey(screen.name);
  return current.find((c) => screen.id !== undefined && c.id === screen.id) ?? current.find((c) => screenNameKey(c.name) === key) ?? null;
}

/**
 * Writes a new screen file after the others, under the lock, and gives back its id. The name must be free in the sketch
 * (AB-136.1): a used one is refused with 'A screen called "Form" already exists in Booking'. The id is free too: "form-2" when a renamed
 * screen keeps the folder "form". `unnamed` marks a screen added with no name ("New screen").
 */
export function writeNewScreen(
  bp: BoardPaths,
  sketch: string,
  current: { id: string; name: string; order: number }[],
  name: string,
  who: EditBy,
  opts: { unnamed?: boolean; order?: number; status?: ScreenStatus } = {},
): string {
  checkScreenNameFree(readSketchFile(sketchFile(bp, sketch)).name, current, name);
  const id = checkedStudioId(freeScreenId(bp, sketch, name));
  const order = opts.order ?? Math.max(0, ...current.map((c) => c.order)) + 1;
  writeMarked<ScreenFile>(screenFile(bp, sketch, id), null, { name, order, status: opts.status ?? 'draft', chosen: null, ...(opts.unnamed ? { unnamed: true } : {}) }, who);
  return id;
}
