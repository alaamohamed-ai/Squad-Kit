import fs from 'node:fs';
import type { BoardPaths } from './store.js';
import { isPlain } from './shape.js';
import {
  STUDIO_ID,
  componentsDir,
  designSystemDir,
  designSystemFile,
  designSystemsDir,
  screenDir,
  screenFile,
  screensDir,
  sketchDir,
  sketchFile,
  sketchesDir,
  tokensFile,
  variantDir,
  variantMetaFile,
} from './studio-paths.js';
import { folders, htmlFiles, idsIn, plainDir, plainFile, problem, readYamlFile, stampOfFolder, versionsIn } from './studio-files.js';

/**
 * The Studio's saved shapes and its reads (AB-128.2). Later stories import these through studio.ts, the one Studio
 * module. Reading never writes a file and never makes a folder (AB-127.1).
 */

/* ── Saved shapes ───────────────────────────────────────── */

/** `system.yaml`. */
export interface SystemFile {
  name: string;
  /** The default mark (AB-158.1): written only on the first design system made in the project, never moved by a save. */
  default: boolean;
  /** The current version. */
  version: number;
  /** When it was made, for working out the default when there are none or several marked. */
  madeAt: string;
  /**
   * The frames its sketches are drawn in (AB-133.1): desktop and mobile when it is made. A file made before the list
   * was kept has none and is read as DEFAULT_FRAMES, without being written again.
   */
  frames?: string[];
}

/** The frames a new design system starts with, and what a design system saved without a list is read as (AB-133.1). */
export const DEFAULT_FRAMES: readonly string[] = ['desktop', 'mobile'];

/**
 * When a change was made and by whom (AB-131.1). Each change writes it on the file it already saves: the sketch file
 * for making, renaming, a new design system or frames and deleting a screen; the screen file for adding, renaming,
 * marking or picking a screen. A drawing's mark is its own version's meta.yaml (madeAt, madeBy, madeFor). A sketch's
 * last edit is the newest mark, worked out on read, so opening the Studio writes nothing.
 */
export interface EditMark {
  at: string;
  /** The person, or "AI Designer". Left out when the change did not say who made it. */
  by?: string;
  /** The person the AI Designer did it for. */
  for?: string;
}

/** Who a change by the AI Designer is marked as, for the person who asked (AB-131.1). */
export const AI_DESIGNER = 'AI Designer';

/** `sketch.yaml`. */
export interface SketchFile {
  name: string;
  designSystem: { id: string; version: number } | null;
  /** The frames each screen is drawn in: desktop, tablet, mobile … */
  frames: string[];
  /** The last change this file saved (AB-131.1); left out on a sketch made before marks were kept. */
  edited?: EditMark;
}

/** What a person can mark a screen as today. */
export const SCREEN_STATUSES = ['draft', 'ready'] as const;
/** Every status a screen file can hold: "approved" is read already, so approving (US-15) only adds the button. */
export const SCREEN_STATES = [...SCREEN_STATUSES, 'approved'] as const;
export type ScreenStatus = (typeof SCREEN_STATES)[number];

/** `screen.yaml`. */
export interface ScreenFile {
  name: string;
  order: number;
  status: ScreenStatus;
  /** The chosen variant's version, or null before the first one is drawn. */
  chosen: number | null;
  /**
   * Not named yet (AB-136.1): a screen added with no name is "New screen" until its first drawing by the AI Designer
   * names it from the description. Kept on the screen's own file, so a teammate who pulls it gets it named the same way.
   * A rename clears it. Left out once it is named.
   */
  unnamed?: boolean;
  /** The last change this file saved (AB-131.1). */
  edited?: EditMark;
}

/** A value in a variant's pages that its design system's tokens lack (US-17, studio-tokens.ts). */
export interface TokenWarning {
  kind: 'color' | 'font' | 'size';
  /** As the page writes it: "#dc2626", "Comic Sans MS", "13px". */
  value: string;
}

