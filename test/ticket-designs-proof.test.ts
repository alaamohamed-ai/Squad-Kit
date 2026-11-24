import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { Browser, DrawJob } from '../src/modules/browser/types.js';
import type { Ticket } from '../src/board/types.js';

/**
 * US-55, done when 4 and 5 (AB-180.1): on the proof card, each picked screen's design picture sits next to the
 * Tester's after picture of the page it built, in the same frame. The Tester names its pictures in "designs" and is
 * asked again for one that is missing; squad-kit draws each frame of the ticket's frozen copy itself, sealed (scripts
 * and the network off), at the frame's size, so an Arabic screen reads right to left as in the Studio. A ticket with no
 * picked screen gets no design pictures. squad-kit's browser is replaced here; the real drawing is checked in
 * ticket-designs-browser.test.ts.
 */

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const studio = await import('../src/board/studio.js');
const actions = await import('../src/board/studio-actions.js');
const { createTicket } = await import('../src/board/actions/new-ticket.js');
const designs = await import('../src/board/ticket-designs.js');
const proof = await import('../src/engine/live.js');
const { mountTicketDesignsApi } = await import('../src/console/api/ticket-designs.js');
const { buildPaths } = await import('../src/core/paths.js');
const { designPairs } = await import('../console-ui/src/lib/design-pairs.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
const BOTH = ['desktop', 'mobile'];
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d20000000049454e44ae426082', 'hex');

const arabicPage = (words: string) => `<!doctype html><html lang="ar" dir="rtl"><body><h1>${words}</h1><button>احجز</button><script>document.body.innerHTML = 'scripts ran'</script></body></html>`;

/** A sketch with one screen approved at version 1. */
function approvedSketch(name: string, screen: string, frames: Record<string, string>) {
  const made = actions.createSketch(bp, { name, frames: BOTH, screens: [{ name: screen }] });
  const id = made.id;
  const sid = made.screens[0]!.id;
  const s = studio.saveDrawnScreens(bp, id, [{ id: sid, name: screen, frames }], made.stamp).sketch;
  actions.approveSketchScreen(bp, id, sid, s.stamp, { chat: null });
  return { id, screen: sid };
}

/** A ticket with "Booking / Form" and the Arabic "الحجز / نموذج الحجز" picked, as the Builder left it. */
function builtTicket(): Ticket {
  const form = approvedSketch('Booking', 'Form', { desktop: '<h1>Form, wide</h1>', mobile: '<h1>Form, small</h1>' });
  const ar = approvedSketch('الحجز', 'نموذج الحجز', { desktop: arabicPage('نموذج الحجز'), mobile: arabicPage('نموذج الحجز') });
  const t = createTicket(bp, { title: 'Book a visit', ask: 'People book a visit online.' });
  designs.addTicketDesigns(bp, t.id, [{ sketch: form.id, screen: form.screen }, { sketch: ar.id, screen: ar.screen }]);
  return updateTicket(bp, t.id, (x) => (x.stage = 'test'));
}

/** squad-kit's browser, replaced: each page drawn is kept, and a tiny PNG comes back for each. */
function fakeBrowser(jobs: DrawJob[]): () => Promise<Browser> {
  return async () => ({
    page: async () => {
      throw new Error('no app page in this test');
    },
    draw: async (job: DrawJob) => {
      jobs.push(job);
      return job.pages.map(() => PNG);
    },
    close: async () => undefined,
  });
}

/** A Tester picture squad-kit took in this step: its file in the proof folder, its page and size. */
function taken(files: Record<string, { page: string; size: string }>) {
  for (const f of Object.keys(files)) fs.writeFileSync(path.join(bp.proofDir, f), PNG);
  return (f: string) => files[f];
}

/** The squad, as the design proof uses it, with a Tester that answers `answer` when asked again. */
function host(answer: () => unknown, size: (f: string) => { page: string; size: string } | undefined) {
  const asked: string[][] = [];
  const logs: string[] = [];
  return {
    asked,
    logs,
    squad: {
      bp,
      stops: new Map<string, AbortController>(),
      update: (id: string, change: (t: Ticket) => void) => updateTicket(bp, id, change),
      log: (_level: 'info' | 'warn', text: string) => void logs.push(text),
      screens: async (id: string, _when: 'after', _beside: undefined, again: string[]) => {
        asked.push(again);
        updateTicket(bp, id, (x) => proof.keepDesignShots(x, answer(), size, false));
        return {};
      },
    },
  };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-design-proof-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50, studio: false });
  writeMeta(bp, { ...readMeta(bp), user: { ...(readMeta(bp).user ?? {}), name: 'Alaa' } } as never);
  fs.mkdirSync(bp.proofDir, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('done when 4: the design picture sits next to the after picture, per frame, the Arabic screen too', () => {
  it('the Tester\'s answer is checked for one picture per screen and frame, at that frame\'s size', () => {
    const t = builtTicket();
    const size = taken({ 'a-desk.png': { page: '/book', size: 'desktop' }, 'a-phone.png': { page: '/book', size: 'phone' }, 'b-desk.png': { page: '/ar/book', size: 'desktop' }, 'wrong.png': { page: '/ar/book', size: 'desktop' } });
    const part = { designs: [{ screen: 'Booking / Form', frame: 'desktop', file: 'a-desk.png' }, { screen: 'booking / form', frame: 'mobile', file: 'a-phone.png' }, { screen: 'الحجز / نموذج الحجز', frame: 'desktop', file: 'b-desk.png' }, { screen: 'الحجز / نموذج الحجز', frame: 'mobile', file: 'wrong.png' }] };
    // The Arabic Mobile picture was taken at desktop size: it does not count.
    expect(proof.designsAnswerProblem(t, part, size, false)).toBe('designs needs one picture squad-kit took in this step for each screen and frame, at that frame\'s size, and it has none for "الحجز / نموذج الحجز" Mobile (size "phone")');
    expect(proof.designsAnswerProblem(t, { designs: [] }, size, false)).toContain('"Booking / Form" Desktop (size "desktop"), "Booking / Form" Mobile (size "phone")');
    // Kept on the ticket's design list: the pictures that count, with the page each was taken at.
    const after = updateTicket(bp, t.id, (x) => proof.keepDesignShots(x, part, size, true));
    expect(after.designs!.map((d) => d.proof)).toEqual([
      [{ frame: 'desktop', after: 'a-desk.png', page: '/book' }, { frame: 'mobile', after: 'a-phone.png', page: '/book' }],
      [{ frame: 'desktop', after: 'b-desk.png', page: '/ar/book' }, { frame: 'mobile' }],
    ]);
    expect(proof.designsWithoutAfter(after)).toEqual(['الحجز / نموذج الحجز, Mobile']);
    // A retake counts what the rounds before it kept: only the missing one is asked for.
    expect(proof.designsAnswerProblem(after, { designs: [] }, size, true)).toBe('designs needs one picture squad-kit took in this step for each screen and frame, at that frame\'s size, and it has none for "الحجز / نموذج الحجز" Mobile (size "phone")');
  });

  it('asks the Tester again for the missing one, draws each design frame sealed at its size, and pairs them', async () => {
    const t = builtTicket();
    const size = taken({ 'a-desk.png': { page: '/book', size: 'desktop' }, 'a-phone.png': { page: '/book', size: 'phone' }, 'b-desk.png': { page: '/ar/book', size: 'desktop' }, 'b-phone.png': { page: '/ar/book', size: 'phone' } });
    updateTicket(bp, t.id, (x) => proof.keepDesignShots(x, { designs: [{ screen: 'Booking / Form', frame: 'desktop', file: 'a-desk.png' }, { screen: 'Booking / Form', frame: 'mobile', file: 'a-phone.png' }, { screen: 'الحجز / نموذج الحجز', frame: 'desktop', file: 'b-desk.png' }] }, size, true));
    const h = host(() => ({ designs: [{ screen: 'الحجز / نموذج الحجز', frame: 'mobile', file: 'b-phone.png' }] }), size);
    const jobs: DrawJob[] = [];
    await proof.designProof(h.squad, t.id, { browser: fakeBrowser(jobs) });

    // Asked again once, for the Arabic Mobile page only.
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]![0]).toContain('الحجز / نموذج الحجز, Mobile');
    expect(h.asked[0]![0]).not.toContain('Booking / Form');

    // Each frame of the frozen copy drawn by squad-kit, sealed, at the size of the Tester's picture of it.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.pages.map((p) => [p.width, p.height])).toEqual([[1280, 800], [390, 844], [1280, 800], [390, 844]]);
    for (const p of jobs[0]!.pages) expect(p.html).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
    // The Arabic screen goes to the browser as the Studio drew it: right to left.
    expect(jobs[0]!.pages[2]!.html).toContain('<html lang="ar" dir="rtl">');

    const x = readTicket(bp, t.id)!;
    const file = (d: number, f: string) => proof.designPictureFile(t.id, x.designs![d]!, f);
    expect(x.designs!.map((d) => d.proof)).toEqual([
      [{ frame: 'desktop', after: 'a-desk.png', page: '/book', design: file(0, 'desktop') }, { frame: 'mobile', after: 'a-phone.png', page: '/book', design: file(0, 'mobile') }],
      [{ frame: 'desktop', after: 'b-desk.png', page: '/ar/book', design: file(1, 'desktop') }, { frame: 'mobile', after: 'b-phone.png', page: '/ar/book', design: file(1, 'mobile') }],
    ]);
    for (const d of x.designs!) for (const p of d.proof!) expect(fs.existsSync(path.join(bp.proofDir, p.design!))).toBe(true);
    expect(x.activity[0]!.text).toBe('The design sits next to the build for 2 screens');

    // The proof card gets the pairs per screen and frame, through the board's call.
    const app = new Hono();
    mountTicketDesignsApi(app, { paths: buildPaths(tmp) });
    const row = (await (await app.request(`/api/v1/tickets/${t.id}/designs`)).json()) as { designs: Parameters<typeof designPairs>[0] };
    expect(designPairs(row.designs).map((p) => [p.name, p.frame, p.design, p.after])).toEqual([
      ['Booking / Form', 'desktop', file(0, 'desktop'), 'a-desk.png'],
      ['Booking / Form', 'mobile', file(0, 'mobile'), 'a-phone.png'],
      ['الحجز / نموذج الحجز', 'desktop', file(1, 'desktop'), 'b-desk.png'],
      ['الحجز / نموذج الحجز', 'mobile', file(1, 'mobile'), 'b-phone.png'],
    ]);

    // A second proof round draws nothing again: the design of a version never changes.
    jobs.length = 0;
    await proof.designProof(h.squad, t.id, { browser: fakeBrowser(jobs) });
    expect(jobs).toEqual([]);
  });

  it('a picture that cannot be taken or drawn leaves its place empty and never stops the proof', async () => {
    const t = builtTicket();
    const h = host(() => ({ designs: [] }), () => undefined);
    await proof.designProof(h.squad, t.id, {
      browser: async () => ({ page: async () => { throw new Error('no'); }, close: async () => undefined }),
    });
    const x = readTicket(bp, t.id)!;
    expect(x.designs!.every((d) => d.proof!.every((p) => !p.after && !p.design))).toBe(true);
    expect(h.logs.some((l) => l.startsWith('Could not draw the design pictures'))).toBe(true);
    expect(x.activity[0]!.text).toContain('The design sits next to the build, with no picture of the page yet for Booking / Form, Desktop');
    expect(designPairs(x.designs!.map((d) => ({ ...d, html: {} })))).toHaveLength(4);
  });
});

