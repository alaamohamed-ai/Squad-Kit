import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, type BoardPaths } from '../src/board/store.js';
import { seedDemoStudio } from '../src/board/demo-studio.js';
import { StudioExportRefused, exportPlan, readSketch, type ScreenVariant, type Sketch, type SketchScreen } from '../src/board/studio.js';
import { MAX_PAGE_PX, measureList, printDocument, sealed } from '../src/engine/studio-pdf.js';

/**
 * US-46 Export sketch to PDF (AB-171.1): the export plan (board/studio-export.ts) and the print document
 * (engine/studio-pdf.ts). The plan lists the pages from what is saved, in the screen list's order and the sketch's frame
 * order, and writes nothing. The print document is made for clients: their words ("Option B"), and none of the
 * Studio's own marks, so no "Draft" and no "In use" anywhere.
 */

const html = (words: string) => `<!doctype html><html><body><h1>${words}</h1></body></html>`;
const frames = (words: string, which = ['desktop', 'mobile']) => Object.fromEntries(which.map((f) => [f, html(`${words} ${f}`)]));

function variant(version: number, words: string, o: Partial<ScreenVariant> = {}, which?: string[]): ScreenVariant {
  return { version, madeAt: '2026-11-20T10:00:00.000Z', frames: frames(words, which), ...o };
}

function screen(id: string, name: string, o: Partial<SketchScreen> = {}): SketchScreen {
  return { id, name, order: 0, status: 'draft', chosen: null, variants: [], ...o };
}

const ask = (letter: string, name: string, idea: string) => ({ ask: 'ask-1', letter, name, idea });

/**
 * "Booking": Home approved at v1, Form drawn as variants A, B and C from one ask (B in use), and an empty "New screen",
 * each in Desktop and Mobile.
 */
function booking(): Sketch {
  return {
    id: 'booking',
    name: 'Booking',
    designSystem: null,
    frames: ['desktop', 'mobile'],
    lastEdit: null,
    stamp: 's1',
    screens: [
      screen('home', 'Home', { order: 1, status: 'approved', chosen: 1, approved: { version: 1, at: '2026-11-20T10:00:00.000Z' }, variants: [variant(1, 'Home')] }),
      screen('form', 'Form', {
        order: 2,
        chosen: 2,
        variants: [
          variant(1, 'Form A', ask('A', 'One page', 'Everything on one page.')),
          variant(2, 'Form B', ask('B', 'Split steps', 'One question per step.')),
          variant(3, 'Form C', ask('C', 'Calendar first', 'Start from the free days.')),
        ],
      }),
      screen('new-screen', 'New screen', { order: 3, unnamed: true }),
    ],
  };
}

const ALL = { screens: ['home', 'form', 'new-screen'], frames: ['desktop', 'mobile'] };
const rows = (pages: { screenName: string; frame: string; page: number; option?: { letter: string } }[]) => pages.map((p) => `${p.page} ${p.screenName} ${p.frame}${p.option ? ` ${p.option.letter}` : ''}`);

