import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * US-18 Pick a variant (AB-143): "Use this one" makes a variant the screen's current version through the one pick
 * action, under the sketch's lock and stamp check, marked with who and when (AB-131.1). The others stay, marked Not
 * chosen, pickable again. Only after the save does the pick add its short line to the open conversation on this computer
 * (AB-143.1); an old stamp, or a pick while the AI Designer works, writes nothing and adds no line. The Designer's next
 * turn is told about the pick and starts from the picked version. Claude Code itself never starts: its run is replaced.
 */

type Answer = unknown | ((opts: RunOptions) => Promise<RunResult>);
const calls: RunOptions[] = [];
const answers: Answer[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    const next = answers.shift();
    if (typeof next === 'function') return (next as (o: RunOptions) => Promise<RunResult>)(opts);
    return { ok: true, text: '', structured: next, sessionId: opts.resume ?? 'session-1' } as RunResult;
  },
}));

const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const studio = await import('../src/board/studio.js');
const actions = await import('../src/board/studio-actions.js');
const chats = await import('../src/board/studio-chats.js');
const { screenFile, ownerChatFile } = await import('../src/board/studio-paths.js');
const { sendChatMessage } = await import('../src/engine/studio-chat.js');
const { chatJobsDone, startChatJob } = await import('../src/engine/studio-chat-runs.js');
const { mountStudioApi } = await import('../src/console/api/studio.js');
const { studioSketchPick, messageLines } = await import('../src/commands/studio.js');
const { buildPaths } = await import('../src/core/paths.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
const BOTH = ['desktop', 'mobile'];
const OWNER = { kind: 'sketch', id: 'booking' } as const;
const page = (words: string) => `<!doctype html><html><head><style>body{font-family:Inter,sans-serif;color:#0f172a}</style></head><body><h1>${words}</h1><button>Book</button></body></html>`;

/** Booking's Form screen with variants A "One page" (v1, in use) and B "Step by step" (v2), from one ask. */
function booking() {
  actions.createDesignSystem(bp, { name: 'Patient app', tokens: { colors: { ink: '#0f172a' }, font: { family: 'Inter, sans-serif' } } });
  const s = actions.createSketch(bp, { name: 'Booking', designSystem: { id: 'patient-app' }, frames: BOTH, screens: [{ name: 'Form' }] });
  studio.saveAskVariants(
    bp,
    'booking',
    { id: 'ask-1', words: 'Draw 2 variants of the Form screen' },
    [
      {
        id: 'form',
        name: 'Form',
        variants: [
          { letter: 'A', name: 'One page', idea: 'Everything on one page.', frames: { desktop: page('A wide'), mobile: page('A small') } },
          { letter: 'B', name: 'Step by step', idea: 'Day, then time, then confirm.', frames: { desktop: page('B wide'), mobile: page('B small') } },
        ],
      },
    ],
    s.stamp,
    { madeBy: studio.AI_DESIGNER, madeFor: 'Alaa' },
  );
  return actions.getSketch(bp, 'booking');
}

const form = () => actions.getSketch(bp, 'booking').screens.find((s) => s.id === 'form')!;
const conversation = (chat = 'main') => chats.readConversation(bp, OWNER, chat).messages;
const lines = (chat = 'main') => conversation(chat).filter((m) => m.role === 'action').map((m) => m.text);

/** Every file in the project's Studio folder and this computer's chats for the sketch, with its bytes. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(bp.studioDir);
  walk(path.dirname(ownerChatFile(bp, OWNER, 'main')));
  return out;
}

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-pick-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50, studio: false });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', quality: 'thrifty', user: { ...(readMeta(bp).user ?? {}), name: 'Alaa' } } as never);
});

afterEach(async () => {
  await chatJobsDone();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('done when 1: "Use this one" on B makes it the current version; A stays, Not chosen; a line goes to the chat', () => {
  it('picks B through the one action, keeps A pickable, and adds "You picked Variant B · Step by step"', () => {
    const s = booking();
    expect(form().chosen).toBe(1);
    const r = actions.pickScreenVariant(bp, 'booking', 'form', 2, s.stamp, { chat: 'main' });
    expect(form().chosen).toBe(2);
    expect(form().variants.map((v) => [v.version, v.letter, v.name])).toEqual([
      [1, 'A', 'One page'],
      [2, 'B', 'Step by step'],
    ]);
    expect(r.picked).toMatchObject({ screen: 'form', screenName: 'Form', version: 2, letter: 'B', name: 'Step by step', by: 'Alaa' });
    expect(r.line).toMatchObject({ role: 'action', text: 'You picked Variant B · Step by step' });
    expect(lines()).toEqual(['You picked Variant B · Step by step']);
    // The terminal prints it as a short line too.
    expect(messageLines(r.line!)).toContain('You picked Variant B · Step by step');
  });

  it('a pick with no conversation adds no line; picking the variant already in use writes nothing', () => {
    const s = booking();
    const was = snapshot();
    const same = actions.pickScreenVariant(bp, 'booking', 'form', 1, s.stamp, { chat: 'main' });
    expect(same).toMatchObject({ picked: null, line: null });
    expect(snapshot()).toEqual(was);
    const r = actions.pickScreenVariant(bp, 'booking', 'form', 2, s.stamp);
    expect(r.line).toBeNull();
    expect(fs.existsSync(ownerChatFile(bp, OWNER, 'main'))).toBe(false);
  });

  it('the terminal does the same: squad studio sketch pick Booking Form B', async () => {
    booking();
    await studioSketchPick(bp, null, 'Booking', 'Form', 'B', {});
    expect(form().chosen).toBe(2);
    expect(lines()).toEqual(['You picked Variant B · Step by step']);
    await expect(studioSketchPick(bp, null, 'Booking', 'Form', 'D', {})).rejects.toThrow('Form has no variant D.');
  });
});

describe('done when 2: after a reload, B is still in use, the line is still there, and the next change starts from B', () => {
  it('reading again keeps the pick and its line; the next Designer turn is told about it and draws from B', async () => {
    const s = booking();
    actions.pickScreenVariant(bp, 'booking', 'form', 2, s.stamp, { chat: 'main' });
    // A reload: everything read again from the files.
    expect(form().chosen).toBe(2);
    expect(conversation()).toEqual([expect.objectContaining({ role: 'action', text: 'You picked Variant B · Step by step', picked: expect.objectContaining({ version: 2, letter: 'B' }) })]);
    expect(chats.listConversations(bp, OWNER)[0]).toMatchObject({ id: 'main', messages: 1, first: null });

    answers.push(
      { kind: 'change', reply: 'I will make the buttons bigger.', screens: [{ id: 'form', name: 'Form', change: 'Make the buttons bigger' }] },
      { screens: [{ name: 'Form', frames: [{ frame: 'desktop', html: page('B wide, bigger') }, { frame: 'mobile', html: page('B small, bigger') }] }], note: 'Bigger buttons.' },
    );
    const r = await sendChatMessage(bp, { owner: OWNER, text: 'make the buttons bigger', lookingAt: { screen: 'form', frame: 'desktop' } });
    expect(r.reply.kind).toBe('changed');
    // The Designer was told about the pick, and its pages to start from are B's.
    expect(calls[0]!.prompt).toContain('Since your last reply, the person picked "Variant B · Step by step of Form"');
    expect(calls[0]!.prompt).not.toContain('Person: You picked');
    expect(calls[1]!.prompt).toContain('screens/form/v2/desktop.html');
    expect(calls[1]!.prompt).not.toContain('screens/form/v1/');
    // The new version is B's: same letter and name, in use; A stays.
    const now = form();
    const v3 = now.variants.find((v) => v.version === 3)!;
    expect(now.chosen).toBe(3);
    expect(v3).toMatchObject({ letter: 'B', name: 'Step by step', ask: 'ask-1' });
    expect(now.variants.map((v) => v.version)).toEqual([1, 2, 3]);
    // The line stays between the messages; after the Designer's reply, it is not told about it again.
    expect(conversation().map((m) => m.role)).toEqual(['action', 'person', 'designer']);
    answers.push({ kind: 'answer', reply: 'B is easier for older patients.' });
    await sendChatMessage(bp, { owner: OWNER, text: 'Which is easier for older patients?' });
    expect(calls[2]!.prompt).not.toContain('Since your last reply');
  });
});

describe('"Answer it" after a pick line', () => {
  it('a message left unanswered, then a pick, is still answered, and the Designer is told about the pick', async () => {
    const s = booking();
    chats.addPersonMessage(bp, OWNER, 'main', { text: 'Which one is easier for older patients?' });
    actions.pickScreenVariant(bp, 'booking', 'form', 2, s.stamp, { chat: 'main' });
    answers.push({ kind: 'answer', reply: 'B: one choice per step.' });
    const r = await sendChatMessage(bp, { owner: OWNER, chat: 'main' });
    expect(r.reply).toMatchObject({ kind: 'answer', text: 'B: one choice per step.' });
    expect(calls[0]!.prompt).toContain('Which one is easier for older patients?');
    expect(calls[0]!.prompt).toContain('the person picked "Variant B · Step by step of Form"');
    expect(conversation().map((m) => m.role)).toEqual(['person', 'action', 'designer']);
  });
});

describe('done when 3: picking A again puts A back in use and marks B Not chosen; nothing is deleted', () => {
  it('both variants stay, and a second line says "You picked Variant A · One page"', () => {
    const s = booking();
    const b = actions.pickScreenVariant(bp, 'booking', 'form', 2, s.stamp, { chat: 'main' });
    const files = Object.keys(snapshot()).filter((f) => f.includes(`${path.sep}screens${path.sep}`)).filter((f) => !f.endsWith('screen.yaml'));
    actions.pickScreenVariant(bp, 'booking', 'form', 1, b.sketch.stamp, { chat: 'main' });
    expect(form().chosen).toBe(1);
    expect(form().variants.map((v) => v.letter)).toEqual(['A', 'B']);
    expect(Object.keys(snapshot()).filter((f) => f.includes(`${path.sep}screens${path.sep}`)).filter((f) => !f.endsWith('screen.yaml'))).toEqual(files);
    expect(lines()).toEqual(['You picked Variant B · Step by step', 'You picked Variant A · One page']);
    // Both picks before the next reply are told to the Designer, in order.
    expect(chats.picksSinceReply(conversation())).toEqual(['Variant B · Step by step of Form', 'Variant A · One page of Form']);
  });
});

describe('done when 4: the pick is saved with who and when, and so is the sketch\'s "last edited"', () => {
  it('Alaa picks B at 16:10: the screen file and the line say Alaa and 16:10', () => {
    // The clock is set for both, whatever the time the test runs: the variants are drawn at 16:00, the pick at 16:10.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 19, 16, 0, 0));
    const s = booking();
    const at = new Date(2026, 10, 19, 16, 10, 0);
    vi.setSystemTime(at);
    actions.pickScreenVariant(bp, 'booking', 'form', 2, s.stamp, { chat: 'main' });
    const saved = yaml.load(fs.readFileSync(screenFile(bp, 'booking', 'form'), 'utf8')) as { chosen: number; edited: { at: string; by: string } };
    expect(saved).toMatchObject({ chosen: 2, edited: { at: at.toISOString(), by: 'Alaa' } });
    expect(actions.getSketch(bp, 'booking').lastEdit).toEqual({ at: at.toISOString(), by: 'Alaa' });
    expect(conversation()[0]!.picked).toMatchObject({ at: at.toISOString(), by: 'Alaa' });
    // The variant's own meta.yaml says nothing of the pick: no "picked by" beside the variant.
    expect(form().variants[1]).not.toHaveProperty('pickedBy');
  });
});

describe('done when 5: a teammate changed the sketch first: the pick is refused, and nothing changes', () => {
  it('an old stamp is refused with "Changed elsewhere, reload": no file and no chat line change', () => {
    const s = booking();
    // A teammate renames the sketch after this page read it.
    actions.changeSketch(bp, 'booking', { name: 'Booking visit' }, s.stamp);
    const was = snapshot();
    expect(() => actions.pickScreenVariant(bp, 'booking', 'form', 2, s.stamp, { chat: 'main' })).toThrow(studio.CHANGED_ELSEWHERE);
    expect(snapshot()).toEqual(was);
    expect(form().chosen).toBe(1);
    expect(fs.existsSync(ownerChatFile(bp, OWNER, 'main'))).toBe(false);
  });

  it('while the AI Designer works on the conversation, the pick is refused before anything is written', () => {
    const s = booking();
    const was = snapshot();
    expect(() => actions.pickScreenVariant(bp, 'booking', 'form', 2, s.stamp, { chat: 'main', busy: () => true })).toThrow(actions.StudioDesignerWorking);
    expect(snapshot()).toEqual(was);
  });

  it('a conversation that is not there is refused before the pick is saved', () => {
    const s = booking();
    expect(() => actions.pickScreenVariant(bp, 'booking', 'form', 2, s.stamp, { chat: 'talk-9' })).toThrow('This conversation is not here any more.');
    expect(form().chosen).toBe(1);
  });
});

describe('the route POST /api/v1/studio/sketches/:id/screens/:screen/pick', () => {
  function app() {
    const a = new Hono();
    mountStudioApi(a, { paths: buildPaths(tmp) });
    return async (method: string, p: string, body?: unknown) => {
      const res = await a.request(`/api/v1/studio${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, data: (await res.json()) as any };
    };
  }

  it('answers 200 with the sketch and the conversation; an old stamp is 409 "Changed elsewhere, reload"', async () => {
    booking();
    const call = app();
    const read = await call('GET', '/sketches/booking');
    const ok = await call('POST', '/sketches/booking/screens/form/pick', { version: 2, stamp: read.data.stamp, chat: 'main' });
    expect(ok.status).toBe(200);
    expect(ok.data.sketch.screens[0].chosen).toBe(2);
    expect(ok.data.picked).toMatchObject({ version: 2, letter: 'B', by: 'Alaa' });
    expect(ok.data.conversation).toMatchObject({ id: 'main', working: null, messages: [{ role: 'action', text: 'You picked Variant B · Step by step', pictures: [] }] });
    // The chat route reads the same line after a reload.
    expect((await call('GET', '/sketches/booking/chats/main')).data.messages.map((m: any) => m.text)).toEqual(['You picked Variant B · Step by step']);

    const stale = await call('POST', '/sketches/booking/screens/form/pick', { version: 1, stamp: read.data.stamp, chat: 'main' });
    expect(stale).toMatchObject({ status: 409, data: { error: 'Changed elsewhere, reload', changedElsewhere: true } });
    expect(form().chosen).toBe(2);
    expect(lines()).toHaveLength(1);
  });

  it('while the AI Designer answers in that conversation, the pick is 409 and waits', async () => {
    const s = booking();
    let finish: (r: RunResult) => void = () => undefined;
    answers.push(() => new Promise<RunResult>((r) => (finish = r)));
    startChatJob(bp, { owner: OWNER, chat: 'main', text: 'Which one is easier for older patients?' });
    const call = app();
    const busy = await call('POST', '/sketches/booking/screens/form/pick', { version: 2, stamp: s.stamp, chat: 'main' });
    expect(busy).toMatchObject({ status: 409, data: { busy: true } });
    expect(busy.data.error).toContain('still working');
    expect(form().chosen).toBe(1);
    expect(lines()).toEqual([]);
    for (let i = 0; i < 400 && !calls.length; i++) await new Promise((r) => setTimeout(r, 10));
    finish({ ok: true, text: '', structured: { kind: 'answer', reply: 'A.' }, sessionId: 'session-1' } as RunResult);
    await chatJobsDone();
  });
});
