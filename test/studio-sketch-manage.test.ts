import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

/**
 * US-13 Manage sketches (AB-138): rename, duplicate and delete a sketch, from the card menu, the sketch header, the
 * terminal and the AI Designer's chat. One name per project, kept by the one Studio store (AB-138.1): names are
 * compared ignoring capital letters and spaces at the ends, a used one is refused, and copies are "Booking copy",
 * then "Booking copy 2". Every action brings the stamp it read and is refused with "Changed elsewhere, reload" when it
 * is old, with nothing changed (AB-129.1).
 */

const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const studio = await import('../src/board/studio.js');
const actions = await import('../src/board/studio-actions.js');
const { startSketch } = await import('../src/board/studio-start.js');
const paths = await import('../src/board/studio-paths.js');
const { mountStudioApi } = await import('../src/console/api/studio.js');
const { buildPaths } = await import('../src/core/paths.js');
const cli = await import('../src/commands/studio.js');
const { sendChatMessage } = await import('../src/engine/studio-chat.js');
const { demoSort } = await import('../src/engine/studio-chat-demo.js');
const { STUDIO_ACTIONS, sortProblem } = await import('../src/engine/studio-chat-prompts.js');

type BP = ReturnType<typeof boardPaths>;
let tmp: string;
let bp: BP;
const page = (words: string) => `<!doctype html><html><head></head><body>${words}</body></html>`;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-sketch-manage-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(buildPaths(tmp).squadDir);
  seedDemoBoard(bp, { speed: 50, studio: false });
  writeMeta(bp, { ...readMeta(bp), user: { ...readMeta(bp).user, name: 'Alaa' } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Every file in the project's Studio and this computer's part of it, with its bytes. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out[r] = fs.readFileSync(path.join(d, e.name)).toString('base64');
    }
  };
  walk(bp.studioDir, 'studio');
  walk(bp.studioLocalDir, 'local');
  return out;
}

/**
 * "Booking" with 2 screens, Form Approved: Form drawn twice with v1 chosen again (so "the drawing it shows now" is not
 * the newest), Confirmation drawn once. With a thumbnail and a conversation on this computer. "Login" beside it.
 */
function booking() {
  const ds = studio.saveDesignSystem(bp, { name: 'Patient app', tokens: { primary: '#1f6fb2' } });
  let s = studio.saveSketch(bp, { name: 'Booking', designSystem: { id: ds.id, version: 1 }, frames: ['desktop', 'mobile'], screens: [{ name: 'Form' }, { name: 'Confirmation' }] });
  s = studio.saveDrawnScreens(bp, 'booking', [{ id: 'form', name: 'Form', frames: { desktop: page('Form v1'), mobile: page('Form v1 mobile') } }, { id: 'confirmation', name: 'Confirmation', frames: { desktop: page('Done') } }], s.stamp).sketch;
  s = studio.addVariant(bp, 'booking', 'form', { frames: { desktop: page('Form v2') }, choose: true }, s.stamp);
  s = studio.pickVariant(bp, 'booking', 'form', 1, s.stamp);
  s = studio.saveSketch(bp, { id: 'booking', name: 'Booking', designSystem: { id: ds.id, version: 1 }, frames: ['desktop', 'mobile'], screens: [{ id: 'form', name: 'Form', order: 1, status: 'approved' }] }, s.stamp);
  studio.saveThumbnail(bp, 'booking', 'form', 1, Buffer.from('png'));
  studio.saveChat(bp, 'booking', 'main', { messages: [{ role: 'person', text: 'A booking page' }] });
  actions.createSketch(bp, { name: 'Login' });
  return studio.readSketch(bp, 'booking')!;
}

function patientProfile() {
  return actions.createSketch(bp, { name: 'Patient profile', screens: [{ name: 'Overview' }, { name: 'Visits' }, { name: 'Edit details' }] });
}

