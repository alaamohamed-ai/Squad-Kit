import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * US-52 (AB-177) on the board server: the chat routes for sketches and design systems. A message is kept at once and
 * answered in the background, one at a time per conversation; the board follows what the Designer is doing and can
 * stop it, keeping the finished screens. The sample board answers with fixed replies. Claude Code never starts here.
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
const { createDesignSystem } = await import('../src/board/studio-actions.js');
const { mountStudioApi } = await import('../src/console/api/studio.js');
const { chatJobsDone } = await import('../src/engine/studio-chat-runs.js');
const { buildPaths } = await import('../src/core/paths.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
let app: Hono;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const page = (words: string) => `<!doctype html><html><head></head><body>${words}</body></html>`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const call = async <T = any>(method: string, p: string, body?: unknown) => {
  const res = await app.request(`/api/v1/studio${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, type, data: (type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())) as T };
};

function booking() {
  const s = studio.saveSketch(bp, { name: 'Booking', frames: ['desktop'], screens: [{ name: 'Form' }, { name: 'Confirmation' }] });
  studio.saveDrawnScreens(bp, 'booking', [{ id: 'form', name: 'Form', frames: { desktop: page('Form') } }, { id: 'confirmation', name: 'Confirmation', frames: { desktop: page('Done') } }], s.stamp);
}

/** Waits until the conversation says what the test waits for. */
async function until(p: string, ok: (c: any) => boolean) {
  for (let i = 0; i < 400; i++) {
    const c = (await call('GET', p)).data;
    if (ok(c)) return c;
    await sleep(10);
  }
  throw new Error(`Waited too long on ${p}`);
}

beforeEach(() => {
  answers.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-chat-api-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(buildPaths(tmp).squadDir);
  // No sample sketches: each test makes its own "Booking".
  seedDemoBoard(bp, { speed: 50, studio: false });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', quality: 'thrifty' });
  app = new Hono();
  mountStudioApi(app, { paths: buildPaths(tmp) });
});

afterEach(async () => {
  await chatJobsDone();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the chat routes', () => {
  it('lists, opens and answers a question in the background, with no version made', async () => {
    booking();
    const before = studio.readSketch(bp, 'booking')!.stamp;
    expect((await call('GET', '/sketches/booking/chats')).data).toEqual({ conversations: [], current: 'main' });
    expect((await call('GET', '/sketches/booking/chats/main')).data).toMatchObject({ id: 'main', owner: { kind: 'sketch', id: 'booking', name: 'Booking' }, messages: [], working: null });

    answers.push({ kind: 'answer', reply: 'The blue marks the one thing to do.' });
    const sent = await call('POST', '/sketches/booking/chats/main/messages', { text: 'Why this color?', lookingAt: { screen: 'form', frame: 'desktop' } });
    expect(sent.status).toBe(200);
    expect(sent.data.messages).toMatchObject([{ role: 'person', text: 'Why this color?' }]);
    expect(sent.data.working).toMatchObject({ doing: expect.any(String) });
    await chatJobsDone();
    const done = (await call('GET', '/sketches/booking/chats/main')).data;
    expect(done.working).toBeNull();
    expect(done.messages.map((m: any) => [m.role, m.kind ?? null, m.text])).toEqual([
      ['person', null, 'Why this color?'],
      ['designer', 'answer', 'The blue marks the one thing to do.'],
    ]);
    expect(studio.readSketch(bp, 'booking')!.stamp).toBe(before);
    expect((await call('GET', '/sketches/booking/chats')).data.conversations).toMatchObject([{ id: 'main', messages: 2 }]);
  });

  it('answers one message at a time per conversation: a second one while it works is refused and not kept', async () => {
    booking();
    let finish: (() => void) | null = null;
    answers.push(() => new Promise<RunResult>((resolve) => (finish = () => resolve({ ok: true, text: '', structured: { kind: 'answer', reply: 'Yes.' }, sessionId: 'session-1' } as RunResult))));
    await call('POST', '/sketches/booking/chats/main/messages', { text: 'Is it clear?' });
    for (let i = 0; i < 400 && !finish; i++) await sleep(10);
    const again = await call('POST', '/sketches/booking/chats/main/messages', { text: 'And now?' });
    expect(again.status).toBe(409);
    expect(again.data).toMatchObject({ busy: true });
    (finish as unknown as () => void)();
    await chatJobsDone();
    expect((await call('GET', '/sketches/booking/chats/main')).data.messages.map((m: any) => m.text)).toEqual(['Is it clear?', 'Yes.']);
  });

  it('shows "Changing screen 2 of 2" while it works; Stop keeps the finished screen as a new version and says it stopped', async () => {
    booking();
    answers.push(
      { kind: 'change', reply: 'Bigger buttons on both.', screens: [{ id: 'form', name: 'Form', change: 'bigger' }, { id: 'confirmation', name: 'Confirmation', change: 'bigger' }] },
      { screens: [{ name: 'Form', frames: [{ frame: 'desktop', html: page('Form, bigger') }] }], note: 'Bigger.' },
      (opts: RunOptions) =>
        new Promise<RunResult>((resolve) => {
          const end = () => resolve({ ok: false, text: '', sessionId: 'session-1' } as RunResult);
          if (opts.signal?.aborted) end();
          else opts.signal?.addEventListener('abort', end, { once: true });
        }),
    );
    await call('POST', '/sketches/booking/chats/main/messages', { text: 'Make the buttons bigger' });
    const working = await until('/sketches/booking/chats/main', (c) => /^Changing screen 2 of 2/.test(c.working?.doing ?? ''));
    expect(working.working.doing).toBe('Changing screen 2 of 2: Confirmation');
    expect((await call('POST', '/sketches/booking/chats/main/stop')).data).toEqual({ stopped: true });
    await chatJobsDone();
    const c = (await call('GET', '/sketches/booking/chats/main')).data;
    expect(c.working).toBeNull();
    expect(c.messages.at(-1)).toMatchObject({ role: 'designer', kind: 'stopped', saved: [{ screen: 'form', version: 2 }] });
    expect(c.messages.at(-1).text).toMatch(/^Stopped\./);
    const s = studio.readSketch(bp, 'booking')!;
    expect(s.screens.map((x) => [x.id, x.chosen])).toEqual([
      ['form', 2],
      ['confirmation', 1],
    ]);
    // Nothing works any more, so Stop says so.
    expect((await call('POST', '/sketches/booking/chats/main/stop')).data).toEqual({ stopped: false });
  });

  it('keeps a picture with the message and serves it back to the board', async () => {
    booking();
    answers.push({ kind: 'answer', reply: 'Seen.' });
    const sent = await call('POST', '/sketches/booking/chats/main/messages', { text: 'Like this one?', pictures: [{ name: 's.png', type: 'image/png', data: `data:image/png;base64,${PNG.toString('base64')}` }] });
    const url = sent.data.messages[0].pictures[0] as string;
    expect(url).toBe('/api/v1/studio/sketches/booking/chats/main/pictures/main-m1-1.png');
    const pic = await call('GET', url.replace('/api/v1/studio', ''));
    expect(pic.status).toBe(200);
    expect(pic.type).toBe('image/png');
    expect(pic.data).toEqual(PNG);
  });

  it('New conversation on a design system: the old one stays, and its page reads its own chats', async () => {
    createDesignSystem(bp, { name: 'Patient app', components: { button: page('<button>Go</button>') } });
    answers.push({ kind: 'answer', reply: 'Calm.' });
    await call('POST', '/design-systems/patient-app/chats/main/messages', { text: 'How does it feel?' });
    await chatJobsDone();
    const made = await call('POST', '/design-systems/patient-app/chats');
    expect(made.data).toMatchObject({ id: 'talk-2', messages: 0 });
    const list = (await call('GET', '/design-systems/patient-app/chats')).data;
    expect(list.current).toBe('talk-2');
    expect(list.conversations.map((r: any) => r.id)).toEqual(['talk-2', 'main']);
    expect((await call('GET', '/design-systems/patient-app/chats/main')).data.messages).toHaveLength(2);
  });

  it('refuses an empty message and a missing sketch, and writes nothing', async () => {
    booking();
    expect((await call('POST', '/sketches/booking/chats/main/messages', { text: '  ' })).status).toBe(400);
    expect((await call('GET', '/sketches/no-such-sketch/chats')).status).toBe(404);
    expect((await call('GET', '/sketches/booking/chats/talk-9')).status).toBe(404);
    expect(fs.existsSync(path.join(bp.studioLocalDir, 'chats', 'booking', 'main.json'))).toBe(false);
  });

  it('on the sample board, the fixed AI Designer answers a question and changes nothing', async () => {
    writeMeta(bp, { ...readMeta(bp), engine: 'demo' });
    booking();
    const stamp = studio.readSketch(bp, 'booking')!.stamp;
    await call('POST', '/sketches/booking/chats/main/messages', { text: 'Why this color?' });
    await chatJobsDone();
    const c = (await call('GET', '/sketches/booking/chats/main')).data;
    expect(c.messages.at(-1)).toMatchObject({ role: 'designer', kind: 'answer' });
    expect(c.messages.at(-1).text).toContain('Nothing changed');
    expect(studio.readSketch(bp, 'booking')!.stamp).toBe(stamp);
  });
});
