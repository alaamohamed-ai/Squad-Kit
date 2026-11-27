import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * US-58 The prototype shows every option of each screen (AB-183). The prototype's rules on the server
 * (studio-prototype-map.ts), one rule for every screen, approved or not: every screen with a drawing joins, with every
 * option of its ask; "In use" holds every screen at its drawing in use, and each "Option" tab only the screens with a
 * drawing of that letter, at it, with their own start screen and their links checked on them; Generate links the buttons of every drawing; and reading, as Play
 * does, writes nothing. Claude Code never starts here: its direct run is replaced and each run is kept to look at.
 */

const calls: RunOptions[] = [];
const answers: unknown[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, text: '', structured: answers.shift(), sessionId: 'designer-1' } as RunResult;
  },
}));

const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const studio = await import('../src/board/studio.js');
const { screenFile } = await import('../src/board/studio-paths.js');
const { demoLinks, linkJobsDone, runLinker, setDemoLinkWait, startLinkJob } = await import('../src/engine/studio-link.js');
const { mountStudioApi } = await import('../src/console/api/studio.js');
const { buildPaths } = await import('../src/core/paths.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

const page = (body: string) => `<!doctype html><html><head></head><body><main>${body}</main></body></html>`;
const both = (body: string) => ({ desktop: page(body), mobile: page(body) });

const sketch = () => studio.readSketch(bp, 'booking')!;
const map = () => studio.prototypeMap(sketch(), studio.readPrototypeFile(bp, 'booking'));
const tab = (id: string) => map().tabs.find((t) => t.id === id)!;
const tabLinks = (id: string) => tab(id).links.map((l) => `${l.screen}/${l.button} → ${'back' in l.to ? 'Back' : l.to.screen}${l.broken ? ` (${l.broken})` : ''}`);
const versionOf = (letter: string) => sketch().screens.find((s) => s.id === 'confirm')!.variants.find((v) => v.letter === letter)!.version;

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

/**
 * The story's Booking: Form approved at version 2; Confirm not approved, drawn as Options A, B and C with B marked
 * "Use this one" ("Pay now" is on A and B, not on C); Done with no drawing yet.
 */
function seedBooking() {
  let s = studio.saveSketch(bp, { name: 'Booking', frames: ['desktop', 'mobile'], screens: [{ name: 'Form' }, { name: 'Confirm' }, { name: 'Done' }] });
  s = studio.addVariant(bp, 'booking', 'form', { frames: both('<h1>Book v1</h1><button>Next</button>') }, s.stamp);
  s = studio.addVariant(bp, 'booking', 'form', { frames: both('<h1>Book</h1><button>Continue</button>'), choose: true }, s.stamp);
  s = studio.approveScreen(bp, 'booking', 'form', s.stamp, { by: 'Alaa' }).sketch;
  s = studio.saveAskVariants(
    bp,
    'booking',
    { id: 'ask-confirm', words: 'Three ways to confirm' },
    [
      {
        id: 'confirm',
        name: 'Confirm',
        variants: [
          { letter: 'A', name: 'Summary', idea: 'All on one card.', frames: both('<h1>Confirm A</h1><button>Back</button><button>Pay now</button>') },
          { letter: 'B', name: 'Split', idea: 'Price first.', frames: both('<h1>Confirm B</h1><button>Back</button><button>Pay now</button><a>Help</a>') },
          { letter: 'C', name: 'Card', idea: 'Card details first.', frames: both('<h1>Confirm C</h1><button>Back</button><button>Pay by card</button>') },
        ],
      },
    ],
    s.stamp,
    { madeBy: studio.AI_DESIGNER, madeFor: 'Alaa' },
  ).sketch;
  studio.pickVariant(bp, 'booking', 'confirm', versionOf('B'), s.stamp, { by: 'Alaa' });
}

/** Done gets its one drawing, with no letter, so it joins the prototype, in "In use" only. */
const drawDone = () => studio.addVariant(bp, 'booking', 'done', { frames: both('<h1>Done</h1><button>Home</button>') }, sketch().stamp).stamp;
/** Done is drawn as options of its own: A, B and C unless said. */
const drawDoneOptions = (letters = ['A', 'B', 'C']) =>
  studio.saveAskVariants(bp, 'booking', { id: 'ask-done' }, [{ id: 'done', name: 'Done', variants: letters.map((letter) => ({ letter, name: `Done ${letter}`, idea: 'x', frames: both(`<h1>Done ${letter}</h1><button>Home</button>`) })) }], sketch().stamp).sketch;

/** Form's Continue leads to Confirm, Confirm's Back goes Back, and (with Done drawn) Pay now leads to Done. */
function link(withPay = false) {
  let stamp = studio.setPrototypeLink(bp, 'booking', { screen: 'form', button: 'Continue', to: { screen: 'confirm' } }, sketch().stamp).stamp;
  stamp = studio.setPrototypeLink(bp, 'booking', { screen: 'confirm', button: 'Back', to: { back: true } }, stamp).stamp;
  if (withPay) stamp = studio.setPrototypeLink(bp, 'booking', { screen: 'confirm', button: 'Pay now', to: { screen: 'done' } }, stamp).stamp;
  return stamp;
}

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-proto-options-')));
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

describe('done when 1: every screen with a drawing is in the prototype, with its options', () => {
  it('has Form at version 2, Confirm with Options A, B and C at B, and leaves Done out', () => {
    const m = map();
    expect(m.screens.map((s) => [s.name, s.version, s.drawings.map((d) => d.letter ?? `v${d.version}`)])).toEqual([
      ['Form', 2, ['v2']],
      ['Confirm', versionOf('B'), ['A', 'B', 'C']],
    ]);
    expect(m.screens[1]!.drawings.map((d) => d.name)).toEqual(['Summary', 'Split', 'Card']);
    // Confirm's buttons are those of all its options, each once.
    expect(m.screens[1]!.buttons.map((b) => b.name)).toEqual(['Back', 'Pay now', 'Help', 'Pay by card']);
    expect(m.screens[1]!.drawings[2]!.buttons.map((b) => b.name)).toEqual(['Back', 'Pay by card']);
  });

  it('works out the tabs: "In use" first, every screen at its drawing in use; then one tab per option', () => {
    const m = map();
    expect(m.tabs.map((t) => [t.id, t.label])).toEqual([
      ['in-use', 'In use'],
      ['A', 'Option A'],
      ['B', 'Option B'],
      ['C', 'Option C'],
    ]);
    expect(m.tabs[0]!.screens).toEqual([
      { id: 'form', version: 2 },
      { id: 'confirm', version: versionOf('B') },
    ]);
    // An Option tab holds only the screens with a drawing of its letter: Form, with no letter, is in "In use" only.
    expect(tab('C').screens).toEqual([{ id: 'confirm', version: versionOf('C') }]);
    expect(tab('A').screens).toEqual([{ id: 'confirm', version: versionOf('A') }]);
    expect(studio.tabDrawing(m.screens[1]!, 'A')!.frames.desktop).toContain('Confirm A');
  });

  it('leaves a screen with options out of a tab for an option it does not have, so options are never mixed', () => {
    drawDone();
    // Done is drawn as two options of its own, A and B: it has no Option C.
    const s = drawDoneOptions(['A', 'B']);
    expect(s.screens.find((x) => x.id === 'done')!.chosen).toBeGreaterThan(1);
    expect(tab('C').screens.map((x) => x.id)).toEqual(['confirm']);
    expect(tab('A').screens.map((x) => x.id)).toEqual(['confirm', 'done']);
    expect(tab('in-use').screens.map((x) => x.id)).toEqual(['form', 'confirm', 'done']);
  });

  it('keeps every option of an approved screen, in "In use" at its approved version and in each tab of its letters', () => {
    // Confirm is approved at Option B, the one in use.
    studio.approveScreen(bp, 'booking', 'confirm', sketch().stamp, { by: 'Alaa' });
    const confirm = map().screens[1]!;
    expect(confirm.version).toBe(versionOf('B'));
    expect(confirm.drawings.map((d) => d.letter)).toEqual(['A', 'B', 'C']);
    expect(tab('in-use').screens[1]).toEqual({ id: 'confirm', version: versionOf('B') });
    expect(tab('A').screens).toEqual([{ id: 'confirm', version: versionOf('A') }]);
    expect(tab('C').screens).toEqual([{ id: 'confirm', version: versionOf('C') }]);
  });

  it('puts a screen with one drawing in "In use" and only in the tab of its own letter', () => {
    // Done is drawn once, as Option C of its own ask; Form has one drawing with no letter.
    drawDoneOptions(['C']);
    const done = map().screens.find((s) => s.id === 'done')!;
    expect(done.drawings.map((d) => d.letter)).toEqual(['C']);
    expect(map().tabs.filter((t) => t.screens.some((x) => x.id === 'done')).map((t) => t.id)).toEqual(['in-use', 'C']);
    expect(map().tabs.filter((t) => t.screens.some((x) => x.id === 'form')).map((t) => t.id)).toEqual(['in-use']);
  });

  it('sends the screens, the tabs and the screens left out from the route, writing nothing', async () => {
    const app = new Hono();
    mountStudioApi(app, { paths: buildPaths(tmp) });
    const before = snapshot();
    const p = (await (await app.request('/api/v1/studio/sketches/booking/prototype')).json()) as any;
    expect(p.screens.map((s: any) => s.name)).toEqual(['Form', 'Confirm']);
    expect(p.screens.every((s: any) => !('approved' in s))).toBe(true);
    expect(p.tabs.map((t: any) => t.label)).toEqual(['In use', 'Option A', 'Option B', 'Option C']);
    expect(p.left).toEqual([{ id: 'done', name: 'Done' }]);
    expect(snapshot()).toEqual(before);
  });
});

describe('done when 2: one link per button works on every option', () => {
  it('has Continue and Back working on "In use"; each Option tab holds Confirm alone, with its Back working and Confirm its start', () => {
    link();
    expect(tabLinks('in-use')).toEqual(['form/Continue → confirm', 'confirm/Back → Back']);
    expect(tab('in-use').start).toBe('form');
    for (const id of ['A', 'B', 'C']) {
      expect(tabLinks(id)).toEqual(['confirm/Back → Back']);
      expect(tab(id).start).toBe('confirm');
    }
  });
});

describe('done when 3: a button on some options only', () => {
  it('has "Pay now" working on Options A and B and broken on Option C, the rest of C working', () => {
    drawDoneOptions();
    link(true);
    expect(map().screens.map((s) => s.name)).toEqual(['Form', 'Confirm', 'Done']);
    expect(tabLinks('A')).toEqual(['confirm/Back → Back', 'confirm/Pay now → done']);
    expect(tabLinks('B')).toEqual(['confirm/Back → Back', 'confirm/Pay now → done']);
    expect(tabLinks('in-use')).toEqual(['form/Continue → confirm', 'confirm/Back → Back', 'confirm/Pay now → done']);
    expect(tabLinks('C')).toEqual(['confirm/Back → Back', 'confirm/Pay now → done (button-gone)']);
    expect(tab('C').links[1]!.warning).toBe('"Pay now" is not on Option C of Confirm, so Play skips it here.');
    // The link itself is fine: its button is on some of Confirm's options.
    expect(map().links.every((l) => !l.broken)).toBe(true);
  });

  it('breaks a link on a tab where the screen it leads to is left out', () => {
    drawDoneOptions(['A', 'B']);
    studio.setPrototypeLink(bp, 'booking', { screen: 'confirm', button: 'Back', to: { screen: 'done' } }, sketch().stamp);
    expect(tabLinks('A')).toEqual(['confirm/Back → done']);
    expect(tabLinks('C')).toEqual(['confirm/Back → done (screen-off)']);
    expect(tab('C').links[0]!.warning).toBe('Done has no Option C, so this link is off here.');
  });

  it('saves a link for a button that is on one option only', () => {
    const stamp = studio.setPrototypeLink(bp, 'booking', { screen: 'confirm', button: 'Pay by card', to: { back: true } }, sketch().stamp).stamp;
    expect(tabLinks('C')).toEqual(['confirm/Pay by card → Back']);
    expect(tabLinks('A')).toEqual(['confirm/Pay by card → Back (button-gone)']);
    expect(() => studio.setPrototypeLink(bp, 'booking', { screen: 'confirm', button: 'Cancel', to: { back: true } }, stamp)).toThrow('Confirm has no button "Cancel"');
  });
});

describe('done when 4: Generate links the buttons of every option', () => {
  it('on a sample board, links Form and all three Confirm options, not only the one in use', async () => {
    drawDoneOptions();
    startLinkJob(bp, { sketch: 'booking', stamp: sketch().stamp });
    await linkJobsDone();
    expect(studio.readPrototypeFile(bp, 'booking').links.map((l) => `${l.screen}/${l.button} → ${'back' in l.to ? 'Back' : l.to.screen}`)).toEqual([
      'form/Continue → confirm',
      'confirm/Back → Back',
      'confirm/Pay now → done',
      'confirm/Pay by card → done',
    ]);
    // Each option has its way on: A and B by "Pay now", C by "Pay by card".
    for (const id of ['A', 'B', 'C']) expect(tab(id).links.filter((l) => l.screen === 'confirm' && !l.broken)).toHaveLength(2);
  });

  it('gives the AI Designer the pages of every option and every button', async () => {
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', quality: 'thrifty' });
    answers.push({ links: [{ screen: 'form', button: 'Continue', to: 'confirm' }, { screen: 'confirm', button: 'Pay by card', to: 'form' }], note: 'Linked.' });
    const r = await runLinker(bp, { sketch: 'booking', stamp: sketch().stamp }, { place: async () => () => undefined });
    expect(r.ok).toBe(true);
    const prompt = calls[0]!.prompt;
    for (const letter of ['A', 'B', 'C']) expect(prompt).toContain(`Option ${letter} pages desktop: .squad/studio/sketches/booking/screens/confirm/v${versionOf(letter)}/desktop.html`);
    expect(prompt).toContain('- Form (id form), pages desktop: .squad/studio/sketches/booking/screens/form/v2/desktop.html');
    expect(prompt).toContain('"Pay by card"');
    expect(prompt).toContain('a button with the same name leads to the same place on every option');
    expect(map().links.map((l) => `${l.screen}/${l.button}`)).toEqual(['form/Continue', 'confirm/Pay by card']);
    // On Option C, Form is left out: Form has no Option C, so the link to it is off there.
    expect(tabLinks('C')).toEqual(['confirm/Pay by card → form (screen-off)']);
  });

  it('the sample linker links each option\'s first button', () => {
    drawDone();
    expect(demoLinks(map()).filter((l) => l.screen === 'confirm').map((l) => l.button)).toEqual(['Back', 'Pay now', 'Pay by card']);
  });

  it('says "Draw a screen to start the prototype" when no screen has a drawing', () => {
    const s = studio.saveSketch(bp, { name: 'Empty', frames: ['desktop'], screens: [{ name: 'One' }] });
    expect(() => startLinkJob(bp, { sketch: 'empty', stamp: s.stamp })).toThrow('Draw a screen to start the prototype.');
  });
});

describe('done when 5: the start can be any screen, and Play changes nothing in the sketch', () => {
  it('starts every tab on Confirm when it is marked', () => {
    link();
    studio.setPrototypeStart(bp, 'booking', 'confirm', sketch().stamp, { by: 'Alaa' });
    const m = map();
    expect(m.start).toBe('confirm');
    expect(m.tabs.map((t) => t.start)).toEqual(['confirm', 'confirm', 'confirm', 'confirm']);
  });

  it('starts a tab the marked screen is not in on its first screen', () => {
    drawDoneOptions(['A', 'B']);
    studio.setPrototypeStart(bp, 'booking', 'done', sketch().stamp);
    expect(map().tabs.map((t) => [t.id, t.start])).toEqual([
      ['in-use', 'done'],
      ['A', 'done'],
      ['B', 'done'],
      ['C', 'confirm'],
    ]);
  });

  it('keeps Option B in use and writes no file while the prototype and its tabs are read, as Play does', async () => {
    link();
    const stamp = studio.setPrototypeStart(bp, 'booking', 'confirm', sketch().stamp).stamp;
    const confirmFile = fs.readFileSync(screenFile(bp, 'booking', 'confirm'), 'utf8');
    const before = snapshot();
    const app = new Hono();
    mountStudioApi(app, { paths: buildPaths(tmp) });
    for (let i = 0; i < 3; i++) await app.request('/api/v1/studio/sketches/booking/prototype');
    const m = map();
    expect(studio.tabDrawing(m.screens[1]!, 'C')!.version).toBe(versionOf('C'));
    expect(snapshot()).toEqual(before);
    expect(fs.readFileSync(screenFile(bp, 'booking', 'confirm'), 'utf8')).toBe(confirmFile);
    expect(sketch().screens.find((s) => s.id === 'confirm')!.chosen).toBe(versionOf('B'));
    expect(sketch().stamp).toBe(stamp);
  });
});