export const TOKEN_KINDS: readonly TokenWarning['kind'][] = ['color', 'font', 'size'];

/**
 * Where a variant drawn for an ask comes from (US-17, AB-142.1): the ask it answers, its letter in that ask (A, B, C),
 * its short name and its one-line idea. Kept on its own meta.yaml, written once; a plain change to the chosen variant
 * of an ask keeps them on its new version.
 */
export interface VariantAskMarks {
  /** The ask's id: every variant drawn for one message shares it. */
  ask?: string;
  /** The person's words that asked for the variants. */
  asked?: string;
  letter?: string;
  /** Its short name: "One page", "Step by step". */
  name?: string;
  /** Its idea, in one line. */
  idea?: string;
  /** The design system its pages were checked against when it was saved, as it was named then. */
  checkedWith?: { id: string; version: number; name: string };
  /** What its pages use that the design system's tokens lack; left out when nothing. */
  warnings?: TokenWarning[];
  /** It was drawn with no design system selected, in plain styles. */
  noDesignSystem?: boolean;
}

/** `v1/meta.yaml` beside a variant's frames. */
export interface VariantMetaFile extends VariantAskMarks {
  madeAt: string;
  /** Who drew it: a person or the AI Designer. */
  madeBy?: string;
  /** The person the AI Designer drew it for. */
  madeFor?: string;
  note?: string;
}

/* ── What a read gives back ─────────────────────────────── */

export interface DesignSystemVersion {
  version: number;
  tokens: Record<string, unknown>;
  /** Component id → its HTML. */
  components: Record<string, string>;
}

export interface DesignSystem {
  id: string;
  name: string;
  /**
   * What its own system.yaml says. Two can be marked after a merge, or none after a hand edit: the project's one
   * default is worked out by defaultDesignSystemOf, never by this alone.
   */
  markedDefault: boolean;
  /** The current version. */
  version: number;
  madeAt: string;
  /** Its frames (AB-133.1), in order: DEFAULT_FRAMES when its file has no list. */
  frames: string[];
  versions: DesignSystemVersion[];
  /** A fingerprint of every shared file in the folder; every change must bring the one it read. */
  stamp: string;
}

export interface ScreenVariant extends VariantMetaFile {
  version: number;
  /** Frame id → its HTML. */
  frames: Record<string, string>;
}

export interface SketchScreen {
  id: string;
  name: string;
  order: number;
  status: ScreenStatus;
  chosen: number | null;
  /** Not named yet (AB-136.1): its first drawing by the AI Designer names it. */
  unnamed?: boolean;
  /** The last change its screen file saved. */
  edited?: EditMark;
  variants: ScreenVariant[];
}

export interface Sketch {
  id: string;
  name: string;
  designSystem: { id: string; version: number } | null;
  frames: string[];
  screens: SketchScreen[];
  /** The newest mark on its files (AB-131.1), or null when none of them has one. */
  lastEdit: EditMark | null;
  stamp: string;
}

/** A file in `.squad/studio/` that could not be read (a merge both people changed, a broken edit). */
export interface BrokenStudioItem {
  kind: StudioKind;
  id: string;
  problem: string;
}

export interface StudioContents {
  designSystems: DesignSystem[];
  /** The project's one default design system's id, worked out on read (AB-158.1), or null when it has none. */
  defaultDesignSystem: string | null;
  sketches: Sketch[];
  broken: BrokenStudioItem[];
}

export type StudioKind = 'design-system' | 'sketch';

export interface StudioItem {
  kind: StudioKind;
  id: string;
}

/* ── Stamps ─────────────────────────────────────────────── */

export function studioItemDir(bp: BoardPaths, item: StudioItem): string {
  return item.kind === 'design-system' ? designSystemDir(bp, item.id) : sketchDir(bp, item.id);
}