describe('the export plan: pages in the screen list\'s order', () => {
  it('gives Home Desktop, Home Mobile, Form Desktop, Form Mobile after the cover, and leaves out the empty "New screen"', () => {
    const plan = exportPlan(booking(), ALL);
    expect(rows(plan.pages)).toEqual(['2 Home desktop', '3 Home mobile', '4 Form desktop', '5 Form mobile']);
    expect(plan.screens.map((s) => [s.name, s.firstPage, s.options])).toEqual([
      ['Home', 2, 1],
      ['Form', 4, 1],
    ]);
    expect(plan.frames).toEqual(['desktop', 'mobile']);
    // Form shows its chosen drawing, B.
    expect(plan.pages[2]!.html).toContain('Form B desktop');
    expect(plan.pages[2]!.option).toBeUndefined();
  });

  it('follows the screen list and the sketch\'s frame order, whatever order the choice lists them in', () => {
    const plan = exportPlan(booking(), { screens: ['form', 'home'], frames: ['mobile', 'desktop'] });
    expect(rows(plan.pages)).toEqual(['2 Home desktop', '3 Home mobile', '4 Form desktop', '5 Form mobile']);
  });

  it('leaves out unticked screens and frames', () => {
    expect(rows(exportPlan(booking(), { screens: ['form'], frames: ['mobile'] }).pages)).toEqual(['2 Form mobile']);
    expect(rows(exportPlan(booking(), { screens: ['home', 'form'], frames: ['desktop'] }).pages)).toEqual(['2 Home desktop', '3 Form desktop']);
  });

  it('leaves out a frame a drawing has no page for, and the page numbers follow', () => {
    const s = booking();
    s.screens[0]!.variants[0]!.frames = frames('Home', ['desktop']);
    const plan = exportPlan(s, ALL);
    expect(rows(plan.pages)).toEqual(['2 Home desktop', '3 Form desktop', '4 Form mobile']);
    expect(plan.screens.map((x) => x.firstPage)).toEqual([2, 3]);
  });

  it('uses the version an approved screen was approved at, even with a newer one chosen', () => {
    const s = booking();
    const home = s.screens[0]!;
    home.variants.push(variant(2, 'Home newer'));
    home.chosen = 2;
    expect(exportPlan(s, { screens: ['home'], frames: ['desktop'] }).pages[0]).toMatchObject({ version: 1, html: expect.stringContaining('Home desktop') });
  });

  it('"Approved screens only" (the approved ids) gives only Home\'s Desktop and Mobile pages', () => {
    const plan = exportPlan(booking(), { screens: ['home'], frames: ['desktop', 'mobile'] });
    expect(rows(plan.pages)).toEqual(['2 Home desktop', '3 Home mobile']);
    expect(plan.screens).toEqual([{ id: 'home', name: 'Home', firstPage: 2, options: 1, approved: true }]);
  });

  it('refuses in plain words: no frame, a frame or a screen the sketch does not have, and a choice that makes no page', () => {
    const s = booking();
    expect(() => exportPlan(s, { screens: ['home'], frames: [] })).toThrow('Pick at least one frame to export.');
    expect(() => exportPlan(s, { screens: ['home'], frames: ['tablet'] })).toThrow('Booking has no frame "tablet".');
    expect(() => exportPlan(s, { screens: [], frames: ['desktop'] })).toThrow('Pick at least one screen to export.');
    expect(() => exportPlan(s, { screens: ['gone'], frames: ['desktop'] })).toThrow('Booking has no screen "gone".');
    expect(() => exportPlan(s, { screens: ['new-screen'], frames: ['desktop'] })).toThrow('None of the screens you picked is drawn in these frames yet, so there is nothing to export.');
    expect(() => exportPlan(s, { screens: 'home' as never, frames: ['desktop'] })).toThrow(StudioExportRefused);
  });
});

describe('the export plan: all variants', () => {
  it('off, gives one page per screen and frame', () => {
    expect(exportPlan(booking(), { ...ALL, allVariants: false }).pages).toHaveLength(4);
    expect(exportPlan(booking(), ALL).pages.every((p) => !p.option)).toBe(true);
  });

  it('on, gives the draft Form three pages per frame in letter order, each with its letter, name and idea', () => {
    const plan = exportPlan(booking(), { ...ALL, allVariants: true });
    expect(rows(plan.pages)).toEqual(['2 Home desktop', '3 Home mobile', '4 Form desktop A', '5 Form desktop B', '6 Form desktop C', '7 Form mobile A', '8 Form mobile B', '9 Form mobile C']);
    expect(plan.pages[3]!.option).toEqual({ letter: 'B', name: 'Split steps', idea: 'One question per step.' });
    expect(plan.pages[3]!.html).toContain('Form B desktop');
    expect(plan.pages[4]!.html).toContain('Form C desktop');
    expect(plan.screens.map((s) => [s.name, s.firstPage, s.options])).toEqual([
      ['Home', 2, 1],
      ['Form', 4, 3],
    ]);
  });

  it('keeps an approved screen to its approved version, even when it came from an ask with variants', () => {
    const s = booking();
    const home = s.screens[0]!;
    home.variants = [variant(1, 'Home A', ask('A', 'Quiet', 'Less.')), variant(2, 'Home B', { ...ask('B', 'Loud', 'More.'), ask: 'ask-1' })];
    home.chosen = 1;
    home.approved = { version: 1, at: '2026-11-20T10:00:00.000Z' };
    const plan = exportPlan(s, { screens: ['home'], frames: ['desktop', 'mobile'], allVariants: true });
    expect(rows(plan.pages)).toEqual(['2 Home desktop', '3 Home mobile']);
    expect(plan.pages[0]!.html).toContain('Home A desktop');
  });

  it('keeps a draft screen with one variant to one page per frame, and the page numbers after it move along', () => {
    const s = booking();
    // Form's ask now has only B; a third screen comes after it.
    s.screens[1]!.variants = [variant(2, 'Form B', ask('B', 'Split steps', 'One question per step.'))];
    s.screens.push(screen('done', 'Done', { order: 4, chosen: 1, variants: [variant(1, 'Done')] }));
    const plan = exportPlan(s, { screens: ['home', 'form', 'done'], frames: ['desktop', 'mobile'], allVariants: true });
    expect(rows(plan.pages)).toEqual(['2 Home desktop', '3 Home mobile', '4 Form desktop', '5 Form mobile', '6 Done desktop', '7 Done mobile']);
    expect(plan.pages.every((p) => !p.option)).toBe(true);

    // With Form's three variants back, Done's pages move along by four.
    const three = exportPlan({ ...booking(), screens: [...booking().screens, s.screens[3]!] }, { screens: ['home', 'form', 'done'], frames: ['desktop', 'mobile'], allVariants: true });
    expect(three.screens.map((x) => [x.name, x.firstPage])).toEqual([
      ['Home', 2],
      ['Form', 4],
      ['Done', 10],
    ]);
  });
});

