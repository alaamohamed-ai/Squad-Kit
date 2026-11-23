import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * US-15 Approve and reopen a screen (AB-140). Approve freezes the screen at the version it shows, as Approved with who
 * and when, kept on its own screen.yaml so a teammate gets it through git (AB-140.1). The one Studio store refuses every
 * change to an approved screen (a new drawing, a pick, a delete, a new status) with "Form is approved. Reopen it
 * first.", so the board, the terminal and the AI Designer meet the same lock. Reopen sets it back to Draft; the next
 * change makes a new version and every older one stays. Approve and Reopen add their line to the chat after the save
 * (AB-143.1). Claude Code itself never starts: its direct run is replaced.
 */

const calls: RunOptions[] = [];
const answers: unknown[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, text: '', structured: answers.shift(), sessionId: opts.resume ?? 'session-1' } as RunResult;
  },
}));

const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const studio = await import('../src/board/studio.js');
const actions = await import('../src/board/studio-actions.js');
const { screenFile, sketchesDir } = await import('../src/board/studio-paths.js');
const { readConversation } = await import('../src/board/studio-chats.js');
const { sendChatMessage } = await import('../src/engine/studio-chat.js');
const { chatSortPrompt } = await import('../src/engine/studio-chat-prompts.js');
const { demoSort } = await import('../src/engine/studio-chat-demo.js');
const { mountStudioApi } = await import('../src/console/api/studio.js');
const { buildPaths } = await import('../src/core/paths.js');
const { chatJobsDone } = await import('../src/engine/studio-chat-runs.js');
const cli = await import('../src/commands/studio.js');
const lib = await import('../console-ui/src/lib/studio.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
const place = async () => () => undefined;
const BOTH = ['desktop', 'mobile'];
const page = (words: string) => `<!doctype html><html><body><h1>${words}</h1><button>Book visit</button></body></html>`;
const pages = (words: string) => ({ desktop: page(`${words}, wide`), mobile: page(`${words}, small`) });

/** The person on this computer is Alaa; the board is a live one, so the chat runs the (replaced) AI tool. */
const asAlaa = () => writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', quality: 'thrifty', user: { ...(readMeta(bp).user ?? {}), name: 'Alaa' } } as never);

/** "Booking" with Form at v3 (drawn three times) and Confirmation at v1, both Draft. */
function booking() {
  const made = actions.createSketch(bp, { name: 'Booking', frames: BOTH, screens: [{ name: 'Form' }, { name: 'Confirmation' }] });
  let s = studio.saveDrawnScreens(bp, 'booking', [{ id: 'form', name: 'Form', frames: pages('Form v1') }, { id: 'confirmation', name: 'Confirmation', frames: pages('Done v1') }], made.stamp).sketch;
  s = studio.addVariant(bp, 'booking', 'form', { frames: pages('Form v2'), choose: true }, s.stamp);
  s = studio.addVariant(bp, 'booking', 'form', { frames: pages('Form v3'), choose: true }, s.stamp);
  return actions.getSketch(bp, 'booking');
}

const screenYaml = (screen: string) => yaml.load(fs.readFileSync(screenFile(bp, 'booking', screen), 'utf8')) as Record<string, unknown>;
const form = () => actions.getSketch(bp, 'booking').screens.find((s) => s.id === 'form')!;
const lines = () => readConversation(bp, { kind: 'sketch', id: 'booking' }, 'main').messages.map((m) => m.text);

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

const approve = (stamp: string, chat: string | null = 'main') => actions.approveSketchScreen(bp, 'booking', 'form', stamp, { chat });
const send = (text: string) => sendChatMessage(bp, { owner: { kind: 'sketch', id: 'booking' }, chat: 'main', text, lookingAt: { screen: 'form', frame: 'desktop' } }, { place });

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-approve-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50, studio: false });
  asAlaa();
});