/** The item's change stamp now, or null when it is not in the project. */
export function studioStamp(bp: BoardPaths, item: StudioItem): string | null {
  return stampOfFolder(studioItemDir(bp, item));
}

/* ── Reading ────────────────────────────────────────────── */

function positive(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 1;
}

/** A time as written: squad-kit writes text, and a time typed without quotes reads back as a date. */
function timeText(x: unknown): string {
  if (x instanceof Date) return Number.isNaN(x.getTime()) ? '' : x.toISOString();
  return typeof x === 'string' ? x : '';
}

export function readSystemFile(file: string): SystemFile {
  const raw = readYamlFile(file);
  if (!isPlain(raw) || typeof raw.name !== 'string' || !positive(raw.version)) throw problem(`The design system file ${file}`);
  const frames = framesIn(raw.frames);
  return { name: raw.name, default: raw.default === true, version: raw.version, madeAt: timeText(raw.madeAt), ...(frames ? { frames } : {}) };
}

/** A saved frames list: each frame id once, in order. Undefined when there is no usable list: it is read as DEFAULT_FRAMES. */
function framesIn(x: unknown): string[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const frames = [...new Set(x.filter((f): f is string => typeof f === 'string' && STUDIO_ID.test(f)))];
  return frames.length ? frames : undefined;
}

/** A name in a mark: one line, kept short. */
function markName(x: unknown): string | undefined {
  return typeof x === 'string' && x.trim() ? x.trim().replace(/\s+/g, ' ').slice(0, 120) : undefined;
}

/** A mark as written, or undefined when there is none or its time cannot be read: a hand edit never breaks the read. */
function readEditMark(x: unknown): EditMark | undefined {
  if (!isPlain(x)) return undefined;
  const at = timeText(x.at);
  if (Number.isNaN(Date.parse(at))) return undefined;
  const by = markName(x.by);
  const forWhom = markName(x.for);
  return { at, ...(by ? { by } : {}), ...(forWhom ? { for: forWhom } : {}) };
}

export function readSketchFile(file: string): SketchFile {
  const raw = readYamlFile(file);
  if (!isPlain(raw) || typeof raw.name !== 'string') throw problem(`The sketch file ${file}`);
  const ds = raw.designSystem;
  const designSystem = isPlain(ds) && typeof ds.id === 'string' && STUDIO_ID.test(ds.id) && positive(ds.version) ? { id: ds.id, version: ds.version } : null;
  const frames = Array.isArray(raw.frames) ? raw.frames.filter((f): f is string => typeof f === 'string' && STUDIO_ID.test(f)) : [];
  const edited = readEditMark(raw.edited);
  return { name: raw.name, designSystem, frames, ...(edited ? { edited } : {}) };
}

export function readScreenFile(file: string): ScreenFile {
  const raw = readYamlFile(file);
  if (!isPlain(raw) || typeof raw.name !== 'string') throw problem(`The screen file ${file}`);
  const edited = readEditMark(raw.edited);
  return {
    name: raw.name,
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : 0,
    status: (SCREEN_STATES as readonly unknown[]).includes(raw.status) ? (raw.status as ScreenStatus) : 'draft',
    chosen: positive(raw.chosen) ? raw.chosen : null,
    ...(raw.unnamed === true ? { unnamed: true } : {}),
    ...(edited ? { edited } : {}),
  };
}

/** A variant's letter in its ask: one capital letter. */
export const VARIANT_LETTER = /^[A-Z]$/;

/** One line of text in a mark, or undefined: a hand edit never breaks the read. */
function lineIn(x: unknown, max: number): string | undefined {
  return typeof x === 'string' && x.trim() ? x.trim().replace(/\s+/g, ' ').slice(0, max) : undefined;
}

/**
 * The ask marks on a variant's meta.yaml (US-17, AB-142.1), as written: what cannot be read is left out, so a hand
 * edit never breaks the read. Reading only shows what the save checked; it checks nothing again (AB-127.1).
 */