describe('the name rule (AB-138.1)', () => {
  it('renames "Booking" to "Book a visit", and refuses "Login" in plain words, keeping "Booking"', () => {
    const b = booking();
    const renamed = actions.changeSketch(bp, 'booking', { name: 'Book a visit' }, b.stamp);
    expect(renamed.name).toBe('Book a visit');
    expect(actions.sketchList(bp).find((c) => c.id === 'booking')?.name).toBe('Book a visit');
    expect(renamed.lastEdit).toMatchObject({ by: 'Alaa' });

    const before = snapshot();
    expect(() => actions.changeSketch(bp, 'booking', { name: 'Login' }, renamed.stamp)).toThrow('A sketch called "Login" already exists. Pick another name.');
    expect(() => actions.changeSketch(bp, 'booking', { name: 'Login' }, renamed.stamp)).toThrow(studio.StudioNameTaken);
    expect(snapshot()).toEqual(before);
    expect(actions.getSketch(bp, 'booking').name).toBe('Book a visit');
  });

  it('compares names ignoring capital letters and spaces at the ends', () => {
    const b = booking();
    for (const name of ['login', '  LOGIN ', 'Login ']) expect(() => actions.changeSketch(bp, 'booking', { name }, b.stamp)).toThrow('A sketch called "Login" already exists. Pick another name.');
    expect(() => actions.createSketch(bp, { id: 'other', name: 'login ' })).toThrow('A sketch called "Login" already exists.');
    // A sketch may change its own name's capitals: no other sketch has it.
    expect(actions.changeSketch(bp, 'booking', { name: 'BOOKING' }, b.stamp).name).toBe('BOOKING');
  });

  it('two "Login" sketches a merge brought both show, still save, and a rename of either must pick a free name', () => {
    booking();
    // A teammate's "Login", made on their computer and merged in.
    fs.cpSync(paths.sketchDir(bp, 'login'), paths.sketchDir(bp, 'login-2'), { recursive: true });
    expect(actions.listSketches(bp).filter((s) => s.name === 'Login').map((s) => s.id)).toEqual(['login', 'login-2']);
    const theirs = actions.getSketch(bp, 'login-2');
    // A save that keeps the name is not refused.
    const framed = actions.changeSketch(bp, 'login-2', { frames: ['desktop', 'mobile'] }, theirs.stamp);
    expect(framed.frames).toEqual(['desktop', 'mobile']);
    expect(() => actions.changeSketch(bp, 'login-2', { name: 'LOGIN' }, framed.stamp)).toThrow('A sketch called "Login" already exists.');
    expect(studio.freeSketchName(bp, 'Login', 'login-2')).toBe('Login 2');
    expect(actions.changeSketch(bp, 'login-2', { name: 'Login 2' }, framed.stamp).name).toBe('Login 2');
  });

  it('gives free names: the name itself, then "… 2", "… 3", and the start page uses it so its names never clash', () => {
    booking();
    expect(studio.freeSketchName(bp, 'Checkout')).toBe('Checkout');
    expect(studio.freeSketchName(bp, ' login ')).toBe('login 2');
    expect(studio.freeSketchName(bp, 'Booking copy')).toBe('Booking copy');
    expect(studio.freeSketchName(bp, 'x'.repeat(120) + 'y')).toBe('x'.repeat(120));
    const one = startSketch(bp, { message: 'Login' });
    expect(one).toEqual({ id: 'login-2', name: 'Login 2' });
    expect(startSketch(bp, { message: 'login' }).name).toBe('login 3');
  });
});

