import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * US-08 New sketch from the chat (AB-133). Each design system keeps its own list of frames, Desktop and Mobile when it
 * is made, and an older one with no list is read as Desktop and Mobile without being written (AB-133.1). The start
 * page's Send takes the design system, its frames and the variants, and refuses anything else before writing. The
 * board then starts the AI Designer's first turn at once: it names the sketch (through the one free-name helper,
 * AB-138.1) and its first screen, and asks first or draws the first screen once per variant; Stop keeps the finished
 * ones. Claude Code itself never starts: its direct run is replaced, and the sample board answers with fixed replies.
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
const { startSketch, startMarkOf } = await import('../src/board/studio-start.js');
const chats = await import('../src/board/studio-chats.js');
const { designSystemFile, designSystemDir, chatFile } = await import('../src/board/studio-paths.js');
const { sendChatMessage } = await import('../src/engine/studio-chat.js');
const { sortProblem } = await import('../src/engine/studio-chat-prompts.js');
const { demoFirstSort, DEMO_SCREEN_MS } = await import('../src/engine/studio-chat-demo.js');
const { chatJobsDone, stopChatJobs } = await import('../src/engine/studio-chat-runs.js');
const { mountStudioApi } = await import('../src/console/api/studio.js');
const { buildPaths } = await import('../src/core/paths.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
const place = async () => () => undefined;
const page = (words: string) => `<!doctype html><html><head></head><body><main>${words}</main></body></html>`;
const BOTH = ['desktop', 'mobile'];

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

const systemYaml = (id: string) => yaml.load(fs.readFileSync(designSystemFile(bp, id), 'utf8')) as Record<string, unknown>;

/** The project's design systems: Patient app, the default, with Desktop and Mobile; Admin with Desktop only. */
function designSystems() {
  actions.createDesignSystem(bp, { name: 'Patient app' });
  actions.createDesignSystem(bp, { name: 'Admin', frames: ['desktop'] });
}

/** A design system saved before frames were kept: its file has no list. */
function olderDesignSystem(id: string, name: string) {
  const dir = designSystemDir(bp, id);
  fs.mkdirSync(path.join(dir, 'v1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'v1', 'tokens.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'system.yaml'), yaml.dump({ name, default: false, version: 1, madeAt: '2026-10-01T09:00:00.000Z' }));
}

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-new-sketch-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(path.join(tmp, '.squad'));
  // The sample board, with no sample sketches: each test makes its own.
  seedDemoBoard(bp, { speed: 50, studio: false });
});