describe('done when 5: a ticket with no picked screen gets no design pictures', () => {
  it('asks the Tester for nothing more, draws nothing and changes nothing on the ticket', async () => {
    const t = updateTicket(bp, createTicket(bp, { title: 'Show my bookings', ask: 'A list of my bookings.' }).id, (x) => (x.stage = 'test'));
    const before = fs.readFileSync(path.join(bp.ticketsDir, t.id, 'ticket.md'), 'utf8');
    const h = host(() => ({}), () => undefined);
    const jobs: DrawJob[] = [];
    let updates = 0;
    await proof.designProof({ ...h.squad, update: (id, change) => (updates++, h.squad.update(id, change)) }, t.id, { browser: fakeBrowser(jobs) });
    expect(h.asked).toEqual([]);
    expect(jobs).toEqual([]);
    expect(updates).toBe(0);
    expect(fs.readFileSync(path.join(bp.ticketsDir, t.id, 'ticket.md'), 'utf8')).toBe(before);
    expect(proof.designsAnswerProblem(readTicket(bp, t.id)!, {}, () => undefined, false)).toBeNull();
    const x = readTicket(bp, t.id)!;
    proof.keepDesignShots(x, { designs: [{ screen: 'X', frame: 'desktop', file: 'x.png' }] }, () => ({ page: '/', size: 'desktop' }), true);
    expect(x.designs).toBeUndefined();
    expect(designPairs([])).toEqual([]);
  });
});