describe('the export plan reads what is saved, and writes nothing', () => {
  let tmp: string;
  let bp: BoardPaths;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-export-'));
    bp = boardPaths(path.join(tmp, '.squad'));
    seedDemoStudio(bp);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const files = () => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out[p] = `${fs.readFileSync(p, 'base64')}@${fs.statSync(p).mtimeMs}`;
      }
    };
    walk(tmp);
    return out;
  };

  it('plans the sample "Booking": Home approved, Form as A, B and C, and "New screen" left out', () => {
    const before = files();
    const sketch = readSketch(bp, 'booking')!;
    expect(sketch.screens.map((s) => [s.name, s.status])).toEqual([
      ['Home', 'approved'],
      ['Form', 'draft'],
      ['New screen', 'draft'],
    ]);
    const plan = exportPlan(sketch, { screens: sketch.screens.map((s) => s.id), frames: sketch.frames, allVariants: true });
    expect(rows(plan.pages)).toEqual(['2 Home desktop', '3 Home mobile', '4 Form desktop A', '5 Form desktop B', '6 Form desktop C', '7 Form mobile A', '8 Form mobile B', '9 Form mobile C']);
    expect(plan.pages[3]!.option).toEqual({ letter: 'B', name: 'Split steps', idea: 'One question per step, with a clear Next.' });
    expect(files()).toEqual(before);
  });

  it('plans the sample "Login" (no screen approved) and "الحجز" (one long right-to-left screen)', () => {
    const login = readSketch(bp, 'login')!;
    expect(login.screens.some((s) => s.status === 'approved')).toBe(false);
    const arabic = readSketch(bp, 'arabic-booking')!;
    expect(arabic.name).toBe('الحجز');
    const plan = exportPlan(arabic, { screens: arabic.screens.map((s) => s.id), frames: arabic.frames });
    expect(rows(plan.pages)).toEqual(['2 نموذج الحجز desktop', '3 نموذج الحجز mobile']);
    expect(plan.pages[0]!.html).toContain('dir="rtl"');
  });
});

