import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * US-17 Draw variants (AB-142): the AI Designer draws 1 to 3 variants of the screens asked for, one at a time, each in
 * every frame of the sketch with a short name and a one-line idea. They are kept on each variant's own meta.yaml (the
 * ask, the letter, the name, the idea and the token check, AB-142.1), each screen's variant A in use; "Use this one"
 * picks another with the sketch's stamp. With no design system nothing is drawn until one is selected, or Skip draws in
 * plain styles once. Stop keeps the finished variants only. Claude Code itself never starts: its direct run is replaced.
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
const { variantMetaFile } = await import('../src/board/studio-paths.js');
const { tokenWarnings } = await import('../src/board/studio-tokens.js');
const { sendChatMessage } = await import('../src/engine/studio-chat.js');
const { STUDIO_ACTIONS, VARIANT_SCHEMA, variantsAsked } = await import('../src/engine/studio-chat-prompts.js');
const { SCREENS_SCHEMA } = await import('../src/engine/studio-prompts.js');
const { DEMO_SCREEN_MS, demoSort, demoVariantsAsked } = await import('../src/engine/studio-chat-demo.js');
const { mountStudioApi } = await import('../src/console/api/studio.js');
const { chatJobsDone } = await import('../src/engine/studio-chat-runs.js');
const { buildPaths } = await import('../src/core/paths.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
/** The sample board's own engine: its fixed replies instead of the AI. */
let sampleEngine: unknown;
const place = async () => () => undefined;
const BOTH = ['desktop', 'mobile'];

/** "Patient app": blue, dark ink and white, the Inter font, and two font sizes. It has no red. */
const PATIENT_APP = { colors: { primary: '#1f6fb2', ink: '#0f172a', surface: '#ffffff', muted: '#64748b' }, font: { family: 'Inter, sans-serif', size: { body: '16px', title: '28px' } } };

/** A page that keeps to Patient app's tokens; `button` paints its button another color. */
const page = (words: string, button = '#1f6fb2') =>
  `<!doctype html><html><head><style>body{font-family:Inter,sans-serif;font-size:16px;color:#0f172a;background:#FFF}h1{font-size:28px}button{background:${button};color:#ffffff;box-shadow:0 2px 8px rgba(15,23,42,.1)}</style></head><body><h1>${words}</h1><button>Book</button></body></html>`;

/** The Designer's answer for one variant of a screen, in both frames, with its name and idea. */
const variant = (screen: string, name: string, idea: string, button?: string) => ({
  screens: [{ name: screen, frames: [{ frame: 'desktop', html: page(`${name}, wide`, button) }, { frame: 'mobile', html: page(`${name}, small`, button) }] }],
  note: `${name}.`,
  variantName: name,
  idea,
});
const A = (screen = 'Form') => variant(screen, 'One page', 'Everything on one page, with one main button.');
const B = (screen = 'Form', button?: string) => variant(screen, 'Step by step', 'Day, then time, then confirm.', button);
const C = (screen = 'Form') => variant(screen, 'Big card', 'One big card with large text.');

/** The sorting answer for these screens: `variants` of each, or null for a message that asks for no variants. */
const askFor = (screens: { id: string; name: string }[], variants: number | null = 2) => ({
  kind: 'change',
  reply: 'I will draw the variants, one at a time.',
  ...(variants === null ? {} : { variants }),
  screens: screens.map((s) => ({ ...s, change: 'Draw variants of it' })),
});
const FORM = { id: 'form', name: 'Form' };
const CONFIRM = { id: 'confirm', name: 'Confirm' };

/** "Booking" follows Patient app and has the frames Desktop and Mobile, and the screens Form and Confirm, not drawn yet. */
function booking() {
  actions.createDesignSystem(bp, { name: 'Patient app', tokens: PATIENT_APP });
  return actions.createSketch(bp, { name: 'Booking', designSystem: { id: 'patient-app' }, frames: BOTH, screens: [{ name: 'Form' }, { name: 'Confirm' }] });
}

/** "Checkout" has no design system selected, and the screen Payment. */
function checkout() {
  return actions.createSketch(bp, { name: 'Checkout', designSystem: null, frames: BOTH, screens: [{ name: 'Payment' }] });
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

const metaYaml = (sketch: string, screen: string, version: number) => yaml.load(fs.readFileSync(variantMetaFile(bp, sketch, screen, version), 'utf8')) as Record<string, unknown>;
const screenOf = (sketch: string, screen: string) => actions.getSketch(bp, sketch).screens.find((s) => s.id === screen)!;
const letters = (sketch: string, screen: string) => screenOf(sketch, screen).variants.map((v) => [v.letter, v.name]);

const send = (owner: string, text: string, more: Partial<Parameters<typeof sendChatMessage>[1]> = {}, o: Parameters<typeof sendChatMessage>[2] = {}) =>
  sendChatMessage(bp, { owner: { kind: 'sketch', id: owner }, text, lookingAt: { screen: 'form', frame: 'desktop' }, ...more }, { place, ...o });

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-variants-')));
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

describe('the Studio store keeps each variant of an ask on its own meta.yaml (AB-142.1)', () => {
  const three = (red?: string) => [
    { letter: 'A', name: 'One page', idea: 'Everything on one page.', frames: { desktop: page('A'), mobile: page('A, small') } },
    { letter: 'B', name: 'Step by step', idea: 'Day, then time, then confirm.', frames: { desktop: page('B', red), mobile: page('B, small', red) } },
    { letter: 'C', name: 'Big card', idea: 'One big card.', frames: { desktop: page('C'), mobile: page('C, small') } },
  ];

  it('saves every finished variant of an ask in one change, with its ask, letter, name, idea and token check, and makes A the one in use', () => {
    const s = booking();
    const was = Object.keys(snapshot());
    const r = studio.saveAskVariants(bp, 'booking', { id: 'ask-1', words: 'Draw 3 variants of the Form screen' }, [{ id: 'form', name: 'Form', variants: three('#dc2626') }], s.stamp, { madeBy: 'AI Designer', madeFor: 'Sara' });
    expect(r.saved).toEqual([
      { screen: 'form', version: 1, letter: 'A', name: 'One page' },
      { screen: 'form', version: 2, letter: 'B', name: 'Step by step' },
      { screen: 'form', version: 3, letter: 'C', name: 'Big card' },
    ]);
    const form = screenOf('booking', 'form');
    expect(form.chosen).toBe(1);
    expect(form.variants.map((v) => [v.version, v.ask, v.letter, v.name, v.idea, Object.keys(v.frames).sort()])).toEqual([
      [1, 'ask-1', 'A', 'One page', 'Everything on one page.', BOTH],
      [2, 'ask-1', 'B', 'Step by step', 'Day, then time, then confirm.', BOTH],
      [3, 'ask-1', 'C', 'Big card', 'One big card.', BOTH],
    ]);
    // The marks sit on each variant's own meta.yaml: no new shared file.
    expect(metaYaml('booking', 'form', 2)).toMatchObject({
      madeBy: 'AI Designer',
      madeFor: 'Sara',
      ask: 'ask-1',
      asked: 'Draw 3 variants of the Form screen',
      letter: 'B',
      name: 'Step by step',
      idea: 'Day, then time, then confirm.',
      checkedWith: { id: 'patient-app', version: 1, name: 'Patient app' },
      warnings: [{ kind: 'color', value: '#dc2626' }],
    });
    // Only the red variant has a warning.
    expect(metaYaml('booking', 'form', 1).warnings).toBeUndefined();
    expect(form.variants.map((v) => v.warnings ?? [])).toEqual([[], [{ kind: 'color', value: '#dc2626' }], []]);
    // No new shared file: the only new files are the three variants' own folders.
    expect(Object.keys(snapshot()).filter((f) => !was.includes(f)).map((f) => f.split('/form/')[1]).sort()).toEqual(['v1/desktop.html', 'v1/meta.yaml', 'v1/mobile.html', 'v2/desktop.html', 'v2/meta.yaml', 'v2/mobile.html', 'v3/desktop.html', 'v3/meta.yaml', 'v3/mobile.html']);
  });

  it('several screens in one change: each screen gets its own A, B …, and its A is in use', () => {
    const s = booking();
    const v = three();
    studio.saveAskVariants(bp, 'booking', { id: 'ask-2' }, [{ id: 'form', name: 'Form', variants: v.slice(0, 2) }, { id: 'confirm', name: 'Confirm', variants: v.slice(0, 1) }], s.stamp);
    expect(letters('booking', 'form')).toEqual([['A', 'One page'], ['B', 'Step by step']]);
    expect(letters('booking', 'confirm')).toEqual([['A', 'One page']]);
    expect([screenOf('booking', 'form').chosen, screenOf('booking', 'confirm').chosen]).toEqual([1, 1]);
  });

  it('a stale stamp writes nothing, and a variant needs its letter, name and idea', () => {
    const s = booking();
    const before = snapshot();
    expect(() => studio.saveAskVariants(bp, 'booking', { id: 'ask-1' }, [{ id: 'form', name: 'Form', variants: three() }], 'old')).toThrow(studio.CHANGED_ELSEWHERE);
    expect(() => studio.saveAskVariants(bp, 'booking', { id: 'ask-1' }, [{ id: 'form', name: 'Form', variants: [{ ...three()[0]!, letter: 'a1' }] }], s.stamp)).toThrow(/one capital letter/);
    expect(() => studio.saveAskVariants(bp, 'booking', { id: 'ask-1' }, [{ id: 'form', name: 'Form', variants: [{ ...three()[0]!, idea: ' ' }] }], s.stamp)).toThrow(/an idea/);
    expect(snapshot()).toEqual(before);
  });

  it('a change to variant B saves a new version with B\'s ask, letter, name and idea; A and C stay as they were', () => {
    const s = booking();
    const saved = studio.saveAskVariants(bp, 'booking', { id: 'ask-1', words: 'Draw 3 variants' }, [{ id: 'form', name: 'Form', variants: three() }], s.stamp);
    const picked = studio.pickVariant(bp, 'booking', 'form', 2, saved.sketch.stamp, { by: 'Sara' });
    const aAndC = [metaYaml('booking', 'form', 1), metaYaml('booking', 'form', 3)];
    const changed = studio.saveDrawnScreens(bp, 'booking', [{ id: 'form', name: 'Form', frames: { desktop: page('B, bigger button'), mobile: page('B, bigger button, small') } }], picked.stamp, { madeBy: 'AI Designer', madeFor: 'Sara' });
    expect(changed.saved).toEqual([{ screen: 'form', version: 4 }]);
    const form = screenOf('booking', 'form');
    expect(form.chosen).toBe(4);
    expect(form.variants.find((v) => v.version === 4)).toMatchObject({ ask: 'ask-1', letter: 'B', name: 'Step by step', idea: 'Day, then time, then confirm.', checkedWith: { name: 'Patient app' } });
    expect([metaYaml('booking', 'form', 1), metaYaml('booking', 'form', 3)]).toEqual(aAndC);
    // "Use B" now means the new drawing of B.
    expect(studio.variantOfLetter(form as never, 'B')?.version).toBe(4);
    expect(studio.variantOfLetter(form as never, 'C')?.version).toBe(3);
    expect(studio.variantOfLetter(form as never, 'D')).toBeNull();
  });

  it('with no design system the variant is marked so; reading shows what was saved and writes nothing', () => {
    const s = checkout();
    studio.saveAskVariants(bp, 'checkout', { id: 'ask-3' }, [{ id: 'payment', name: 'Payment', variants: three('#dc2626').slice(0, 2) }], s.stamp);
    expect(screenOf('checkout', 'payment').variants.map((v) => [v.noDesignSystem, v.checkedWith, v.warnings])).toEqual([
      [true, undefined, undefined],
      [true, undefined, undefined],
    ]);
    const before = snapshot();
    studio.readStudio(bp);
    actions.sketchList(bp);
    actions.getSketch(bp, 'checkout');
    expect(snapshot()).toEqual(before);
  });
});

describe('the token check: every color, font and size the pages use that the tokens lack', () => {
  it('names a red outside the tokens, however it is written, and a font and a size outside them', () => {
    const pages = [
      '<style>.a{background:#DC2626}.b{color:red}.c{border:1px solid rgb(220, 38, 38)}h1{font:700 30px/1.2 "Comic Sans MS",sans-serif}</style>',
      '<p style="color: hsl(0, 72%, 51%)">x</p>',
    ];
    expect(tokenWarnings(pages, PATIENT_APP)).toEqual([
      { kind: 'color', value: '#DC2626' },
      { kind: 'color', value: 'red' },
      { kind: 'color', value: 'hsl(0, 72%, 51%)' },
      { kind: 'font', value: 'Comic Sans MS' },
      { kind: 'size', value: '30px' },
    ]);
  });

  it('stays quiet on pages that keep to the tokens: any case, short hex, another opacity, generic fonts', () => {
    expect(tokenWarnings([page('ok')], PATIENT_APP)).toEqual([]);
    expect(tokenWarnings(['<style>body{color:#0F172A;background:#fff;font-family:system-ui,Inter;font-size:16px}a:hover{color:rgba(31,111,178,.5)}</style>'], PATIENT_APP)).toEqual([]);
  });

  it('a kind the tokens say nothing about is not checked', () => {
    expect(tokenWarnings([page('x', '#dc2626')], {})).toEqual([]);
    // Colors only: the font and the sizes are free.
    expect(tokenWarnings(['<style>h1{font-size:40px;font-family:Georgia;color:#000}</style>'], { colors: { ink: '#000000' } })).toEqual([]);
  });
});

describe('done when 1: "Draw 3 variants of the Form screen" draws A, B and C side by side, each in Desktop and Mobile, with a name and an idea', () => {
  it('draws them one at a time with their names and ideas, keeps to the tokens, and puts A in use', async () => {
    booking();
    answers.push(askFor([FORM], 3), A(), B(), C());
    const said: string[] = [];
    const r = await send('booking', 'Draw 3 variants of the Form screen', {}, { onProgress: (w) => said.push(w) });
    expect(said).toEqual(['Reading your message', 'Drawing variant 1 of 3: Form', 'Drawing variant 2 of 3: Form', 'Drawing variant 3 of 3: Form', 'Saving the new version']);
    // The sorting was asked for the number; each variant was asked for its name and idea, in the design system's tokens.
    expect(calls[0]!.prompt).toContain('put how many of each in "variants"');
    expect(calls[1]!.schema).toEqual(VARIANT_SCHEMA);
    expect(calls[2]!.prompt).toContain('Draw it as variant 2 of 3 (variant B)');
    expect(calls[2]!.prompt).toContain("Use only the colors, fonts and sizes in the design system's tokens (.squad/studio/design-systems/patient-app/v1/tokens.json)");
    expect(calls[2]!.prompt).toContain('"variantName"');
    expect(r.reply.kind).toBe('changed');
    expect(r.reply.text).toContain('3 variants of Form are drawn: A · One page, B · Step by step, C · Big card. Variant A is in use');
    const form = screenOf('booking', 'form');
    expect(form.variants.map((v) => [v.letter, v.name, v.idea, Object.keys(v.frames).sort(), v.warnings ?? []])).toEqual([
      ['A', 'One page', 'Everything on one page, with one main button.', BOTH, []],
      ['B', 'Step by step', 'Day, then time, then confirm.', BOTH, []],
      ['C', 'Big card', 'One big card with large text.', BOTH, []],
    ]);
    expect(form.chosen).toBe(form.variants[0]!.version);
    expect(new Set(form.variants.map((v) => v.ask)).size).toBe(1);
    expect(form.variants.every((v) => v.madeBy === 'AI Designer' && v.madeFor === 'Sara')).toBe(true);
  });

  it('counts the variants asked for: 2 with no number, at most 3', async () => {
    expect([variantsAsked({}), variantsAsked({ variants: 1 }), variantsAsked({ variants: 3 }), variantsAsked({ variants: 7 }), variantsAsked({ variants: 'some' as never })]).toEqual([null, 1, 3, 3, 2]);
    expect(demoVariantsAsked('Draw 3 variants of the Form screen')).toBe(3);
    expect(demoVariantsAsked('Draw variants of Form and Confirm')).toBe(2);
    expect(demoVariantsAsked('Draw two variants of Form')).toBe(2);
    expect(demoVariantsAsked('Which variant suits older patients?')).toBeNull();
    expect(demoVariantsAsked('Make the buttons bigger')).toBeNull();

    booking();
    answers.push(askFor([FORM], 7), A(), B(), C());
    await send('booking', 'Draw 7 variants of the Form screen');
    expect(calls).toHaveLength(4);
    expect(letters('booking', 'form').map(([l]) => l)).toEqual(['A', 'B', 'C']);
  });

  it('a message that asks for no variants still makes one drawing, as before', async () => {
    booking();
    answers.push(askFor([FORM], null), { screens: [{ name: 'Form', frames: [{ frame: 'desktop', html: page('Form') }, { frame: 'mobile', html: page('Form, small') }] }], note: 'Drawn.' });
    const r = await send('booking', 'Draw the Form screen');
    expect(r.reply.kind).toBe('changed');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.schema).toEqual(SCREENS_SCHEMA);
    const form = screenOf('booking', 'form');
    expect(form.variants).toHaveLength(1);
    expect(form.variants[0]!.ask).toBeUndefined();
  });

  it('the sample board does the same with its fixed replies, in the design system\'s own colors', async () => {
    writeMeta(bp, { ...readMeta(bp), engine: sampleEngine } as never);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    booking();
    const going = send('booking', 'Draw 3 variants of the Form screen');
    await vi.advanceTimersByTimeAsync(600 + 3 * DEMO_SCREEN_MS + 100);
    const r = await going;
    expect(r.reply.kind).toBe('changed');
    expect(letters('booking', 'form')).toEqual([['A', 'One page'], ['B', 'Step by step'], ['C', 'Big and simple']]);
    expect(screenOf('booking', 'form').variants.every((v) => !v.warnings && Object.keys(v.frames).sort().join() === 'desktop,mobile')).toBe(true);
  });
});

describe('done when 2: "Use this one" saves the pick, which a reload still shows; both variants stay', () => {
  function app() {
    const a = new Hono();
    mountStudioApi(a, { paths: buildPaths(tmp) });
    return async (method: string, p: string, body?: unknown) => {
      const res = await a.request(`/api/v1/studio${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, data: (await res.json()) as any };
    };
  }

  it('the board\'s "Use this one" picks B with the stamp; a stale stamp is refused with "Changed elsewhere, reload"', async () => {
    const s = booking();
    studio.saveAskVariants(bp, 'booking', { id: 'ask-1' }, [{ id: 'form', name: 'Form', variants: [A(), B()].map((v, i) => ({ letter: 'AB'[i]!, name: v.variantName, idea: v.idea, frames: { desktop: page(v.variantName) } })) }], s.stamp);
    const call = app();
    const read = await call('GET', '/sketches/booking');
    expect(read.data.screens[0].variants.map((v: any) => [v.version, v.letter, v.name, v.idea])).toEqual([
      [1, 'A', 'One page', 'Everything on one page, with one main button.'],
      [2, 'B', 'Step by step', 'Day, then time, then confirm.'],
    ]);
    expect(read.data.screens[0].chosen).toBe(1);

    const picked = await call('POST', '/sketches/booking/screens/form/pick', { version: 2, stamp: read.data.stamp });
    expect(picked.status).toBe(200);
    // A reload reads B in use, and both variants still there.
    const again = await call('GET', '/sketches/booking');
    expect(again.data.screens[0].chosen).toBe(2);
    expect(again.data.screens[0].variants.map((v: any) => v.letter)).toEqual(['A', 'B']);
    expect(actions.getSketch(bp, 'booking').lastEdit).toMatchObject({ by: 'Sara' });

    // The stamp read before the pick is old now.
    const stale = await call('POST', '/sketches/booking/screens/form/pick', { version: 1, stamp: read.data.stamp });
    expect(stale).toMatchObject({ status: 409, data: { error: studio.CHANGED_ELSEWHERE, changedElsewhere: true } });
    expect(screenOf('booking', 'form').chosen).toBe(2);
    expect((await call('POST', '/sketches/booking/screens/form/pick', { version: 9, stamp: again.data.stamp })).status).toBe(404);
    expect((await call('POST', '/sketches/booking/screens/form/pick', { version: 1 })).status).toBe(400);
  });

  it('the chat can do it too: "Use B" picks variant B with the stamp of the message', async () => {
    expect(STUDIO_ACTIONS.find((a) => a.id === 'pick-variant')?.available).toBe(true);
    const s = booking();
    studio.saveAskVariants(bp, 'booking', { id: 'ask-1' }, [{ id: 'form', name: 'Form', variants: [{ letter: 'A', name: 'One page', idea: 'One page.', frames: { desktop: page('A') } }, { letter: 'B', name: 'Step by step', idea: 'Steps.', frames: { desktop: page('B') } }] }], s.stamp);
    answers.push({ kind: 'change', action: 'pick-variant', letter: 'B', reply: 'I will use B.', screens: [{ id: 'form', name: 'Form', change: 'Use B' }] });
    const r = await send('booking', 'Use B');
    expect(r.reply).toMatchObject({ kind: 'changed', text: 'Done. Form now uses variant B · Step by step. The other variants stay.' });
    expect(screenOf('booking', 'form').chosen).toBe(2);
    // The sample board reads "Use B" the same way, but not "Use a bigger button".
    const screens = [{ id: 'form', name: 'Form' }];
    expect(demoSort('Use B', 'English', undefined, screens, true, 'form')).toMatchObject({ action: 'pick-variant', letter: 'B', screens: [{ id: 'form' }] });
    expect(demoSort('Use a bigger button', 'English', undefined, screens, true, 'form').action).toBeUndefined();
  });
});

describe('done when 3: a variant with a color outside the design system is kept and its card says so', () => {
  it('B uses a red Patient app has no: it is kept, with a warning naming the red; A has none', async () => {
    booking();
    answers.push(askFor([FORM], 2), A(), B('Form', '#dc2626'));
    const r = await send('booking', 'Draw 2 variants of the Form screen');
    expect(r.reply.kind).toBe('changed');
    expect(r.reply.text).toContain('B · Step by step uses what "Patient app" does not have: #dc2626.');
    const [a, b] = screenOf('booking', 'form').variants;
    expect(a!.warnings).toBeUndefined();
    expect(b).toMatchObject({ letter: 'B', warnings: [{ kind: 'color', value: '#dc2626' }], checkedWith: { name: 'Patient app' } });
    // What the board sends the page: the warning, as it was saved.
    const call = new Hono();
    mountStudioApi(call, { paths: buildPaths(tmp) });
    const read = (await (await call.request('/api/v1/studio/sketches/booking')).json()) as any;
    expect(read.screens[0].variants.map((v: any) => v.warnings ?? null)).toEqual([null, [{ kind: 'color', value: '#dc2626' }]]);
  });
});

describe('done when 4: with no design system, nothing is drawn until one is selected, or Skip draws plain styles once', () => {
  it('asks for a design system and draws nothing; Skip draws plain variants once; the next ask shows the alert again', async () => {
    checkout();
    const before = snapshot();
    answers.push(askFor([{ id: 'payment', name: 'Payment' }], 2));
    const r = await send('checkout', 'Draw 2 variants of the Payment screen');
    expect(r.reply).toMatchObject({ kind: 'needs-design-system' });
    expect(r.reply.text).toContain('"Checkout" has no design system selected, so I drew nothing.');
    expect(calls).toHaveLength(1);
    expect(snapshot()).toEqual(before);

    // Skip: the same words once more, in plain styles.
    answers.push(askFor([{ id: 'payment', name: 'Payment' }], 2), A('Payment'), B('Payment'));
    const skipped = await send('checkout', 'Draw 2 variants of the Payment screen', { plainStyles: true });
    expect(skipped.reply.kind).toBe('changed');
    expect(calls[2]!.prompt).toContain('The sketch has no design system: use plain, neutral styles.');
    expect(screenOf('checkout', 'payment').variants.map((v) => [v.letter, v.noDesignSystem])).toEqual([
      ['A', true],
      ['B', true],
    ]);

    // Only that once: the next ask shows the alert again.
    answers.push(askFor([{ id: 'payment', name: 'Payment' }], 2));
    expect((await send('checkout', 'Draw 2 variants of the Payment screen')).reply.kind).toBe('needs-design-system');
  });

  it('after a design system is selected there, the same ask draws the variants in it', async () => {
    const s = checkout();
    actions.createDesignSystem(bp, { name: 'Patient app', tokens: PATIENT_APP });
    answers.push(askFor([{ id: 'payment', name: 'Payment' }], 2));
    expect((await send('checkout', 'Draw 2 variants of the Payment screen')).reply.kind).toBe('needs-design-system');

    // "Select a design system" saves the choice to the sketch, with its stamp.
    actions.changeSketch(bp, 'checkout', { designSystem: { id: 'patient-app' } }, s.stamp);
    answers.push(askFor([{ id: 'payment', name: 'Payment' }], 2), A('Payment'), B('Payment'));
    const r = await send('checkout', 'Draw 2 variants of the Payment screen');
    expect(r.reply.kind).toBe('changed');
    expect(screenOf('checkout', 'payment').variants.map((v) => [v.letter, v.noDesignSystem ?? false, v.checkedWith?.name])).toEqual([
      ['A', false, 'Patient app'],
      ['B', false, 'Patient app'],
    ]);
  });
});

describe('done when 5: the run shows its progress, and Stop keeps only the finished variants', () => {
  it('"Draw variants of Form and Confirm" with no number: 4 variants, screen by screen; Stop while the last is drawn keeps Form A, B and Confirm A', async () => {
    booking();
    const stop = new AbortController();
    const said: string[] = [];
    // No number in the message: the Designer sorts it as 2 of each, as it is told to.
    answers.push(askFor([FORM, CONFIRM], 2), A(), B(), A('Confirm'), B('Confirm'));
    const r = await send('booking', 'Draw variants of Form and Confirm', {}, {
      signal: stop.signal,
      onProgress: (w) => {
        said.push(w);
        if (w === 'Drawing variant 4 of 4: Confirm') stop.abort();
      },
    });
    expect(said).toEqual(['Reading your message', 'Drawing variant 1 of 4: Form', 'Drawing variant 2 of 4: Form', 'Drawing variant 3 of 4: Confirm', 'Drawing variant 4 of 4: Confirm', 'Saving the new version']);
    expect(r.reply.kind).toBe('stopped');
    expect(r.reply.text).toContain('Stopped. The finished variants are kept: Form A · One page, Form B · Step by step, Confirm A · One page. Nothing half drawn was saved.');
    expect(letters('booking', 'form')).toEqual([['A', 'One page'], ['B', 'Step by step']]);
    expect(letters('booking', 'confirm')).toEqual([['A', 'One page']]);
    expect([screenOf('booking', 'form').chosen, screenOf('booking', 'confirm').chosen]).toEqual([1, 1]);
  });

  it('Stop while the third is drawn keeps Form A and B; Confirm gets nothing half drawn', async () => {
    booking();
    const stop = new AbortController();
    answers.push(askFor([FORM, CONFIRM], 2), A(), B(), A('Confirm'));
    const r = await send('booking', 'Draw variants of Form and Confirm', {}, { signal: stop.signal, onProgress: (w) => w.startsWith('Drawing variant 3 of 4') && stop.abort() });
    expect(r.reply.kind).toBe('stopped');
    expect(letters('booking', 'form')).toEqual([['A', 'One page'], ['B', 'Step by step']]);
    expect(screenOf('booking', 'confirm').variants).toEqual([]);
  });

  it('Stop before anything is finished changes nothing', async () => {
    booking();
    const before = snapshot();
    const stop = new AbortController();
    answers.push(askFor([FORM], 2), A());
    const r = await send('booking', 'Draw 2 variants of the Form screen', {}, { signal: stop.signal, onProgress: (w) => w.startsWith('Drawing variant 1') && stop.abort() });
    expect(r.reply.kind).toBe('stopped');
    expect(snapshot()).toEqual(before);
  });
});
