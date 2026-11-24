import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { ExportPlan } from '../src/board/studio.js';

/**
 * US-46 Export sketch to PDF (AB-171.1): POST /api/v1/studio/sketches/<id>/export/pdf answers with the PDF itself,
 * named "<sketch name>.pdf" (Arabic too), made in memory: no project file changes and the PDF is never saved. Only one
 * export per sketch runs at a time. squad-kit's browser is replaced here: the real print is checked in
 * studio-pdf-browser.test.ts.
 */

const printed: { plan: ExportPlan; project: string }[] = [];
let print: (plan: ExportPlan) => Promise<Buffer> = async () => Buffer.from('%PDF-1.7 fake');
vi.mock('../src/engine/studio-pdf.js', async (orig) => ({
  ...(await orig<typeof import('../src/engine/studio-pdf.js')>()),
  makeSketchPdf: async (plan: ExportPlan, o: { project: string }) => {
    printed.push({ plan, project: o.project });
    return print(plan);
  },
}));

const { boardPaths } = await import('../src/board/store.js');
const { seedDemoStudio } = await import('../src/board/demo-studio.js');
const { mountStudioApi } = await import('../src/console/api/studio.js');
const { buildPaths } = await import('../src/core/paths.js');
const { ShotsUnavailable, NO_BROWSER } = await import('../src/engine/shots.js');
const { ALREADY_MAKING, attachmentOf, safeFileName } = await import('../src/console/api/studio-export.js');

let tmp: string;
let app: Hono;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-export-api-'));
  seedDemoStudio(boardPaths(path.join(tmp, '.squad')));
  app = new Hono();
  mountStudioApi(app, { paths: buildPaths(tmp) });
  printed.length = 0;
  print = async () => Buffer.from('%PDF-1.7 fake');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const exportPdf = (id: string, body: unknown) => app.request(`/api/v1/studio/sketches/${encodeURIComponent(id)}/export/pdf`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ALL = { screens: ['home', 'form', 'new-screen'], frames: ['desktop', 'mobile'] };

/** Every file in the project, with its bytes and change time. */
function files(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(tmp, p)] = `${fs.readFileSync(p, 'base64')}@${fs.statSync(p).mtimeMs}`;
    }
  };
  walk(tmp);
  return out;
}

describe('the export route', () => {
  it('answers with the PDF itself, named "Booking.pdf", and changes no project file', async () => {
    const before = files();
    const res = await exportPdf('booking', ALL);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Booking.pdf"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-1.7 fake');
    // The pages the server worked out from what is saved, in the screen list's order; "New screen" has no drawing.
    expect(printed[0]!.plan.pages.map((p) => `${p.screenName} ${p.frame}`)).toEqual(['Home desktop', 'Home mobile', 'Form desktop', 'Form mobile']);
    expect(printed[0]!.project).toBe(path.basename(tmp));
    expect(files()).toEqual(before);
  });

  it('takes allVariants left out as off, and true as one page per variant', async () => {
    await exportPdf('booking', ALL);
    await exportPdf('booking', { ...ALL, allVariants: 'yes' });
    await exportPdf('booking', { ...ALL, allVariants: true });
    expect(printed.map((p) => p.plan.pages.length)).toEqual([4, 4, 8]);
    expect(printed[2]!.plan.pages.filter((p) => p.option).map((p) => `${p.frame} ${p.option!.letter}`)).toEqual(['desktop A', 'desktop B', 'desktop C', 'mobile A', 'mobile B', 'mobile C']);
  });

  it('names an Arabic sketch\'s file "الحجز.pdf" in a way browsers read', async () => {
    const res = await exportPdf('arabic-booking', { screens: ['booking-form'], frames: ['desktop', 'mobile'] });
    expect(res.status).toBe(200);
    const header = res.headers.get('content-disposition')!;
    expect(header).toBe(`attachment; filename="sketch.pdf"; filename*=UTF-8''${encodeURIComponent('الحجز.pdf')}`);
    expect(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(header)![1]!)).toBe('الحجز.pdf');
  });

  it('refuses a second export of the same sketch while the first is made, with "Already making the PDF"', async () => {
    let finish: (b: Buffer) => void = () => undefined;
    print = () => new Promise<Buffer>((r) => (finish = r));
    const first = exportPdf('booking', ALL);
    await vi.waitFor(() => expect(printed).toHaveLength(1));
    const second = await exportPdf('booking', ALL);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: ALREADY_MAKING, busy: true });
    expect(ALREADY_MAKING).toBe('Already making the PDF');
    // Another sketch is not held up.
    print = async () => Buffer.from('%PDF login');
    expect((await exportPdf('login', { screens: ['sign-in'], frames: ['desktop'] })).status).toBe(200);
    finish(Buffer.from('%PDF done'));
    expect((await first).status).toBe(200);
    // Once it is done, the next one runs.
    expect((await exportPdf('booking', ALL)).status).toBe(200);
  });

  it('says in plain words when squad-kit\'s browser cannot be set up, and the next try runs again', async () => {
    print = async () => {
      throw new ShotsUnavailable(NO_BROWSER, 'npm install failed');
    };
    const res = await exportPdf('booking', ALL);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: NO_BROWSER, noBrowser: true });
    print = async () => Buffer.from('%PDF ok');
    expect((await exportPdf('booking', ALL)).status).toBe(200);
  });

  it('refuses a choice the plan cannot make a file from with its words, and a missing sketch with 404', async () => {
    const before = files();
    const noFrame = await exportPdf('booking', { screens: ['home'], frames: [] });
    expect(noFrame.status).toBe(400);
    expect(await noFrame.json()).toEqual({ error: 'Pick at least one frame to export.' });
    const empty = await exportPdf('booking', { screens: ['new-screen'], frames: ['desktop'] });
    expect(empty.status).toBe(400);
    const gone = await exportPdf('nowhere', ALL);
    expect(gone.status).toBe(404);
    expect(printed).toEqual([]);
    expect(files()).toEqual(before);
  });
});

describe('the file name', () => {
  it('swaps out every character a file name cannot hold', () => {
    expect(safeFileName('Booking', 'pdf')).toBe('Booking.pdf');
    expect(safeFileName('Booking / v2: "final"?', 'pdf')).toBe('Booking - v2- -final--.pdf');
    expect(safeFileName('  ', 'pdf')).toBe('Sketch.pdf');
    expect(safeFileName('الحجز', 'pdf')).toBe('الحجز.pdf');
    expect(attachmentOf('Booking.pdf')).toBe('attachment; filename="Booking.pdf"');
    expect(attachmentOf('Booking الحجز.pdf')).toBe(`attachment; filename="Booking .pdf"; filename*=UTF-8''${encodeURIComponent('Booking الحجز.pdf')}`);
  });
});
