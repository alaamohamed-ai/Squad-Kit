import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * US-52 Talk with the AI Designer (AB-177): each chat message is sorted first (an answer, a question back, "not
 * available yet", or a change), and only a change makes a version, one screen at a time in the same session, saved with
 * the stamp read when the message was sent. Stop keeps the finished screens. Conversations stay on this computer, and
 * `squad studio chat` reaches the same conversation. Claude Code itself never starts: its direct run is replaced.
 */

type Answer = unknown | ((opts: RunOptions) => Promise<RunResult>);
const calls: RunOptions[] = [];
const answers: Answer[] = [];
/** Runs while the Designer works on a run: a teammate's change, for example. */
let during: (() => void) | null = null;
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    during?.();
    during = null;
    const next = answers.shift();
    if (typeof next === 'function') return (next as (o: RunOptions) => Promise<RunResult>)(opts);
    return { ok: true, text: '', structured: next, sessionId: opts.resume ?? 'session-1' } as RunResult;
  },
}));

const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const studio = await import('../src/board/studio.js');
const { createDesignSystem, changeSketch } = await import('../src/board/studio-actions.js');
const { startSketch } = await import('../src/board/studio-start.js');
const chats = await import('../src/board/studio-chats.js');
const { designSystemChatsDir, ownerChatFile } = await import('../src/board/studio-paths.js');
const { sendChatMessage } = await import('../src/engine/studio-chat.js');
const { SORT_SCHEMA, languageOf } = await import('../src/engine/studio-chat-prompts.js');
const { demoSort } = await import('../src/engine/studio-chat-demo.js');
const { studioChat } = await import('../src/commands/studio.js');
const { mountStudioApi } = await import('../src/console/api/studio.js');
const { chatJobsDone } = await import('../src/engine/studio-chat-runs.js');
const { buildPaths } = await import('../src/core/paths.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
const BOOKING = { kind: 'sketch' as const, id: 'booking' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const page = (words: string) => `<!doctype html><html><head><style>body{font-family:sans-serif}</style></head><body><main>${words}</main></body></html>`;
const place = async () => () => undefined;

/** "Booking" with the screens Form and Confirmation, each drawn once, in its desktop frame. */
function booking() {
  const s = studio.saveSketch(bp, { name: 'Booking', frames: ['desktop'], screens: [{ name: 'Form' }, { name: 'Confirmation' }] });
  studio.saveDrawnScreens(bp, 'booking', [{ id: 'form', name: 'Form', frames: { desktop: page('Form') } }, { id: 'confirmation', name: 'Confirmation', frames: { desktop: page('Done') } }], s.stamp);
  return studio.readSketch(bp, 'booking')!;
}

/** Every file in the project's Studio folder, with its bytes: what makes a version. */
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

const send = (text: string, more: Partial<Parameters<typeof sendChatMessage>[1]> = {}, o: Parameters<typeof sendChatMessage>[2] = {}) =>
  sendChatMessage(bp, { owner: BOOKING, text, lookingAt: { screen: 'form', frame: 'desktop' }, ...more }, { place, ...o });

const twoScreens = (change = 'Make the buttons bigger') => ({
  kind: 'change',
  reply: 'I will make the buttons bigger on both screens.',
  screens: [
    { id: 'form', name: 'Form', change },
    { id: 'confirmation', name: 'Confirmation', change },
  ],
});
const drawn = (words: string) => ({ screens: [{ name: words, frames: [{ frame: 'desktop', html: page(`${words}, bigger buttons`) }] }], note: `${words} has bigger buttons.` });

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  during = null;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-chat-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(path.join(tmp, '.squad'));
  // No sample sketches: each test makes its own "Booking".
  seedDemoBoard(bp, { speed: 50, studio: false });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', quality: 'thrifty' });
});

