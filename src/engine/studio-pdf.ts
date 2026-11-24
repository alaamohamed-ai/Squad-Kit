import type { ExportPage, ExportPlan } from '../board/studio.js';
import type { Browser } from '../modules/browser/types.js';
import { BrowserSession, NO_BROWSER, ShotsUnavailable, prepareShots } from './shots.js';

/**
 * Export sketch to PDF (US-46, AB-171.1): the print part. From the export plan (board/studio-export.ts) it builds one
 * print document made for clients, and squad-kit's own browser prints it, in memory, to one PDF: nothing is saved on
 * disk and no project file changes.
 *
 * The document is written for a client: it uses their words ("Option B") and none of the Studio's own marks, so no
 * "Draft" and no "In use" anywhere. A plain cover first (the project small at the top, the sketch's name as a large
 * title, the date, the number of screens and the screen list with page numbers), then one page per screen and frame,
 * each with a thin strip naming the screen and the frame, and under it the screen drawn at its frame's real width,
 * sealed: no scripts and no network. Each page is as tall as its screen, so a long screen stays on one page. Names and
 * ideas use dir="auto" and fonts that show Arabic, so a right-to-left sketch reads as it does in the Studio.
 */

/** The size each frame is drawn at, as the Studio draws it: its real width, and the least height of one screen. */
export const FRAME_SIZES: Record<string, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
};

export const frameSize = (frame: string) => FRAME_SIZES[frame] ?? FRAME_SIZES.desktop!;

/** "desktop" → "Desktop". */
export const frameWord = (frame: string) => (frame ? frame[0]!.toUpperCase() + frame.slice(1) : frame);

/** The cover, an A4 page in CSS pixels; it grows taller only when the screen list needs it. */
const COVER = { width: 794, height: 1123 };
/** Chromium's tallest PDF page, in CSS pixels (200 inches): a taller screen is made smaller to fit, never cut. */
export const MAX_PAGE_PX = 19_000;
/** The thin strip over a screen: one line, or three with a variant's option and idea. */
const STRIP = 44;
const STRIP_OPTION = 82;

/** The same seal the Studio's frames use: the policy first, so a drawing reaches no network. */
const SEAL = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

