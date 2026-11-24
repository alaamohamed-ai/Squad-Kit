/**
 * Export sketch to PDF on the board (US-46, AB-171.1): what the export window ticks and sends, and the download. The
 * board sends what the person wants (the screens, the frames, and whether to include all variants); the board server
 * works out the pages from what is saved and answers with the PDF itself. Nothing is saved in the project, and nothing
 * is added to the chat. Later exports (PNG, JPG, SVG, HTML) reuse these same choices.
 */

import { ApiError, NO_ANSWER, UnauthorizedError, apiPath, currentToken } from '../api/client';
import { sketchApiPath, type ScreenView } from './studio';

/** The window's first choice: every drawn screen, or the approved ones only. */
export type ExportScope = 'all' | 'approved';

/** The other export choices in the sketch's menu, off until US-44, US-45 and US-47 bring them. */
export const FUTURE_EXPORTS = ['PNG', 'JPG', 'SVG', 'HTML'] as const;

export const EXPORT_PDF = 'Export sketch to PDF';
export const MAKING_PDF = 'Making the PDF…';
export const NO_APPROVED = 'No approved screens yet';
export const NOT_DRAWN = 'Not drawn yet';

type ScreenLike = Pick<ScreenView, 'id' | 'status' | 'chosen' | 'variants'> & { approved?: { version: number } };

export const isApprovedScreen = (s: Pick<ScreenView, 'status'>) => s.status === 'approved';

/** A screen has a drawing to export: the version it was approved at, or its chosen one, with at least one frame. */
export function isDrawn(s: ScreenLike): boolean {
  const shown = (isApprovedScreen(s) && s.approved ? s.variants.find((v) => v.version === s.approved!.version) : undefined) ?? s.variants.find((v) => v.version === s.chosen);
  return Boolean(shown && Object.keys(shown.html ?? {}).length);
}

/** True when "Approved screens only" can be picked: some approved screen has a drawing. */
export const hasApprovedScreens = (screens: ScreenLike[]) => screens.some((s) => isApprovedScreen(s) && isDrawn(s));

/** The screens a choice ticks, in the screen list's order: every drawn one, or the drawn approved ones. */
export function ticksFor(scope: ExportScope, screens: ScreenLike[]): string[] {
  return screens.filter((s) => isDrawn(s) && (scope === 'all' || isApprovedScreen(s))).map((s) => s.id);
}

/** Select all's box: ticked when every drawn screen is, half-ticked when some are, empty when none. Screens with no drawing are skipped. */
export function selectAllState(screens: ScreenLike[], ticked: string[]): 'all' | 'some' | 'none' {
  const drawn = screens.filter(isDrawn).map((s) => s.id);
  const n = drawn.filter((id) => ticked.includes(id)).length;
  if (!n) return 'none';
  return n === drawn.length ? 'all' : 'some';
}

/** A click on Select all: every drawn screen, or none when all were ticked. */
export function toggleAll(screens: ScreenLike[], ticked: string[]): string[] {
  return selectAllState(screens, ticked) === 'all' ? [] : screens.filter(isDrawn).map((s) => s.id);
}

/** A click on one screen's box: a screen with no drawing cannot be ticked. The list keeps the screen list's order. */
export function toggleScreen(screens: ScreenLike[], ticked: string[], id: string): string[] {
  const s = screens.find((x) => x.id === id);
  if (!s || !isDrawn(s)) return ticked;
  const next = ticked.includes(id) ? ticked.filter((x) => x !== id) : [...ticked, id];
  return screens.map((x) => x.id).filter((x) => next.includes(x));
}

/** A click on one frame's box: the last ticked frame stays ticked. The list keeps the sketch's frame order. */
export function toggleFrame(frames: string[], ticked: string[], frame: string): string[] {
  if (ticked.includes(frame)) return ticked.length > 1 ? ticked.filter((f) => f !== frame) : ticked;
  return frames.filter((f) => f === frame || ticked.includes(f));
}

/** Export is on only with at least one screen and one frame ticked, and while no PDF is being made. */
export const canExport = (screens: string[], frames: string[], busy = false) => !busy && screens.length > 0 && frames.length > 0;

/** "<sketch name>.pdf", with every character a file name cannot hold swapped for "-". */
export function pdfFileName(sketchName: string): string {
  const clean = sketchName
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return `${clean || 'Sketch'}.pdf`;
}

export const exportPdfPath = (sketch: string) => `${sketchApiPath(sketch)}/export/pdf`;

/** What the export window sends. allVariants is off unless the person ticks it. */
export interface ExportRequest {
  screens: string[];
  frames: string[];
  allVariants: boolean;
}

/** The body sent: the three choices, the screens in the screen list's order. */
export function exportBody(screens: ScreenLike[], ticked: string[], frames: string[], allVariants: boolean): ExportRequest {
  return { screens: screens.map((s) => s.id).filter((id) => ticked.includes(id)), frames, allVariants };
}

/** Asks the board server for the PDF. Gives back its bytes; throws the server's own words when it says no. */
export async function fetchExportPdf(sketch: string, body: ExportRequest): Promise<Blob> {
  const token = currentToken();
  if (!token) throw new UnauthorizedError();
  let res: Response;
  try {
    res = await fetch(apiPath(exportPdfPath(sketch)), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  } catch {
    throw new Error(NO_ANSWER);
  }
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? `${res.status} ${res.statusText}`, res.status);
  }
  return res.blob();
}

/** Hands a file to the browser as a download, named `name`. */
export function downloadFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Makes the PDF and downloads it as "<sketch name>.pdf". */
export async function exportSketchPdf(sketch: { id: string; name: string }, body: ExportRequest, download: (blob: Blob, name: string) => void = downloadFile): Promise<void> {
  const blob = await fetchExportPdf(sketch.id, body);
  download(blob, pdfFileName(sketch.name));
}
