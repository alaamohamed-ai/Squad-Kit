import { readMeta, type BoardPaths } from './store.js';
import { isPlain } from './shape.js';
import {
  SCREEN_STATUSES,
  byMadeOrder,
  deleteDesignSystem as removeDesignSystem,
  deleteScreen as removeScreen,
  deleteSketch as removeSketch,
  duplicateSketch as copySketch,
  readDefaultDesignSystem,
  readDesignSystem,
  readSketch,
  readStudio,
  saveDesignSystem,
  saveSketch,
  studioIdFor,
  type DesignSystem,
  type DesignSystemInput,
  type EditBy,
  type EditMark,
  type ScreenInput,
  type ScreenStatus,
  type Sketch,
  type SketchScreen,
} from './studio.js';

/**
 * The Studio's actions (US-04, AB-129): list, read, create, change and delete for sketches and design systems, and
 * add, change and delete for the screens in a sketch. The board's Studio API (console/api/studio.ts) and the
 * `squad studio` commands call these same functions, so the pages and the terminal always behave the same way.
 *
 * Every change and delete brings the stamp it started from (AB-129.1). When the saved one has moved on, it stops with
 * "Changed elsewhere, reload" and writes nothing; a screen change checks the stamp of its sketch. Deletes are for
 * good, with no bin. Reading and listing never write a file (AB-127.1). All of it goes through the Studio store,
 * studio.ts (AB-128.2).
 *
 * Each change to a sketch is marked with who made it (AB-131.1): the person's name from the project settings, the same
 * name the board shows elsewhere, whether the change comes from the board or the terminal.
 */

/** The person a change from the board or the terminal is marked with (AB-131.1). */
export function personEditing(bp: BoardPaths): EditBy {
  try {
    const name = readMeta(bp).user?.name;
    return typeof name === 'string' && name.trim() ? { by: name.trim() } : {};
  } catch {
    return {};
  }
}

/** The project has no sketch, screen or design system by that id. */
export class StudioNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioNotFound';
  }
}

/** A sketch as the actions give it back: its design system also carries its name, or null when it is not saved. */
export interface SketchView extends Omit<Sketch, 'designSystem'> {
  designSystem: { id: string; version: number; name: string | null } | null;
}

/** A design system as the actions give it back, with whether it is the project's one default (AB-158.1). */
export interface DesignSystemView extends DesignSystem {
  isDefault: boolean;
}

function sketchView(sketch: Sketch, nameOf: (id: string) => string | null): SketchView {
  const ds = sketch.designSystem;
  return { ...sketch, designSystem: ds ? { ...ds, name: nameOf(ds.id) } : null };
}

function designSystemName(bp: BoardPaths, id: string): string | null {
  try {
    return readDesignSystem(bp, id)?.name ?? null;
  } catch {
    return null;
  }
}

/** The stamp a change brings: the one it read. Without it the change cannot be checked, so it is refused. */
function checkedStamp(stamp: unknown): string {
  if (typeof stamp !== 'string' || !stamp.trim()) throw new Error('Send the stamp of what you started from. Reload and try again.');
  return stamp;
}

function maybeText(x: unknown, what: string): string | undefined {
  if (x === undefined) return undefined;
  if (typeof x !== 'string') throw new Error(`The ${what} must be text.`);
  return x;
}

function maybeOrder(x: unknown): number | undefined {
  if (x === undefined) return undefined;
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error("A screen's place must be a number.");
  return x;
}

function maybeStatus(x: unknown): ScreenStatus | undefined {
  if (x === undefined) return undefined;
  if (!(SCREEN_STATUSES as readonly unknown[]).includes(x)) throw new Error(`A screen is ${SCREEN_STATUSES.join(' or ')}.`);
  return x as ScreenStatus;
}