describe('the print document, made for clients', () => {
  const day = new Date('2026-11-24T12:00:00Z');
  const doc = (allVariants: boolean, heights: number[] = []) => {
    const plan = exportPlan(booking(), { ...ALL, allVariants });
    return printDocument(plan, heights, { project: 'Clinic Booking', date: day });
  };
  /** The words a reader sees: the document without its tags and the screens inside their sealed frames. */
  const visible = (d: string) => d.replace(/srcdoc="[^"]*"/g, '').replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('has no "Draft" and no "In use" anywhere', () => {
    for (const d of [doc(false), doc(true)]) {
      expect(d).not.toMatch(/draft/i);
      expect(d).not.toMatch(/in use/i);
      expect(d).not.toMatch(/approved/i);
    }
  });

  it('has a plain cover: the project small at the top, the sketch as the title, the date, the number of screens, the list with page numbers', () => {
    const words = visible(doc(false));
    expect(words).toContain('Clinic Booking Booking 24 November 2026 · 2 screens');
    expect(doc(false)).toMatch(/<p class="project"><bdi>Clinic Booking<\/bdi><\/p>\s*<h1 dir="auto">Booking<\/h1>/);
    expect(doc(false)).toContain('<p class="facts"><bdi>24 November 2026 · 2 screens</bdi></p>');
    expect(words).toMatch(/Home 2 Form 4/);
    expect(doc(false)).toContain('@page cover { size: 794px 1123px; margin: 0 }');
  });

  it('names a screen with its variants in the file "Form (3 options)" on the cover, with its first page number', () => {
    const d = doc(true);
    expect(visible(d)).toMatch(/Home 2 Form \(3 options\) 4/);
    expect(visible(doc(false))).not.toContain('options');
  });

  it('puts the screen\'s name and frame on each page, and "Option B: Split steps" with its idea on a variant\'s page', () => {
    const d = doc(true);
    expect(d).toContain('<span class="nm" dir="auto">Home</span><span class="fr">Desktop</span>');
    expect(d).toContain('<span class="nm" dir="auto">Form</span><span class="fr">Mobile</span>');
    expect(d).toContain('<p class="opt" dir="auto">Option B: Split steps</p><p class="idea" dir="auto">One question per step.</p>');
    expect(d).toContain('Option A: One page');
    expect(d).toContain('Option C: Calendar first');
    expect(visible(doc(false))).not.toContain('Option');
  });

  it('draws each screen sealed, at its frame\'s real width and full height, one page each, each its own size', () => {
    const d = doc(false, [800, 2600, 1200, 844]);
    expect(d.match(/<iframe /g)).toHaveLength(4);
    expect(d).toMatch(/<iframe title="Home, Desktop" sandbox="" scrolling="no" width="1280" height="800"/);
    expect(d).toMatch(/<iframe title="Home, Mobile" sandbox="" scrolling="no" width="390" height="2600"/);
    expect(d).toContain('@page s1 { size: 390px 2644px; margin: 0 }');
    // The screens' HTML is sealed: no scripts and no network.
    expect(d).toContain('Content-Security-Policy');
    expect(sealed('<!doctype html><p>x</p>')).toBe(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"><p>x</p>`);
    expect(measureList(exportPlan(booking(), ALL)).map((m) => [m.width, m.height])).toEqual([
      [1280, 800],
      [390, 844],
      [1280, 800],
      [390, 844],
    ]);
  });

  it('makes a screen taller than a PDF page can be smaller, all of it, so nothing is cut', () => {
    const d = doc(false, [40_000, 844, 800, 844]);
    const size = /@page s0 \{ size: (\d+)px (\d+)px/.exec(d)!;
    expect(Number(size[2])).toBeLessThanOrEqual(MAX_PAGE_PX);
    expect(d).toMatch(/zoom: 0\.4/);
  });

  it('shows Arabic names and ideas with dir="auto", fonts that show Arabic, and a right-to-left cover for an Arabic sketch', () => {
    const s = booking();
    s.name = 'الحجز';
    s.screens[1]!.name = 'نموذج الحجز';
    s.screens[1]!.variants[1]!.idea = 'سؤال واحد في كل خطوة';
    const d = printDocument(exportPlan(s, { ...ALL, allVariants: true }), [], { project: 'عيادة النور', date: day });
    expect(d).toContain('<section class="cover" dir="rtl"');
    expect(d).toContain('<p class="project"><bdi>عيادة النور</bdi></p>');
    expect(d).toContain('<h1 dir="auto">الحجز</h1>');
    expect(d).toContain('<span class="nm" dir="auto">نموذج الحجز (3 options)</span>');
    expect(d).toContain('<span class="nm" dir="auto">نموذج الحجز</span><span class="fr">Desktop</span>');
    expect(d).toContain('<p class="idea" dir="auto">سؤال واحد في كل خطوة</p>');
    expect(d).toContain('<title>الحجز</title>');
    expect(d).toContain('"Noto Sans Arabic"');
    expect(doc(false)).toContain('<section class="cover" dir="ltr"');
  });

  it('keeps names safe: a name with HTML in it is shown as text', () => {
    const s = booking();
    s.name = '<b>Booking</b> & co';
    const d = printDocument(exportPlan(s, ALL), [], { project: 'P', date: day });
    expect(d).toContain('&lt;b&gt;Booking&lt;/b&gt; &amp; co');
    expect(d).not.toContain('<b>Booking</b>');
  });
});
