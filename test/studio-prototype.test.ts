import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * US-54 Prototype: link the approved screens (AB-179). The prototype store (studio-prototype.ts: one prototype.yaml in
 * the sketch's own folder, saved with the stamp read, under the Studio lock), its rules (studio-prototype-map.ts: the
 * approved screens at their approved version, the buttons by name, working and broken links, the start screen), the AI
 * Designer's Link step through the one runner (studio-link.ts), the sample board's linker, and the routes. Claude Code
 * never starts here: its direct run is replaced and each run is kept to look at.
 */

const calls: RunOptions[] = [];
const answers: unknown[] = [];
let during: (() => void) | null = null;
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    during?.();
    during = null;
    return { ok: true, text: '', structured: answers.length ? answers.shift() : undefined, sessionId: opts.resume ?? opts.sessionId ?? 'designer-1' } as RunResult;
  },
}));

const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const studio = await import('../src/board/studio.js');
const { findButtons, isRightToLeft, buttonKey } = await import('../src/board/studio-prototype-map.js');
const { prototypeFile, sketchDir } = await import('../src/board/studio-paths.js');
const { LinkBusy, demoLinks, linkJobsDone, linkProblem, linkWorking, runLinker, setDemoLinkWait, startLinkJob } = await import('../src/engine/studio-link.js');
const { LINKS_SCHEMA, linksProblem, linkPrompt } = await import('../src/engine/studio-link-prompts.js');
const { mountStudioApi } = await import('../src/console/api/studio.js');
const { buildPaths } = await import('../src/core/paths.js');
const { seedDemoStudio } = await import('../src/board/demo-studio.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

const page = (body: string, rtl = false) => `<!doctype html><html${rtl ? ' dir="rtl" lang="ar"' : ''}><head><style>body{font-family:sans-serif}</style></head><body><main>${body}</main></body></html>`;
const FORM_V1 = { desktop: page('<h1>Book</h1><button>Next</button>'), mobile: page('<h1>Book</h1><button>Next</button>') };
const FORM = { desktop: page('<h1>Book</h1><button>Continue</button><a href="/help">Help</a>'), mobile: page('<h1>Book</h1><button>Continue</button>') };
const CONFIRM = { desktop: page('<button aria-label="Back">‹</button><h1>Confirm</h1><button>Edit</button><button>Book visit</button>'), mobile: page('<button aria-label="Back">‹</button><h1>Confirm</h1><button>Edit</button><button>Book visit</button>') };
const DONE = { desktop: page('<h1>Done</h1><button>Home</button>'), mobile: page('<h1>Done</h1><button>Home</button>') };

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

const sketch = (id = 'booking') => studio.readSketch(bp, id)!;
const map = (id = 'booking') => studio.prototypeMap(sketch(id), studio.readPrototypeFile(bp, id));
const linkLines = (id = 'booking') => map(id).links.map((l) => `${l.screen}/${l.button} → ${'back' in l.to ? 'Back' : l.to.screen}${l.broken ? ` (${l.broken})` : ''}`);

/**
 * "Booking" with Form, Confirm, Done and Receipt, in that order: Form approved at v2 (its v1 had "Next"), Confirm
 * approved at v1, Done drawn but not approved (US-58: it is in the prototype too), Receipt with no drawing yet. "Login"
 * with one screen and no drawing.
 */
function seedBooking() {
  let s = studio.saveSketch(bp, { name: 'Booking', frames: ['desktop', 'mobile'], screens: [{ name: 'Form' }, { name: 'Confirm' }, { name: 'Done' }, { name: 'Receipt' }] });
  s = studio.addVariant(bp, 'booking', 'form', { frames: FORM_V1 }, s.stamp);
  s = studio.addVariant(bp, 'booking', 'form', { frames: FORM, choose: true }, s.stamp);
  s = studio.addVariant(bp, 'booking', 'confirm', { frames: CONFIRM }, s.stamp);
  s = studio.addVariant(bp, 'booking', 'done', { frames: DONE }, s.stamp);
  s = studio.approveScreen(bp, 'booking', 'form', s.stamp, { by: 'Alaa' }).sketch;
  s = studio.approveScreen(bp, 'booking', 'confirm', s.stamp, { by: 'Alaa' }).sketch;
  studio.saveSketch(bp, { name: 'Login', frames: ['desktop'], screens: [{ name: 'Sign in' }] });
  return s;
}

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  during = null;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-prototype-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50, studio: false });
  setDemoLinkWait(20);
  seedBooking();
});