export function readAskMarks(raw: Record<string, unknown>): VariantAskMarks {
  const out: VariantAskMarks = {};
  const ask = lineIn(raw.ask, 80);
  const letter = typeof raw.letter === 'string' && VARIANT_LETTER.test(raw.letter) ? raw.letter : undefined;
  if (ask && letter) {
    out.ask = ask;
    out.letter = letter;
    const asked = lineIn(raw.asked, 500);
    const name = lineIn(raw.name, 120);
    const idea = lineIn(raw.idea, 300);
    if (asked) out.asked = asked;
    if (name) out.name = name;
    if (idea) out.idea = idea;
  }
  const w = raw.checkedWith;
  if (isPlain(w) && typeof w.id === 'string' && positive(w.version) && typeof w.name === 'string') out.checkedWith = { id: w.id, version: w.version, name: w.name };
  if (Array.isArray(raw.warnings)) {
    const warnings = raw.warnings.flatMap((x) => (isPlain(x) && TOKEN_KINDS.includes(x.kind as TokenWarning['kind']) && typeof x.value === 'string' && x.value.trim() ? [{ kind: x.kind as TokenWarning['kind'], value: x.value.trim().slice(0, 120) }] : []));
    if (warnings.length) out.warnings = warnings;
  }
  if (raw.noDesignSystem === true) out.noDesignSystem = true;
  return out;
}

function readVariantMeta(file: string): VariantMetaFile {
  const raw = plainFile(file) ? readYamlFile(file) : {};
  const meta: VariantMetaFile = { madeAt: isPlain(raw) ? timeText(raw.madeAt) : '' };
  if (isPlain(raw) && typeof raw.madeBy === 'string') meta.madeBy = raw.madeBy;
  if (isPlain(raw) && typeof raw.madeFor === 'string') meta.madeFor = raw.madeFor;
  if (isPlain(raw) && typeof raw.note === 'string') meta.note = raw.note;
  return isPlain(raw) ? { ...meta, ...readAskMarks(raw) } : meta;
}

/**
 * A sketch's last edit (AB-131.1): the newest mark on its sketch file, its screen files and its drawings. On equal
 * times the sketch file's mark wins, then the screens' in their order. Null when no file has a mark.
 */
export function lastEditOf(sketch: SketchFile, screens: SketchScreen[]): EditMark | null {
  const marks: EditMark[] = [];
  if (sketch.edited) marks.push(sketch.edited);
  for (const s of screens) {
    if (s.edited) marks.push(s.edited);
    for (const v of s.variants) {
      const drawn = readEditMark({ at: v.madeAt, by: v.madeBy, for: v.madeFor });
      if (drawn) marks.push(drawn);
    }
  }
  let newest: EditMark | null = null;
  for (const m of marks) if (!newest || Date.parse(m.at) > Date.parse(newest.at)) newest = m;
  return newest;
}

