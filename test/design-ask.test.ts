import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * US-55 and US-56, the design step of a ticket: before the Analyst reads a new ticket, a ticket of a project with
 * approved Studio screens waits with "Does this ticket follow a design from the Studio?". The person ticks approved
 * screens and presses "Use these designs", or presses "No design"; the Analyst then reads the ticket, with the picked
 * screens, and asks only what they do not show; the spec and the plan use the same screens. A ticket made before
 * US-56, already past its questions, gets the card once before the spec instead (AB-181.1). It is skipped by itself
 * when the project has no approved screen, when screens are picked already, when it was answered before, and on
 * Express and a story that builds by itself. The sample board's squad and the live squad both play it here.
 */

// The live squad's AI calls: each one is kept, and answered from `answers` in order.
const calls: RunOptions[] = [];
const answers: unknown[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: answers.shift(), sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

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
const { LiveSquad } = await import('../src/engine/live.js');

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

/** A new ticket, as the person makes it: the Analyst's first read is its next step. */
function newTicket(track?: 'express' | 'auto') {
  const t = createTicket(bp, { title: 'Book a visit', ask: 'People book a visit online, with their name and phone.' });
  return updateTicket(bp, t.id, (x) => {
    if (track) x.track = track;
    scheduleSquad(x, 'analyst-read', 0, 1, 0);
  });
}

/** A ticket made before US-56 whose questions are answered and whose card has not shown: its next step is the spec. */
function answeredTicket(track?: 'express' | 'auto') {
  const t = createTicket(bp, { title: 'Book a visit', ask: 'People book a visit online.' });
  return updateTicket(bp, t.id, (x) => {
    x.stage = 'tickets';
    x.questions = [];
    if (track) x.track = track;
    scheduleSquad(x, 'plan-write', 0, 1, 0);
  });
}

/** The sample squad takes the ticket's next step now. */
function step(id: string) {
  updateTicket(bp, id, (x) => x.squad && (x.squad.nextAt = new Date(Date.now() - 1000).toISOString()));
  tick(bp);
  return readTicket(bp, id)!;
}

const call = (p: string, body: unknown) => app.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const FORM = [{ sketch: 'booking', screen: 'form' }];
const RULE = 'Ask only about what the screens do not show';
const CLASH = 'ask a "clash" question';

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
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

describe('a new ticket waits for the design before the Analyst reads it (US-56)', () => {
  it('with approved screens, the card shows first: the Analyst has not read the ticket or asked anything', () => {
    booking();
    const t = step(newTicket().id);
    expect(t.waiting).toEqual({ kind: 'design', summary: 'Does this ticket follow a design from the Studio?', before: 'read' });
    expect(t.status).toBe('Waiting for you: a design from the Studio?');
    expect(t.squad).toBeNull();
    expect(t.live).toBe(false);
    expect(t.questions).toBeUndefined();
    expect(t.activity[0]!.text).toBe('Asked whether it follows a design from the Studio, before the questions');
    expect(t.activity.some((a) => a.who === 'analyst')).toBe(false);
    // A step again finds it still waiting: nothing moves until the person answers.
    expect(ask.waitForDesign(bp, readTicket(bp, t.id)!, 'read')).toBe(true);
    expect(step(t.id).activity.some((a) => a.who === 'analyst')).toBe(false);
  });

  it('"Use these designs": the Analyst reads the ticket with the screen, asks only what it does not show, and the spec and plan use it', async () => {
    booking();
    const t0 = step(newTicket().id);
    const r = await call(`/api/v1/tickets/${t0.id}/designs/answer`, { picks: FORM });
    expect(r.status).toBe(200);
    let t = readTicket(bp, t0.id)!;
    expect(t.designs!.map((d) => [d.name, d.version])).toEqual([['Booking / Form', 1]]);
    expect(t.designAsked).toMatchObject({ answer: 'designs', by: 'Alaa' });
    expect(t.waiting).toBeNull();
    expect(t.squad).toMatchObject({ phase: 'analyst-read', index: 0 });
    expect(t.status).toBe('Analyst is reading the ticket');
    // The questions ask reads the screen and its page, and asks only what it does not show, with a clash for a disagreement.
    const intake = P.intakePrompt(readMeta(bp), [], t);
    expect(intake).toContain('"Booking / Form", version 1');
    expect(intake).toContain(path.join(t.designs![0]!.dir, 'desktop.html'));
    expect(intake).toContain(RULE);
    expect(intake).toContain(CLASH);
    expect(intake).toContain('The ticket asks for a phone field, but Booking / Form has none: which one is right?');
    // The spec and the plan list the same screen.
    expect(P.specPrompt(t)).toContain('"Booking / Form", version 1');
    expect(P.planPrompt(t)).toContain('"Booking / Form", version 1');
    // The sample Analyst reads the ticket next, and the card does not show again.
    t = step(t.id);
    expect(t.waiting?.kind).not.toBe('design');
    expect(t.activity[0]!.who).toBe('analyst');
  });

  it('"No design": the Analyst reads the ticket and asks as today, with no design', async () => {
    booking();
    const t0 = step(newTicket().id);
    const r = await call(`/api/v1/tickets/${t0.id}/designs/answer`, { none: true });
    expect(r.status).toBe(200);
    const t = readTicket(bp, t0.id)!;
    expect(t.designs).toBeUndefined();
    expect(t.designAsked).toMatchObject({ answer: 'none' });
    expect(t.activity[0]!.text).toBe('Said this ticket follows no design from the Studio');
    expect(t.squad?.phase).toBe('analyst-read');
    expect(P.intakePrompt(readMeta(bp), [], t)).not.toContain('from the Studio');
    expect(P.specPrompt(t)).not.toContain('from the Studio');
    const next = step(t.id);
    expect(next.activity[0]!.who).toBe('analyst');
    expect(next.waiting?.kind).not.toBe('design');
    // Kept with the ticket in ticket.md, so a teammate's squad does not ask again either.
    expect(fs.readFileSync(path.join(bp.ticketsDir, t.id, 'ticket.md'), 'utf8')).toMatch(/designAsked:\n\s+at: .+\n\s+by: Alaa\n\s+answer: none/);
  });

  it('refuses an answer with nothing ticked, and an answer when it does not wait', async () => {
    booking();
    const t = step(newTicket().id);
    const empty = await call(`/api/v1/tickets/${t.id}/designs/answer`, { picks: [] });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBe('Tick at least one approved screen, or press No design.');
    expect(() => ask.answerDesign(bp, t.id, {})).toThrow('Tick at least one approved screen, or press No design.');
    expect(readTicket(bp, t.id)!.waiting?.kind).toBe('design');
    ask.answerDesign(bp, t.id, { none: true });
    expect(() => ask.answerDesign(bp, t.id, { none: true })).toThrow('This ticket does not wait for a design any more.');
  });

  it('a ticket that answered the card is never asked again, before the questions or before the spec', () => {
    booking();
    const t0 = step(newTicket().id);
    ask.answerDesign(bp, t0.id, { none: true });
    const t = readTicket(bp, t0.id)!;
    expect(ask.designAskDue(bp, t)).toBe(false);
    expect(ask.waitForDesign(bp, t, 'read')).toBe(false);
    expect(ask.waitForDesign(bp, t, 'spec')).toBe(false);
  });
});

describe('the step is skipped by itself', () => {
  /** The sample Analyst starts on the ticket as today: its first line, with no card. */
  const startsAsToday = (t: ReturnType<typeof step>) => {
    expect(t.waiting?.kind).not.toBe('design');
    expect(t.activity.some((a) => a.text.includes('design from the Studio'))).toBe(false);
  };

  it('when the project has no approved screen', () => {
    const made = actions.createSketch(bp, { name: 'Booking', frames: BOTH, screens: [{ name: 'Form' }] });
    studio.saveDrawnScreens(bp, 'booking', [{ id: 'form', name: 'Form', frames: pages('Form') }], made.stamp);
    const t = step(newTicket().id);
    startsAsToday(t);
    expect(t.activity[0]!.who).toBe('analyst');
    const old = step(answeredTicket().id);
    startsAsToday(old);
    expect(old.status).toBe('Analyst is writing the spec');
  });

  it('when it was answered before, or the ticket came with screens picked already (from a teammate, through git)', () => {
    booking();
    const picked = newTicket();
    designs.addTicketDesigns(bp, picked.id, FORM);
    expect(step(picked.id).activity[0]!.who).toBe('analyst');
    const answered = updateTicket(bp, newTicket().id, (x) => (x.designAsked = { at: new Date().toISOString(), answer: 'none' }));
    startsAsToday(step(answered.id));
    expect(readTicket(bp, answered.id)!.activity[0]!.who).toBe('analyst');
  });

  it('on Express and on a story that builds by itself: no one waits for a card there', () => {
    booking();
    for (const track of ['express', 'auto'] as const) {
      const t = newTicket(track);
      expect(ask.designAskDue(bp, readTicket(bp, t.id)!)).toBe(false);
      const next = step(t.id);
      startsAsToday(next);
      expect(next.squad?.phase).toBe('plan-write');
    }
    expect(ask.designAskDue(bp, readTicket(bp, newTicket().id)!)).toBe(true);
  });
});

describe('a ticket made before this change, already past its questions', () => {
  it('gets the card once, before the spec, and the spec is written after the answer', () => {
    booking();
    const t0 = readTicket(bp, answeredTicket().id)!;
    // Past its questions, it moves on toward its spec: the card shows there, and the answer goes on to the spec.
    const t = step(t0.id);
    expect(t.waiting).toEqual({ kind: 'design', summary: 'Does this ticket follow a design from the Studio?' });
    expect(ask.designBeforeRead(t)).toBe(false);
    expect(t.story).toBeUndefined();
    expect(t.activity[0]!.text).toBe('Asked whether it follows a design from the Studio, before the spec');
    const after = ask.answerDesign(bp, t.id, { picks: FORM });
    expect(after.squad?.phase).toBe('plan-write');
    expect(after.status).toBe('Analyst is writing the spec');
    expect(P.specPrompt(after)).toContain('The person picked an approved screen from the Studio');
    const next = step(t.id);
    expect(next.waiting?.kind).not.toBe('design');
    expect(next.status).toBe('Analyst is writing the spec');
  });

  it('a ticket past its spec, or one that answered the card, is not asked again', () => {
    booking();
    const pastSpec = updateTicket(bp, answeredTicket().id, (x) => (x.story = 'As a visitor, I book a visit.'));
    expect(ask.designAskDue(bp, pastSpec)).toBe(false);
    const approved = updateTicket(bp, answeredTicket().id, (x) => (x.specApproved = { at: new Date().toISOString(), by: 'Alaa' } as never));
    expect(ask.designAskDue(bp, approved)).toBe(false);
    const answered = updateTicket(bp, answeredTicket().id, (x) => (x.designAsked = { at: new Date().toISOString(), answer: 'designs' }));
    expect(step(answered.id).status).toBe('Analyst is writing the spec');
  });
});

describe('the live squad plays the same step', () => {
  type Steps = { step(id: string, phase: string): Promise<void> };
  const QUESTIONS = { summary: 'People book a visit online.', questions: [{ from: 'analyst', kind: 'clash', text: 'The ticket asks for a phone field, but Booking / Form has none: which one is right?', options: ['The ticket', 'The screen'] }] };
  const live = () => {
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' } as never);
    return new LiveSquad(bp) as unknown as Steps;
  };

  it('waits on the card before the Analyst runs, then reads the ticket with the screens and the rule', async () => {
    booking();
    const squad = live();
    const t0 = newTicket();
    await squad.step(t0.id, 'analyst-read');
    expect(calls).toEqual([]);
    expect(readTicket(bp, t0.id)!.waiting).toMatchObject({ kind: 'design', before: 'read' });
    expect(readTicket(bp, t0.id)!.activity[0]!.text).toBe('Asked whether it follows a design from the Studio, before the questions');
    const t = ask.answerDesign(bp, t0.id, { picks: FORM });
    expect(t.squad?.phase).toBe('analyst-read');
    answers.push(QUESTIONS);
    await squad.step(t.id, 'analyst-read');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain('"Booking / Form", version 1');
    expect(calls[0]!.prompt).toContain(RULE);
    expect(calls[0]!.addDirs).toContain(readTicket(bp, t.id)!.designs![0]!.dir);
    expect(readTicket(bp, t.id)!.waiting?.kind).toBe('questions');
  });

  it('"No design" reads the ticket as today, with neither the screens nor the rule', async () => {
    booking();
    const squad = live();
    const t0 = newTicket();
    await squad.step(t0.id, 'analyst-read');
    ask.answerDesign(bp, t0.id, { none: true });
    answers.push({ summary: 'People book a visit online.', questions: [] });
    await squad.step(t0.id, 'analyst-read');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).not.toContain('from the Studio');
    expect(calls[0]!.prompt).not.toContain(RULE);
  });

  it('with no approved screen, the Analyst reads the ticket at once', async () => {
    const squad = live();
    const t0 = newTicket();
    answers.push({ summary: 'People book a visit online.', questions: [] });
    await squad.step(t0.id, 'analyst-read');
    expect(calls).toHaveLength(1);
    expect(readTicket(bp, t0.id)!.waiting?.kind).not.toBe('design');
  });

  it('an older ticket past its questions gets the card before the spec, and goes on to the spec after', async () => {
    booking();
    const squad = live();
    const t0 = answeredTicket();
    await squad.step(t0.id, 'plan-write');
    expect(calls).toEqual([]);
    expect(readTicket(bp, t0.id)!.activity[0]!.text).toBe('Asked whether it follows a design from the Studio, before the spec');
    expect(ask.answerDesign(bp, t0.id, { none: true }).squad?.phase).toBe('plan-write');
  });
});
