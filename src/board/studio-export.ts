import type { ScreenVariant, Sketch, SketchScreen } from './studio-read.js';

/**
 * The export plan (US-46, AB-171.1): from a sketch as it is saved and what the person picked (the screens, the frames
 * and whether to include all variants), the pages of the export file, in the screen list's order and, inside a screen,
 * in the sketch's frame order. It only reads: it writes nothing, so exporting changes no project file (AB-127.1).
 *
 * Which drawing a screen shows is worked out from what is saved (AB-140.1, AB-142.1): an approved screen shows the
 * version it was approved at, any other screen its chosen drawing. With "all variants" on, a screen that is not approved
 * and whose chosen drawing came from an ask with more than one variant gets one page per variant in each frame, in
 * letter order (A, B, C), each with its letter, name and idea, in the client's words ("Option B"). A frame a drawing
 * has no page for is left out, and so is a screen with no page at all. Later exports (PNG, JPG, SVG, HTML) read the
 * same plan; only the file type changes.
 */

/** What the person picked in the export window. */
export interface ExportChoice {
  /** Screen ids; the order they come in does not matter: the plan follows the screen list. */
  screens: string[];
  /** Frame ids, like desktop and mobile; at least one. */
  frames: string[];
  /** One page per variant for a draft screen drawn as variants. Left out, it is off. */
  allVariants?: boolean;
}

/** A variant's marks on its page, in the client's words: "Option B: Split steps" and its one-line idea. */
export interface ExportOption {
  letter: string;
  name: string;
  idea: string;
}

export interface ExportPage {
  /** Its page number in the file: the cover is page 1. */
  page: number;
  screen: string;
  screenName: string;
  frame: string;
  /** The saved version it shows. */
  version: number;
  html: string;
  /** Set on a variant's page, when all variants are in the file. */
  option?: ExportOption;
}

export interface ExportScreen {
  id: string;
  name: string;
  /** The page its first page is on. */
  firstPage: number;
  /** How many options of it the file has: 1, or the number of its variants when they are all in the file. */
  options: number;
  /** Approved: the cover and the board may say so; the client's pages never show the Studio's own marks. */
  approved: boolean;
}

export interface ExportPlan {
  sketch: { id: string; name: string };
  /** The frames picked, in the sketch's order. */
  frames: string[];
  /** The screens in the file, in the screen list's order. */
  screens: ExportScreen[];
  /** Every page after the cover, in order. */
  pages: ExportPage[];
}

/** A choice the plan cannot make a file from. Nothing was made. */
export class StudioExportRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioExportRefused';
  }
}

const ids = (x: unknown, what: string): string[] => {
  if (!Array.isArray(x) || x.some((v) => typeof v !== 'string')) throw new StudioExportRefused(`Give the ${what} to export as a list.`);
  return [...new Set(x as string[])];
};

/** The version an approved screen froze; any other screen's chosen one. Undefined when it has no drawing. */
export function shownVariant(screen: SketchScreen): ScreenVariant | undefined {
  const frozen = screen.status === 'approved' && screen.approved ? screen.variants.find((v) => v.version === screen.approved!.version) : undefined;
  return frozen ?? screen.variants.find((v) => v.version === screen.chosen);
}

/**
 * The variants of the ask the shown drawing came from, A first: each letter's newest drawing, and the shown one for its
 * own letter, as the variant cards show them. Empty when it came from no ask.
 */
export function askVariantsOf(screen: SketchScreen, shown: ScreenVariant): ScreenVariant[] {
  if (!shown.ask || !shown.letter) return [];
  const byLetter = new Map<string, ScreenVariant>();
  for (const v of screen.variants) {
    if (v.ask !== shown.ask || !v.letter) continue;
    const was = byLetter.get(v.letter);
    if (!was || v.version > was.version) byLetter.set(v.letter, v);
  }
  byLetter.set(shown.letter, shown);
  return [...byLetter.values()].sort((a, b) => a.letter!.localeCompare(b.letter!));
}

const optionOf = (v: ScreenVariant): ExportOption => ({ letter: v.letter!, name: v.name ?? '', idea: v.idea ?? '' });

/**
 * The pages of an export of `sketch` as `choice` picks them. Refused in plain words: no frame, a frame or a screen the
 * sketch does not have, or a choice that makes no page.
 */
export function exportPlan(sketch: Sketch, choice: ExportChoice): ExportPlan {
  const pickedFrames = ids(choice?.frames, 'frames');
  const pickedScreens = ids(choice?.screens, 'screens');
  if (!pickedFrames.length) throw new StudioExportRefused('Pick at least one frame to export.');
  const missingFrame = pickedFrames.find((f) => !sketch.frames.includes(f));
  if (missingFrame !== undefined) throw new StudioExportRefused(`${sketch.name} has no frame "${missingFrame}".`);
  if (!pickedScreens.length) throw new StudioExportRefused('Pick at least one screen to export.');
  const missingScreen = pickedScreens.find((s) => !sketch.screens.some((x) => x.id === s));
  if (missingScreen !== undefined) throw new StudioExportRefused(`${sketch.name} has no screen "${missingScreen}".`);

  const frames = sketch.frames.filter((f) => pickedFrames.includes(f));
  const allVariants = choice.allVariants === true;
  const screens: ExportScreen[] = [];
  const pages: ExportPage[] = [];
  for (const screen of sketch.screens) {
    if (!pickedScreens.includes(screen.id)) continue;
    const shown = shownVariant(screen);
    if (!shown) continue;
    const approved = screen.status === 'approved';
    const asked = allVariants && !approved ? askVariantsOf(screen, shown) : [];
    const drawings = asked.length > 1 ? asked : [shown];
    const mine: ExportPage[] = [];
    for (const frame of frames) {
      for (const v of drawings) {
        const html = v.frames[frame];
        if (html === undefined) continue;
        mine.push({ page: 0, screen: screen.id, screenName: screen.name, frame, version: v.version, html, ...(drawings.length > 1 ? { option: optionOf(v) } : {}) });
      }
    }
    if (!mine.length) continue;
    // The cover is page 1.
    const firstPage = pages.length + 2;
    mine.forEach((p, i) => pages.push({ ...p, page: firstPage + i }));
    const options = drawings.length > 1 ? new Set(mine.map((p) => p.option!.letter)).size : 1;
    screens.push({ id: screen.id, name: screen.name, firstPage, options, approved });
  }
  if (!pages.length) throw new StudioExportRefused('None of the screens you picked is drawn in these frames yet, so there is nothing to export.');
  return { sketch: { id: sketch.id, name: sketch.name }, frames, screens, pages };
}