afterEach(async () => {
  await linkJobsDone();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the buttons of a drawing, named the same on every frame', () => {
  it('names each button by its words, else its label, title or picture text, else by kind and place', () => {
    const r = findButtons(
      page(
        '<a href="#">Home</a><button aria-label="Back">‹</button><button>←</button><a><svg><title>Close</title><path/></svg></a>' +
          '<span class="btn">Book visit</span><button>Next</button><button>Next</button><input type="submit" value="Send"/>' +
          '<button title="Search"></button><button><img src="x.png" alt="Profile"></button><a>→</a><div class="card"><p>Text</p></div>',
      ),
    );
    expect(r.buttons).toEqual([
      { name: 'Home', kind: 'link' },
      { name: 'Back', kind: 'button' },
      { name: 'Icon button 1', kind: 'button' },
      { name: 'Close', kind: 'link' },
      { name: 'Book visit', kind: 'button' },
      { name: 'Next', kind: 'button' },
      { name: 'Next 2', kind: 'button' },
      { name: 'Send', kind: 'button' },
      { name: 'Search', kind: 'button' },
      { name: 'Profile', kind: 'button' },
      { name: 'Icon link 1', kind: 'link' },
    ]);
    // Each one is marked in the drawing the board gets, so the board finds the same button.
    expect(r.marked).toContain('<button aria-label="Back" data-sq-button="Back">‹</button>');
    expect(r.marked).toContain('<input type="submit" value="Send" data-sq-button="Send"/>');
    expect(r.marked).toContain('<button data-sq-button="Next 2">Next</button>');
  });

  it('reads Arabic words as words, and icon-only Arabic back buttons by their label', () => {
    const html = page('<button aria-label="رجوع">›</button><span class="btn">احجز الزيارة</span><a>تعديل الموعد</a>', true);
    expect(findButtons(html).buttons.map((b) => b.name)).toEqual(['رجوع', 'احجز الزيارة', 'تعديل الموعد']);
    expect(isRightToLeft(html)).toBe(true);
    expect(isRightToLeft(page('<button>Go</button>'))).toBe(false);
    expect(isRightToLeft(`<!doctype html><html><body><div dir="rtl" lang="ar"><button>تم</button></div></body></html>`)).toBe(true);
  });

  it('counts only its own marks: a mark the drawing wrote itself is renamed first', () => {
    const r = findButtons(page('<button data-sq-button="Pay">Cancel</button>'));
    expect(r.buttons.map((b) => b.name)).toEqual(['Cancel']);
    expect(r.marked).toContain('data-was-sq-button="Pay"');
    expect(r.marked).toContain('data-sq-button="Cancel"');
  });

  it('compares button names without capitals or spaces at the ends', () => {
    expect(buttonKey('form', ' continue ')).toBe(buttonKey('form', 'Continue'));
  });
});