function maybeFrames(x: unknown): string[] | undefined {
  if (x === undefined) return undefined;
  if (!Array.isArray(x) || x.some((f) => typeof f !== 'string')) throw new Error('The frames must be a list, like desktop and mobile.');
  return x as string[];
}

/* ── Design systems ─────────────────────────────────────── */

/** Every design system saved in the project, with the one default marked. A file that cannot be read is left out. */
export function listDesignSystems(bp: BoardPaths): DesignSystemView[] {
  const studio = readStudio(bp);
  return studio.designSystems.map((ds) => ({ ...ds, isDefault: ds.id === studio.defaultDesignSystem }));
}

/** A design system as its card on the Design systems tab shows it (US-33, AB-158). */
export interface DesignSystemCard extends DesignSystemView {
  /** Up to six colours from its current version's tokens, in the order the tokens list them. */
  colors: string[];
  /** How many sketches follow it, any version of it. */
  sketches: number;
}

/** What the Design systems tab and the terminal show: every card, and the design system a new sketch starts with. */
export interface DesignSystemList {
  /** The default first, then the others in the order they were made. */
  designSystems: DesignSystemCard[];
  /** The project's one default (AB-158.1), which a new sketch starts with; null when the project has none. */
  default: { id: string; name: string; version: number } | null;
}

const MAX_COLORS = 6;

/**
 * A colour a page can paint as it is: #hex, or rgb(), hsl(), hwb(), lab(), lch(), oklab() and oklch() with numbers in
 * them. Anything else (a name, a reference like {colors.blue}, a url()) is not a colour here.
 */
const COLOR = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?=[^)]*\d)(?:[\d.%\s,/+-]|deg|g?rad|turn|none)*\))$/i;

export function isColorValue(x: unknown): x is string {
  return typeof x === 'string' && x.length <= 80 && COLOR.test(x.trim());
}

/** The colours in a version's tokens, however deep they sit, each once, up to six. */
export function colorsOf(tokens: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown, depth: number) => {
    if (out.length >= MAX_COLORS || depth > 8) return;
    if (isColorValue(x)) {
      const c = x.trim();
      if (!out.some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c);
    } else if (Array.isArray(x)) x.forEach((v) => walk(v, depth + 1));
    else if (isPlain(x)) Object.values(x).forEach((v) => walk(v, depth + 1));
  };
  walk(tokens, 0);
  return out;
}

/**
 * The design systems for the Design systems tab (US-33, AB-158): each one's name, current version, up to six colours,
 * how many sketches follow it and whether it is the one default (AB-158.1). The board's Studio API and the terminal
 * read this same answer. It only reads: nothing is written, not even to settle which one is the default.
 */
export function designSystemList(bp: BoardPaths): DesignSystemList {
  const studio = readStudio(bp);
  const following = new Map<string, number>();
  for (const s of studio.sketches) if (s.designSystem) following.set(s.designSystem.id, (following.get(s.designSystem.id) ?? 0) + 1);
  const cards = studio.designSystems.map((ds) => ({
    ...ds,
    isDefault: ds.id === studio.defaultDesignSystem,
    colors: colorsOf(ds.versions.find((v) => v.version === ds.version)?.tokens),
    sketches: following.get(ds.id) ?? 0,
  }));
  cards.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || byMadeOrder(a, b));
  const def = cards.find((c) => c.isDefault);
  return { designSystems: cards, default: def ? { id: def.id, name: def.name, version: def.version } : null };
}

/** The design system a new sketch starts with: the project's one default, at its current version, or null when it has none. */
export function newSketchDesignSystem(bp: BoardPaths): DesignSystemList['default'] {
  return designSystemList(bp).default;
}

export function getDesignSystem(bp: BoardPaths, id: string): DesignSystemView {
  const ds = readDesignSystem(bp, id);
  if (!ds) throw new StudioNotFound(`This project has no design system "${id}".`);
  return { ...ds, isDefault: readDefaultDesignSystem(bp) === id };
}