afterEach(async () => {
  await chatJobsDone();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('done when 1: Approve screen freezes Form at v3, Approved by Alaa, with the time', () => {
  it('keeps v3, writes the approval on screen.yaml and adds "Alaa approved Form at v3" to the chat after the save', () => {
    const s = booking();
    expect(form()).toMatchObject({ status: 'draft', chosen: 3 });
    const before = Date.now();
    const r = approve(s.stamp);
    expect(r.done).toMatchObject({ screen: 'form', screenName: 'Form', version: 3, by: 'Alaa' });
    expect(Date.parse(r.done!.at)).toBeGreaterThanOrEqual(before - 1000);
    // It stays at v3: nothing new is drawn.
    expect(form()).toMatchObject({ status: 'approved', chosen: 3, approved: { version: 3, by: 'Alaa', at: r.done!.at } });
    expect(form().variants.map((v) => v.version)).toEqual([1, 2, 3]);
    // Kept on the screen's own file, so a teammate gets it through git.
    expect(screenYaml('form')).toMatchObject({ status: 'approved', chosen: 3, approved: { version: 3, by: 'Alaa', at: r.done!.at }, edited: { by: 'Alaa' } });
    expect(r.line).toMatchObject({ role: 'action', text: 'Alaa approved Form at v3', approval: { screen: 'form', version: 3 } });
    expect(lines()).toEqual(['Alaa approved Form at v3']);
  });

  it('a Ready screen is approved the same way', () => {
    let s = booking();
    s = actions.changeScreen(bp, 'booking', 'form', { status: 'ready' }, s.stamp);
    expect(approve(s.stamp).done).toMatchObject({ version: 3 });
    expect(form().status).toBe('approved');
  });

  it('a stale stamp is refused with "Changed elsewhere, reload": nothing is written and no line is added', () => {
    const s = booking();
    actions.changeScreen(bp, 'booking', 'confirmation', { status: 'ready' }, s.stamp);
    const was = snapshot();
    expect(() => approve(s.stamp)).toThrow('Changed elsewhere, reload');
    expect(snapshot()).toEqual(was);
    expect(lines()).toEqual([]);
  });

  it('a screen with no drawing yet cannot be approved; approving twice writes nothing the second time', () => {
    let s = booking();
    s = actions.addScreen(bp, 'booking', { name: 'Payment' }, s.stamp);
    expect(() => actions.approveSketchScreen(bp, 'booking', 'payment', s.stamp)).toThrow('Payment has no drawing yet. Draw it first, then approve it.');
    const once = approve(s.stamp);
    const was = snapshot();
    const twice = approve(once.sketch.stamp);
    expect(twice).toMatchObject({ done: null, line: null });
    expect(snapshot()).toEqual(was);
    expect(lines()).toEqual(['Alaa approved Form at v3']);
  });

  it('is refused while the AI Designer works on that conversation, before anything is written', () => {
    const s = booking();
    const was = snapshot();
    expect(() => actions.approveSketchScreen(bp, 'booking', 'form', s.stamp, { chat: 'main', busy: () => true })).toThrow(actions.StudioDesignerWorking);
    expect(snapshot()).toEqual(was);
  });
});

describe('done when 2: an approved screen is locked in the store, from the board and the terminal', () => {
  it('a new drawing, a pick, a delete and a new status are each refused with "Form is approved. Reopen it first."', () => {
    const s = approve(booking().stamp).sketch;
    const was = snapshot();
    const LOCKED = 'Form is approved. Reopen it first.';
    expect(() => studio.addVariant(bp, 'booking', 'form', { frames: pages('Form v4') }, s.stamp)).toThrow(LOCKED);
    expect(() => studio.saveDrawnScreens(bp, 'booking', [{ id: 'confirmation', name: 'Confirmation', frames: pages('Done v2') }, { id: 'form', name: 'Form', frames: pages('Form v4') }], s.stamp)).toThrow(LOCKED);
    expect(() => studio.saveAskVariants(bp, 'booking', { id: 'ask-1' }, [{ id: 'form', name: 'Form', variants: [{ letter: 'A', name: 'One page', idea: 'All on one page.', frames: pages('Form A') }] }], s.stamp)).toThrow(LOCKED);
    expect(() => studio.saveScreenVariants(bp, 'booking', { id: 'form', name: 'Form' }, [pages('Form A')], s.stamp)).toThrow(LOCKED);
    expect(() => actions.pickScreenVariant(bp, 'booking', 'form', 1, s.stamp)).toThrow(studio.StudioScreenApproved);
    expect(() => actions.deleteScreen(bp, 'booking', 'form', s.stamp)).toThrow(LOCKED);
    expect(() => actions.changeScreen(bp, 'booking', 'form', { status: 'draft' }, s.stamp)).toThrow(LOCKED);
    // Not one file changed: the drawing of Confirmation in the same save was refused with it.
    expect(snapshot()).toEqual(was);
    expect(form()).toMatchObject({ status: 'approved', chosen: 3 });
    // A rename or a move changes no design: they are kept, with the approval.
    actions.changeScreen(bp, 'booking', 'form', { name: 'Booking form' }, s.stamp);
    expect(form()).toMatchObject({ name: 'Booking form', status: 'approved', approved: { version: 3, by: 'Alaa' } });
  });

  it('the board answers a change to Form with 409 and the plain words', async () => {
    const s = approve(booking().stamp).sketch;
    const app = new Hono();
    mountStudioApi(app, { paths: buildPaths(tmp) });
    const res = await app.request('/api/v1/studio/sketches/booking/screens/form/pick', { method: 'POST', body: JSON.stringify({ version: 1, stamp: s.stamp }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Form is approved. Reopen it first.', approved: { id: 'form', name: 'Form' } });
    const del = await app.request(`/api/v1/studio/sketches/booking/screens/form?stamp=${encodeURIComponent(s.stamp)}`, { method: 'DELETE' });
    expect(del.status).toBe(409);
    // The sketch read sends the approval: who, when and the version.
    const read = (await (await app.request('/api/v1/studio/sketches/booking')).json()) as { screens: { id: string; status: string; approved?: unknown }[] };
    expect(read.screens.find((x) => x.id === 'form')).toMatchObject({ status: 'approved', approved: { version: 3, by: 'Alaa' } });
  });

  it('the terminal refuses a pick and a delete of Form with the plain words, before asking anything', async () => {
    approve(booking().stamp);
    const was = snapshot();
    await expect(cli.studioSketchPick(bp, null, 'Booking', 'Form', 'v1', {})).rejects.toThrow('Form is approved. Reopen it first.');
    const ask = vi.fn(async (_question: string) => true);
    await expect(cli.studioScreenDelete(bp, null, 'Booking', 'Form', {}, ask)).rejects.toThrow('Form is approved. Reopen it first.');
    expect(ask).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(was);
  });

  it('squad studio sketch screen approve does what the button does, line included', async () => {
    booking();
    await cli.studioScreenApprove(bp, null, 'booking', 'form', {});
    expect(form()).toMatchObject({ status: 'approved', approved: { version: 3, by: 'Alaa' } });
    expect(lines()).toEqual(['Alaa approved Form at v3']);
  });
});

describe('done when 3: the AI Designer leaves Form out of a change, says so, and answers a question as usual', () => {
  it('"make the main buttons bigger" on both screens: Confirmation gets v2, Form stays at v3; the question changes nothing', async () => {
    approve(booking().stamp);
    answers.push(
      { kind: 'change', reply: 'I will make the main buttons bigger on both screens.', screens: [{ id: 'form', name: 'Form', change: 'Bigger main button' }, { id: 'confirmation', name: 'Confirmation', change: 'Bigger main button' }] },
      { screens: [{ name: 'Confirmation', frames: [{ frame: 'desktop', html: page('Done, bigger, wide') }, { frame: 'mobile', html: page('Done, bigger, small') }] }], note: 'The button is bigger.' },
    );
    const r = await send('Make the main buttons bigger on both screens');
    expect(r.reply).toMatchObject({ kind: 'changed', saved: [{ screen: 'confirmation', name: 'Confirmation', version: 2 }] });
    expect(r.reply.text).toContain('Form is approved, so I did not change it. Reopen it first.');
    // The Designer was told Form is locked, and drew only Confirmation.
    expect(calls[0]!.prompt).toContain('Form (id form, approved and locked: never change it, it needs Reopen first)');
    expect(calls[0]!.prompt).toContain('"Form" is approved: locked until the person reopens it with Reopen.');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain('"Confirmation"');
    expect(form()).toMatchObject({ status: 'approved', chosen: 3 });
    expect(form().variants.map((v) => v.version)).toEqual([1, 2, 3]);

    answers.push({ kind: 'answer', reply: 'Blue marks the one thing to do on the page.' });
    const q = await send('Why is the button blue?');
    expect(q.reply).toMatchObject({ kind: 'answer', text: 'Blue marks the one thing to do on the page.' });
  });

  it('a change that names only Form changes nothing and says it needs Reopen first; "Use A" on Form is refused the same way', async () => {
    approve(booking().stamp);
    const was = snapshot();
    answers.push({ kind: 'change', reply: 'I will change Form.', screens: [{ id: 'form', name: 'Form', change: 'Rounder' }] });
    const r = await send('Make the Form button rounder');
    expect(r.reply).toMatchObject({ kind: 'answer', text: 'Form is approved, so I did not change it. Reopen it first.' });
    answers.push({ kind: 'change', reply: 'I will draw 2 variants.', variants: 2, screens: [{ id: 'form', name: 'Form', change: 'Variants' }] });
    expect((await send('Draw 2 variants of Form')).reply.text).toBe('Form is approved, so I did not change it. Reopen it first.');
    answers.push({ kind: 'change', action: 'pick-variant', letter: 'A', reply: 'I will use A.', screens: [{ id: 'form', name: 'Form', change: 'Use A' }] });
    expect((await send('Use A')).reply.text).toBe('Form is approved, so I did not change it. Reopen it first.');
    // Only the chat on this computer changed: no project file.
    expect(snapshot()).toEqual(was);
  });

  it('the sample Designer points to the buttons instead of approving from the chat', () => {
    expect(demoSort('Approve the Form screen', 'English', undefined, [{ id: 'form', name: 'Form' }])).toMatchObject({ kind: 'unavailable', action: 'approve-screen' });
    expect(chatSortPrompt({ project: 'p', target: { kind: 'sketch', name: 'Booking', frames: ['desktop'], screens: [{ id: 'form', name: 'Form', files: {} }] }, pictures: [], message: 'hi', language: 'English', earlier: [] })).not.toContain('is approved: locked');
  });
});

describe('done when 4: Reopen sets Form back to Draft; the next change saves v4 and v3 stays', () => {
  it('reopens with the line "Alaa reopened Form", then one change from the chat saves v4', async () => {
    const approved = approve(booking().stamp);
    const r = actions.reopenSketchScreen(bp, 'booking', 'form', approved.sketch.stamp, { chat: 'main' });
    expect(r.done).toMatchObject({ screen: 'form', version: 3, reopened: true, by: 'Alaa' });
    expect(form()).toMatchObject({ status: 'draft', chosen: 3 });
    expect(form().approved).toBeUndefined();
    expect(screenYaml('form').approved).toBeUndefined();
    expect(lines()).toEqual(['Alaa approved Form at v3', 'Alaa reopened Form']);

    answers.push(
      { kind: 'change', reply: 'I will make the button bigger.', screens: [{ id: 'form', name: 'Form', change: 'Bigger button' }] },
      { screens: [{ name: 'Form', frames: [{ frame: 'desktop', html: page('Form v4, wide') }, { frame: 'mobile', html: page('Form v4, small') }] }], note: 'Bigger.' },
    );
    const sent = await send('Make the button bigger');
    expect(sent.reply).toMatchObject({ kind: 'changed', saved: [{ screen: 'form', version: 4 }] });
    expect(form()).toMatchObject({ status: 'draft', chosen: 4 });
    // v3 is still kept, as it was approved.
    expect(form().variants.map((v) => v.version)).toEqual([1, 2, 3, 4]);
    expect(form().variants.find((v) => v.version === 3)!.frames.desktop).toBe(page('Form v3, wide'));
  });

  it('the terminal asks "Are you sure?" first: No leaves Form Approved, Yes reopens it', async () => {
    approve(booking().stamp);
    const no = vi.fn(async (_question: string) => false);
    await cli.studioScreenReopen(bp, null, 'Booking', 'form', {}, no);
    expect(no.mock.calls[0]![0]).toContain('Are you sure?');
    expect(form().status).toBe('approved');
    await cli.studioScreenReopen(bp, null, 'Booking', 'form', {}, async () => true);
    expect(form().status).toBe('draft');
    expect(lines()).toEqual(['Alaa approved Form at v3', 'Alaa reopened Form']);
  });

  it('a stale stamp is refused and Form stays Approved', () => {
    const approved = approve(booking().stamp);
    actions.changeScreen(bp, 'booking', 'confirmation', { status: 'ready' }, approved.sketch.stamp);
    expect(() => actions.reopenSketchScreen(bp, 'booking', 'form', approved.sketch.stamp, { chat: 'main' })).toThrow('Changed elsewhere, reload');
    expect(form().status).toBe('approved');
    expect(lines()).toEqual(['Alaa approved Form at v3']);
  });
});

describe('done when 5: the Booking card counts "2 of 3 approved", for a teammate too', () => {
  it('counts the approved screens, and a teammate who gets the files through git sees the same count and who approved each', () => {
    let s = booking();
    s = actions.addScreen(bp, 'booking', { name: 'Payment' }, s.stamp);
    s = actions.getSketch(bp, studio.addVariant(bp, 'booking', 'payment', { frames: pages('Pay') }, s.stamp).id);
    s = approve(s.stamp).sketch as never;
    s = actions.approveSketchScreen(bp, 'booking', 'confirmation', s.stamp).sketch as never;
    const card = actions.sketchList(bp).find((c) => c.id === 'booking')!.card;
    expect(card).toMatchObject({ screens: 3, approved: 2 });
    expect(lib.approvedText(card.approved, card.screens)).toBe('2 of 3 approved');

    // The teammate's copy: the same files, read in another project folder.
    const other = boardPaths(path.join(tmp, 'teammate', '.squad'));
    fs.cpSync(sketchesDir(bp), sketchesDir(other), { recursive: true });
    expect(actions.sketchList(other).find((c) => c.id === 'booking')!.card).toMatchObject({ screens: 3, approved: 2 });
    const theirs = actions.getSketch(other, 'booking').screens;
    expect(theirs.filter((x) => x.status === 'approved').map((x) => [x.name, x.approved?.by, x.approved?.version])).toEqual([
      ['Form', 'Alaa', 3],
      ['Confirmation', 'Alaa', 1],
    ]);
  });

  it('an older screen.yaml that says "approved" with no mark is read as approved, with no who, and reading writes nothing', () => {
    booking();
    const file = screenFile(bp, 'booking', 'form');
    fs.writeFileSync(file, yaml.dump({ name: 'Form', order: 1, status: 'approved', chosen: 3 }));
    const was = snapshot();
    expect(form()).toMatchObject({ status: 'approved', chosen: 3 });
    expect(form().approved).toBeUndefined();
    expect(actions.sketchList(bp)[0]!.card.approved).toBe(1);
    expect(lib.approvedByText(form().approved)).toBe('Approved');
    // Still locked, and still reopened the usual way.
    expect(() => actions.pickScreenVariant(bp, 'booking', 'form', 1, form() && actions.getSketch(bp, 'booking').stamp)).toThrow('Form is approved. Reopen it first.');
    expect(snapshot()).toEqual(was);
    const r = actions.reopenSketchScreen(bp, 'booking', 'form', actions.getSketch(bp, 'booking').stamp);
    expect(r.done).toMatchObject({ version: 3, reopened: true });
  });

  it('a hand-broken approval or one left on a draft is not read: the read never fails', () => {
    booking();
    const file = screenFile(bp, 'booking', 'form');
    fs.writeFileSync(file, yaml.dump({ name: 'Form', order: 1, status: 'approved', chosen: 3, approved: { version: 'three', at: 'soon' } }));
    expect(form()).toMatchObject({ status: 'approved' });
    expect(form().approved).toBeUndefined();
    fs.writeFileSync(file, yaml.dump({ name: 'Form', order: 1, status: 'draft', chosen: 3, approved: { version: 3, at: new Date().toISOString(), by: 'Sara' } }));
    expect(form().approved).toBeUndefined();
  });
});

describe('the board helpers', () => {
  it('say "Approved by Alaa · time", ask "Are you sure?" naming the version that stays, and name the status', () => {
    expect(lib.approvedByText({ version: 3, at: '2026-11-23T14:05:00.000Z', by: 'Alaa' })).toMatch(/^Approved by Alaa · .+/);
    expect(lib.approvedByText({ version: 3, at: 'not a time' })).toBe('Approved');
    expect(lib.reopenQuestion('Form', 3)).toEqual({ title: 'Reopen "Form"?', holds: 'Are you sure? Form goes back to Draft and its lock goes away. The next change makes a new version; v3 stays.' });
    expect(lib.statusLabel('ready')).toBe('Ready');
    expect(lib.isApproved({ status: 'approved' })).toBe(true);
    expect(lib.approvalPath('booking', 'form', 'reopen')).toBe('/api/v1/studio/sketches/booking/screens/form/reopen');
  });
});
