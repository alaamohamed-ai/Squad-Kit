import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

/**
 * US-55, the design step of a ticket: right after the questions and before the spec, a ticket of a project with
 * approved Studio screens waits with "Does this ticket follow a design from the Studio?". The person ticks approved
 * screens and presses "Use these designs", or presses "No design"; the spec is written after the answer, with the
 * picked screens. It is skipped by itself when the project has no approved screen, when screens are picked already, or
 * when it was answered before. It is the only place screens are picked. The sample board's squad plays it here; the live squad's
 * plan-write step calls the same designAskDue and waitForDesign.
 */

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const studio = await import('../src/board/studio.js');
const actions = await import('../src/board/studio-actions.js');
const { createTicket } = await import('../src/board/actions/new-ticket.js');
const { scheduleSquad } = await import('../src/board/schedule.js');
const { tick } = await import('../src/board/engine.js');
const designs = await import('../src/board/ticket-designs.js');
const ask = await import('../src/board/design-ask.js');
const { mountTicketDesignsApi } = await import('../src/console/api/ticket-designs.js');
const { buildPaths } = await import('../src/core/paths.js');
const P = await import('../src/engine/prompts.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
let app: Hono;
const BOTH = ['desktop', 'mobile'];
const pages = (words: string) => ({ desktop: `<h1>${words}, wide</h1>`, mobile: `<h1>${words}, small</h1>` });

/** "Booking": Form approved at version 1, Summary still a draft. */
function booking() {
  const made = actions.createSketch(bp, { name: 'Booking', frames: BOTH, screens: [{ name: 'Form' }, { name: 'Summary' }] });
  const s = studio.saveDrawnScreens(bp, 'booking', [{ id: 'form', name: 'Form', frames: pages('Form') }, { id: 'summary', name: 'Summary', frames: pages('Summary') }], made.stamp).sketch;
  actions.approveSketchScreen(bp, 'booking', 'form', s.stamp, { chat: null });
}

/** A Full-track ticket whose questions are answered: its next step is the spec. */
function answeredTicket(track?: 'express' | 'auto') {
  const t = createTicket(bp, { title: 'Book a visit', ask: 'People book a visit online.' });
  return updateTicket(bp, t.id, (x) => {
    x.stage = 'tickets';
    x.questions = [];
    if (track) x.track = track;
    scheduleSquad(x, 'plan-write', 0, 1, 0);
    x.squad!.nextAt = new Date(Date.now() - 1000).toISOString();
  });
}

/** The sample squad takes the ticket's next step now. */
function step(id: string) {
  updateTicket(bp, id, (x) => x.squad && (x.squad.nextAt = new Date(Date.now() - 1000).toISOString()));
  tick(bp);
  return readTicket(bp, id)!;
}

const call = (p: string, body: unknown) => app.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-design-ask-')));
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

describe('the ticket waits for the design right after the questions, before the spec', () => {
  it('with approved screens, it stops with the card and writes no spec yet', () => {
    booking();
    const t = step(answeredTicket().id);
    expect(t.waiting).toEqual({ kind: 'design', summary: 'Does this ticket follow a design from the Studio?' });
    expect(t.squad).toBeNull();
    expect(t.live).toBe(false);
    expect(t.story).toBeUndefined();
    expect(t.activity[0]!.text).toBe('Asked whether it follows a design from the Studio, before the spec');
    // A step again finds it still waiting: nothing moves until the person answers.
    expect(ask.waitForDesign(bp, readTicket(bp, t.id)!)).toBe(true);
  });

  it('"Use these designs" adds the ticked screens, and the spec is written after, with them', async () => {
    booking();
    const t0 = step(answeredTicket().id);
    const r = await call(`/api/v1/tickets/${t0.id}/designs/answer`, { picks: [{ sketch: 'booking', screen: 'form' }] });
    expect(r.status).toBe(200);
    const t = readTicket(bp, t0.id)!;
    expect(t.designs!.map((d) => [d.name, d.version])).toEqual([['Booking / Form', 1]]);
    expect(t.designAsked).toMatchObject({ answer: 'designs', by: 'Alaa' });
    expect(t.waiting).toBeNull();
    expect(t.squad?.phase).toBe('plan-write');
    expect(t.activity.map((a) => a.text).slice(0, 2)).toEqual(['Chose the design to follow: Booking / Form', 'Added the design Booking / Form (version 1)']);
    // The Analyst's spec ask carries the picked screens and their files, as it resumes its talk from before the pick.
    const spec = P.specPrompt(t);
    expect(spec).toContain('The person picked an approved screen from the Studio');
    expect(spec).toContain('"Booking / Form", version 1');
    expect(spec).toContain(path.join(t.designs![0]!.dir, 'desktop.html'));
    // The sample squad goes on to the spec, and does not ask again.
    const next = step(t.id);
    expect(next.waiting?.kind).not.toBe('design');
    expect(next.status).toBe('Analyst is writing the spec');
  });

  it('"No design" goes on to the spec with no design, and is not asked again', async () => {
    booking();
    const t0 = step(answeredTicket().id);
    const r = await call(`/api/v1/tickets/${t0.id}/designs/answer`, { none: true });
    expect(r.status).toBe(200);
    const t = readTicket(bp, t0.id)!;
    expect(t.designs).toBeUndefined();
    expect(t.designAsked).toMatchObject({ answer: 'none' });
    expect(t.activity[0]!.text).toBe('Said this ticket follows no design from the Studio');
    expect(P.specPrompt(t)).not.toContain('from the Studio');
    expect(step(t.id).status).toBe('Analyst is writing the spec');
    // Kept with the ticket in ticket.md, so a teammate's squad does not ask again either.
    expect(fs.readFileSync(path.join(bp.ticketsDir, t.id, 'ticket.md'), 'utf8')).toMatch(/designAsked:\n\s+at: .+\n\s+by: Alaa\n\s+answer: none/);
  });

  it('refuses an answer with nothing ticked, and an answer when it does not wait', async () => {
    booking();
    const t = step(answeredTicket().id);
    const empty = await call(`/api/v1/tickets/${t.id}/designs/answer`, { picks: [] });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBe('Tick at least one approved screen, or press No design.');
    expect(() => ask.answerDesign(bp, t.id, {})).toThrow('Tick at least one approved screen, or press No design.');
    expect(readTicket(bp, t.id)!.waiting?.kind).toBe('design');
    ask.answerDesign(bp, t.id, { none: true });
    expect(() => ask.answerDesign(bp, t.id, { none: true })).toThrow('This ticket does not wait for a design any more.');
  });
});

describe('the step is skipped by itself', () => {
  it('when the project has no approved screen: the spec is written as today', () => {
    const made = actions.createSketch(bp, { name: 'Booking', frames: BOTH, screens: [{ name: 'Form' }] });
    studio.saveDrawnScreens(bp, 'booking', [{ id: 'form', name: 'Form', frames: pages('Form') }], made.stamp);
    const t = step(answeredTicket().id);
    expect(t.waiting).toBeNull();
    expect(t.status).toBe('Analyst is writing the spec');
    expect(t.activity.some((a) => a.text.includes('design from the Studio'))).toBe(false);
  });

  it('when it was answered before, or the ticket came with screens picked already (from a teammate, through git)', () => {
    booking();
    const picked = answeredTicket();
    designs.addTicketDesigns(bp, picked.id, [{ sketch: 'booking', screen: 'form' }]);
    expect(step(picked.id).status).toBe('Analyst is writing the spec');
    const answered = updateTicket(bp, answeredTicket().id, (x) => (x.designAsked = { at: new Date().toISOString(), answer: 'none' }));
    expect(step(answered.id).status).toBe('Analyst is writing the spec');
  });

  it('on Express and on a story that builds by itself: no one waits for a card there', () => {
    booking();
    for (const track of ['express', 'auto'] as const) expect(ask.designAskDue(bp, readTicket(bp, answeredTicket(track).id)!)).toBe(false);
    expect(ask.designAskDue(bp, readTicket(bp, answeredTicket().id)!)).toBe(true);
  });
});