function readTokens(file: string): Record<string, unknown> {
  if (!plainFile(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw problem(`The tokens file ${file}`);
  }
  if (!isPlain(raw)) throw problem(`The tokens file ${file}`);
  return raw;
}

/** One design system with all its versions, or null when the project has none by that id. */
export function readDesignSystem(bp: BoardPaths, id: string): DesignSystem | null {
  const file = designSystemFile(bp, id);
  // A link to a folder or a file is not part of the Studio: the stamp leaves it out, so a read does too.
  if (!plainDir(designSystemDir(bp, id)) || !plainFile(file)) return null;
  const stamp = stampOfFolder(designSystemDir(bp, id));
  const system = readSystemFile(file);
  const versions = versionsIn(designSystemDir(bp, id)).map((version) => ({
    version,
    tokens: readTokens(tokensFile(bp, id, version)),
    components: htmlFiles(componentsDir(bp, id, version)),
  }));
  return { id, name: system.name, markedDefault: system.default, version: system.version, madeAt: system.madeAt, frames: system.frames ?? [...DEFAULT_FRAMES], versions, stamp: stamp ?? '' };
}

/** A made time to compare: one that cannot be read counts as made last. */
function madeTime(madeAt: string): number {
  const t = Date.parse(madeAt);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** The order design systems were made in: the older first; on equal times, the lower id. */
export function byMadeOrder(a: Pick<DesignSystem, 'id' | 'madeAt'>, b: Pick<DesignSystem, 'id' | 'madeAt'>): number {
  return madeTime(a.madeAt) - madeTime(b.madeAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The project's one default design system (AB-158.1): the oldest one marked default; when none is marked, the oldest
 * one; on equal times, the lower id. It holds on any files git brings in, such as two teammates' first design systems
 * merged into one project, and it only reads: nothing is written to settle a tie.
 */
export function defaultDesignSystemOf(systems: Pick<DesignSystem, 'id' | 'markedDefault' | 'madeAt'>[]): string | null {
  const marked = systems.filter((s) => s.markedDefault);
  const pool = marked.length ? marked : systems;
  const oldest = [...pool].sort(byMadeOrder)[0];
  return oldest?.id ?? null;
}

function readScreen(bp: BoardPaths, sketch: string, id: string): SketchScreen {
  const screen = readScreenFile(screenFile(bp, sketch, id));
  const variants = versionsIn(screenDir(bp, sketch, id)).map((version) => {
    const frames = htmlFiles(variantDir(bp, sketch, id, version));
    return { version, ...readVariantMeta(variantMetaFile(bp, sketch, id, version)), frames };
  });
  return { id, ...screen, variants };
}

/** One sketch with its screens and every variant, or null when the project has none by that id. */
export function readSketch(bp: BoardPaths, id: string): Sketch | null {
  const file = sketchFile(bp, id);
  if (!plainDir(sketchDir(bp, id)) || !plainFile(file)) return null;
  const stamp = stampOfFolder(sketchDir(bp, id));
  const sketch = readSketchFile(file);
  const screens = folders(screensDir(bp, id))
    .filter((s) => STUDIO_ID.test(s) && plainFile(screenFile(bp, id, s)))
    .map((s) => readScreen(bp, id, s))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { id, name: sketch.name, designSystem: sketch.designSystem, frames: sketch.frames, screens, lastEdit: lastEditOf(sketch, screens), stamp: stamp ?? '' };
}

/**
 * Every design system and sketch in the project, each with its change stamp, and the one default design system. A file
 * that cannot be read is listed in `broken`. Reading writes nothing and makes no folder.
 */
export function readStudio(bp: BoardPaths): StudioContents {
  const out: StudioContents = { designSystems: [], defaultDesignSystem: null, sketches: [], broken: [] };
  for (const id of idsIn(designSystemsDir(bp))) {
    try {
      const ds = readDesignSystem(bp, id);
      if (ds) out.designSystems.push(ds);
    } catch (err) {
      out.broken.push({ kind: 'design-system', id, problem: (err as Error).message });
    }
  }
  for (const id of idsIn(sketchesDir(bp))) {
    try {
      const sk = readSketch(bp, id);
      if (sk) out.sketches.push(sk);
    } catch (err) {
      out.broken.push({ kind: 'sketch', id, problem: (err as Error).message });
    }
  }
  out.defaultDesignSystem = defaultDesignSystemOf(out.designSystems);
  return out;
}

/** The project's default design system's id, the same answer readStudio gives, for later stories (a new sketch, "Make default", delete). */
export function readDefaultDesignSystem(bp: BoardPaths): string | null {
  const systems: DesignSystem[] = [];
  for (const id of idsIn(designSystemsDir(bp))) {
    try {
      const ds = readDesignSystem(bp, id);
      if (ds) systems.push(ds);
    } catch {
      // A design system that cannot be read is not the default; readStudio lists it as broken.
    }
  }
  return defaultDesignSystemOf(systems);
}
