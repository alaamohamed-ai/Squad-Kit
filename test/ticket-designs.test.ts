import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { Hono } from 'hono';

/**
 * US-55 Build a ticket from approved Studio screens (AB-180.1). The design step before the spec lists the approved
 * screens of every sketch as "Sketch / Screen" and the person ticks one or more (test/design-ask.test.ts has the step
 * itself); the Story tab shows the picked ones as cards, with Remove until the build starts. Each is kept as a frozen copy of its frames at its
 * approved version in the ticket's own folder, so a later change in the Studio never changes what the ticket builds, and
 * a teammate who gets the ticket through git gets the same copy. Picking and removing stop once the build starts, and
 * picking writes nothing in the Studio. The Analyst, the Architect and the Builder get the HTML of each frame as the
 * design to follow; the plan must name each screen. A ticket with no picked screen reads as it always did.
 */

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta, ticketDir } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const studio = await import('../src/board/studio.js');
const actions = await import('../src/board/studio-actions.js');
const { createTicket } = await import('../src/board/actions/new-ticket.js');
const { waitForDesign } = await import('../src/board/design-ask.js');
const designs = await import('../src/board/ticket-designs.js');
const { mountTicketDesignsApi } = await import('../src/console/api/ticket-designs.js');
const { buildPaths } = await import('../src/core/paths.js');
const P = await import('../src/engine/prompts.js');
const { ticketContext } = await import('../src/engine/prompts/context.js');
const D = await import('../src/engine/prompts/designs.js');
const { attachmentDirs } = await import('../src/engine/live.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
let app: Hono;
const BOTH = ['desktop', 'mobile'];
const page = (words: string) => `<!doctype html><html><body><h1>${words}</h1><button>Book visit</button></body></html>`;
const pages = (words: string) => ({ desktop: page(`${words}, wide`), mobile: page(`${words}, small`) });

/** "Booking": Form approved at version 2, Summary still a draft. */
function booking() {
  const made = actions.createSketch(bp, { name: 'Booking', frames: BOTH, screens: [{ name: 'Form' }, { name: 'Summary' }] });
  let s = studio.saveDrawnScreens(bp, 'booking', [{ id: 'form', name: 'Form', frames: pages('Form v1') }, { id: 'summary', name: 'Summary', frames: pages('Summary v1') }], made.stamp).sketch;
  s = studio.addVariant(bp, 'booking', 'form', { frames: pages('Form v2'), choose: true }, s.stamp);
  actions.approveSketchScreen(bp, 'booking', 'form', s.stamp, { chat: null });
}

/** Every file in the project's Studio folder, with its bytes. */
function studioFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(bp.studioDir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(bp.studioDir);
  return out;
}

const call = (p: string, method = 'GET', body?: unknown) => app.request(p, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ticket = () => createTicket(bp, { title: 'Book a visit', ask: 'People book a visit online.' });
/** A ticket at its design step, before the spec: its card waits for the person's ticks. */
const atDesignStep = () => updateTicket(bp, ticket().id, (x) => void waitForDesign(bp, x));
const answer = (id: string, body: unknown) => call(`/api/v1/tickets/${id}/designs/answer`, 'POST', body);

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-ticket-designs-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50, studio: false });
  writeMeta(bp, { ...readMeta(bp), user: { ...(readMeta(bp).user ?? {}), name: 'Alaa' } } as never);
  app = new Hono();
  mountTicketDesignsApi(app, { paths: buildPaths(tmp) });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('done when 1: the design step lists approved screens only, and a pick shows on the Story tab', () => {
  it('lists "Booking / Form" with its frames and no "Booking / Summary"', async () => {
    booking();
    const t = ticket();
    const r = await call(`/api/v1/tickets/${t.id}/designs/approved`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { locked: boolean; screens: { name: string; version: number; frames: string[]; html: Record<string, string>; picked: boolean }[] };
    expect(body.locked).toBe(false);
    expect(body.screens.map((s) => s.name)).toEqual(['Booking / Form']);
    expect(body.screens[0]).toMatchObject({ version: 2, frames: ['desktop', 'mobile'], picked: false });
    // The small picture is drawn from the approved version's own page.
    expect(body.screens[0]!.html.desktop).toContain('Form v2, wide');
  });

  it('a ticked screen shows on the ticket with its picture and frames, and can be removed', async () => {
    booking();
    const t = atDesignStep();
    expect(t.waiting?.kind).toBe('design');
    const before = studioFiles();
    const added = await answer(t.id, { picks: [{ sketch: 'booking', screen: 'form' }] });
    expect(added.status).toBe(200);
    const row = (await added.json()) as { locked: boolean; designs: { name: string; version: number; frames: string[]; html: Record<string, string> }[] };
    expect(row.designs).toHaveLength(1);
    expect(row.designs[0]).toMatchObject({ name: 'Booking / Form', version: 2, frames: ['desktop', 'mobile'] });
    expect(row.designs[0]!.html.mobile).toContain('Form v2, small');
    expect(readTicket(bp, t.id)!.activity[1]!.text).toBe('Added the design Booking / Form (version 2)');
    // Picking reads the Studio and writes nothing there (AB-127.1).
    expect(studioFiles()).toEqual(before);
    // It is ticked in the list now.
    const listed = (await (await call(`/api/v1/tickets/${t.id}/designs/approved`)).json()) as { screens: { picked: boolean }[] };
    expect(listed.screens[0]!.picked).toBe(true);
    // Remove takes it off, with its copy.
    const dir = readTicket(bp, t.id)!.designs![0]!.dir;
    const gone = await call(`/api/v1/tickets/${t.id}/designs/booking/form`, 'DELETE');
    expect(gone.status).toBe(200);
    expect(((await gone.json()) as { designs: unknown[] }).designs).toEqual([]);
    expect(readTicket(bp, t.id)!.designs).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
    expect(readTicket(bp, t.id)!.activity[0]!.text).toBe('Removed the design Booking / Form');
  });

  it('refuses a screen that is not approved, and a screen picked twice', async () => {
    booking();
    const t = atDesignStep();
    const r = await answer(t.id, { picks: [{ sketch: 'booking', screen: 'summary' }] });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe('Booking / Summary is not approved, so it cannot be built yet. Approve it in the Studio first.');
    // Refused with nothing written: the card still waits.
    expect(readTicket(bp, t.id)!.waiting?.kind).toBe('design');
    expect(readTicket(bp, t.id)!.designs).toBeUndefined();
    designs.addTicketDesigns(bp, t.id, [{ sketch: 'booking', screen: 'form' }]);
    expect(() => designs.addTicketDesigns(bp, t.id, [{ sketch: 'booking', screen: 'form' }])).toThrow('Booking / Form is on this ticket already.');
    expect(readTicket(bp, t.id)!.designs).toHaveLength(1);
  });

  it('the Story tab has no picker of its own: screens are added only through the design step', async () => {
    booking();
    const t = ticket();
    const r = await call(`/api/v1/tickets/${t.id}/designs`, 'POST', { picks: [{ sketch: 'booking', screen: 'form' }] });
    expect(r.status).toBe(404);
    // Answering when no design step waits is refused too.
    const late = await answer(t.id, { picks: [{ sketch: 'booking', screen: 'form' }] });
    expect(late.status).toBe(400);
    expect(readTicket(bp, t.id)!.designs).toBeUndefined();
  });

  it('once the build has started, picking and removing are refused and the board hides Remove', async () => {
    booking();
    const t = ticket();
    designs.addTicketDesigns(bp, t.id, [{ sketch: 'booking', screen: 'form' }]);
    updateTicket(bp, t.id, (x) => {
      x.stage = 'implement';
      x.sessions = { ...x.sessions, build: 'build-1' };
    });
    const row = (await (await call(`/api/v1/tickets/${t.id}/designs`)).json()) as { locked: boolean };
    expect(row.locked).toBe(true);
    expect(() => designs.addTicketDesigns(bp, t.id, [{ sketch: 'booking', screen: 'form' }])).toThrow(designs.DESIGNS_LOCKED);
    const remove = await call(`/api/v1/tickets/${t.id}/designs/booking/form`, 'DELETE');
    expect(remove.status).toBe(400);
    expect(readTicket(bp, t.id)!.designs).toHaveLength(1);
    // The build started on this computer only (its session) also locks it, before the stage moves.
    const u = ticket();
    updateTicket(bp, u.id, (x) => (x.sessions = { ...x.sessions, build: 'build-2' }));
    expect(() => designs.addTicketDesigns(bp, u.id, [{ sketch: 'booking', screen: 'form' }])).toThrow(designs.DESIGNS_LOCKED);
  });
});

describe('done when 2: the ticket keeps version 2 when the Studio approves version 3', () => {
  it('still shows and builds version 2, and a teammate who gets the ticket through git sees version 2', async () => {
    booking();
    const t = ticket();
    designs.addTicketDesigns(bp, t.id, [{ sketch: 'booking', screen: 'form' }], { by: 'Alaa' });
    // Someone reopens Form, changes it and approves it again as version 3.
    let s = actions.getSketch(bp, 'booking');
    s = actions.reopenSketchScreen(bp, 'booking', 'form', s.stamp, { chat: null }).sketch as never;
    s = actions.getSketch(bp, 'booking');
    const v3 = studio.addVariant(bp, 'booking', 'form', { frames: pages('Form v3'), choose: true }, s.stamp);
    actions.approveSketchScreen(bp, 'booking', 'form', v3.stamp, { chat: null });
    expect(actions.getSketch(bp, 'booking').screens.find((x) => x.id === 'form')!.approved?.version).toBe(3);

    const kept = readTicket(bp, t.id)!.designs![0]!;
    expect(kept).toMatchObject({ name: 'Booking / Form', version: 2, addedBy: 'Alaa' });
    expect(designs.readDesignFrame(kept, 'desktop')).toContain('Form v2, wide');
    const row = (await (await call(`/api/v1/tickets/${t.id}/designs`)).json()) as { designs: { version: number; html: Record<string, string> }[] };
    expect(row.designs[0]!.version).toBe(2);
    expect(row.designs[0]!.html.desktop).toContain('Form v2, wide');
    expect(row.designs[0]!.html.desktop).not.toContain('Form v3');
    // The squad is given version 2 too.
    expect(ticketContext(readTicket(bp, t.id)!)).toContain(path.join(ticketDir(bp, t.id), 'designs', 'booking', 'form', 'v2', 'desktop.html'));

    // Saved with the ticket: ticket.md keeps the list, with the copy inside the ticket's own folder.
    const head = fs.readFileSync(path.join(ticketDir(bp, t.id), 'ticket.md'), 'utf8').split('---')[1]!;
    const saved = (yaml.load(head) as { designs: { dir: string; version: number }[] }).designs;
    expect(saved).toEqual([expect.objectContaining({ dir: 'designs/booking/form/v2', version: 2 })]);

    // A teammate's board gets the ticket's folder through git: the same version 2, with no note.
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-ticket-designs-mate-')));
    try {
      const mate = boardPaths(path.join(other, '.squad'));
      seedDemoBoard(mate, { speed: 50, studio: false });
      fs.cpSync(ticketDir(bp, t.id), ticketDir(mate, t.id), { recursive: true });
      const theirs = readTicket(mate, t.id)!.designs![0]!;
      expect(theirs).toMatchObject({ name: 'Booking / Form', version: 2, frames: ['desktop', 'mobile'] });
      expect(theirs.dir.startsWith(ticketDir(mate, t.id))).toBe(true);
      expect(designs.readDesignFrame(theirs, 'mobile')).toContain('Form v2, small');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('done when 3: the Analyst, the Architect and the Builder are given the HTML of each frame', () => {
  it('each step\'s text names "Booking / Form", its version and the path of each frame, with the rule to match it', () => {
    booking();
    const t0 = ticket();
    designs.addTicketDesigns(bp, t0.id, [{ sketch: 'booking', screen: 'form' }]);
    const t = readTicket(bp, t0.id)!;
    const desktop = path.join(t.designs![0]!.dir, 'desktop.html');
    const mobile = path.join(t.designs![0]!.dir, 'mobile.html');
    const meta = readMeta(bp);
    const analyst = P.intakePrompt(meta, [], t);
    const builder = P.buildPrompt(meta, [], t);
    for (const text of [analyst, builder]) {
      expect(text).toContain('Designs from the Studio to build');
      expect(text).toContain('"Booking / Form", version 2');
      expect(text).toContain(`Desktop: ${desktop}`);
      expect(text).toContain(`Mobile: ${mobile}`);
      expect(text).toContain('keep the app\'s own one');
      expect(text).toContain('stays right to left');
    }
    // The Architect's plan, whichever way it is written, must name the screen and the page it becomes.
    for (const plan of [P.planPrompt(t), P.designPrompt({ ...t, story: 'As a visitor…' })]) {
      expect(plan).toContain('Name each one in the step that builds it');
      expect(plan).toContain('"Booking / Form"');
      expect(plan).toContain(desktop);
    }
    // Each step may read the ticket's design folder.
    expect(attachmentDirs(t)).toContain(t.designs![0]!.dir);
  });

  it('the plan check asks again when a step does not name the screen', () => {
    booking();
    const t0 = ticket();
    designs.addTicketDesigns(bp, t0.id, [{ sketch: 'booking', screen: 'form' }]);
    const t = readTicket(bp, t0.id)!;
    expect(D.designsPlanProblem(t, { steps: ['Add a booking page'] })).toContain('"Booking / Form" is not named');
    expect(D.designsPlanProblem(t, { steps: ['Build "booking / form " as the page /book, matching its Desktop and Mobile design'] })).toBeNull();
  });

  it('the Tester is asked for one picture of the page per frame, at that frame\'s size, after the change only', () => {
    booking();
    const t0 = ticket();
    designs.addTicketDesigns(bp, t0.id, [{ sketch: 'booking', screen: 'form' }]);
    const t = { ...readTicket(bp, t0.id)!, criteria: [{ given: 'a visitor', when: 'they open Book', then: 'they see the form' }] } as never;
    const after = P.proofPrompt(readMeta(bp), t, 'after');
    expect(after).toContain('"Booking / Form": Desktop at size "desktop", Mobile at size "phone"');
    expect(after).toContain('name it in designs');
    expect(P.proofPrompt(readMeta(bp), t, 'before')).not.toContain('Designs from the Studio');
    expect((D.proofSchemaFor(t, P.PROOF_SCHEMA).properties as Record<string, unknown>).designs).toBeDefined();
  });
});

describe('done when 5: a ticket with no picked screen works as it does today', () => {
  it('gives no design to any step, and no design ask to the plan or the Tester', async () => {
    const t = { ...ticket(), criteria: [{ given: 'a visitor', when: 'they open Book', then: 'they see the form' }] } as never as ReturnType<typeof ticket>;
    const meta = readMeta(bp);
    for (const text of [ticketContext(t), P.intakePrompt(meta, [], t), P.buildPrompt(meta, [], t), P.planPrompt(t), P.proofPrompt(meta, t, 'after')]) {
      expect(text).not.toContain('Designs from the Studio');
      expect(text).not.toContain('designs:');
    }
    expect(D.designsPlanProblem(t, { steps: ['Anything'] })).toBeNull();
    expect(D.proofSchemaFor(t, P.PROOF_SCHEMA)).toBe(P.PROOF_SCHEMA);
    expect(attachmentDirs(t)).toEqual([]);
    expect(t.designs).toBeUndefined();
    // Its file has no designs, and the board's section is empty.
    expect(fs.readFileSync(path.join(ticketDir(bp, t.id), 'ticket.md'), 'utf8')).not.toContain('designs');
    const row = (await (await call(`/api/v1/tickets/${t.id}/designs`)).json()) as { designs: unknown[]; locked: boolean };
    expect(row).toEqual({ locked: false, designs: [] });
  });
});