describe('done when 1: the Prototype tab shows every drawn screen at its drawing in use, with a start screen', () => {
  it('shows Form and Confirm at the version each was approved at, and Done; Receipt is left out; Form is the start', () => {
    const m = map();
    expect(m.screens.map((s) => [s.name, s.version])).toEqual([
      ['Form', 2],
      ['Confirm', 1],
      ['Done', 1],
    ]);
    // Form's v1 came from no ask, so it is not one of Form's options: Form has its drawing in use only.
    expect(m.screens[0]!.drawings.map((d) => d.version)).toEqual([2]);
    expect(m.screens[0]!.drawings[0]!.frames.desktop).toContain('data-sq-button="Continue"');
    expect(m.start).toBe('form');
    expect(m.markedStart).toBeNull();
  });

  it('saves Confirm as the start screen with the sketch, with who and when', () => {
    const before = sketch().stamp;
    const r = studio.setPrototypeStart(bp, 'booking', 'confirm', before, { by: 'Alaa' });
    expect(r.map.start).toBe('confirm');
    expect(r.stamp).not.toBe(before);
    // Read again, as after a reload.
    expect(map().start).toBe('confirm');
    expect(fs.readFileSync(prototypeFile(bp, 'booking'), 'utf8')).toMatch(/start: confirm/);
    expect(sketch().lastEdit).toMatchObject({ by: 'Alaa' });
    // Any screen in the prototype can be the start; one with no drawing cannot.
    expect(() => studio.setPrototypeStart(bp, 'booking', 'receipt', sketch().stamp)).toThrow('Receipt has no drawing yet, so it is not in the prototype. Draw it first, then make it the start.');
  });

  it('has nothing for "Login", where no screen has a drawing, and Generate is refused there', () => {
    expect(map('login').screens).toEqual([]);
    expect(map('login').start).toBeNull();
    expect(() => startLinkJob(bp, { sketch: 'login', stamp: sketch('login').stamp })).toThrow('Draw a screen to start the prototype.');
  });

  it('writes nothing when the prototype is read', () => {
    studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Continue', to: { screen: 'confirm' } }, sketch().stamp);
    const before = snapshot();
    map();
    map('login');
    studio.readPrototypeFile(bp, 'login');
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(prototypeFile(bp, 'login'))).toBe(false);
  });
});