export function sealed(html: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${SEAL}">${html.replace(/^\s*<!doctype[^>]*>/i, '')}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Fonts that show Latin and Arabic letters on each system. */
const FONTS = `system-ui, -apple-system, "Segoe UI", "Noto Sans", "Noto Sans Arabic", "Geeza Pro", "Arial Unicode MS", Tahoma, Arial, sans-serif`;

/** "3 screens", "1 screen". */
export const screenCount = (n: number) => `${n} ${n === 1 ? 'screen' : 'screens'}`;

/** "Option B: Split steps", or "Option B" with no name. */
export const optionTitle = (o: { letter: string; name: string }) => `Option ${o.letter}${o.name ? `: ${o.name}` : ''}`;

/** Arabic reads right to left: the direction of a name, from most of its letters, as the Studio's chat decides it. */
export function textDir(text: string): 'rtl' | 'ltr' {
  const arabic = (text.match(/[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return arabic > 0 && arabic >= latin ? 'rtl' : 'ltr';
}

/** "24 November 2026". */
export const dateWords = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

export interface PrintOptions {
  /** The project's name, small at the top of the cover. */
  project: string;
  /** The day on the cover; left out, today. */
  date?: Date;
}

function coverHtml(plan: ExportPlan, o: PrintOptions): { html: string; height: number } {
  const rows = plan.screens
    .map((s) => {
      const name = s.options > 1 ? `${s.name} (${s.options} options)` : s.name;
      return `<li><span class="nm" dir="auto">${esc(name)}</span><span class="dots"></span><span class="pn">${s.firstPage}</span></li>`;
    })
    .join('');
  const height = Math.max(COVER.height, 460 + plan.screens.length * 38);
  // A sketch named in Arabic gets a right-to-left cover: its title, list and page numbers read from the right. The
  // project's name and the English date line are isolated, so each reads in its own direction on either side.
  const html = `<section class="cover" dir="${textDir(plan.sketch.name)}" style="page: cover; height: ${height}px">
<p class="project"><bdi>${esc(o.project)}</bdi></p>
<h1 dir="auto">${esc(plan.sketch.name)}</h1>
<p class="facts"><bdi>${esc(dateWords(o.date ?? new Date()))} · ${screenCount(plan.screens.length)}</bdi></p>
<ol class="list">${rows}</ol>
</section>`;
  return { html, height };
}

function pageHtml(p: ExportPage, i: number, height: number): { css: string; html: string } {
  const { width } = frameSize(p.frame);
  const strip = p.option ? STRIP_OPTION : STRIP;
  const total = strip + height;
  // A screen taller than a PDF page can be is made smaller, all of it, so nothing is cut.
  const scale = Math.min(1, MAX_PAGE_PX / total);
  const w = Math.floor(width * scale);
  const h = Math.floor(total * scale);
  const name = `s${i}`;
  const option = p.option
    ? `<p class="opt" dir="auto">${esc(optionTitle(p.option))}</p>${p.option.idea ? `<p class="idea" dir="auto">${esc(p.option.idea)}</p>` : ''}`
    : '';
  const html = `<section class="pg" style="page: ${name}; width: ${w}px; height: ${h}px">
<div class="fit" style="width: ${width}px; height: ${total}px; zoom: ${scale}">
<div class="strip" style="height: ${strip}px"><p class="where"><span class="nm" dir="auto">${esc(p.screenName)}</span><span class="fr">${esc(frameWord(p.frame))}</span></p>${option}</div>
<iframe title="${esc(`${p.screenName}, ${frameWord(p.frame)}`)}" sandbox="" scrolling="no" width="${width}" height="${height}" srcdoc="${esc(sealed(p.html))}"></iframe>
</div>
</section>`;
  return { css: `@page ${name} { size: ${w}px ${h}px; margin: 0 }`, html };
}

/**
 * The print document: the cover, then one page per screen and frame, each page its own size. `heights` is each page's
 * screen at its full height, in the plan's page order.
 */
export function printDocument(plan: ExportPlan, heights: number[], o: PrintOptions): string {
  const cover = coverHtml(plan, o);
  const pages = plan.pages.map((p, i) => pageHtml(p, i, Math.max(frameSize(p.frame).height, Math.ceil(heights[i] ?? 0))));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SEAL}">
<title>${esc(plan.sketch.name)}</title>
<style>
@page cover { size: ${COVER.width}px ${cover.height}px; margin: 0 }
${pages.map((p) => p.css).join('\n')}
* { box-sizing: border-box }
html, body { margin: 0; padding: 0; background: #fff; color: #1b1f1d; font-family: ${FONTS}; -webkit-print-color-adjust: exact; print-color-adjust: exact }
section { break-after: page; overflow: hidden; position: relative }
section:last-child { break-after: auto }
.cover { width: ${COVER.width}px; padding: 120px 96px 96px }
.cover .project { margin: 0 0 18px; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: #7a837e }
.cover h1 { margin: 0 0 22px; font-size: 52px; line-height: 1.12; font-weight: 700; letter-spacing: -.02em; overflow-wrap: anywhere }
.cover .facts { margin: 0 0 96px; font-size: 15px; color: #59625d }
.cover .list { list-style: none; margin: 0; padding: 0; font-size: 15px }
.cover .list li { display: flex; align-items: baseline; gap: 10px; height: 38px; border-bottom: 1px solid #ecefed; padding-top: 10px }
.cover .list .nm { flex: none; max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.cover .list .dots { flex: 1 }
.cover .list .pn { flex: none; color: #59625d; font-variant-numeric: tabular-nums }
.pg .fit { display: flex; flex-direction: column }
.strip { flex: none; display: flex; flex-direction: column; justify-content: center; gap: 2px; padding: 0 18px; background: #f6f7f6; border-bottom: 1px solid #e3e7e4; overflow: hidden }
.strip p { margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.strip .where { display: flex; gap: 10px; align-items: baseline; font-size: 14px }
.strip .where .nm { font-weight: 650; overflow: hidden; text-overflow: ellipsis }
.strip .where .fr { flex: none; color: #6b746f; font-size: 13px }
.strip .opt { font-size: 13.5px; font-weight: 600; color: #1b1f1d }
.strip .idea { font-size: 12.5px; color: #59625d }
iframe { display: block; border: 0; flex: none }
</style></head>
<body>
${cover.html}
${pages.map((p) => p.html).join('\n')}
</body></html>
`;
}

/** What the browser measures for each page of the plan, in the plan's page order. */
export function measureList(plan: ExportPlan): { html: string; width: number; height: number }[] {
  return plan.pages.map((p) => ({ html: sealed(p.html), ...frameSize(p.frame) }));
}

/**
 * Prints the plan to PDF bytes with squad-kit's own browser, in memory. Throws ShotsUnavailable with the person's words
 * when the browser cannot be set up or cannot print. `browser` stands in for squad-kit's browser in tests.
 */
export async function makeSketchPdf(plan: ExportPlan, o: PrintOptions & { signal?: AbortSignal; browser?: () => Promise<Browser> }): Promise<Buffer> {
  const session = o.browser ? null : new BrowserSession(o.signal ? { signal: o.signal } : {});
  try {
    if (!o.browser) await prepareShots(o.signal ? { signal: o.signal } : {});
    const browser = o.browser ? await o.browser() : await session!.browser();
    if (!browser.print) throw new ShotsUnavailable(NO_BROWSER, 'This browser module cannot print');
    try {
      const pdf = await browser.print({ measure: measureList(plan), document: (heights) => printDocument(plan, heights, o) });
      return Buffer.from(pdf);
    } catch (err) {
      if (err instanceof ShotsUnavailable) throw err;
      throw new ShotsUnavailable('squad-kit could not make the PDF. Try again.', (err as Error)?.message ?? String(err));
    }
  } finally {
    await session?.close();
  }
}
