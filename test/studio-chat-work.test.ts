import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * US-57 Show the work while the AI Designer draws (AB-182.1): while it works, the running answer keeps its steps
 * ("Read your message", "Planned 2 variants", "Drawing variant B: Form", "Saving"), in the language of the message, and
 * one frame per variant or screen with each finished drawing, in memory, before the one save at the end; the project
 * stays untouched until then. The reply keeps its steps and time. A refused save goes through anyway when the teammate
 * changed other things; when they changed the same screen, the drawings are kept "Not saved" with the chat on this
 * computer, and "Save them anyway" saves them as a new version on top. Claude Code itself never starts here.
 */

type Answer = unknown | ((opts: RunOptions) => Promise<RunResult>);
const answers: Answer[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    const next = answers.shift();
    if (typeof next === 'function') return (next as (o: RunOptions) => Promise<RunResult>)(opts);
    return { ok: true, text: '', structured: next, sessionId: opts.resume ?? 'session-1' } as RunResult;
  },
}));

const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const studio = await import('../src/board/studio.js');
const actions = await import('../src/board/studio-actions.js');
const { readConversation } = await import('../src/board/studio-chats.js');
const { ownerChatUnsavedFile } = await import('../src/board/studio-paths.js');
const { readUnsaved } = await import('../src/board/studio-unsaved.js');
const { sendChatMessage } = await import('../src/engine/studio-chat.js');
const { ChatProgress } = await import('../src/engine/studio-chat-progress.js');
const { saveUnsaved } = await import('../src/engine/studio-chat-save.js');
const { CHAT_WORDS } = await import('../src/engine/studio-chat-words.js');
const { DEMO_SCREEN_MS } = await import('../src/engine/studio-chat-demo.js');
const { chatJobsDone } = await import('../src/engine/studio-chat-runs.js');
const { mountStudioApi } = await import('../src/console/api/studio.js');
const { buildPaths } = await import('../src/core/paths.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
let sampleEngine: unknown;
const BOTH = ['desktop', 'mobile'];
const OWNER = { kind: 'sketch' as const, id: 'booking' };
const page = (words: string) => `<!doctype html><html><head><style>body{font-family:Inter,sans-serif;color:#0f172a}</style></head><body><h1>${words}</h1><button>Book</button></body></html>`;
const variant = (name: string) => ({ screens: [{ name: 'Form', frames: [{ frame: 'desktop', html: page(`${name}, wide`) }, { frame: 'mobile', html: page(`${name}, small`) }] }], note: '', variantName: name, idea: `${name} idea.` });
const askFor = (n: number, screens = [{ id: 'form', name: 'Form' }]) => ({ kind: 'change', reply: 'I will draw the variants, one at a time.', variants: n, screens: screens.map((s) => ({ ...s, change: 'Draw variants of it' })) });
/** An answer given after `before` runs, as if the teammate did it while the Designer drew. */
const after = (before: () => void, value: unknown) => async (opts: RunOptions): Promise<RunResult> => {
  before();
  return { ok: true, text: '', structured: value, sessionId: opts.resume ?? 'session-1' } as RunResult;
};
const noPlace = async () => () => undefined;
/** A place that is busy first: it says why it waits, then is taken. */
const busyPlace = async (o: { onWait?: (words: string) => void }) => {
  o.onWait?.('Next in line: the Designer starts when a place is free (2 of 2 busy).');
  return () => undefined;
};

function booking() {
  actions.createDesignSystem(bp, { name: 'Patient app', tokens: { colors: { primary: '#1f6fb2', ink: '#0f172a' } } });
  const s = actions.createSketch(bp, { name: 'Booking', designSystem: { id: 'patient-app' }, frames: BOTH, screens: [{ name: 'Form' }, { name: 'Confirmation' }] });
  return studio.saveDrawnScreens(bp, 'booking', [{ id: 'confirmation', name: 'Confirmation', frames: { desktop: page('Done'), mobile: page('Done, small') } }], s.stamp).sketch;
}
const stampNow = () => studio.readSketch(bp, 'booking')!.stamp;
const form = () => studio.readSketch(bp, 'booking')!.screens.find((s) => s.id === 'form')!;

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${rel}/${e.name}`);
      else out[`${rel}/${e.name}`] = fs.readFileSync(path.join(d, e.name), 'utf8');
    }
  };
  walk(bp.studioDir, 'studio');
  return out;
}

const send = (text: string, o: Parameters<typeof sendChatMessage>[2] = {}) => sendChatMessage(bp, { owner: OWNER, text, lookingAt: { screen: 'form', frame: 'desktop' } }, { place: noPlace, ...o });

beforeEach(() => {
  answers.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-work-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50, studio: false });
  sampleEngine = readMeta(bp).engine;
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', quality: 'thrifty', user: { ...(readMeta(bp).user ?? {}), name: 'Sara' } } as never);
});
afterEach(async () => {
  await chatJobsDone();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('done when 1: the steps of the work, with the time so far, folded under the reply when it is done', () => {
  it('a wait for a free place, reading, the plan, each variant and the save, in order, done, moving and waiting', async () => {
    booking();
    const progress = new ChatProgress('English');
    let during: ReturnType<typeof progress.view> | null = null;
    answers.push(askFor(2), variant('One page'), after(() => (during = progress.view()), variant('Step by step')));
    const r = await send('Draw 2 variants of the Form screen', { place: busyPlace, progress });
    expect(during!.steps.map((s) => [s.words, s.state])).toEqual([
      ['Waited for a free place', 'done'],
      ['Read your message', 'done'],
      ['Planned 2 variants', 'done'],
      ['Drew variant A: Form', 'done'],
      ['Drawing variant B: Form', 'now'],
      ['Saving', 'next'],
    ]);
    expect(during!.steps[0]!.detail).toBe('Next in line: the Designer starts when a place is free (2 of 2 busy).');
    expect(Date.parse(during!.since)).not.toBeNaN();
    // The reply keeps its steps and its time: the board folds them into "6 steps, 2 min".
    expect(r.reply.kind).toBe('changed');
    expect(r.reply.steps?.map((s) => [s.words, s.state])).toEqual([
      ['Waited for a free place', 'done'],
      ['Read your message', 'done'],
      ['Planned 2 variants', 'done'],
      ['Drew variant A: Form', 'done'],
      ['Drew variant B: Form', 'done'],
      ['Saved', 'done'],
    ]);
    expect(typeof r.reply.took).toBe('number');
    // Kept with the chat on this computer, so the folded line stays after a reload.
    const kept = readConversation(bp, OWNER, 'main').messages.at(-1)!;
    expect(kept.steps).toHaveLength(6);
    expect(kept.took).toBe(r.reply.took);
  });

  it('the steps of an Arabic message are in Arabic, with no English reason for the wait', async () => {
    booking();
    const progress = new ChatProgress('Arabic');
    let during: ReturnType<typeof progress.view> | null = null;
    answers.push({ ...askFor(2), reply: 'سأرسم نسختين.' }, variant('One page'), after(() => (during = progress.view()), variant('Step by step')));
    const r = await send('ارسم نسختين من شاشة النموذج', { place: busyPlace, progress });
    expect(during!.language).toBe('Arabic');
    expect(during!.steps.map((s) => s.words)).toEqual(['انتظرت مكانًا متاحًا', 'قرأت رسالتك', 'خطّطت لعدد 2 من النسخ', 'رسمت النسخة A من "Form"', 'أرسم النسخة B من "Form"', 'أحفظ']);
    expect(during!.steps[0]!.detail).toBeUndefined();
    expect(r.reply.steps?.at(-1)?.words).toBe('حفظت');
  });

  it('a question keeps no steps: it is only read and answered', async () => {
    booking();
    answers.push({ kind: 'answer', reply: 'Blue is calm.' });
    const r = await send('Why blue?');
    expect(r.reply.kind).toBe('answer');
    expect(r.reply.steps).toBeUndefined();
  });

  it('the sample Designer waits for its one place in a project, and says so as its own step', async () => {
    booking();
    actions.createSketch(bp, { name: 'Checkout', designSystem: { id: 'patient-app' }, frames: BOTH, screens: [{ name: 'Payment' }] });
    writeMeta(bp, { ...readMeta(bp), engine: sampleEngine } as never);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = new ChatProgress('English');
    const second = new ChatProgress('English');
    const one = sendChatMessage(bp, { owner: OWNER, text: 'Why blue?' }, { progress: first });
    const two = sendChatMessage(bp, { owner: { kind: 'sketch', id: 'checkout' }, text: 'Why blue?' }, { progress: second });
    await vi.advanceTimersByTimeAsync(100);
    expect(second.view().steps.map((s) => [s.words, s.state])).toEqual([
      ['Waiting for a free place', 'now'],
      ['Reading your message', 'next'],
    ]);
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([one, two]);
    expect(second.view().steps.map((s) => [s.words, s.state])).toEqual([
      ['Waited for a free place', 'done'],
      ['Read your message', 'done'],
    ]);
  });
});

describe('done when 2: a frame per variant at once, each drawing before the save; Stop; a refused save', () => {
  it('frames A, B and C show at once; A is drawn before the save, and the project is untouched until then', async () => {
    booking();
    const before = snapshot();
    const progress = new ChatProgress('English');
    let during: ReturnType<typeof progress.view> | null = null;
    let files: Record<string, string> = {};
    answers.push(
      askFor(3),
      variant('One page'),
      after(() => {
        during = progress.view();
        files = snapshot();
      }, variant('Step by step')),
      variant('Big card'),
    );
    const r = await send('Draw 3 variants of the Form screen', { progress });
    expect(during!.drafts.map((d) => [d.key, d.screen, d.letter, d.state])).toEqual([
      ['form:A', 'form', 'A', 'done'],
      ['form:B', 'form', 'B', 'drawing'],
      ['form:C', 'form', 'C', 'waiting'],
    ]);
    expect(during!.drafts[0]!.variantName).toBe('One page');
    expect(during!.drafts[0]!.pages).toEqual({ desktop: page('One page, wide'), mobile: page('One page, small') });
    expect(files).toEqual(before);
    expect(r.reply.kind).toBe('changed');
    expect(form().variants.map((v) => v.letter)).toEqual(['A', 'B', 'C']);
  });

  it('Stop while B draws keeps A only, as today; B and C are not kept', async () => {
    booking();
    const stop = new AbortController();
    const progress = new ChatProgress('English');
    answers.push(
      askFor(3),
      variant('One page'),
      async (opts: RunOptions) => {
        stop.abort();
        return { ok: false, text: '', sessionId: opts.resume ?? 'session-1' } as RunResult;
      },
    );
    const r = await send('Draw 3 variants of the Form screen', { progress, signal: stop.signal });
    expect(r.reply.kind).toBe('stopped');
    expect(form().variants.map((v) => [v.letter, v.name])).toEqual([['A', 'One page']]);
    expect(progress.view().drafts.map((d) => d.state)).toEqual(['done', 'stopped', 'stopped']);
    expect(r.reply.steps?.map((s) => s.state)).toEqual(['done', 'done', 'done', 'stopped', 'stopped', 'done']);
  });

  it.each([
    ['renames the sketch', () => actions.changeSketch(bp, 'booking', { name: 'Clinic booking' }, stampNow())],
    ['adds an empty screen', () => actions.addScreen(bp, 'booking', { name: 'Payment' }, stampNow())],
    ['changes another screen', () => studio.saveDrawnScreens(bp, 'booking', [{ id: 'confirmation', name: 'Confirmation', frames: { desktop: page('Done, calmer') } }], stampNow())],
  ])('a teammate who %s before the save: the drawings are saved anyway, with no button and no message', async (_what, teammate) => {
    booking();
    answers.push(askFor(2), variant('One page'), after(teammate, variant('Step by step')));
    const r = await send('Draw 2 variants of the Form screen');
    expect(r.reply.kind).toBe('changed');
    expect(r.reply.unsaved).toBeUndefined();
    expect(r.reply.text).not.toMatch(/Changed elsewhere|Not saved/);
    expect(form().variants.map((v) => v.letter)).toEqual(['A', 'B']);
  });

  it('a teammate who changes "Form" itself: the drawings stay "Not saved", kept on this computer; "Save them anyway" saves them on top', async () => {
    booking();
    answers.push(
      askFor(2),
      variant('One page'),
      after(() => studio.saveDrawnScreens(bp, 'booking', [{ id: 'form', name: 'Form', frames: { desktop: page('Teammate form') } }], stampNow()), variant('Step by step')),
    );
    const r = await send('Draw 2 variants of the Form screen');
    expect(r.reply.kind).toBe('not-saved');
    expect(r.reply.text).toBe(CHAT_WORDS.English.notSaved(['Form']));
    expect(r.reply.unsaved?.screens).toEqual(['Form']);
    expect(r.reply.steps?.at(-1)).toEqual({ words: 'Not saved: changed elsewhere', state: 'stopped' });
    // Only the teammate's drawing is in the project; the Designer's are kept with the chat on this computer.
    expect(form().variants.map((v) => v.version)).toEqual([1]);
    const id = r.reply.unsaved!.id;
    const file = ownerChatUnsavedFile(bp, OWNER, id);
    expect(fs.existsSync(file)).toBe(true);
    expect(path.relative(bp.studioDir, file).startsWith('..')).toBe(true);
    expect(readUnsaved(bp, OWNER, id)?.kind).toBe('variants');

    // Save them anyway: a new version on top; the teammate's version stays in the history.
    const line = saveUnsaved(bp, OWNER, 'main', id, stampNow());
    expect(form().variants.map((v) => [v.version, v.letter ?? null])).toEqual([
      [1, null],
      [2, 'A'],
      [3, 'B'],
    ]);
    expect(form().chosen).toBe(2);
    expect(line.text).toBe('You saved them anyway: Form A v2 · Form B v3');
    const msgs = readConversation(bp, OWNER, 'main').messages;
    expect(msgs.at(-1)).toMatchObject({ role: 'action', savedAnyway: { saved: [{ screen: 'form', version: 2 }, { screen: 'form', version: 3 }] } });
    expect(msgs.at(-2)).toMatchObject({ role: 'designer', kind: 'changed' });
    expect(msgs.at(-2)!.unsaved).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
    // Saved once only.
    expect(() => saveUnsaved(bp, OWNER, 'main', id, stampNow())).toThrow(/not kept here any more/);
  });

  it('"Save them anyway" with an old stamp is refused, and nothing changes', async () => {
    booking();
    const old = stampNow();
    answers.push(askFor(1), after(() => studio.saveDrawnScreens(bp, 'booking', [{ id: 'form', name: 'Form', frames: { desktop: page('Teammate form') } }], stampNow()), variant('One page')));
    const r = await send('Draw 1 variant of the Form screen');
    expect(r.reply.kind).toBe('not-saved');
    expect(() => saveUnsaved(bp, OWNER, 'main', r.reply.unsaved!.id, old)).toThrow(studio.CHANGED_ELSEWHERE);
    expect(form().variants).toHaveLength(1);
    expect(readUnsaved(bp, OWNER, r.reply.unsaved!.id)).not.toBeNull();
  });
});

describe('done when 3: a screen being changed is "Redrawing" until its new drawing is ready', () => {
  it('the changed screen has one frame, marked as a redraw, drawing, then done with its new drawing', async () => {
    booking();
    const progress = new ChatProgress('English');
    let during: ReturnType<typeof progress.view> | null = null;
    answers.push(
      { kind: 'change', reply: 'I will make it calmer.', screens: [{ id: 'confirmation', name: 'Confirmation', change: 'Calmer' }] },
      after(() => (during = progress.view()), { screens: [{ name: 'Confirmation', frames: [{ frame: 'desktop', html: page('Calm') }, { frame: 'mobile', html: page('Calm, small') }] }], note: '' }),
    );
    const r = await send('Make the confirmation calmer', { progress });
    expect(during!.drafts).toEqual([{ key: 'confirmation', screen: 'confirmation', name: 'Confirmation', redraw: true, state: 'drawing' }]);
    expect(during!.steps.find((s) => s.state === 'now')?.words).toBe('Redrawing Confirmation');
    expect(progress.view().drafts[0]).toMatchObject({ state: 'done', pages: { desktop: page('Calm') } });
    expect(r.reply.kind).toBe('changed');
  });
});

describe('done when 3: a screen with no drawing yet is drawn, not redrawn', () => {
  it('its frame is a plain drawing, and its step says Drawing', async () => {
    booking();
    const progress = new ChatProgress('English');
    let during: ReturnType<typeof progress.view> | null = null;
    answers.push(
      { kind: 'change', reply: 'I will draw it.', screens: [{ id: 'form', name: 'Form', change: 'Draw it' }] },
      after(() => (during = progress.view()), { screens: [{ name: 'Form', frames: [{ frame: 'desktop', html: page('Form') }, { frame: 'mobile', html: page('Form, small') }] }], note: '' }),
    );
    await send('Draw the form', { progress });
    expect(during!.drafts).toEqual([{ key: 'form', screen: 'form', name: 'Form', state: 'drawing' }]);
    expect(during!.steps.find((s) => s.state === 'now')?.words).toBe('Drawing Form');
  });
});

describe('the board server: the work with the conversation, and "Save them anyway"', () => {
  let app: Hono;
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await app.request(`/api/v1/studio${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: (await res.json()) as any };
  };
  beforeEach(() => {
    app = new Hono();
    mountStudioApi(app, { paths: buildPaths(tmp) });
  });

  it('reads the steps and the finished drawings while it works, and the kept drawings after; the save route saves them', async () => {
    booking();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    answers.push(askFor(2), variant('One page'), async (opts: RunOptions) => {
      await held;
      studio.saveDrawnScreens(bp, 'booking', [{ id: 'form', name: 'Form', frames: { desktop: page('Teammate form') } }], stampNow());
      return { ok: true, text: '', structured: variant('Step by step'), sessionId: opts.resume ?? 'session-1' } as RunResult;
    });
    await call('POST', '/sketches/booking/chats/main/messages', { text: 'Draw 2 variants of the Form screen', lookingAt: { screen: 'form' } });
    let c: any = null;
    for (let i = 0; i < 300; i++) {
      c = (await call('GET', '/sketches/booking/chats/main')).data;
      if (c.working?.drafts?.[0]?.state === 'done') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(c.working.steps.map((s: any) => s.words)).toEqual(['Read your message', 'Planned 2 variants', 'Drew variant A: Form', 'Drawing variant B: Form', 'Saving']);
    expect(c.working.language).toBe('English');
    expect(c.working.drafts.map((d: any) => [d.letter, d.state])).toEqual([
      ['A', 'done'],
      ['B', 'drawing'],
    ]);
    expect(c.working.drafts[0].pages.desktop).toBe(page('One page, wide'));
    release();
    await chatJobsDone();
    c = (await call('GET', '/sketches/booking/chats/main')).data;
    const reply = c.messages.at(-1);
    expect(reply).toMatchObject({ role: 'designer', kind: 'not-saved' });
    expect(reply.unsaved.drafts.map((d: any) => [d.letter, d.variantName, d.state])).toEqual([
      ['A', 'One page', 'done'],
      ['B', 'Step by step', 'done'],
    ]);
    // The drawings just finished stay readable for a short while, for the tab that watched them.
    expect(c.justDrawn.map((d: any) => d.key)).toEqual(['form:A', 'form:B']);
    const stale = await call('POST', `/sketches/booking/chats/main/unsaved/${reply.unsaved.id}/save`, { stamp: 'old' });
    expect(stale.status).toBe(409);
    const saved = await call('POST', `/sketches/booking/chats/main/unsaved/${reply.unsaved.id}/save`, { stamp: stampNow() });
    expect(saved.status).toBe(200);
    expect(saved.data.messages.at(-1)).toMatchObject({ role: 'action', text: 'You saved them anyway: Form A v2 · Form B v3' });
    expect(saved.data.messages.at(-2).unsaved).toBeUndefined();
    const again = await call('POST', `/sketches/booking/chats/main/unsaved/${reply.unsaved.id}/save`, { stamp: stampNow() });
    expect(again.status).toBe(404);
  });

  it('the sample board draws the same way: each variant in its frame before the save', async () => {
    booking();
    writeMeta(bp, { ...readMeta(bp), engine: sampleEngine } as never);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const progress = new ChatProgress('English');
    const going = send('Draw 2 variants of the Form screen', { progress });
    await vi.advanceTimersByTimeAsync(600 + DEMO_SCREEN_MS + 100);
    expect(progress.view().drafts.map((d) => d.state)).toEqual(['done', 'drawing']);
    expect(form().variants).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DEMO_SCREEN_MS + 100);
    const r = await going;
    expect(r.reply.kind).toBe('changed');
    expect(r.reply.steps?.map((s) => s.words)).toEqual(['Read your message', 'Planned 2 variants', 'Drew variant A: Form', 'Drew variant B: Form', 'Saved']);
  });
});