afterEach(async () => {
  stopChatJobs();
  await chatJobsDone();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('done when 3: each design system keeps its own list of frames (AB-133.1)', () => {
  it('saves a new one with Desktop and Mobile, or the frames it is made with', () => {
    designSystems();
    expect(systemYaml('patient-app').frames).toEqual(BOTH);
    expect(systemYaml('admin').frames).toEqual(['desktop']);
    expect(actions.getDesignSystem(bp, 'patient-app').frames).toEqual(BOTH);
    expect(actions.designSystemList(bp).designSystems.map((d) => [d.name, d.frames])).toEqual([
      ['Patient app', BOTH],
      ['Admin', ['desktop']],
    ]);
    expect(actions.designSystemList(bp).default).toMatchObject({ id: 'patient-app', frames: BOTH });
    // A new version or a rename keeps the list.
    const ds = actions.getDesignSystem(bp, 'admin');
    actions.changeDesignSystem(bp, 'admin', { name: 'Admin desk', tokens: { color: '#123456' } }, ds.stamp);
    expect(systemYaml('admin').frames).toEqual(['desktop']);
  });

  it('reads an older one with no list as Desktop and Mobile, never rewrites it on read, and it keeps working', async () => {
    designSystems();
    olderDesignSystem('legacy', 'Legacy');
    const before = snapshot();
    expect(actions.getDesignSystem(bp, 'legacy').frames).toEqual(BOTH);
    expect(actions.listDesignSystems(bp).find((d) => d.id === 'legacy')!.frames).toEqual(BOTH);
    expect(actions.designSystemList(bp).designSystems.find((d) => d.id === 'legacy')!.frames).toEqual(BOTH);
    expect(studio.readStudio(bp).designSystems.find((d) => d.id === 'legacy')!.frames).toEqual(BOTH);
    // The board's list sends the frames of each card.
    const app = new Hono();
    mountStudioApi(app, { paths: buildPaths(tmp) });
    const listed = (await (await app.request('/api/v1/studio/design-systems')).json()) as { designSystems: { id: string; frames: string[] }[] };
    expect(Object.fromEntries(listed.designSystems.map((d) => [d.id, d.frames]))).toEqual({ 'patient-app': BOTH, admin: ['desktop'], legacy: BOTH });
    // Reading wrote nothing.
    expect(snapshot()).toEqual(before);

    // A sketch can start on it, in one of its frames; its file is still the same, with no list.
    const made = startSketch(bp, { message: 'An old admin page', designSystem: 'legacy', frames: ['mobile'], variants: 1 });
    expect(actions.getSketch(bp, made.id)).toMatchObject({ designSystem: { id: 'legacy', version: 1, name: 'Legacy' }, frames: ['mobile'] });
    expect(systemYaml('legacy')).toEqual({ name: 'Legacy', default: false, version: 1, madeAt: '2026-10-01T09:00:00.000Z' });
  });
});

describe("done when 2 and 4: Send takes the chips' choice, and refuses anything else before writing", () => {
  it('refuses a frame the design system does not have, no frame at all, variants outside 1 to 3, or an unknown design system', () => {
    designSystems();
    const before = snapshot();
    const local = () => (fs.existsSync(bp.studioLocalDir) ? fs.readdirSync(bp.studioLocalDir) : []);
    const localBefore = local();
    const refused: [Record<string, unknown>, string | RegExp][] = [
      [{ frames: ['tablet'] }, '"tablet" is not a frame of Patient app. Its frames: Desktop and Mobile.'],
      [{ designSystem: 'admin', frames: ['mobile'] }, '"mobile" is not a frame of Admin. Its frames: Desktop.'],
      [{ frames: [] }, 'Keep at least one frame on.'],
      [{ frames: 'desktop' }, 'Keep at least one frame on.'],
      [{ variants: 0 }, 'Variants go from 1 to 3.'],
      [{ variants: 4 }, 'Variants go from 1 to 3.'],
      [{ variants: 2.5 }, 'Variants go from 1 to 3.'],
      [{ variants: '2' }, 'Variants go from 1 to 3.'],
      [{ designSystem: 'nope' }, 'This project has no design system "nope". Reload and pick another.'],
    ];
    for (const [choice, why] of refused) {
      expect(() => startSketch(bp, { message: 'A booking page', ...choice } as never)).toThrow(why);
    }
    expect(snapshot()).toEqual(before);
    expect(actions.listSketches(bp)).toEqual([]);
    expect(local()).toEqual(localBefore);
  });

  it('saves the sketch with the design system and frames; the variants and the to-be-named mark go on the first message, on this computer', () => {
    designSystems();
    const made = startSketch(bp, { message: 'An admin page for today', designSystem: 'admin', frames: ['desktop'], variants: 3 });
    expect(actions.getSketch(bp, made.id)).toMatchObject({ designSystem: { id: 'admin', version: 1, name: 'Admin' }, frames: ['desktop'], screens: [] });
    expect(startMarkOf(bp, made.id)).toEqual({ variants: 3, unnamed: true });
    expect(chatFile(bp, made.id, 'main').startsWith(bp.studioLocalDir)).toBe(true);
    expect(JSON.stringify(snapshot())).not.toContain('variants');

    // Left out, the chips' defaults: the default design system, all its frames, 2 variants.
    const plain = startSketch(bp, { message: 'A page where patients book a follow-up visit with their last doctor' });
    expect(actions.getSketch(bp, plain.id)).toMatchObject({ designSystem: { id: 'patient-app', version: 1 }, frames: BOTH });
    expect(startMarkOf(bp, plain.id)).toEqual({ variants: 2, unnamed: true });
    // The frames keep the design system's own order.
    const turned = startSketch(bp, { message: 'Mobile first please', frames: ['mobile', 'desktop'] });
    expect(actions.getSketch(bp, turned.id).frames).toEqual(BOTH);
  });
});

describe('done when 5: the names the AI Designer suggests, through the one free-name helper', () => {
  it('names the sketch "Booking 2" when "Booking" is taken, with a first screen "Form", marked as the AI Designer\'s work; both can be renamed later', () => {
    designSystems();
    studio.saveSketch(bp, { name: 'Booking', frames: ['desktop'] });
    const made = startSketch(bp, { message: 'A page where patients book a follow-up visit with their last doctor' });
    const stamp = actions.getSketch(bp, made.id).stamp;
    const r = studio.nameSketchAndFirstScreen(bp, made.id, { sketch: 'Booking', screen: 'Form' }, stamp, { by: 'AI Designer', for: 'Sara' });
    expect(r.sketch.name).toBe('Booking 2');
    expect(r.sketch.screens.map((s) => [s.id, s.name, s.variants.length])).toEqual([['form', 'Form', 0]]);
    expect(r.sketch.lastEdit).toMatchObject({ by: 'AI Designer', for: 'Sara' });
    // An old stamp writes nothing.
    expect(() => studio.nameSketchAndFirstScreen(bp, made.id, { sketch: 'Visits', screen: 'List' }, stamp)).toThrow(studio.CHANGED_ELSEWHERE);

    // Names stay unique: a used one is refused; another name is fine, for the sketch and the screen.
    const now = actions.getSketch(bp, made.id);
    expect(() => actions.changeSketch(bp, made.id, { name: 'booking ' }, now.stamp)).toThrow(studio.StudioNameTaken);
    const renamed = actions.changeSketch(bp, made.id, { name: 'Follow-up booking' }, now.stamp);
    expect(actions.changeScreen(bp, made.id, 'form', { name: 'Pick a time' }, renamed.stamp).screens[0]!.name).toBe('Pick a time');
  });

  it('asks again for a first answer with no names', () => {
    expect(sortProblem({ kind: 'ask', reply: 'Who is it for?' }, 'sketch', true)).toContain('"sketchName"');
    expect(sortProblem({ kind: 'ask', reply: 'Who is it for?', sketchName: 'Booking' }, 'sketch', true)).toContain('"screenName"');
    expect(sortProblem({ kind: 'ask', reply: 'Who is it for?', sketchName: 'Booking', screenName: 'Form' }, 'sketch', true)).toBeNull();
    expect(sortProblem({ kind: 'ask', reply: 'Who is it for?' }, 'sketch')).toBeNull();
  });
});

describe('several variants of one new screen, in one change', () => {
  it('saves each as the next version and picks the first; an old stamp or a frame the sketch lacks writes nothing', () => {
    const s = studio.saveSketch(bp, { name: 'Booking', frames: BOTH });
    const before = snapshot();
    expect(() => studio.saveScreenVariants(bp, 'booking', { name: 'Form' }, [{ tablet: page('x') }], s.stamp)).toThrow('has no frame "tablet"');
    expect(() => studio.saveScreenVariants(bp, 'booking', { name: 'Form' }, [{ desktop: page('x') }], 'old')).toThrow(studio.CHANGED_ELSEWHERE);
    expect(snapshot()).toEqual(before);

    const r = studio.saveScreenVariants(bp, 'booking', { name: 'Form' }, [{ desktop: page('One page'), mobile: page('One page, small') }, { desktop: page('Steps'), mobile: page('Steps, small') }], s.stamp, { madeBy: 'AI Designer', madeFor: 'Sara' });
    expect(r.screen).toBe('form');
    expect(r.versions).toEqual([1, 2]);
    const form = r.sketch.screens[0]!;
    expect([form.name, form.chosen, form.variants.map((v) => [v.version, Object.keys(v.frames).sort(), v.madeBy])]).toEqual([
      'Form',
      1,
      [
        [1, BOTH, 'AI Designer'],
        [2, BOTH, 'AI Designer'],
      ],
    ]);
  });
});

describe('done when 4: the AI Designer on the sample board asks first, or draws the first screen as the variants asked for', () => {
  const owner = (id: string) => ({ kind: 'sketch' as const, id });
  /** Answers the first message, the way the start route does, with the sample board's timings run at once. */
  async function answer(id: string, o: Parameters<typeof sendChatMessage>[2] = {}, text?: string) {
    const going = sendChatMessage(bp, { owner: owner(id), chat: 'main', ...(text ? { text } : {}) }, o);
    await vi.advanceTimersByTimeAsync(600 + 3 * DEMO_SCREEN_MS + 100);
    return going;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    designSystems();
  });

  it('a short description: names it "Booking" / "Form" and asks first, drawing nothing; the answer then draws 2 variants in Desktop and Mobile', async () => {
    const made = startSketch(bp, { message: 'A booking page', designSystem: 'patient-app', frames: BOTH, variants: 2 });
    const before = Object.keys(snapshot());
    const asked = await answer(made.id);
    expect(asked.reply.kind).toBe('ask');
    expect(asked.reply.text).toMatch(/^I named the sketch "Booking" and its first screen "Form"\. You can rename both later\.\n\nTwo quick questions first:/);
    const named = actions.getSketch(bp, made.id);
    expect(named.name).toBe('Booking');
    expect(named.screens.map((s) => [s.name, s.variants.length])).toEqual([['Form', 0]]);
    expect(named.lastEdit).toMatchObject({ by: 'AI Designer' });
    // No drawing: only the sketch file and the empty screen's file.
    expect(Object.keys(snapshot()).filter((f) => !before.includes(f))).toEqual([`studio/sketches/${made.id}/screens/form/screen.yaml`]);
    expect(startMarkOf(bp, made.id)).toEqual({ variants: 2 });

    const drew = await answer(made.id, {}, 'Keep the last doctor. Buttons for the times.');
    expect(drew.reply.kind).toBe('changed');
    expect(drew.reply.saved).toEqual([
      { screen: 'form', name: 'Form', version: 1 },
      { screen: 'form', name: 'Form', version: 2 },
    ]);
    const s = actions.getSketch(bp, made.id);
    // Named once: the second turn does not rename it.
    expect(s.name).toBe('Booking');
    expect(s.screens[0]!.chosen).toBe(1);
    expect(s.screens[0]!.variants.map((v) => Object.keys(v.frames).sort())).toEqual([BOTH, BOTH]);
    expect(s.screens[0]!.variants[0]!.frames.desktop).not.toBe(s.screens[0]!.variants[1]!.frames.desktop);
  });

  it('a longer description: the first screen drawn as 2 variants in Desktop and Mobile, one variant at a time', async () => {
    const made = startSketch(bp, { message: 'A page where patients book a follow-up visit with their last doctor', designSystem: 'patient-app', frames: BOTH, variants: 2 });
    const said: string[] = [];
    const r = await answer(made.id, { onProgress: (w) => said.push(w) });
    expect(said).toEqual(['Reading your message', 'Drawing variant 1 of 2: Form', 'Drawing variant 2 of 2: Form', 'Saving the new version']);
    expect(r.reply.kind).toBe('changed');
    expect(r.reply.text).toContain('I named the sketch "Booking" and its first screen "Form".');
    expect(r.reply.text).toContain('2 variants of Form are drawn: Form v1, Form v2. The first one is picked; the others stay.');
    const s = actions.getSketch(bp, made.id);
    expect(s.screens.map((x) => [x.name, x.chosen, x.variants.map((v) => Object.keys(v.frames).sort())])).toEqual([['Form', 1, [BOTH, BOTH]]]);
    expect(s.screens[0]!.variants.every((v) => v.madeBy === 'AI Designer')).toBe(true);
    // The person's message comes first in the conversation, then the Designer's.
    expect(chats.readConversation(bp, owner(made.id), 'main').messages.map((m) => m.role)).toEqual(['person', 'designer']);
  });

  it('3 variants of Admin, Desktop only', async () => {
    const made = startSketch(bp, { message: 'An admin dashboard with all of the visits for today', designSystem: 'admin', frames: ['desktop'], variants: 3 });
    const r = await answer(made.id);
    expect(r.reply.saved?.map((x) => x.version)).toEqual([1, 2, 3]);
    const s = actions.getSketch(bp, made.id);
    expect(s.name).toBe('Dashboard');
    expect(s.screens[0]!.variants.map((v) => Object.keys(v.frames))).toEqual([['desktop'], ['desktop'], ['desktop']]);
  });

  it('Stop keeps the variants already finished', async () => {
    const made = startSketch(bp, { message: 'A page where patients book a follow-up visit with their last doctor', variants: 3 });
    const stop = new AbortController();
    const r = await answer(made.id, { signal: stop.signal, onProgress: (w) => w.startsWith('Drawing variant 2') && stop.abort() });
    expect(r.reply.kind).toBe('stopped');
    expect(r.reply.saved).toEqual([{ screen: 'form', name: 'Form', version: 1 }]);
    const s = actions.getSketch(bp, made.id);
    expect(s.screens[0]!.variants.map((v) => v.version)).toEqual([1]);
    expect(s.screens[0]!.chosen).toBe(1);
  });

  it('the sample names, in English and Arabic', () => {
    expect(demoFirstSort('A login page in Arabic and English', 'English')).toMatchObject({ kind: 'change', sketchName: 'Login', screenName: 'Sign in' });
    expect(demoFirstSort('Booking', 'English')).toMatchObject({ kind: 'ask', sketchName: 'Booking', screenName: 'Form' });
    expect(demoFirstSort('صفحة حجز موعد مع الطبيب للمرضى الكبار', 'Arabic')).toMatchObject({ kind: 'change', sketchName: 'الحجز', screenName: 'النموذج' });
  });
});

describe('done when 5 with the live AI Designer', () => {
  beforeEach(() => {
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', quality: 'thrifty' });
    designSystems();
  });

  it('asks for the names and the variants, names it "Booking 2" when "Booking" is taken, and says which variant each run draws', async () => {
    studio.saveSketch(bp, { name: 'Booking', frames: ['desktop'] });
    const made = startSketch(bp, { message: 'A page where patients book a follow-up visit with their last doctor' });
    const drawn = (words: string) => ({ screens: [{ name: 'Form', frames: [{ frame: 'desktop', html: page(words) }, { frame: 'mobile', html: page(`${words}, small`) }] }], note: `${words}.` });
    answers.push({ kind: 'change', reply: 'I will draw the booking form.', sketchName: 'Booking', screenName: 'Form', screens: [{ name: 'Form', change: 'Book a follow-up with the last doctor' }] }, drawn('One page'), drawn('Steps'));
    const r = await sendChatMessage(bp, { owner: { kind: 'sketch', id: made.id }, chat: 'main' }, { place });
    expect(r.reply.kind).toBe('changed');
    expect(calls[0]!.prompt).toContain('Suggest a short name for the sketch in "sketchName"');
    expect(calls[0]!.prompt).toContain('you draw it as 2 variants in its frames (desktop, mobile)');
    expect(calls[1]!.prompt).toContain('Draw it as variant 1 of 2');
    expect(calls[2]!.prompt).toContain('Draw it as variant 2 of 2');
    const s = actions.getSketch(bp, made.id);
    expect(s.name).toBe('Booking 2');
    expect(s.screens.map((x) => [x.name, x.chosen, x.variants.length])).toEqual([['Form', 1, 2]]);
    expect(r.reply.text).toMatch(/^I named the sketch "Booking 2" and its first screen "Form"\./);
  });

  it('a teammate changed the sketch while it drew: the save is refused with "Changed elsewhere, reload"', async () => {
    const made = startSketch(bp, { message: 'A page where patients book a follow-up visit with their last doctor', variants: 1 });
    answers.push({ kind: 'change', reply: 'Drawing.', sketchName: 'Booking', screenName: 'Form', screens: [{ name: 'Form', change: 'Draw it' }] }, async () => {
      const now = actions.getSketch(bp, made.id);
      actions.changeSketch(bp, made.id, { name: 'Theirs' }, now.stamp);
      return { ok: true, text: '', structured: { screens: [{ name: 'Form', frames: [{ frame: 'desktop', html: page('x') }, { frame: 'mobile', html: page('y') }] }], note: 'x.' }, sessionId: 'session-1' } as RunResult;
    });
    const r = await sendChatMessage(bp, { owner: { kind: 'sketch', id: made.id }, chat: 'main' }, { place });
    expect(r.reply.kind).toBe('failed');
    expect(r.reply.text).toContain(studio.CHANGED_ELSEWHERE);
    expect(actions.getSketch(bp, made.id).screens[0]!.variants).toEqual([]);
  });
});

describe('the start route starts the first turn at once', () => {
  it('makes the sketch and answers in the background: the workspace opens with the AI Designer working, and no "Answer it"', async () => {
    designSystems();
    const app = new Hono();
    mountStudioApi(app, { paths: buildPaths(tmp) });
    const call = async (method: string, p: string, body?: unknown) => {
      const res = await app.request(`/api/v1/studio${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, data: (await res.json()) as any };
    };
    const r = await call('POST', '/sketches/start', { message: 'A booking page', designSystem: 'patient-app', frames: BOTH, variants: 2 });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ id: 'a-booking-page', name: 'A booking page', working: { doing: 'Reading your message' } });
    expect(actions.getSketch(bp, 'a-booking-page')).toMatchObject({ designSystem: { id: 'patient-app' }, frames: BOTH });
    // What the workspace reads straight after: the message, and the Designer at work.
    const open = await call('GET', '/sketches/a-booking-page/chats/main');
    expect(open.data.messages.map((m: { role: string }) => m.role)).toEqual(['person']);
    expect(open.data.working).toMatchObject({ doing: expect.any(String) });

    await chatJobsDone();
    const after = await call('GET', '/sketches/a-booking-page/chats/main');
    expect(after.data.working).toBeNull();
    expect(after.data.messages.map((m: { role: string; kind?: string }) => [m.role, m.kind ?? null])).toEqual([
      ['person', null],
      ['designer', 'ask'],
    ]);
    expect((await call('GET', '/sketches/a-booking-page')).data).toMatchObject({ name: 'Booking', screens: [{ name: 'Form' }] });

    // A refused choice makes nothing and starts nothing.
    const bad = await call('POST', '/sketches/start', { message: 'A booking page', frames: ['tablet'] });
    expect(bad.status).toBe(400);
    expect(actions.listSketches(bp).map((s) => s.id)).toEqual(['a-booking-page']);
  });
});
