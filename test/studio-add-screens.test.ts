import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * US-11 Add screens to a sketch (AB-136). Add screen makes "New screen" at once, then "New screen 2", not named yet
 * (the mark sits on its own screen.yaml). The AI Designer's first drawing of it, from the chat, names it from the
 * description through the one free-name helper ("Form 2" when "Form" is used) and draws its variants in the sketch's
 * design system and frames, matching the sketch's approved screens, or else the drawing each other screen uses now.
 * A screen name is unique in its sketch, so "Sketch / Screen" is unique in the project (AB-136.1), from the board, the
 * terminal and the AI Designer alike. Claude Code itself never starts: its direct run is replaced.
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
const { screenFile } = await import('../src/board/studio-paths.js');
const { sendChatMessage, flowOf } = await import('../src/engine/studio-chat.js');
const { sortProblem } = await import('../src/engine/studio-chat-prompts.js');
const { demoNewScreenSort } = await import('../src/engine/studio-chat-demo.js');
const { mountStudioApi } = await import('../src/console/api/studio.js');
const { chatJobsDone } = await import('../src/engine/studio-chat-runs.js');
const { buildPaths } = await import('../src/core/paths.js');
const { studioScreenAdd, studioScreenDelete } = await import('../src/commands/studio.js');
const { addScreenStamp } = await import('../console-ui/src/lib/studio.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
const place = async () => () => undefined;
const BOTH = ['desktop', 'mobile'];

/** "Patient app v2"'s tokens: blue, dark ink and white, the Inter font. */
const PATIENT_APP = { colors: { primary: '#1f6fb2', ink: '#0f172a', surface: '#ffffff' }, font: { family: 'Inter, sans-serif', size: { body: '16px', title: '28px' } } };
const page = (words: string) => `<!doctype html><html><head><style>body{font-family:Inter,sans-serif;font-size:16px;color:#0f172a;background:#ffffff}h1{font-size:28px}button{background:#1f6fb2;color:#ffffff}</style></head><body><h1>${words}</h1><button>Pay</button></body></html>`;
const pages = (words: string) => ({ desktop: page(`${words}, wide`), mobile: page(`${words}, small`) });

/** The Designer's answer for one variant of a screen, in both frames, with its name and idea. */
const variant = (screen: string, name: string) => ({
  screens: [{ name: screen, frames: [{ frame: 'desktop', html: page(`${screen} ${name}, wide`) }, { frame: 'mobile', html: page(`${screen} ${name}, small`) }] }],
  note: `${name}.`,
  variantName: name,
  idea: `${name}, in one line.`,
});

/**
 * "Booking" follows Patient app with the frames Desktop and Mobile, and the screens Form and Confirmation, both drawn:
 * Form once, Confirmation as A and B.
 */
function booking() {
  actions.createDesignSystem(bp, { name: 'Patient app', tokens: PATIENT_APP });
  const made = actions.createSketch(bp, { name: 'Booking', designSystem: { id: 'patient-app' }, frames: BOTH, screens: [{ name: 'Form' }, { name: 'Confirmation' }] });
  const drawn = studio.saveAskVariants(
    bp,
    'booking',
    { id: 'ask-1' },
    [
      { id: 'form', name: 'Form', variants: [{ letter: 'A', name: 'One page', idea: 'All on one page.', frames: pages('Form') }] },
      {
        id: 'confirmation',
        name: 'Confirmation',
        variants: [
          { letter: 'A', name: 'Plain', idea: 'A plain line.', frames: pages('Confirmation A') },
          { letter: 'B', name: 'Card', idea: 'A big card.', frames: pages('Confirmation B') },
        ],
      },
    ],
    made.stamp,
  );
  return drawn.sketch;
}

/** Every file in the project's Studio folder, with its bytes. */
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

const screenYaml = (sketch: string, screen: string) => yaml.load(fs.readFileSync(screenFile(bp, sketch, screen), 'utf8')) as Record<string, unknown>;
const tabs = (sketch: string) => actions.getSketch(bp, sketch).screens.map((s) => s.name);
const ofScreens = (snap: Record<string, string>, ...ids: string[]) => Object.fromEntries(Object.entries(snap).filter(([f]) => ids.some((id) => f.includes(`/screens/${id}/`))));
const live = () => writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', quality: 'thrifty', user: { ...(readMeta(bp).user ?? {}), name: 'Sara' } } as never);

const send = (text: string, screen: string, more: Partial<Parameters<typeof sendChatMessage>[1]> = {}) =>
  sendChatMessage(bp, { owner: { kind: 'sketch', id: 'booking' }, text, lookingAt: { screen, frame: 'desktop' }, ...more }, { place });

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-add-screens-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50, studio: false });
});