describe('Duplicate', () => {
  it('copies all screens at their current drawing, as Draft, with no conversation, twice: "Booking copy", then "Booking copy 2"', () => {
    const b = booking();
    const before = snapshot();
    const one = actions.duplicateSketch(bp, 'booking', b.stamp);
    const two = actions.duplicateSketch(bp, 'booking', b.stamp);
    expect([one.name, two.name]).toEqual(['Booking copy', 'Booking copy 2']);
    expect([one.id, two.id]).toEqual(['booking-copy', 'booking-copy-2']);

    for (const copy of [one, two]) {
      expect(copy.designSystem).toEqual(b.designSystem && { ...b.designSystem, name: 'Patient app' });
      expect(copy.frames).toEqual(['desktop', 'mobile']);
      expect(copy.screens.map((s) => [s.id, s.name, s.order, s.status, s.chosen])).toEqual([
        ['form', 'Form', 1, 'draft', 1],
        ['confirmation', 'Confirmation', 2, 'draft', 1],
      ]);
      // Each shows the drawing Booking shows now (Form's v1, picked again over v2), saved as its version 1.
      expect(copy.screens[0]!.variants.map((v) => [v.version, v.frames])).toEqual([[1, { desktop: page('Form v1'), mobile: page('Form v1 mobile') }]]);
      expect(copy.screens[1]!.variants.map((v) => [v.version, v.frames])).toEqual([[1, { desktop: page('Done') }]]);
      // No conversation and no thumbnails on this computer.
      expect(studio.readChat(bp, copy.id, 'main')).toBeNull();
      expect(fs.existsSync(paths.sketchChatsDir(bp, copy.id))).toBe(false);
      expect(fs.existsSync(paths.sketchThumbnailsDir(bp, copy.id))).toBe(false);
      // Marked as made by the person (AB-131.1).
      expect(copy.lastEdit).toMatchObject({ by: 'Alaa' });
    }

    const cards = Object.fromEntries(actions.sketchList(bp).map((c) => [c.id, c.card]));
    expect(cards['booking-copy']).toMatchObject({ screens: 2, approved: 0 });
    expect(cards['booking-copy-2']).toMatchObject({ screens: 2, approved: 0 });
    expect(cards.booking).toMatchObject({ screens: 2, approved: 1 });

    // Booking itself is unchanged: its files, its stamp, its conversation and thumbnail.
    const after = snapshot();
    for (const [file, bytes] of Object.entries(before)) expect(after[file], file).toBe(bytes);
    expect(studio.readSketch(bp, 'booking')!.stamp).toBe(b.stamp);
  });

  it('a copy of a copy is "Booking copy copy", and a sketch with nothing drawn copies its screens with no drawing', () => {
    const b = booking();
    const copy = actions.duplicateSketch(bp, 'booking', b.stamp);
    expect(actions.duplicateSketch(bp, copy.id, copy.stamp).name).toBe('Booking copy copy');
    const p = patientProfile();
    const pc = actions.duplicateSketch(bp, p.id, p.stamp);
    // A long name keeps " copy" and stays within 120 letters.
    const long = actions.createSketch(bp, { name: 'L'.repeat(120) });
    expect(actions.duplicateSketch(bp, long.id, long.stamp).name).toBe(`${'L'.repeat(115)} copy`);
    expect(pc.screens.map((s) => [s.name, s.status, s.chosen, s.variants.length])).toEqual([
      ['Overview', 'draft', null, 0],
      ['Visits', 'draft', null, 0],
      ['Edit details', 'draft', null, 0],
    ]);
  });
});

describe('Delete', () => {
  it('says how many screens it removed, and the sketch cannot be brought back', () => {
    const p = patientProfile();
    expect(actions.deleteSketch(bp, p.id, p.stamp)).toEqual({ deleted: 'patient-profile', name: 'Patient profile', screens: 3 });
    expect(fs.existsSync(paths.sketchDir(bp, 'patient-profile'))).toBe(false);
    expect(actions.listSketches(bp).map((s) => s.id)).not.toContain('patient-profile');
    expect(() => actions.getSketch(bp, 'patient-profile')).toThrow(actions.StudioNotFound);
  });
});

describe('a stale stamp: "Changed elsewhere, reload", and nothing changes', () => {
  it('refuses rename, duplicate and delete when a teammate changed the sketch since it was read', () => {
    const b = booking();
    // A teammate renames a screen after this stamp was read.
    actions.changeScreen(bp, 'booking', 'confirmation', { name: 'Booked' }, b.stamp);
    const before = snapshot();
    expect(() => actions.changeSketch(bp, 'booking', { name: 'Book a visit' }, b.stamp)).toThrow(studio.CHANGED_ELSEWHERE);
    expect(() => actions.duplicateSketch(bp, 'booking', b.stamp)).toThrow(studio.StudioChangedElsewhere);
    expect(() => actions.deleteSketch(bp, 'booking', b.stamp)).toThrow(studio.CHANGED_ELSEWHERE);
    expect(snapshot()).toEqual(before);
  });
});