afterEach(async () => {
  await chatJobsDone();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('done when 1: questions get answers, a maybe gets a question back, a missing action is named, and none makes a version', () => {
  it('answers "Why this color?", asks before "Maybe a softer blue?", and says "Export this as PDF" is not available yet', async () => {
    booking();
    const before = snapshot();

    answers.push({ kind: 'answer', reply: 'The blue is the main colour: it marks the one thing to do on the page.' });
    const a = await send('Why this color?');
    expect(a.reply).toMatchObject({ role: 'designer', kind: 'answer', text: 'The blue is the main colour: it marks the one thing to do on the page.' });
    // It was sorted with the sorting shape, told what the person looks at and what the Studio can and cannot do yet.
    expect(calls[0]!.schema).toEqual(SORT_SCHEMA);
    expect(calls[0]!.prompt).toContain('looking at the screen "Form" in its desktop frame');
    expect(calls[0]!.prompt).toContain('change-screens: Change screens of the sketch');
    expect(calls[0]!.prompt).toMatch(/export: Export .*\(not available yet\)/);
    expect(calls[0]!.prompt).toContain('Write "reply" in English');

    answers.push({ kind: 'ask', reply: 'Do you want me to change it?' });
    const b = await send('Maybe a softer blue?');
    expect(b.reply).toMatchObject({ kind: 'ask', text: 'Do you want me to change it?' });

    answers.push({ kind: 'unavailable', action: 'export', reply: 'Exporting as PDF is not available yet.' });
    const c = await send('Export this as PDF');
    expect(c.reply).toMatchObject({ kind: 'unavailable', text: 'Exporting as PDF is not available yet.' });

    // Nothing in the project changed: no new version.
    expect(snapshot()).toEqual(before);
    // The same session goes on, message after message.
    expect(calls.map((x) => x.resume)).toEqual([undefined, 'session-1', 'session-1']);
    // The conversation keeps all six messages, in order, on this computer.
    const convo = chats.readConversation(bp, BOOKING, 'main');
    expect(convo.messages.map((m) => [m.role, m.kind ?? null])).toEqual([
      ['person', null],
      ['designer', 'answer'],
      ['person', null],
      ['designer', 'ask'],
      ['person', null],
      ['designer', 'unavailable'],
    ]);
    expect(convo.messages[0]!.lookingAt).toEqual({ screen: 'form', frame: 'desktop' });
  });

  it('works the same on a design system: an answer changes nothing, and the chat is kept beside its own folder', async () => {
    const ds = createDesignSystem(bp, { name: 'Patient app', tokens: { color: { primary: '#1f6fb2' } }, components: { button: page('<button>Go</button>') } });
    const before = snapshot();
    answers.push({ kind: 'answer', reply: 'It is calm and easy to read.' });
    const r = await sendChatMessage(bp, { owner: { kind: 'design-system', id: ds.id }, text: 'Why this blue?' }, { place });
    expect(r.reply.kind).toBe('answer');
    expect(snapshot()).toEqual(before);
    expect(calls[0]!.prompt).toContain('The design system');
    expect(fs.existsSync(ownerChatFile(bp, { kind: 'design-system', id: ds.id }, 'main'))).toBe(true);
    expect(designSystemChatsDir(bp, ds.id).startsWith(bp.studioLocalDir)).toBe(true);
  });

  it("a deleted design system takes this computer's chats about it along, and a sketch never shares its folder", async () => {
    const ds = createDesignSystem(bp, { name: 'Patient app' });
    chats.addChatMessage(bp, { kind: 'design-system', id: ds.id }, 'main', { role: 'person', text: 'Hi' });
    // A sketch with the same id keeps its own chats apart.
    studio.saveSketch(bp, { id: 'patient-app', name: 'Patient app', frames: ['desktop'] });
    chats.addChatMessage(bp, { kind: 'sketch', id: 'patient-app' }, 'main', { role: 'person', text: 'Hello' });
    expect(chats.readConversation(bp, { kind: 'design-system', id: ds.id }, 'main').messages.map((m) => m.text)).toEqual(['Hi']);
    expect(chats.readConversation(bp, { kind: 'sketch', id: 'patient-app' }, 'main').messages.map((m) => m.text)).toEqual(['Hello']);
    studio.deleteDesignSystem(bp, ds.id, studio.readDesignSystem(bp, ds.id)!.stamp);
    expect(fs.existsSync(designSystemChatsDir(bp, ds.id))).toBe(false);
    expect(chats.readConversation(bp, { kind: 'sketch', id: 'patient-app' }, 'main').messages).toHaveLength(1);
  });

  it('a sorting answer that does not fit is asked once more, then refused with nothing saved', async () => {
    booking();
    const before = snapshot();
    answers.push({ kind: 'maybe' }, { kind: 'change', reply: 'ok' });
    const r = await send('Do something');
    expect(r.reply.kind).toBe('failed');
    expect(r.reply.text).toContain('could not be used');
    expect(calls).toHaveLength(2);
    expect(snapshot()).toEqual(before);
  });
});

describe('done when 2: a change goes one screen at a time, and Stop keeps the finished screens', () => {
  it('says "Changing screen 2 of 2" as it goes and saves both screens as one new version', async () => {
    booking();
    const said: string[] = [];
    answers.push(twoScreens(), drawn('Form'), drawn('Confirmation'));
    const r = await send('Make the buttons bigger', {}, { onProgress: (w) => said.push(w) });
    expect(said).toEqual(['Reading your message', 'Changing screen 1 of 2: Form', 'Changing screen 2 of 2: Confirmation', 'Saving the new version']);
    expect(r.reply).toMatchObject({ kind: 'changed', saved: [{ screen: 'form', name: 'Form', version: 2 }, { screen: 'confirmation', name: 'Confirmation', version: 2 }] });
    const s = studio.readSketch(bp, 'booking')!;
    expect(s.screens.map((x) => [x.id, x.chosen, x.variants.length])).toEqual([
      ['form', 2, 2],
      ['confirmation', 2, 2],
    ]);
    expect(s.screens[0]!.variants[1]!.madeBy).toBe('AI Designer');
    // Every screen run goes on in the same session, one screen each.
    expect(calls.map((x) => x.resume)).toEqual([undefined, 'session-1', 'session-1']);
    expect(calls[1]!.prompt).toContain('Now screen 1 of 2: "Form" (id form)');
    expect(calls[1]!.prompt).toContain('.squad/studio/sketches/booking/screens/form/v1/desktop.html');
    expect(calls[2]!.prompt).toContain('Now screen 2 of 2: "Confirmation"');
  });

  it('Stop after the first screen: only the finished screen becomes a new version, and the chat says it stopped', async () => {
    booking();
    const stop = new AbortController();
    answers.push(twoScreens(), drawn('Form'), (opts: RunOptions) =>
      new Promise<RunResult>((resolve) => {
        const end = () => resolve({ ok: false, text: '', sessionId: 'session-1', error: 'Stopped.' } as RunResult);
        if (opts.signal?.aborted) end();
        else opts.signal?.addEventListener('abort', end, { once: true });
      }),
    );
    const r = await send('Make the buttons bigger', {}, { signal: stop.signal, onProgress: (w) => w.startsWith('Changing screen 2 of 2') && setTimeout(() => stop.abort(), 5) });
    expect(r.reply.kind).toBe('stopped');
    expect(r.reply.text).toMatch(/^Stopped\./);
    expect(r.reply.saved).toEqual([{ screen: 'form', name: 'Form', version: 2 }]);
    const s = studio.readSketch(bp, 'booking')!;
    expect(s.screens.find((x) => x.id === 'form')!.chosen).toBe(2);
    expect(s.screens.find((x) => x.id === 'confirmation')!.variants.map((v) => v.version)).toEqual([1]);
    expect(chats.readConversation(bp, BOOKING, 'main').messages.at(-1)).toMatchObject({ role: 'designer', kind: 'stopped' });
  });

  it('Stop before any screen is finished changes nothing', async () => {
    booking();
    const before = snapshot();
    const stop = new AbortController();
    answers.push(twoScreens(), (opts: RunOptions) =>
      new Promise<RunResult>((resolve) => {
        opts.signal?.addEventListener('abort', () => resolve({ ok: false, text: '', sessionId: 'session-1' } as RunResult), { once: true });
        setTimeout(() => stop.abort(), 5);
      }),
    );
    const r = await send('Make the buttons bigger', {}, { signal: stop.signal });
    expect(r.reply).toMatchObject({ kind: 'stopped', text: 'Stopped before anything was finished. Nothing changed.' });
    expect(snapshot()).toEqual(before);
  });

  it('a teammate changed the sketch while it worked: the save is refused with "Changed elsewhere, reload"', async () => {
    const s = booking();
    // While the first screen is drawn, a teammate renames the sketch.
    answers.push(twoScreens(), async () => {
      changeSketch(bp, 'booking', { name: 'Booking (theirs)' }, studio.readSketch(bp, 'booking')!.stamp);
      return { ok: true, text: '', structured: drawn('Form'), sessionId: 'session-1' } as RunResult;
    });
    answers.push(drawn('Confirmation'));
    const r = await send('Make the buttons bigger', { stamp: s.stamp });
    expect(r.reply).toMatchObject({ kind: 'failed', text: studio.CHANGED_ELSEWHERE });
    const after = studio.readSketch(bp, 'booking')!;
    expect(after.name).toBe('Booking (theirs)');
    expect(after.screens.map((x) => x.variants.length)).toEqual([1, 1]);
  });
});

describe('done when 3: a picture as a reference, and the answer in the language of the message', () => {
  it('keeps the screenshot with the message, gives it to the Designer to read, and asks for the answer in Arabic', async () => {
    booking();
    answers.push({ kind: 'answer', reply: 'الأزرق هادئ وواضح على الأبيض.' });
    const data = `data:image/png;base64,${PNG.toString('base64')}`;
    const r = await send('لماذا هذا اللون؟', { pictures: [{ name: 'shot.png', type: 'image/png', data }] });
    expect(r.reply.text).toBe('الأزرق هادئ وواضح على الأبيض.');
    const person = chats.readConversation(bp, BOOKING, 'main').messages[0]!;
    expect(person.pictures).toEqual(['main-m1-1.png']);
    const file = path.join(bp.studioLocalDir, 'chats', 'booking', 'pictures', 'main-m1-1.png');
    expect(fs.readFileSync(file)).toEqual(PNG);
    expect(calls[0]!.prompt).toContain(file);
    expect(calls[0]!.addDirs).toContain(path.dirname(file));
    expect(calls[0]!.prompt).toContain('Write "reply" in Arabic');
    // Nothing of it is in the project.
    expect(fs.existsSync(path.join(bp.studioDir, 'sketches', 'booking', 'pictures'))).toBe(false);
  });

  it('tells Arabic from English by most of the letters', () => {
    expect(languageOf('لماذا هذا اللون؟')).toBe('Arabic');
    expect(languageOf('اجعل زر Book أكبر')).toBe('Arabic');
    expect(languageOf('Why this color?')).toBe('English');
    expect(languageOf('Make the زر bigger')).toBe('English');
  });
});

describe('done when 4: conversations come back, and New conversation starts fresh without losing versions', () => {
  it('keeps the old conversation, starts an empty one in a fresh session, and every version stays', async () => {
    booking();
    answers.push(twoScreens(), drawn('Form'), drawn('Confirmation'));
    await send('Make the buttons bigger');
    const versions = studio.readSketch(bp, 'booking')!.screens.map((s) => s.variants.map((v) => v.version));

    const fresh = chats.newConversation(bp, BOOKING);
    expect(fresh).toMatchObject({ id: 'talk-2', messages: 0 });
    // Pressing it again on the empty one does not pile up empty chats.
    expect(chats.newConversation(bp, BOOKING).id).toBe('talk-2');
    expect(chats.currentConversation(bp, BOOKING)).toBe('talk-2');
    expect(chats.listConversations(bp, BOOKING).map((c) => [c.id, c.messages])).toEqual([
      ['talk-2', 0],
      ['main', 2],
    ]);
    // The old one comes back as it was left.
    expect(chats.readConversation(bp, BOOKING, 'main').messages.map((m) => m.text)).toEqual(['Make the buttons bigger', expect.stringContaining('New versions: Form v2, Confirmation v2')]);
    expect(studio.readSketch(bp, 'booking')!.screens.map((s) => s.variants.map((v) => v.version))).toEqual(versions);

    // The new conversation goes to the current one, in a fresh session.
    answers.push({ kind: 'answer', reply: 'Yes.' });
    const r = await send('Is the form clear?');
    expect(r.chat).toBe('talk-2');
    expect(calls.at(-1)!.resume).toBeUndefined();
    expect(chats.readConversation(bp, BOOKING, 'talk-2').messages).toHaveLength(2);
  });

  it("answers the start page's first message, which stays the first one, reading it as the conversation so far", async () => {
    const made = startSketch(bp, { message: 'Booking' });
    answers.push({ kind: 'answer', reply: 'Tell me what the booking page should hold.' });
    const r = await sendChatMessage(bp, { owner: { kind: 'sketch', id: made.id } }, { place });
    expect(r.reply.kind).toBe('answer');
    expect(calls[0]!.prompt).toContain('The person writes:\nBooking');
    expect(chats.readConversation(bp, { kind: 'sketch', id: made.id }, 'main').messages.map((m) => m.role)).toEqual(['person', 'designer']);
  });

  it('a later fresh session reads the conversation so far as data', async () => {
    booking();
    chats.addChatMessage(bp, BOOKING, 'main', { role: 'person', text: 'A booking page for older patients' });
    chats.addChatMessage(bp, BOOKING, 'main', { role: 'designer', text: 'Here are two variants.', kind: 'changed' });
    answers.push({ kind: 'answer', reply: 'The one-page variant.' });
    await send('Which variant suits older patients?');
    expect(calls[0]!.prompt).toContain('The conversation so far');
    expect(calls[0]!.prompt).toContain('Person: A booking page for older patients');
  });
});

describe('done when 5: squad studio chat in the terminal', () => {
  const printed = () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => {
      lines.push(String(s));
      return true;
    }) as never);
    return lines;
  };

  it('without the board open: answers here, prints it, makes no version, and the board shows the same message and answer', async () => {
    booking();
    const before = snapshot();
    answers.push({ kind: 'answer', reply: 'The one-page variant: everything is visible at once.' });
    const lines = printed();
    await studioChat(bp, null, 'booking', ['Which variant suits older patients?'], {});
    vi.restoreAllMocks();
    const text = lines.join('');
    expect(text).toContain('The one-page variant: everything is visible at once.');
    expect(text).toContain('No version was made.');
    expect(snapshot()).toEqual(before);
    // What the board reads for the sketch's chat.
    const app = new Hono();
    mountStudioApi(app, { paths: buildPaths(tmp) });
    const convo = (await (await app.request('/api/v1/studio/sketches/booking/chats/main')).json()) as { messages: { role: string; text: string }[] };
    expect(convo.messages.map((m) => [m.role, m.text])).toEqual([
      ['person', 'Which variant suits older patients?'],
      ['designer', 'The one-page variant: everything is visible at once.'],
    ]);
  });

  it("with the board open: it is the board's own call, so both show the same conversation", async () => {
    booking();
    const app = new Hono();
    mountStudioApi(app, { paths: buildPaths(tmp) });
    const api = {
      async call<T>(method: string, p: string, payload?: unknown): Promise<T> {
        const res = await app.request(`/api/v1${p}`, { method, headers: { 'content-type': 'application/json' }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
        const data = (await res.json()) as T & { error?: string };
        if (!res.ok) throw new Error(data.error);
        return data;
      },
    };
    answers.push({ kind: 'answer', reply: 'The one-page variant.' });
    const lines = printed();
    await studioChat(bp, api, 'Booking', ['Which variant suits older patients?'], {});
    vi.restoreAllMocks();
    expect(lines.join('')).toContain('The one-page variant.');
    expect(chats.readConversation(bp, BOOKING, 'main').messages.map((m) => m.text)).toEqual(['Which variant suits older patients?', 'The one-page variant.']);
  });

  it('names the sketches when the name is not one', async () => {
    booking();
    // The sample board has its own sketches too (US-06): every one is named, booking among them.
    await expect(studioChat(bp, null, 'no-such-sketch', ['Hi'], {})).rejects.toThrow(/^This project has no sketch "no-such-sketch"\. Its sketches: .*\bbooking\b.*\.$/);
  });
});

describe("the sample board's fixed replies", () => {
  const screens = [{ id: 'form', name: 'Form' }];
  it('sorts a question, a maybe, a missing action and a change, in English and Arabic', () => {
    expect(demoSort('Why this color?', 'English', undefined, screens).kind).toBe('answer');
    expect(demoSort('Maybe a softer blue?', 'English', undefined, screens)).toMatchObject({ kind: 'ask', reply: 'Do you want me to change it?' });
    expect(demoSort('Export this as PDF', 'English', undefined, screens)).toMatchObject({ kind: 'unavailable', action: 'export' });
    expect(demoSort('Add a mobile frame', 'English', undefined, screens)).toMatchObject({ kind: 'unavailable', action: 'add-frame' });
    expect(demoSort('Make the buttons bigger', 'English', undefined, screens)).toMatchObject({ kind: 'change', screens: [{ id: 'form' }] });
    expect(demoSort('Yes', 'English', 'ask', screens).kind).toBe('change');
    expect(demoSort('لماذا هذا اللون؟', 'Arabic', undefined, screens).reply).toMatch(/[؀-ۿ]/);
    // A question in Arabic, with more words after its question mark, is still a question.
    expect(demoSort('لماذا هذا اللون الأزرق؟ أريد شيئًا مثل هذه الصورة', 'Arabic', undefined, screens).kind).toBe('answer');
    expect(demoSort('نعم، غيّره', 'Arabic', 'ask', screens).kind).toBe('change');
    expect(demoSort('ربما أزرق أهدأ', 'Arabic', undefined, screens)).toMatchObject({ kind: 'ask', reply: 'هل تريد أن أغيّره؟' });
  });
});