afterEach(async () => {
  await chatJobsDone();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('done when 1: Add screen makes "New screen" at once, then "New screen 2"', () => {
  it('adds "New screen" after Confirmation, not named yet, with no drawing, and then "New screen 2"', () => {
    const s = booking();
    const one = actions.addScreen(bp, 'booking', {}, s.stamp);
    expect(one.added).toBe('new-screen');
    expect(tabs('booking')).toEqual(['Form', 'Confirmation', 'New screen']);
    const added = one.screens.find((x) => x.id === 'new-screen')!;
    expect(added).toMatchObject({ name: 'New screen', unnamed: true, chosen: null, status: 'draft', variants: [] });
    // The "not named yet" mark sits on the screen's own file, so a teammate who pulls it gets it too.
    expect(screenYaml('booking', 'new-screen')).toMatchObject({ name: 'New screen', unnamed: true, edited: { at: expect.any(String) } });

    const two = actions.addScreen(bp, 'booking', { name: '  ' }, one.stamp);
    expect(two.added).toBe('new-screen-2');
    expect(tabs('booking')).toEqual(['Form', 'Confirmation', 'New screen', 'New screen 2']);
    expect(two.screens.find((x) => x.id === 'new-screen-2')).toMatchObject({ name: 'New screen 2', unnamed: true });
  });

  it('reading the sketch writes nothing, and an old stamp adds nothing', () => {
    const s = booking();
    actions.addScreen(bp, 'booking', {}, s.stamp);
    const before = snapshot();
    actions.getSketch(bp, 'booking');
    actions.sketchList(bp);
    expect(snapshot()).toEqual(before);
    expect(() => actions.addScreen(bp, 'booking', {}, s.stamp)).toThrow(studio.CHANGED_ELSEWHERE);
    expect(() => actions.addScreen(bp, 'booking', { name: 'Payment' }, s.stamp)).toThrow(studio.CHANGED_ELSEWHERE);
    expect(snapshot()).toEqual(before);
  });
});

describe('done when 5: a screen name is unique in its sketch, so "Sketch / Screen" is unique in the project (AB-136.1)', () => {
  it('refuses "form " in Booking, saving nothing, and keeps "Form" in Sign up', () => {
    const s = booking();
    const signUp = actions.createSketch(bp, { name: 'Sign up', frames: ['desktop'] });
    const before = snapshot();
    expect(() => actions.addScreen(bp, 'booking', { name: 'form ' }, s.stamp)).toThrow(studio.StudioScreenNameTaken);
    expect(() => actions.addScreen(bp, 'booking', { name: 'form ' }, s.stamp)).toThrow('A screen called "Form" already exists in Booking. Pick another name.');
    expect(snapshot()).toEqual(before);

    const kept = actions.addScreen(bp, 'sign-up', { name: 'Form' }, signUp.stamp);
    expect(kept.screens.map((x) => [x.id, x.name])).toEqual([['form', 'Form']]);
  });

  it('a rename to a name another screen has is refused too; a rename to its own name in other letters is kept', () => {
    const s = booking();
    expect(() => actions.changeScreen(bp, 'booking', 'confirmation', { name: ' FORM' }, s.stamp)).toThrow('A screen called "Form" already exists in Booking. Pick another name.');
    const renamed = actions.changeScreen(bp, 'booking', 'form', { name: 'form' }, s.stamp);
    expect(renamed.screens[0]!.name).toBe('form');
    // A sketch made with two screens of one name is refused before anything is written.
    expect(() => actions.createSketch(bp, { name: 'Twice', screens: [{ name: 'Pay', id: 'pay' }, { name: 'pay ', id: 'pay-2' }] })).toThrow('Two screens in the sketch have the same name.');
  });

  it('the free-name helper gives "New screen 2" and "Form 2", and the AI Designer\'s "Form" becomes "Form 2"', () => {
    const s = booking();
    const screens = actions.getSketch(bp, 'booking').screens;
    expect(studio.freeScreenName(screens, 'New screen')).toBe('New screen');
    expect(studio.freeScreenName(screens, 'form ')).toBe('form 2');
    expect(studio.freeScreenName(screens, 'Payment')).toBe('Payment');

    const added = actions.addScreen(bp, 'booking', {}, s.stamp);
    const named = studio.nameNewScreen(bp, 'booking', 'new-screen', 'Form', added.stamp, { by: studio.AI_DESIGNER, for: 'Sara' });
    expect(named.name).toBe('Form 2');
    expect(screenYaml('booking', 'new-screen')).toMatchObject({ name: 'Form 2', edited: { by: 'AI Designer', for: 'Sara' } });
    // The mark is cleared: a screen with a name is never named again.
    expect(screenYaml('booking', 'new-screen').unnamed).toBeUndefined();
    const again = studio.nameNewScreen(bp, 'booking', 'new-screen', 'Payment', named.sketch.stamp);
    expect(again.name).toBe('Form 2');
  });

  it('a rename by the person clears the "not named yet" mark; a status change keeps it', () => {
    const s = booking();
    const one = actions.addScreen(bp, 'booking', {}, s.stamp);
    const ready = actions.changeScreen(bp, 'booking', 'new-screen', { status: 'ready' }, one.stamp);
    expect(screenYaml('booking', 'new-screen').unnamed).toBe(true);
    actions.changeScreen(bp, 'booking', 'new-screen', { name: 'Payment' }, ready.stamp);
    expect(screenYaml('booking', 'new-screen')).toMatchObject({ name: 'Payment', status: 'ready' });
    expect(screenYaml('booking', 'new-screen').unnamed).toBeUndefined();
  });

  it('a new screen drawn by the AI Designer with a name the sketch has takes a free one, and a renamed screen\'s folder is not reused', () => {
    const s = booking();
    const renamed = actions.changeScreen(bp, 'booking', 'form', { name: 'Details' }, s.stamp);
    // "Form" is free again, but the folder "form" is Details': the new screen gets "form-2".
    const r = studio.saveDrawnScreens(bp, 'booking', [{ name: 'Form', frames: pages('Form again') }], renamed.stamp);
    expect(r.saved).toEqual([{ screen: 'form-2', version: 1 }]);
    expect(tabs('booking')).toEqual(['Details', 'Confirmation', 'Form']);
  });
});

describe('done when 2: the AI Designer draws and names the new screen from the chat', () => {
  beforeEach(live);

  it('names "New screen" Payment in one save, then draws 2 variants on Desktop and Mobile in Patient app; Form and Confirmation stay', async () => {
    const s = booking();
    const added = actions.addScreen(bp, 'booking', {}, s.stamp);
    const others = ofScreens(snapshot(), 'form', 'confirmation');
    answers.push(
      { kind: 'change', reply: 'I will draw the payment page.', screenName: 'Payment', screens: [{ id: 'new-screen', name: 'Payment', change: 'A payment page with card details and one Pay button' }] },
      variant('Payment', 'One page'),
      variant('Payment', 'Steps'),
    );
    const r = await send('A payment page with card details and one Pay button', 'new-screen', { stamp: added.stamp });
    expect(r.reply.kind).toBe('changed');
    expect(r.reply.text).toContain('I named the new screen "Payment".');

    const sketch = actions.getSketch(bp, 'booking');
    expect(sketch.screens.map((x) => x.name)).toEqual(['Form', 'Confirmation', 'Payment']);
    const pay = sketch.screens.find((x) => x.id === 'new-screen')!;
    expect(pay.unnamed).toBeUndefined();
    expect(pay.variants.map((v) => [v.letter, v.name, Object.keys(v.frames).sort(), v.checkedWith?.name])).toEqual([
      ['A', 'One page', BOTH, 'Patient app'],
      ['B', 'Steps', BOTH, 'Patient app'],
    ]);
    expect(pay.chosen).toBe(1);
    expect(screenYaml('booking', 'new-screen')).toMatchObject({ name: 'Payment', edited: { by: 'AI Designer', for: 'Sara' } });
    // Form and Confirmation stay as they were, file for file.
    expect(ofScreens(snapshot(), 'form', 'confirmation')).toEqual(others);

    // The sorting was told the screen is new and not named yet, and asked for its name.
    expect(calls[0]!.prompt).toContain('"New screen" (id new-screen) selected');
    expect(calls[0]!.prompt).toContain('"screenName"');
    expect(calls[1]!.prompt).toContain('Draw it as variant 1 of 2 (variant A)');
    expect(calls[1]!.prompt).toContain('design-systems/patient-app/v1/tokens.json');
    expect(calls[1]!.prompt).toContain('one page for each frame (desktop, mobile)');
  });

  it('the number of variants asked for is drawn, from a picture added to the message', async () => {
    const s = booking();
    const added = actions.addScreen(bp, 'booking', {}, s.stamp);
    answers.push({ kind: 'change', reply: 'I will draw it.', variants: 1, screenName: 'Receipt', screens: [{ id: 'new-screen', name: 'Receipt', change: 'Draw the screen in the picture' }] }, variant('Receipt', 'As pictured'));
    const png = { name: 'shot.png', type: 'image/png', data: `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')}` };
    const r = await send('Draw 1 variant like this', 'new-screen', { stamp: added.stamp, pictures: [png] });
    // The Designer reads the picture before it sorts the message.
    expect(calls[0]!.prompt).toContain('added a picture to this message');
    expect(r.reply.kind).toBe('changed');
    const receipt = actions.getSketch(bp, 'booking').screens.find((x) => x.id === 'new-screen')!;
    expect([receipt.name, receipt.variants.length]).toEqual(['Receipt', 1]);
  });

  it('"start from a copy of Form": the drawing gets Form\'s pages, and the screen is named "Form 2"', async () => {
    const s = booking();
    const added = actions.addScreen(bp, 'booking', {}, s.stamp);
    answers.push(
      { kind: 'change', reply: 'I will start from a copy of Form.', screens: [{ id: 'new-screen', name: 'Form', from: 'form', change: 'Start from a copy of Form' }] },
      variant('Form', 'Copy'),
      variant('Form', 'Copy, shorter'),
    );
    const r = await send('start from a copy of Form', 'new-screen', { stamp: added.stamp });
    expect(r.reply.kind).toBe('changed');
    expect(tabs('booking')).toEqual(['Form', 'Confirmation', 'Form 2']);
    expect(calls[1]!.prompt).toContain('Start from a copy of the screen "Form": its pages are desktop: .squad/studio/sketches/booking/screens/form/v1/desktop.html');
  });

  it('with no design system selected, nothing is named or drawn: the "select one or skip" alert shows', async () => {
    const made = actions.createSketch(bp, { name: 'Booking', frames: BOTH, screens: [{ name: 'Form' }] });
    const added = actions.addScreen(bp, 'booking', {}, made.stamp);
    const before = snapshot();
    answers.push({ kind: 'change', reply: 'I will draw it.', screenName: 'Payment', screens: [{ id: 'new-screen', name: 'Payment', change: 'A payment page' }] });
    const r = await send('A payment page', 'new-screen', { stamp: added.stamp });
    expect(r.reply.kind).toBe('needs-design-system');
    expect(snapshot()).toEqual(before);
  });

  it('a teammate\'s change to another screen since the message was read: the naming and the drawing are saved anyway (US-57)', async () => {
    const s = booking();
    const added = actions.addScreen(bp, 'booking', {}, s.stamp);
    actions.changeScreen(bp, 'booking', 'form', { status: 'ready' }, added.stamp);
    const before = snapshot();
    answers.push({ kind: 'change', reply: 'I will draw it.', screenName: 'Payment', screens: [{ id: 'new-screen', name: 'Payment', change: 'A payment page' }] }, variant('Payment', 'One page'), variant('Payment', 'Steps'));
    const r = await send('A payment page', 'new-screen', { stamp: added.stamp });
    expect(r.reply.text).toMatch(/^I named the new screen "Payment"\./);
    expect(snapshot()).not.toEqual(before);
    expect(actions.getSketch(bp, 'booking').screens.find((x) => x.id === 'new-screen')).toMatchObject({ name: 'Payment' });
  });

  it('the name is saved with the drawing: a drawing that fails saves no name, and the reply does not say one', async () => {
    const s = booking();
    const added = actions.addScreen(bp, 'booking', {}, s.stamp);
    const before = snapshot();
    // The sorting names it Payment, but the variant never comes back in the shape asked for.
    answers.push({ kind: 'change', reply: 'I will draw it.', screenName: 'Payment', screens: [{ id: 'new-screen', name: 'Payment', change: 'A payment page' }] });
    const r = await send('A payment page', 'new-screen', { stamp: added.stamp });
    expect(r.reply.kind).toBe('failed');
    expect(r.reply.text).not.toContain('I named');
    expect(snapshot()).toEqual(before);
    expect(screenYaml('booking', 'new-screen')).toMatchObject({ name: 'New screen', unnamed: true });
  });

  it('drawn from another tab: a drawing that brings a name names it; one that brings none keeps the mark, and the next drawing names it', async () => {
    const s = booking();
    const one = actions.addScreen(bp, 'booking', {}, s.stamp);
    const two = actions.addScreen(bp, 'booking', {}, one.stamp);
    // From the Form tab: the Designer draws both new screens, giving a name to the first one only.
    answers.push(
      { kind: 'change', reply: 'I will draw them.', variants: 1, screens: [{ id: 'new-screen', name: 'Payment', change: 'A payment page' }, { id: 'new-screen-2', name: 'New screen 2', change: 'Something' }] },
      variant('Payment', 'One page'),
      variant('New screen 2', 'Plain'),
    );
    const r = await send('Draw the payment page and the other one', 'form', { stamp: two.stamp });
    expect(r.reply.kind).toBe('changed');
    expect(screenYaml('booking', 'new-screen')).toMatchObject({ name: 'Payment', edited: { by: 'AI Designer', for: 'Sara' } });
    expect(screenYaml('booking', 'new-screen').unnamed).toBeUndefined();
    expect(screenYaml('booking', 'new-screen-2')).toMatchObject({ name: 'New screen 2', unnamed: true });
    expect(actions.getSketch(bp, 'booking').screens.find((x) => x.id === 'new-screen-2')!.variants).toHaveLength(1);

    // Selected later, already drawn but still not named: the next drawing names it.
    answers.length = 0;
    calls.length = 0;
    answers.push({ kind: 'change', reply: 'I will draw it.', variants: 1, screenName: 'Receipt', screens: [{ id: 'new-screen-2', name: 'Receipt', change: 'A receipt' }] }, variant('Receipt', 'Plain'));
    const again = await send('A receipt page', 'new-screen-2', { stamp: actions.getSketch(bp, 'booking').stamp });
    expect(again.reply.text).toContain('I named the new screen "Receipt".');
    expect(calls[0]!.prompt).toContain('it is not named yet.');
    expect(screenYaml('booking', 'new-screen-2').name).toBe('Receipt');
    expect(screenYaml('booking', 'new-screen-2').unnamed).toBeUndefined();
  });

  it('a question with the new screen selected changes nothing, and the name it suggests must be usable', async () => {
    const s = booking();
    const added = actions.addScreen(bp, 'booking', {}, s.stamp);
    const before = snapshot();
    answers.push({ kind: 'answer', reply: 'A payment page usually has one main button.' });
    const r = await send('What should a payment page have?', 'new-screen', { stamp: added.stamp });
    expect(r.reply.kind).toBe('answer');
    expect(snapshot()).toEqual(before);
    expect(sortProblem({ kind: 'change', reply: 'x', screenName: 'A\nB', screens: [{ name: 'X', change: 'y' }] }, 'sketch', false, true)).toMatch(/screenName/);
    expect(sortProblem({ kind: 'change', reply: 'x', screens: [{ name: 'X', change: 'y', from: 3 }] }, 'sketch')).toMatch(/from/);
  });
});

describe('done when 3: every drawing gets the flow to match', () => {
  beforeEach(live);

  it('Form approved: the new screen is given Form only; with none approved, each other screen\'s current drawing (Confirmation\'s B)', async () => {
    const s = booking();
    const picked = studio.pickVariant(bp, 'booking', 'confirmation', 2, s.stamp, { by: 'Sara' });
    const sketch = studio.readSketch(bp, 'booking')!;
    expect(flowOf(bp, sketch, 'new-screen')).toEqual({
      approved: false,
      screens: [
        { name: 'Form', files: { desktop: '.squad/studio/sketches/booking/screens/form/v1/desktop.html', mobile: '.squad/studio/sketches/booking/screens/form/v1/mobile.html' } },
        { name: 'Confirmation', files: { desktop: '.squad/studio/sketches/booking/screens/confirmation/v2/desktop.html', mobile: '.squad/studio/sketches/booking/screens/confirmation/v2/mobile.html' } },
      ],
    });

    // Form is approved (US-15 adds the button; the store already keeps the status).
    const approved = studio.saveSketch(bp, { id: 'booking', name: 'Booking', designSystem: sketch.designSystem, frames: BOTH, screens: [{ id: 'form', name: 'Form', status: 'approved', order: 1 }] }, picked.stamp);
    const added = actions.addScreen(bp, 'booking', {}, approved.stamp);
    answers.push({ kind: 'change', reply: 'I will draw it.', screenName: 'Payment', variants: 1, screens: [{ id: 'new-screen', name: 'Payment', change: 'A payment page' }] }, variant('Payment', 'One page'));
    await send('A payment page', 'new-screen', { stamp: added.stamp });
    expect(calls[1]!.prompt).toContain("The sketch's approved screens, to match");
    expect(calls[1]!.prompt).toContain('screens/form/v1/desktop.html');
    expect(calls[1]!.prompt).not.toContain('screens/confirmation/');
  });

  it('with none approved, the drawing is given Form\'s and Confirmation\'s Variant B', async () => {
    const s = booking();
    const picked = studio.pickVariant(bp, 'booking', 'confirmation', 2, s.stamp, { by: 'Sara' });
    const added = actions.addScreen(bp, 'booking', {}, picked.stamp);
    answers.push({ kind: 'change', reply: 'I will draw it.', screenName: 'Payment', variants: 1, screens: [{ id: 'new-screen', name: 'Payment', change: 'A payment page' }] }, variant('Payment', 'One page'));
    await send('A payment page', 'new-screen', { stamp: added.stamp });
    expect(calls[1]!.prompt).toContain('No screen of the sketch is approved yet');
    expect(calls[1]!.prompt).toContain('- Form: desktop: .squad/studio/sketches/booking/screens/form/v1/desktop.html');
    expect(calls[1]!.prompt).toContain('- Confirmation: desktop: .squad/studio/sketches/booking/screens/confirmation/v2/desktop.html');
    expect(calls[1]!.prompt).not.toContain('screens/confirmation/v1/');
  });
});

describe('Add screen on the board brings the stamp the last add answered with', () => {
  it('a second click before the sketch is read again sends the stamp of the first add, and so adds "New screen 2"', () => {
    expect(addScreenStamp('read-1', null)).toBe('read-1');
    expect(addScreenStamp('read-1', { read: 'read-1', now: 'after-add' })).toBe('after-add');
    // Read again since: the page's own stamp.
    expect(addScreenStamp('read-2', { read: 'read-1', now: 'after-add' })).toBe('read-2');
    const s = booking();
    const first = actions.addScreen(bp, 'booking', {}, addScreenStamp(s.stamp, null));
    const second = actions.addScreen(bp, 'booking', {}, addScreenStamp(s.stamp, { read: s.stamp, now: first.stamp }));
    expect(second.screens.map((x) => x.name)).toEqual(['Form', 'Confirmation', 'New screen', 'New screen 2']);
  });
});

describe('the sample board names a new screen and starts one from a copy, in plain words', () => {
  const screens = [
    { id: 'form', name: 'Form' },
    { id: 'confirmation', name: 'Confirmation' },
    { id: 'new-screen', name: 'New screen' },
  ];
  const fresh = { id: 'new-screen', name: 'New screen' };

  it('"A payment page …" draws 2 variants of Payment; "start from a copy of Form" starts from Form', () => {
    expect(demoNewScreenSort('A payment page with card details and one Pay button', 'English', undefined, screens, fresh)).toMatchObject({
      kind: 'change',
      screenName: 'Payment',
      variants: 2,
      screens: [{ id: 'new-screen', name: 'Payment' }],
    });
    expect(demoNewScreenSort('start from a copy of Form', 'English', undefined, screens, fresh)).toMatchObject({ kind: 'change', screenName: 'Form', screens: [{ id: 'new-screen', name: 'Form', from: 'form' }] });
    expect(demoNewScreenSort('Why blue?', 'English', undefined, screens, fresh).kind).toBe('answer');
  });

  it('on the sample board, a copy of Form becomes "Form 2", drawn as 2 variants that show what Form shows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const s = booking();
      const added = actions.addScreen(bp, 'booking', {}, s.stamp);
      const going = send('start from a copy of Form', 'new-screen', { stamp: added.stamp });
      await vi.advanceTimersByTimeAsync(30_000);
      const r = await going;
      expect(r.reply.kind).toBe('changed');
      const copy = actions.getSketch(bp, 'booking').screens.find((x) => x.id === 'new-screen')!;
      expect([copy.name, copy.variants.length, Object.keys(copy.variants[0]!.frames).sort()]).toEqual(['Form 2', 2, BOTH]);
      expect(copy.variants[0]!.frames.desktop).toContain('Book a follow-up');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('done when 4: the board\'s add and delete routes bring the stamp', () => {
  const api = () => {
    const a = new Hono();
    mountStudioApi(a, { paths: buildPaths(tmp) });
    return async (method: string, p: string, body?: unknown) => {
      const res = await a.request(`/api/v1/studio${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, data: (await res.json()) as any };
    };
  };

  it('adds "New screen" and answers with its id; deletes Payment and its drawings, Form and Confirmation stay', async () => {
    const s = booking();
    const call = api();
    const added = await call('POST', '/sketches/booking/screens', { stamp: s.stamp });
    expect(added.status).toBe(200);
    expect(added.data.added).toBe('new-screen');
    expect(added.data.screens.map((x: any) => [x.name, x.unnamed ?? false])).toEqual([['Form', false], ['Confirmation', false], ['New screen', true]]);
    const named = await call('PATCH', '/sketches/booking/screens/new-screen', { name: 'Payment', stamp: added.data.stamp });
    const others = ofScreens(snapshot(), 'form', 'confirmation');
    const gone = await call('DELETE', `/sketches/booking/screens/new-screen?stamp=${named.data.stamp}`);
    expect(gone.status).toBe(200);
    expect(gone.data.screens.map((x: any) => x.name)).toEqual(['Form', 'Confirmation']);
    expect(Object.keys(snapshot()).filter((f) => f.includes('/new-screen/'))).toEqual([]);
    expect(ofScreens(snapshot(), 'form', 'confirmation')).toEqual(others);
  });

  it('an old stamp is 409 "Changed elsewhere, reload" for add and delete, and a used name is 409 "A screen called Form already exists in Booking"', async () => {
    const s = booking();
    const call = api();
    const added = await call('POST', '/sketches/booking/screens', { stamp: s.stamp });
    const before = snapshot();
    const stale = await call('POST', '/sketches/booking/screens', { stamp: s.stamp });
    expect(stale).toMatchObject({ status: 409, data: { error: 'Changed elsewhere, reload', changedElsewhere: true } });
    const staleDelete = await call('DELETE', `/sketches/booking/screens/form?stamp=${s.stamp}`);
    expect(staleDelete).toMatchObject({ status: 409, data: { changedElsewhere: true } });
    // Done when 5 from the board: "form " in Booking is refused in plain words, with the existing screen's name, and nothing is saved.
    const taken = await call('POST', '/sketches/booking/screens', { name: 'form ', stamp: added.data.stamp });
    expect(taken).toEqual({ status: 409, data: { error: 'A screen called "Form" already exists in Booking. Pick another name.', screenNameTaken: { id: 'form', name: 'Form' } } });
    expect(snapshot()).toEqual(before);
    // "Form" in Sign up is a new full name in the project: kept.
    const signUp = actions.createSketch(bp, { name: 'Sign up', frames: ['desktop'] });
    const kept = await call('POST', '/sketches/sign-up/screens', { name: 'Form', stamp: signUp.stamp });
    expect(kept.status).toBe(200);
    expect([kept.data.added, kept.data.screens.map((x: any) => x.name)]).toEqual(['form', ['Form']]);
  });
});

describe('the terminal: squad studio sketch screen add and delete, with the same rules', () => {
  it('adds "New screen", refuses "form " in Booking, keeps "Form" in Sign up', async () => {
    booking();
    actions.createSketch(bp, { name: 'Sign up', frames: ['desktop'] });
    await studioScreenAdd(bp, null, 'Booking', [], {});
    expect(tabs('booking')).toEqual(['Form', 'Confirmation', 'New screen']);
    const before = snapshot();
    await expect(studioScreenAdd(bp, null, 'booking', ['form', ' '], {})).rejects.toThrow('A screen called "Form" already exists in Booking. Pick another name.');
    expect(snapshot()).toEqual(before);
    await studioScreenAdd(bp, null, 'Sign up', ['Form'], {});
    expect(tabs('sign-up')).toEqual(['Form']);
  });

  it('through the open board, it is the board\'s own call', async () => {
    const s = booking();
    const sent: [string, string, unknown][] = [];
    const board = { call: async <T,>(method: string, p: string, body?: unknown) => (sent.push([method, p, body]), { ...actions.getSketch(bp, 'booking'), added: 'new-screen', screens: [{ id: 'new-screen', name: 'New screen' }] } as T) };
    await studioScreenAdd(bp, board, 'Booking', [], {});
    expect(sent).toEqual([['POST', '/studio/sketches/booking/screens', { stamp: s.stamp }]]);
  });

  it('delete asks first, naming the screen: No changes nothing, Yes deletes it', async () => {
    booking();
    const asked: string[] = [];
    const before = snapshot();
    await studioScreenDelete(bp, null, 'Booking', 'confirmation', {}, async (q) => (asked.push(q), false));
    expect(asked).toEqual(['Delete "Confirmation" and its drawings? This cannot be undone.']);
    expect(snapshot()).toEqual(before);
    await studioScreenDelete(bp, null, 'Booking', 'Confirmation', {}, async () => true);
    expect(tabs('booking')).toEqual(['Form']);
  });
});