describe('the board server calls', () => {
  let app: Hono;
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await app.request(`/api/v1/studio${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: (await res.json()) as any };
  };
  beforeEach(() => {
    app = new Hono();
    mountStudioApi(app, { paths: buildPaths(tmp) });
  });

  it('renames with PATCH, and a used name comes back as 409 with the plain message', async () => {
    const b = booking();
    const taken = await call('PATCH', '/sketches/booking', { name: 'login', stamp: b.stamp });
    expect(taken).toMatchObject({ status: 409, data: { error: 'A sketch called "Login" already exists. Pick another name.', nameTaken: { id: 'login', name: 'Login' } } });
    const ok = await call('PATCH', '/sketches/booking', { name: 'Book a visit', stamp: b.stamp });
    expect(ok).toMatchObject({ status: 200, data: { id: 'booking', name: 'Book a visit' } });
    expect((await call('GET', '/sketches')).data.sketches.find((s: any) => s.id === 'booking').name).toBe('Book a visit');
  });

  it('duplicates with POST …/duplicate and deletes with DELETE, which says how many screens went', async () => {
    const b = booking();
    const copy = await call('POST', '/sketches/booking/duplicate', { stamp: b.stamp });
    expect(copy).toMatchObject({ status: 200, data: { id: 'booking-copy', name: 'Booking copy' } });
    expect(copy.data.screens.map((s: any) => s.status)).toEqual(['draft', 'draft']);
    const gone = await call('DELETE', '/sketches/booking-copy', { stamp: copy.data.stamp });
    expect(gone).toEqual({ status: 200, data: { deleted: 'booking-copy', name: 'Booking copy', screens: 2 } });
  });

  it('refuses each with 409 "Changed elsewhere, reload" when the stamp is old, and a missing sketch with 404', async () => {
    const b = booking();
    actions.changeScreen(bp, 'booking', 'form', { name: 'Form 2' }, b.stamp);
    const before = snapshot();
    for (const [method, p, body] of [
      ['PATCH', '/sketches/booking', { name: 'Book a visit', stamp: b.stamp }],
      ['POST', '/sketches/booking/duplicate', { stamp: b.stamp }],
      ['DELETE', '/sketches/booking', { stamp: b.stamp }],
    ] as const) {
      expect(await call(method, p, body)).toEqual({ status: 409, data: { error: 'Changed elsewhere, reload', changedElsewhere: true } });
    }
    expect(snapshot()).toEqual(before);
    expect((await call('POST', '/sketches/nope/duplicate', { stamp: 'x' })).status).toBe(404);
    expect((await call('POST', '/sketches/booking/duplicate', {})).status).toBe(400);
  });
});

describe('squad studio sketch …', () => {
  let said: string[];
  beforeEach(() => {
    said = [];
    const keep = (s: unknown) => {
      said.push(String(s).replace(/\x1b\[[0-9;]*m/g, ''));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(keep as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(keep as never);
  });

  it('lists each sketch with its id, screens and stamp', () => {
    const b = booking();
    cli.studioSketchList(bp);
    const out = said.join('');
    expect(out).toContain(`Booking  booking · 2 screens, 1 approved · stamp ${b.stamp}`);
    expect(out).toContain('Login  login · 0 screens');
  });

  it('rename names a sketch by id or name, and refuses a used name like the button', () => {
    booking();
    cli.studioSketchRename(bp, 'booking', ['Book', 'a', 'visit'], {});
    expect(said.join('')).toContain('Renamed "Booking" to "Book a visit".');
    expect(() => cli.studioSketchRename(bp, 'BOOK A VISIT ', ['Login'], {})).toThrow('A sketch called "Login" already exists. Pick another name.');
    expect(actions.getSketch(bp, 'booking').name).toBe('Book a visit');
    expect(() => cli.studioSketchRename(bp, 'nope', ['X'], {})).toThrow(/^This project has no sketch "nope"\. Its sketches: booking, login\./);
  });

  it('duplicate makes "… copy" with all screens Draft', () => {
    booking();
    cli.studioSketchDuplicate(bp, 'Booking', {});
    cli.studioSketchDuplicate(bp, 'booking', {});
    expect(said.join('')).toContain('Made "Booking copy" (booking-copy) from "Booking": 2 screens, all Draft.');
    expect(said.join('')).toContain('Made "Booking copy 2" (booking-copy-2)');
    expect(actions.getSketch(bp, 'booking-copy-2').screens.every((s) => s.status === 'draft')).toBe(true);
  });

  it('delete asks first, naming the sketch and its screens; No keeps it, --yes does not ask', async () => {
    patientProfile();
    const asked: string[] = [];
    await cli.studioSketchDelete(bp, 'Patient profile', {}, async (q) => (asked.push(q), false));
    expect(asked).toEqual(['Delete "Patient profile" and its 3 screens?']);
    expect(said.join('')).toContain('Not deleted.');
    expect(actions.getSketch(bp, 'patient-profile').screens).toHaveLength(3);

    await cli.studioSketchDelete(bp, 'patient-profile', {}, async () => true);
    expect(said.join('')).toContain('Deleted "Patient profile" and its 3 screens. It cannot be brought back.');
    expect(actions.listSketches(bp)).toEqual([]);

    const again = patientProfile();
    const ask = vi.fn(async () => true);
    await cli.studioSketchDelete(bp, again.id, { yes: true, stamp: again.stamp }, ask);
    expect(ask).not.toHaveBeenCalled();
    expect(actions.listSketches(bp)).toEqual([]);
  });

  it('a --stamp a teammate made old stops each one with "Changed elsewhere, reload", and nothing changes', async () => {
    const b = booking();
    actions.changeScreen(bp, 'booking', 'form', { name: 'Form 2' }, b.stamp);
    const before = snapshot();
    expect(() => cli.studioSketchRename(bp, 'booking', ['Book a visit'], { stamp: b.stamp })).toThrow('Changed elsewhere, reload');
    expect(() => cli.studioSketchDuplicate(bp, 'booking', { stamp: b.stamp })).toThrow('Changed elsewhere, reload');
    await expect(cli.studioSketchDelete(bp, 'booking', { stamp: b.stamp, yes: true })).rejects.toThrow('Changed elsewhere, reload');
    expect(snapshot()).toEqual(before);
  });

  it('does not guess between two sketches with one name', () => {
    booking();
    fs.cpSync(paths.sketchDir(bp, 'login'), paths.sketchDir(bp, 'login-2'), { recursive: true });
    expect(() => cli.studioSketchDuplicate(bp, 'Login', {})).toThrow('2 sketches are called "Login": login, login-2. Name one by its id.');
    cli.studioSketchDuplicate(bp, 'login-2', {});
    expect(actions.getSketch(bp, 'login-copy').name).toBe('Login copy');
  });

  it('are real commands with --stamp, and delete has --yes', () => {
    const sketch = cli.studioCommand().commands.find((c) => c.name() === 'sketch')!;
    // "pick" is a variant card's "Use this one" (US-18); "screen" is Add screen and a tab's Delete (US-11).
    expect(sketch.commands.map((c) => c.name())).toEqual(['list', 'rename', 'duplicate', 'delete', 'pick', 'screen']);
    const opts = Object.fromEntries(sketch.commands.map((c) => [c.name(), c.options.map((o) => o.long)]));
    expect(opts).toEqual({ list: [], rename: ['--stamp'], duplicate: ['--stamp'], delete: ['--stamp', '--yes'], pick: ['--stamp'], screen: [] });
    const screen = sketch.commands.find((c) => c.name() === 'screen')!;
    expect(Object.fromEntries(screen.commands.map((c) => [c.name(), c.options.map((o) => o.long)]))).toEqual({ add: ['--stamp'], delete: ['--stamp', '--yes'] });
  });
});

describe('the AI Designer (AB-177.1)', () => {
  it('lists Rename and Duplicate as actions it does, and Delete as one it points to the card menu for', () => {
    const on = Object.fromEntries(STUDIO_ACTIONS.map((a) => [a.id, a.available]));
    expect(on).toMatchObject({ 'rename-sketch': true, 'duplicate-sketch': true, delete: false });
    expect(STUDIO_ACTIONS.find((a) => a.id === 'delete')!.words).toContain('⋯ menu');
    expect(sortProblem({ kind: 'change', reply: 'OK', action: 'rename-sketch' }, 'sketch')).toBe('a rename must put the new name in "name"');
    expect(sortProblem({ kind: 'change', reply: 'OK', action: 'rename-sketch', name: 'Book a visit' }, 'sketch')).toBeNull();
    expect(sortProblem({ kind: 'change', reply: 'OK', action: 'duplicate-sketch' }, 'sketch')).toBeNull();
  });

  it('the sample Designer sorts rename, duplicate and delete of the sketch itself', () => {
    expect(demoSort('Rename the sketch to "Book a visit"', 'English', undefined, [])).toMatchObject({ kind: 'change', action: 'rename-sketch', name: 'Book a visit' });
    expect(demoSort('Rename this sketch to Book a visit.', 'English', undefined, [])).toMatchObject({ kind: 'change', action: 'rename-sketch', name: 'Book a visit' });
    expect(demoSort('Please duplicate this sketch', 'English', undefined, [])).toMatchObject({ kind: 'change', action: 'duplicate-sketch' });
    expect(demoSort('Make a copy of the sketch', 'English', undefined, [])).toMatchObject({ kind: 'change', action: 'duplicate-sketch' });
    expect(demoSort('Delete this sketch', 'English', undefined, [])).toMatchObject({ kind: 'unavailable', action: 'delete' });
    expect(demoSort('احذف المخطط', 'Arabic', undefined, [])).toMatchObject({ kind: 'unavailable', action: 'delete' });
    expect(demoSort('انسخ هذا المخطط', 'Arabic', undefined, [])).toMatchObject({ kind: 'change', action: 'duplicate-sketch' });
  });

  it('the sample Designer takes a change to part of a screen as a screen change, not a sketch action', () => {
    const screens = [{ id: 'form', name: 'Form' }];
    for (const text of ['Delete the footer', 'Copy the header from Checkout', 'Rename the button to Confirm', 'Remove the logo', 'حذف الزر']) {
      const sorted = demoSort(text, 'English', undefined, screens);
      expect(sorted.action, text).toBeUndefined();
      expect(sorted.kind, text).toBe('change');
      expect(sorted.screens, text).toEqual([{ id: 'form', name: 'Form', change: text }]);
    }
  });

  it('renames and duplicates from the chat with the same rules, and points to the card menu for delete', async () => {
    booking();
    const owner = { kind: 'sketch' as const, id: 'booking' };
    const taken = await sendChatMessage(bp, { owner, text: 'Rename the sketch to "Login"' });
    expect(taken.reply).toMatchObject({ kind: 'failed', text: 'A sketch called "Login" already exists. Pick another name.' });
    expect(actions.getSketch(bp, 'booking').name).toBe('Booking');

    const renamed = await sendChatMessage(bp, { owner, text: 'Rename the sketch to "Book a visit"' });
    expect(renamed.reply).toMatchObject({ kind: 'changed', text: 'Done. "Booking" is now called "Book a visit".' });
    expect(actions.getSketch(bp, 'booking').lastEdit).toMatchObject({ by: 'AI Designer', for: 'Alaa' });

    const copied = await sendChatMessage(bp, { owner, text: 'Duplicate this sketch' });
    expect(copied.reply.text).toBe('Done. I made "Book a visit copy" with 2 screens, all Draft, and no conversation. "Book a visit" is unchanged.');
    expect(actions.getSketch(bp, 'book-a-visit-copy').screens.map((s) => s.status)).toEqual(['draft', 'draft']);

    const del = await sendChatMessage(bp, { owner, text: 'Delete this sketch' });
    expect(del.reply.kind).toBe('unavailable');
    expect(del.reply.text).toContain("To delete a sketch, use Delete in its ⋯ menu on the Sketches page: it asks first and says how many screens go with it.");
    expect(actions.getSketch(bp, 'booking').name).toBe('Book a visit');
  });

  it('a stale stamp from the chat is refused with "Changed elsewhere, reload"', async () => {
    const b = booking();
    actions.changeScreen(bp, 'booking', 'form', { name: 'Form 2' }, b.stamp);
    const r = await sendChatMessage(bp, { owner: { kind: 'sketch', id: 'booking' }, text: 'Rename the sketch to "Book a visit"', stamp: b.stamp });
    expect(r.reply).toMatchObject({ kind: 'failed', text: 'Changed elsewhere, reload' });
    expect(actions.getSketch(bp, 'booking').name).toBe('Booking');
  });
});