export interface DesignSystemChange {
  name?: string;
  tokens?: Record<string, unknown>;
  components?: Record<string, string>;
}

/**
 * Makes a design system, version 1, with the time it was made. Only the first one in the project is marked default
 * (AB-158.1); making another never moves the mark, and later saves and new versions keep both (saveDesignSystem).
 */
export function createDesignSystem(bp: BoardPaths, input: DesignSystemInput): DesignSystemView {
  if (!isPlain(input as unknown)) throw new Error('Give the design system a name.');
  const saved = saveDesignSystem(bp, { id: maybeText(input.id, 'id'), name: input.name, tokens: input.tokens, components: input.components }, null);
  return getDesignSystem(bp, saved.id);
}

/** Renames a design system, or saves new tokens or components as its next version. What is left out stays. */
export function changeDesignSystem(bp: BoardPaths, id: string, change: DesignSystemChange, stamp: unknown): DesignSystemView {
  const from = checkedStamp(stamp);
  if (!isPlain(change as unknown)) throw new Error('Say what to change in the design system.');
  const current = getDesignSystem(bp, id);
  saveDesignSystem(bp, { id, name: maybeText(change.name, 'name') ?? current.name, tokens: change.tokens, components: change.components }, from);
  return getDesignSystem(bp, id);
}

/** Deletes a design system for good. Refused, naming them, while sketches follow it (StudioInUse). */
export function deleteDesignSystem(bp: BoardPaths, id: string, stamp: unknown): { deleted: string } {
  const from = checkedStamp(stamp);
  getDesignSystem(bp, id);
  removeDesignSystem(bp, id, from);
  return { deleted: id };
}

/* ── Sketches ───────────────────────────────────────────── */

/** Every sketch saved in the project, with its screens and its design system's name. A file that cannot be read is left out. */
export function listSketches(bp: BoardPaths): SketchView[] {
  const studio = readStudio(bp);
  const names = new Map(studio.designSystems.map((ds) => [ds.id, ds.name]));
  return studio.sketches.map((s) => sketchView(s, (id) => names.get(id) ?? null));
}

/** The views a card's thumbnail shows, in this order, when the first screen's drawing has them. */
export const COVER_VIEWS = ['desktop', 'mobile'] as const;

/** What a sketch's card on the Sketches home shows (US-06, AB-131). */
export interface SketchCardInfo {
  /** The first screen's chosen drawing and the views of it to show, or null when it has none yet. */
  cover: { screen: string; version: number; views: string[] } | null;
  screens: number;
  /** Screens marked Approved; Ready ones do not count. */
  approved: number;
  /** The design system's name; null when the sketch follows none, or its id when it is not saved. */
  designSystem: string | null;
  /** The newest mark on the sketch's files (AB-131.1), or null when none has one. */
  edited: EditMark | null;
}

export interface SketchCard extends SketchView {
  card: SketchCardInfo;
}

/** The views of the first screen's chosen drawing a thumbnail shows: desktop and mobile, or else its first frame. */
function coverOf(s: Sketch | SketchView): SketchCardInfo['cover'] {
  const first = s.screens[0];
  const chosen = first?.variants.find((v) => v.version === first.chosen);
  if (!first || !chosen) return null;
  const has = Object.keys(chosen.frames);
  const views = COVER_VIEWS.filter((v) => has.includes(v));
  if (!views.length && !has.length) return null;
  return { screen: first.id, version: chosen.version, views: views.length ? [...views] : [has[0]!] };
}