describe('done when 3: a link set by hand, saved with the sketch', () => {
  it('changes Continue to Back, then to no link, then to Confirm again, each saved', () => {
    let stamp = studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Continue', to: { screen: 'confirm' } }, sketch().stamp, { by: 'Alaa' }).stamp;
    expect(linkLines()).toEqual(['form/Continue → confirm']);
    stamp = studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Continue', to: { back: true } }, stamp).stamp;
    expect(linkLines()).toEqual(['form/Continue → Back']);
    stamp = studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Continue', to: null }, stamp).stamp;
    expect(linkLines()).toEqual([]);
    studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'continue ', to: { screen: 'confirm' } }, stamp);
    // Kept with the name its drawing gives it.
    expect(linkLines()).toEqual(['form/Continue → confirm']);
    expect(fs.readFileSync(prototypeFile(bp, 'booking'), 'utf8')).toContain('button: Continue');
  });

  it('refuses an old stamp with "Changed elsewhere, reload" and writes nothing', () => {
    const old = sketch().stamp;
    studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Continue', to: { screen: 'confirm' } }, old);
    const before = snapshot();
    expect(() => studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Continue', to: { back: true } }, old)).toThrow('Changed elsewhere, reload');
    expect(() => studio.setPrototypeStart(bp, 'booking', 'confirm', old)).toThrow('Changed elsewhere, reload');
    expect(snapshot()).toEqual(before);
  });

  it('is not refused by the approved screen\'s lock, and leaves the screen\'s own files as they were', () => {
    const screenFiles = () => Object.entries(snapshot()).filter(([k]) => k.includes('/screens/'));
    const before = screenFiles();
    expect(sketch().screens.find((s) => s.id === 'form')!.status).toBe('approved');
    studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Continue', to: { screen: 'confirm' } }, sketch().stamp);
    expect(screenFiles()).toEqual(before);
  });

  it('refuses a button the drawing does not have, a screen with no drawing, and a link to its own screen', () => {
    const stamp = sketch().stamp;
    expect(() => studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Pay', to: { screen: 'confirm' } }, stamp)).toThrow('Form has no button "Pay"');
    expect(() => studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Continue', to: { screen: 'receipt' } }, stamp)).toThrow('Receipt has no drawing yet, so it is not in the prototype. Pick a screen in it, Back or no link.');
    expect(() => studio.setPrototypeLink(bp, 'booking', { screen: 'receipt', button: 'Home', to: { screen: 'form' } }, stamp)).toThrow('Receipt has no drawing yet, so it is not in the prototype. Draw it first, then link it.');
    expect(() => studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Continue', to: { screen: 'form' } }, stamp)).toThrow(/cannot lead to Form itself/);
    expect(fs.existsSync(prototypeFile(bp, 'booking'))).toBe(false);
  });

  it('works on Desktop and on Mobile alike: one link, tied to the button\'s name', () => {
    studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Continue', to: { screen: 'confirm' } }, sketch().stamp);
    const form = map().screens[0]!;
    expect(form.buttons).toEqual([
      { name: 'Continue', kind: 'button', frames: ['desktop', 'mobile'] },
      { name: 'Help', kind: 'link', frames: ['desktop'] },
    ]);
    expect(form.drawings[0]!.frames.desktop).toContain('data-sq-button="Continue"');
    expect(form.drawings[0]!.frames.mobile).toContain('data-sq-button="Continue"');
  });

  it('lives in the sketch\'s own folder, so a teammate gets it through git with the sketch', () => {
    studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Continue', to: { screen: 'confirm' } }, sketch().stamp);
    expect(path.dirname(prototypeFile(bp, 'booking'))).toBe(sketchDir(bp, 'booking'));
    // A teammate's project gets the same folder through git.
    const mate = boardPaths(path.join(tmp, 'mate', '.squad'));
    fs.cpSync(sketchDir(bp, 'booking'), sketchDir(mate, 'booking'), { recursive: true });
    expect(studio.prototypeMap(studio.readSketch(mate, 'booking')!, studio.readPrototypeFile(mate, 'booking')).links.map((l) => l.button)).toEqual(['Continue']);
  });
});

describe('done when 5: a changed or reopened screen', () => {
  /** Confirm is the start, Form's Continue leads to Confirm, and Confirm's Edit back to Form. */
  function linked() {
    let stamp = studio.setPrototypeStart(bp, 'booking', 'confirm', sketch().stamp).stamp;
    stamp = studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Continue', to: { screen: 'confirm' } }, stamp).stamp;
    return studio.setPrototypeLink(bp, 'booking', { screen: 'confirm', button: 'Edit', to: { screen: 'form' } }, stamp).stamp;
  }

  it('shows "Continue" as broken with a short warning when a new drawing of Form drops it', () => {
    let stamp = linked();
    stamp = studio.reopenScreen(bp, 'booking', 'form', stamp).sketch.stamp;
    stamp = studio.addVariant(bp, 'booking', 'form', { frames: { desktop: page('<button>Book now</button>'), mobile: page('<button>Book now</button>') }, choose: true }, stamp).stamp;
    studio.approveScreen(bp, 'booking', 'form', stamp);
    const m = map();
    expect(m.screens[0]!.version).toBe(3);
    const cont = m.links.find((l) => l.button === 'Continue')!;
    expect(cont).toMatchObject({ broken: 'button-gone' });
    expect(cont.warning).toBe('"Continue" is gone from Form. Pick its new button, or take the link away.');
    // Still saved: nothing is fixed while reading.
    expect(fs.readFileSync(prototypeFile(bp, 'booking'), 'utf8')).toContain('button: Continue');
    // It can be taken away.
    studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Continue', to: null }, sketch().stamp);
    expect(linkLines()).toEqual(['confirm/Edit → form']);
  });

  it('keeps Confirm in while it is reopened (US-58), with its links working and Play starting there', () => {
    const stamp = linked();
    studio.reopenScreen(bp, 'booking', 'confirm', stamp);
    const m = map();
    expect(m.screens.map((s) => s.name)).toEqual(['Form', 'Confirm', 'Done']);
    expect(linkLines()).toEqual(['form/Continue → confirm', 'confirm/Edit → form']);
    expect(m.start).toBe('confirm');
  });

  it('shows a link to a screen with no drawing as broken, with the start back on the first screen, and fixes nothing', () => {
    // A teammate's file, through git, links Form to Receipt and starts on it: Receipt has no drawing here.
    fs.writeFileSync(prototypeFile(bp, 'booking'), 'start: receipt\nlinks:\n  - { screen: form, button: Continue, to: receipt }\n  - { screen: receipt, button: Home, to: form }\n');
    const m = map();
    expect(m.links).toEqual([expect.objectContaining({ screen: 'form', button: 'Continue', broken: 'screen-off', warning: 'Receipt has no drawing yet, so this link is off.' })]);
    expect(m.tabs[0]!.links).toEqual(m.links);
    expect(m.start).toBe('form');
    expect(m.markedStart).toBe('receipt');
    expect(studio.readPrototypeFile(bp, 'booking').links.map((l) => l.screen)).toEqual(['form', 'receipt']);
  });
});

describe('done when 2: Generate the prototype', () => {
  it('on a sample board, links the flow in the background, shows it is working and cannot start twice', async () => {
    const stamp = sketch().stamp;
    const working = startLinkJob(bp, { sketch: 'booking', stamp });
    expect(working.doing).toBe('Linking the screens');
    expect(linkWorking(bp, 'booking')).not.toBeNull();
    expect(() => startLinkJob(bp, { sketch: 'booking', stamp })).toThrow(LinkBusy);
    await linkJobsDone();
    expect(linkWorking(bp, 'booking')).toBeNull();
    expect(linkProblem(bp, 'booking')).toBeNull();
    expect(linkLines()).toEqual(['form/Continue → confirm', 'confirm/Back → Back', 'confirm/Edit → form', 'confirm/Book visit → done']);
    expect(fs.readFileSync(prototypeFile(bp, 'booking'), 'utf8')).toMatch(/by: AI Designer/);
  });

  it('replaces the old links, and keeps those of a screen out of the prototype now', async () => {
    fs.writeFileSync(prototypeFile(bp, 'booking'), 'links:\n  - { screen: form, button: Help, to: confirm }\n  - { screen: receipt, button: Home, to: form }\n');
    startLinkJob(bp, { sketch: 'booking', stamp: sketch().stamp });
    await linkJobsDone();
    // Form's Help link is replaced; Receipt's own link stays in the file for when it has a drawing.
    expect(studio.readPrototypeFile(bp, 'booking').links.map((l) => `${l.screen}/${l.button}`)).toEqual(['receipt/Home', 'form/Continue', 'confirm/Back', 'confirm/Edit', 'confirm/Book visit']);
  });

  it('keeps the old links and says what went wrong when the sketch changed meanwhile', async () => {
    const stamp = studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Help', to: { screen: 'confirm' } }, sketch().stamp).stamp;
    startLinkJob(bp, { sketch: 'booking', stamp });
    // A teammate changes the sketch while it works.
    studio.setPrototypeStart(bp, 'booking', 'confirm', stamp);
    await linkJobsDone();
    expect(linkProblem(bp, 'booking')).toBe('Changed elsewhere, reload');
    expect(linkLines()).toEqual(['form/Help → confirm']);
  });

  it('refuses an old stamp at once, starting nothing', () => {
    const old = sketch().stamp;
    studio.setPrototypeStart(bp, 'booking', 'confirm', old);
    expect(() => startLinkJob(bp, { sketch: 'booking', stamp: old })).toThrow('Changed elsewhere, reload');
    expect(linkWorking(bp, 'booking')).toBeNull();
  });

  it('the sample linker: back words go Back, edit words to the screen before, the first other button to the next screen', () => {
    expect(demoLinks(map()).map((l) => `${l.screen}/${l.button} → ${'back' in l.to ? 'Back' : l.to.screen}`)).toEqual(['form/Continue → confirm', 'confirm/Back → Back', 'confirm/Edit → form', 'confirm/Book visit → done']);
  });
});

describe('done when 2: the AI Designer\'s Link step, through the one Designer runner', () => {
  beforeEach(() => {
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', quality: 'thrifty' });
  });
  const run = () => runLinker(bp, { sketch: 'booking', stamp: sketch().stamp, for: 'Alaa' }, { place: async () => () => undefined });
  const good = { links: [{ screen: 'form', button: 'Continue', to: 'confirm' }, { screen: 'form', button: 'Help', to: 'NONE' }, { screen: 'confirm', button: 'Back', to: 'BACK' }, { screen: 'confirm', button: 'Edit', to: 'form' }], note: 'Form leads to Confirm.' };

  it('is given every drawn screen and the buttons squad-kit found, reads files only, and saves the checked links', async () => {
    answers.push(good);
    const r = await run();
    expect(r).toMatchObject({ ok: true, note: 'Form leads to Confirm.' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain('- Form (id form)');
    expect(calls[0]!.prompt).toContain('"Continue"');
    expect(calls[0]!.prompt).toContain('.squad/studio/sketches/booking/screens/form/v2/desktop.html');
    expect(calls[0]!.prompt).toContain('- Done (id done)');
    expect(calls[0]!.prompt).not.toContain('Receipt (id receipt)');
    expect(calls[0]!.schema).toEqual(LINKS_SCHEMA);
    expect(linkLines()).toEqual(['form/Continue → confirm', 'confirm/Back → Back', 'confirm/Edit → form']);
    expect(fs.readFileSync(prototypeFile(bp, 'booking'), 'utf8')).toMatch(/by: AI Designer\n\s+for: Alaa/);
  });

  it('asks once more when the answer does not fit, then saves it', async () => {
    answers.push({ links: [{ screen: 'form', button: 'Pay', to: 'confirm' }], note: 'x' }, good);
    const r = await run();
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain('names the button "Pay", which Form does not have');
    expect(calls[1]!.resume).toBe('designer-1');
  });

  it('keeps the old links and says what went wrong when the answer does not fit twice', async () => {
    studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Help', to: { screen: 'confirm' } }, sketch().stamp);
    answers.push({ links: [{ screen: 'receipt', button: 'Home', to: 'form' }], note: 'x' }, { links: [{ screen: 'receipt', button: 'Home', to: 'form' }], note: 'x' });
    const r = await run();
    expect(r).toEqual({ ok: false, error: expect.stringContaining('The Designer\'s answer could not be used: link 1 names the screen "receipt"') });
    expect(linkLines()).toEqual(['form/Help → confirm']);
  });

  it('is refused with "Changed elsewhere, reload" when a teammate changed the sketch during the run', async () => {
    answers.push(good);
    during = () => studio.setPrototypeStart(bp, 'booking', 'confirm', sketch().stamp);
    const r = await run();
    expect(r).toEqual({ ok: false, error: 'Changed elsewhere, reload' });
    expect(linkLines()).toEqual([]);
  });

  it('checks every answer: screens, buttons, targets and each button once', () => {
    const m = map();
    expect(linksProblem(good, m)).toBeNull();
    expect(linksProblem({ note: 'x' }, m)).toBe('the answer has no list of links');
    expect(linksProblem({ links: [{ screen: 'form', button: 'Continue', to: 'receipt' }], note: '' }, m)).toMatch(/leads to "receipt", which is not a listed screen's id/);
    expect(linksProblem({ links: [{ screen: 'form', button: 'Continue', to: 'form' }], note: '' }, m)).toMatch(/leads to its own screen/);
    expect(linksProblem({ links: [{ screen: 'form', button: 'Continue', to: 'BACK' }, { screen: 'form', button: 'continue', to: 'NONE' }], note: '' }, m)).toMatch(/linked twice/);
    expect(linkPrompt({ project: 'p', sketch: 'S', screens: [] })).toContain('BACK');
  });
});

describe('the routes', () => {
  let app: Hono;
  beforeEach(() => {
    app = new Hono();
    mountStudioApi(app, { paths: buildPaths(tmp) });
  });
  const put = (what: string, body: unknown, id = 'booking') => app.request(`/api/v1/studio/sketches/${id}/prototype/${what}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const post = (body: unknown, id = 'booking') => app.request(`/api/v1/studio/sketches/${id}/prototype/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = async (id = 'booking') => (await (await app.request(`/api/v1/studio/sketches/${id}/prototype`)).json()) as any;

  it('reads the prototype: the drawn screens, the links, the tabs, the start, the screens left out, and writes nothing', async () => {
    const before = snapshot();
    const p = await get();
    expect(p.screens.map((s: any) => [s.id, s.version])).toEqual([
      ['form', 2],
      ['confirm', 1],
      ['done', 1],
    ]);
    expect(p.tabs.map((t: any) => t.label)).toEqual(['In use']);
    expect(p.left).toEqual([{ id: 'receipt', name: 'Receipt' }]);
    expect(p).toMatchObject({ start: 'form', markedStart: null, links: [], working: null, problem: null, sketch: { id: 'booking', name: 'Booking', frames: ['desktop', 'mobile'] } });
    expect((await get('login')).screens).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect((await app.request('/api/v1/studio/sketches/nope/prototype')).status).toBe(404);
  });

  it('sets a link and the start with the stamp read, and refuses an old one with 409', async () => {
    const stamp = (await get()).sketch.stamp;
    const linked = (await (await put('link', { stamp, screen: 'form', button: 'Continue', to: 'confirm' })).json()) as any;
    expect(linked.links).toEqual([{ screen: 'form', button: 'Continue', to: { screen: 'confirm' } }]);
    const back = (await (await put('link', { stamp: linked.sketch.stamp, screen: 'form', button: 'Continue', back: true })).json()) as any;
    expect(back.links).toEqual([{ screen: 'form', button: 'Continue', to: { back: true } }]);
    const none = (await (await put('link', { stamp: back.sketch.stamp, screen: 'form', button: 'Continue' })).json()) as any;
    expect(none.links).toEqual([]);
    const started = (await (await put('start', { stamp: none.sketch.stamp, screen: 'confirm' })).json()) as any;
    expect(started.start).toBe('confirm');
    const stale = await put('link', { stamp, screen: 'form', button: 'Continue', to: 'confirm' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'Changed elsewhere, reload', changedElsewhere: true });
    expect((await put('link', { stamp: started.sketch.stamp, screen: 'form', button: 'Pay', to: 'confirm' })).status).toBe(400);
  });

  it('starts Generate, answers 409 while it works, and says when it is done', async () => {
    const stamp = (await get()).sketch.stamp;
    const r = await post({ stamp });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).working).toMatchObject({ doing: 'Linking the screens' });
    expect((await get()).working).not.toBeNull();
    const again = await post({ stamp });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ busy: true });
    await linkJobsDone();
    const done = (await (await app.request('/api/v1/studio/sketches/booking/prototype/generate')).json()) as any;
    expect(done).toEqual({ working: null, problem: null });
    expect((await get()).links).toHaveLength(4);
    // "Login" has no drawn screen: refused, nothing started.
    const login = await post({ stamp: (await get('login')).sketch.stamp }, 'login');
    expect(login.status).toBe(400);
    expect(((await login.json()) as any).error).toBe('Draw a screen to start the prototype.');
  });
});

describe('the sample board', () => {
  it('has Booking linked with Form\'s options, an icon-only back button and one broken link, and "الحجز" linked right to left', () => {
    const demo = boardPaths(path.join(tmp, 'demo', '.squad'));
    seedDemoStudio(demo);
    const read = (id: string) => studio.prototypeMap(studio.readSketch(demo, id)!, studio.readPrototypeFile(demo, id));
    const booking = read('booking');
    expect(booking.screens.map((s) => s.name)).toEqual(['Home', 'Form', 'Confirm']);
    expect(booking.tabs.map((t) => t.label)).toEqual(['In use', 'Option A', 'Option B', 'Option C']);
    expect(booking.links.map((l) => [l.screen, l.button, l.broken ?? 'ok'])).toEqual([
      ['home', 'Book a follow-up', 'ok'],
      ['form', 'Book visit', 'ok'],
      ['form', 'Next', 'ok'],
      ['confirm', 'Back', 'ok'],
      ['confirm', 'Change the day', 'button-gone'],
    ]);
    // "Book visit" is on Options A and C; on B (in use) Play skips it, and "Next" works.
    expect(booking.tabs[0]!.links.find((l) => l.button === 'Book visit')).toMatchObject({ broken: 'button-gone' });
    expect(booking.tabs[0]!.links.find((l) => l.button === 'Next')!.broken).toBeUndefined();
    // Home and Confirm have one drawing with no letter: they are in "In use" only, so Option A holds Form alone.
    expect(booking.tabs[1]!.screens.map((s) => s.id)).toEqual(['form']);
    expect(booking.tabs[1]!.links.find((l) => l.button === 'Book visit')).toMatchObject({ broken: 'screen-off', warning: 'Confirm has no Option A, so this link is off here.' });
    expect(booking.screens[2]!.drawings[0]!.frames.desktop).toMatch(/<button aria-label="Back" style="[^"]*" data-sq-button="Back">‹<\/button>/);
    const arabic = read('arabic-booking');
    expect(arabic.screens.map((s) => [s.name, s.rtl])).toEqual([
      ['نموذج الحجز', true],
      ['تأكيد الحجز', true],
    ]);
    expect(arabic.links.every((l) => !l.broken)).toBe(true);
    expect(read('profile').screens).toEqual([]);
  });
});