function editTime(m: EditMark | null): number {
  const t = m ? Date.parse(m.at) : Number.NaN;
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * The Sketches home's cards (US-06, AB-131): every sketch with its first screen's cover, how many screens and how many
 * approved, its design system's name and its last edit, newest edit first, then by name. It only reads.
 */
export function sketchList(bp: BoardPaths): SketchCard[] {
  return listSketches(bp)
    .map((s) => ({
      ...s,
      card: {
        cover: coverOf(s),
        screens: s.screens.length,
        approved: s.screens.filter((sc) => sc.status === 'approved').length,
        designSystem: s.designSystem ? (s.designSystem.name ?? s.designSystem.id) : null,
        edited: s.lastEdit,
      },
    }))
    .sort((a, b) => editTime(b.card.edited) - editTime(a.card.edited) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The HTML of a sketch's cover, by view, for its card's thumbnail; null fields when its first screen has no drawing yet. */
export function sketchCover(bp: BoardPaths, id: string): { screen: string | null; version: number | null; frames: Record<string, string> } {
  const s = getSketch(bp, id);
  const cover = coverOf(s);
  if (!cover) return { screen: null, version: null, frames: {} };
  const drawn = s.screens[0]!.variants.find((v) => v.version === cover.version)!.frames;
  return { screen: cover.screen, version: cover.version, frames: Object.fromEntries(cover.views.map((v) => [v, drawn[v]!])) };
}

export function getSketch(bp: BoardPaths, id: string): SketchView {
  const sketch = readSketch(bp, id);
  if (!sketch) throw new StudioNotFound(`This project has no sketch "${id}".`);
  return sketchView(sketch, (ds) => designSystemName(bp, ds));
}

/** Which design system a sketch follows. Left without a version, it follows the design system's current one. */
export type DesignSystemChoice = { id: string; version?: number } | null;

function followed(bp: BoardPaths, choice: unknown): { id: string; version: number } | null {
  if (choice === null) return null;
  if (!isPlain(choice) || typeof choice.id !== 'string') throw new Error('Name the design system the sketch follows.');
  if (choice.version !== undefined) return { id: choice.id, version: choice.version as number };
  return { id: choice.id, version: getDesignSystem(bp, choice.id).version };
}

export interface NewSketchInput {
  /** Left out, it is made from the name. */
  id?: string;
  name: string;
  /** Left out or null, the sketch follows no design system. */
  designSystem?: DesignSystemChoice;
  /** Left out, one desktop frame. */
  frames?: string[];
  screens?: ScreenInput[];
}

/** Makes a sketch, with the screens it starts with. */
export function createSketch(bp: BoardPaths, input: NewSketchInput): SketchView {
  if (!isPlain(input as unknown)) throw new Error('Give the sketch a name.');
  if (input.screens !== undefined && !Array.isArray(input.screens)) throw new Error('The screens must be a list.');
  const saved = saveSketch(
    bp,
    {
      id: maybeText(input.id, 'id'),
      name: input.name,
      designSystem: input.designSystem === undefined ? null : followed(bp, input.designSystem),
      frames: maybeFrames(input.frames) ?? ['desktop'],
      // A person marks a screen draft or ready; approving comes with its own button (US-15).
      screens: input.screens?.map((sc) => (isPlain(sc) ? { ...sc, status: maybeStatus(sc.status) } : sc)),
    },
    null,
    personEditing(bp),
  );
  return getSketch(bp, saved.id);
}

export interface SketchChange {
  name?: string;
  designSystem?: DesignSystemChoice;
  frames?: string[];
}

/**
 * Renames a sketch, or changes the design system it follows or its frames. What is left out stays, its screens too. A
 * name another sketch uses is refused with StudioNameTaken (AB-138.1).
 */
export function changeSketch(bp: BoardPaths, id: string, change: SketchChange, stamp: unknown): SketchView {
  const from = checkedStamp(stamp);
  if (!isPlain(change as unknown)) throw new Error('Say what to change in the sketch.');
  const current = getSketch(bp, id);
  const designSystem = change.designSystem === undefined ? current.designSystem && { id: current.designSystem.id, version: current.designSystem.version } : followed(bp, change.designSystem);
  saveSketch(bp, { id, name: maybeText(change.name, 'name') ?? current.name, designSystem, frames: maybeFrames(change.frames) ?? current.frames }, from, personEditing(bp));
  return getSketch(bp, id);
}

/**
 * Deletes a sketch, its screens and every variant, for good, and says how many screens it removed (US-13). The
 * confirmation before it is the board's and the terminal's; this only deletes.
 */
export function deleteSketch(bp: BoardPaths, id: string, stamp: unknown): { deleted: string; name: string; screens: number } {
  const from = checkedStamp(stamp);
  const { name } = getSketch(bp, id);
  const { screens } = removeSketch(bp, id, from);
  return { deleted: id, name, screens };
}

/**
 * Duplicates a sketch (US-13, AB-138): "Booking copy", then "Booking copy 2" …, with every screen at the drawing it
 * shows now, as Draft, and no conversation. The source stays as it is. A stale stamp is refused with "Changed
 * elsewhere, reload".
 */
export function duplicateSketch(bp: BoardPaths, id: string, stamp: unknown): SketchView {
  const from = checkedStamp(stamp);
  getSketch(bp, id);
  const copy = copySketch(bp, id, from, personEditing(bp));
  return getSketch(bp, copy.id);
}

/* ── Screens in a sketch: each change checks the sketch's stamp ── */

function sketchAsSaved(s: SketchView) {
  return { id: s.id, name: s.name, designSystem: s.designSystem && { id: s.designSystem.id, version: s.designSystem.version }, frames: s.frames };
}

function screenOf(s: SketchView, screen: string): SketchScreen {
  const found = s.screens.find((sc) => sc.id === screen);
  if (!found) throw new StudioNotFound(`The sketch "${s.name}" has no screen "${screen}".`);
  return found;
}

export interface ScreenChange {
  name?: string;
  order?: number;
  status?: ScreenStatus;
}

/** Adds a screen to a sketch, after the others unless it says its place. It has no variant until one is drawn. */
export function addScreen(bp: BoardPaths, sketch: string, input: ScreenInput, stamp: unknown): SketchView {
  const from = checkedStamp(stamp);
  if (!isPlain(input as unknown)) throw new Error('Give the screen a name.');
  const current = getSketch(bp, sketch);
  const name = maybeText(input.name, 'name') ?? '';
  const id = maybeText(input.id, 'id') ?? studioIdFor(name.trim());
  if (name.trim() && current.screens.some((sc) => sc.id === id)) throw new Error(`The sketch "${current.name}" already has a screen "${name.trim()}".`);
  const order = maybeOrder(input.order) ?? Math.max(0, ...current.screens.map((sc) => sc.order)) + 1;
  saveSketch(bp, { ...sketchAsSaved(current), screens: [{ id, name, order, status: maybeStatus(input.status) }] }, from, personEditing(bp));
  return getSketch(bp, sketch);
}

/** Renames a screen, moves it or marks it draft or ready. What is left out stays, its variants too. */
export function changeScreen(bp: BoardPaths, sketch: string, screen: string, change: ScreenChange, stamp: unknown): SketchView {
  const from = checkedStamp(stamp);
  if (!isPlain(change as unknown)) throw new Error('Say what to change in the screen.');
  const current = getSketch(bp, sketch);
  const was = screenOf(current, screen);
  const next = { id: was.id, name: maybeText(change.name, 'name') ?? was.name, order: maybeOrder(change.order) ?? was.order, status: maybeStatus(change.status) ?? was.status };
  saveSketch(bp, { ...sketchAsSaved(current), screens: [next] }, from, personEditing(bp));
  return getSketch(bp, sketch);
}

/** Deletes a screen and every variant of it, for good. */
export function deleteScreen(bp: BoardPaths, sketch: string, screen: string, stamp: unknown): SketchView {
  const from = checkedStamp(stamp);
  screenOf(getSketch(bp, sketch), screen);
  removeScreen(bp, sketch, screen, from, personEditing(bp));
  return getSketch(bp, sketch);
}
