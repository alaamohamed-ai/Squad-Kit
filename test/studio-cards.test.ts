import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { boardPaths, readMeta, writeMeta, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { chooseProject } from '../src/core/paths.js';
import { AI_DESIGNER, addVariant, pickVariant, readSketch, saveDrawnScreens, saveSketch } from '../src/board/studio.js';
import { addScreen, changeScreen, changeSketch, createDesignSystem, createSketch, deleteScreen, getSketch, sketchCover, sketchList } from '../src/board/studio-actions.js';
import { screenFile, sketchFile, variantMetaFile } from '../src/board/studio-paths.js';

/**
 * US-06 Sketches home: the grid (AB-131). Each change to a sketch writes when and by whom on the file it already saves
 * (AB-131.1): the sketch file, a screen file, or a drawing's own meta.yaml. The card's last edit is the newest mark,
 * worked out on read, and the cards come newest edit first. Reading the cards and a card's cover writes nothing.
 */

let tmp: string;
let home: string;
let bp: BoardPaths;
let oldHome: string | undefined;

const T0 = Date.parse('2026-11-16T09:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
/** The clock squad-kit reads, set to minutes after T0. */
const clock = (minutes: number) => vi.setSystemTime(T0 + minutes * 60_000);
/** The person in the project settings, whose name a change from the board or the terminal is marked with. */
const person = (name: string) => writeMeta(bp, { ...readMeta(bp), user: { ...readMeta(bp).user, name } });
const loadYaml = (file: string) => yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out[r] = `${fs.readFileSync(path.join(d, e.name)).toString('base64')}@${fs.statSync(path.join(d, e.name)).mtimeMs}`;
    }
  };
  walk(dir, '');
  return out;
}

const html = (title: string) => `<main><h1>${title}</h1></main>\n`;

beforeEach(() => {
  oldHome = process.env.SQUAD_KIT_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-studio-cards-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-studio-cards-home-'));
  process.env.SQUAD_KIT_HOME = home;
  fs.mkdirSync(path.join(tmp, 'project', '.squad'), { recursive: true });
  bp = boardPaths(path.join(tmp, 'project', '.squad'));
  seedDemoBoard(bp, { speed: 1000, studio: false });
  vi.useFakeTimers({ toFake: ['Date'] });
  clock(0);
  person('Sara');
});

afterEach(() => {
  vi.useRealTimers();
  if (oldHome === undefined) delete process.env.SQUAD_KIT_HOME;
  else process.env.SQUAD_KIT_HOME = oldHome;
  chooseProject(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('each change marks the file it saves (AB-131.1)', () => {
  it('making, renaming and new frames mark the sketch file; adding, renaming and marking a screen mark its screen file', () => {
    createSketch(bp, { name: 'Checkout', frames: ['desktop'] });
    expect(loadYaml(sketchFile(bp, 'checkout')).edited).toEqual({ at: at(0), by: 'Sara' });
    expect(getSketch(bp, 'checkout').lastEdit).toEqual({ at: at(0), by: 'Sara' });

    clock(5);
    person('Omar');
    changeSketch(bp, 'checkout', { name: 'Checkout flow' }, getSketch(bp, 'checkout').stamp);
    expect(loadYaml(sketchFile(bp, 'checkout')).edited).toEqual({ at: at(5), by: 'Omar' });

    clock(6);
    changeSketch(bp, 'checkout', { frames: ['desktop', 'mobile'] }, getSketch(bp, 'checkout').stamp);
    expect(loadYaml(sketchFile(bp, 'checkout')).edited).toEqual({ at: at(6), by: 'Omar' });

    clock(10);
    person('Sara');
    addScreen(bp, 'checkout', { name: 'Cart' }, getSketch(bp, 'checkout').stamp);
    expect(loadYaml(screenFile(bp, 'checkout', 'cart')).edited).toEqual({ at: at(10), by: 'Sara' });
    // Adding a screen leaves the sketch file as it was: only the file the change writes gets the mark.
    expect(loadYaml(sketchFile(bp, 'checkout')).edited).toEqual({ at: at(6), by: 'Omar' });
    expect(getSketch(bp, 'checkout').lastEdit).toEqual({ at: at(10), by: 'Sara' });

    clock(12);
    person('Omar');
    changeScreen(bp, 'checkout', 'cart', { name: 'Your cart', status: 'ready' }, getSketch(bp, 'checkout').stamp);
    expect(loadYaml(screenFile(bp, 'checkout', 'cart'))).toMatchObject({ name: 'Your cart', status: 'ready', edited: { at: at(12), by: 'Omar' } });
    expect(getSketch(bp, 'checkout').lastEdit).toEqual({ at: at(12), by: 'Omar' });
  });

  it('a drawing marks its own version, picking one marks the screen file, deleting a screen marks the sketch file', () => {
    createSketch(bp, { name: 'Checkout', frames: ['desktop'], screens: [{ name: 'Cart' }, { name: 'Payment' }] });
    clock(20);
    addVariant(bp, 'checkout', 'cart', { frames: { desktop: html('Cart') }, madeBy: 'Omar' }, getSketch(bp, 'checkout').stamp);
    expect(loadYaml(variantMetaFile(bp, 'checkout', 'cart', 1))).toMatchObject({ madeAt: at(20), madeBy: 'Omar' });
    expect(getSketch(bp, 'checkout').lastEdit).toEqual({ at: at(20), by: 'Omar' });

    // The AI Designer's drawing, for the person who asked.
    clock(30);
    saveDrawnScreens(bp, 'checkout', [{ id: 'cart', name: 'Cart', frames: { desktop: html('Cart, calmer') } }], getSketch(bp, 'checkout').stamp, { madeBy: AI_DESIGNER, madeFor: 'Sara' });
    expect(loadYaml(variantMetaFile(bp, 'checkout', 'cart', 2))).toMatchObject({ madeAt: at(30), madeBy: 'AI Designer', madeFor: 'Sara' });
    expect(getSketch(bp, 'checkout').lastEdit).toEqual({ at: at(30), by: 'AI Designer', for: 'Sara' });

    clock(40);
    pickVariant(bp, 'checkout', 'cart', 1, getSketch(bp, 'checkout').stamp, { by: 'Sara' });
    expect(loadYaml(screenFile(bp, 'checkout', 'cart'))).toMatchObject({ chosen: 1, edited: { at: at(40), by: 'Sara' } });
    expect(getSketch(bp, 'checkout').lastEdit).toEqual({ at: at(40), by: 'Sara' });

    clock(50);
    person('Omar');
    deleteScreen(bp, 'checkout', 'payment', getSketch(bp, 'checkout').stamp);
    expect(loadYaml(sketchFile(bp, 'checkout')).edited).toEqual({ at: at(50), by: 'Omar' });
    expect(getSketch(bp, 'checkout').lastEdit).toEqual({ at: at(50), by: 'Omar' });
  });

  it('a save that changes nothing writes nothing, so its mark and the stamp stay', () => {
    createSketch(bp, { name: 'Checkout', frames: ['desktop'], screens: [{ name: 'Cart' }] });
    const before = snapshot(bp.studioDir);
    const stamp = getSketch(bp, 'checkout').stamp;
    clock(60);
    person('Omar');
    changeSketch(bp, 'checkout', { name: 'Checkout' }, stamp);
    changeScreen(bp, 'checkout', 'cart', { name: 'Cart' }, stamp);
    expect(snapshot(bp.studioDir)).toEqual(before);
    expect(getSketch(bp, 'checkout')).toMatchObject({ stamp, lastEdit: { at: at(0), by: 'Sara' } });
  });

  it('the newest mark wins, from any of its files', () => {
    saveSketch(bp, { name: 'Checkout', frames: ['desktop'], screens: [{ name: 'Cart' }, { name: 'Payment' }] }, null, { by: 'Sara' });
    clock(30);
    changeScreen(bp, 'checkout', 'payment', { status: 'ready' }, getSketch(bp, 'checkout').stamp);
    clock(20);
    addVariant(bp, 'checkout', 'cart', { frames: { desktop: html('Cart') }, madeBy: 'Omar' }, getSketch(bp, 'checkout').stamp);
    // The drawing at 20 is older than Payment's mark at 30, even though it was saved last.
    expect(getSketch(bp, 'checkout').lastEdit).toEqual({ at: at(30), by: 'Sara' });
  });

  it('a sketch made before marks were kept still reads; a mark that cannot be read is left out', () => {
    const dir = path.dirname(sketchFile(bp, 'old'));
    fs.mkdirSync(path.join(dir, 'screens', 'home'), { recursive: true });
    fs.writeFileSync(sketchFile(bp, 'old'), yaml.dump({ name: 'Old one', designSystem: null, frames: ['desktop'] }));
    fs.writeFileSync(screenFile(bp, 'old', 'home'), yaml.dump({ name: 'Home', order: 1, status: 'draft', chosen: null, edited: { at: 'soon', by: 'Sara' } }));
    expect(readSketch(bp, 'old')).toMatchObject({ name: 'Old one', lastEdit: null, screens: [{ id: 'home', name: 'Home' }] });
    expect(readSketch(bp, 'old')!.screens[0]!.edited).toBeUndefined();
    const card = sketchList(bp).find((s) => s.id === 'old')!.card;
    expect(card).toEqual({ cover: null, screens: 1, approved: 0, designSystem: null, edited: null });

    // Its drawings, made before too, already say when and by whom.
    fs.mkdirSync(path.join(dir, 'screens', 'home', 'v1'));
    fs.writeFileSync(path.join(dir, 'screens', 'home', 'v1', 'desktop.html'), html('Home'));
    fs.writeFileSync(variantMetaFile(bp, 'old', 'home', 1), yaml.dump({ madeAt: at(-60), madeBy: 'Omar' }));
    expect(readSketch(bp, 'old')!.lastEdit).toEqual({ at: at(-60), by: 'Omar' });
  });
});

describe('approved screens (US-06 done when 1 and 2)', () => {
  it('counts the screens marked Approved, never the Ready ones; a person still marks only draft or ready', () => {
    const statuses = ['approved', 'ready', 'approved', 'draft', 'ready'] as const;
    saveSketch(bp, { name: 'Onboarding', frames: ['desktop'], screens: statuses.map((status, i) => ({ name: `Step ${i + 1}`, status })) }, null, { by: 'Sara' });
    expect(readSketch(bp, 'onboarding')!.screens.map((s) => s.status)).toEqual([...statuses]);
    expect(sketchList(bp)[0]!.card).toMatchObject({ screens: 5, approved: 2 });

    saveSketch(bp, { name: 'Checkout', frames: ['desktop'], screens: [{ name: 'Cart', status: 'ready' }, { name: 'Payment' }, { name: 'Done' }] }, null, { by: 'Sara' });
    expect(sketchList(bp).find((s) => s.id === 'checkout')!.card).toMatchObject({ screens: 3, approved: 0 });

    // Approving comes with its own button (US-15): the board and the terminal cannot set it yet, and a rename keeps it.
    const stamp = getSketch(bp, 'onboarding').stamp;
    expect(() => changeScreen(bp, 'onboarding', 'step-4', { status: 'approved' as never }, stamp)).toThrow(/draft or ready/);
    expect(() => createSketch(bp, { name: 'Profile', screens: [{ name: 'Me', status: 'approved' as never }] })).toThrow(/draft or ready/);
    changeScreen(bp, 'onboarding', 'step-1', { name: 'Welcome' }, stamp);
    expect(getSketch(bp, 'onboarding').screens[0]).toMatchObject({ name: 'Welcome', status: 'approved' });
  });
});

describe('the cards (US-06)', () => {
  it('done when 1: Checkout shows desktop and mobile of its first screen, 3 screens, Brand and its last edit', () => {
    createDesignSystem(bp, { name: 'Brand' });
    clock(-120);
    createSketch(bp, { name: 'Checkout', designSystem: { id: 'brand' }, frames: ['desktop', 'mobile'], screens: [{ name: 'Cart' }, { name: 'Payment', status: 'ready' }, { name: 'Done' }] });
    addVariant(bp, 'checkout', 'cart', { frames: { desktop: html('Cart'), mobile: html('Cart, small') }, madeBy: 'Sara' }, getSketch(bp, 'checkout').stamp);
    const [card] = sketchList(bp);
    expect(card!.card).toEqual({ cover: { screen: 'cart', version: 1, views: ['desktop', 'mobile'] }, screens: 3, approved: 0, designSystem: 'Brand', edited: { at: at(-120), by: 'Sara' } });
    expect(sketchCover(bp, 'checkout')).toEqual({ screen: 'cart', version: 1, frames: { desktop: html('Cart'), mobile: html('Cart, small') } });
  });

  it('done when 3: newest edit first — Checkout redrawn by the AI Designer, Profile just made, Onboarding renamed yesterday', () => {
    clock(-3 * 24 * 60);
    createSketch(bp, { id: 'onboarding', name: 'Onboarding draft', frames: ['desktop'], screens: [{ name: 'Welcome' }] });
    clock(-2 * 24 * 60);
    createSketch(bp, { name: 'Checkout', frames: ['desktop', 'mobile'], screens: [{ name: 'Cart' }] });
    clock(-24 * 60);
    changeSketch(bp, 'onboarding', { name: 'Onboarding' }, getSketch(bp, 'onboarding').stamp);
    clock(-60);
    person('Omar');
    createSketch(bp, { name: 'Profile', frames: ['desktop', 'mobile'] });
    clock(-10);
    saveDrawnScreens(bp, 'checkout', [{ id: 'cart', name: 'Cart', frames: { desktop: html('Cart'), mobile: html('Cart') } }], getSketch(bp, 'checkout').stamp, { madeBy: AI_DESIGNER, madeFor: 'Sara' });
    clock(0);

    const cards = sketchList(bp);
    expect(cards.map((s) => s.name)).toEqual(['Checkout', 'Profile', 'Onboarding']);
    expect(cards.map((s) => s.card.edited)).toEqual([
      { at: at(-10), by: 'AI Designer', for: 'Sara' },
      { at: at(-60), by: 'Omar' },
      { at: at(-24 * 60), by: 'Sara' },
    ]);
  });

  it('puts equal times in name order, and a sketch with no mark last', () => {
    for (const name of ['Zebra', 'Apple']) saveSketch(bp, { name, frames: ['desktop'] }, null, { by: 'Sara' });
    const dir = path.dirname(sketchFile(bp, 'unmarked'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sketchFile(bp, 'unmarked'), yaml.dump({ name: 'Aardvark', designSystem: null, frames: ['desktop'] }));
    expect(sketchList(bp).map((s) => s.name)).toEqual(['Apple', 'Zebra', 'Aardvark']);
  });

  it('done when 5: a desktop-only sketch shows only desktop; a first screen with no drawing has no cover', () => {
    createSketch(bp, { name: 'Onboarding', frames: ['desktop'], screens: [{ name: 'Welcome' }] });
    addVariant(bp, 'onboarding', 'welcome', { frames: { desktop: html('Welcome') } }, getSketch(bp, 'onboarding').stamp);
    // Its first screen in order is the one shown, even when a later screen is drawn.
    createSketch(bp, { name: 'Profile', frames: ['desktop', 'mobile'], screens: [{ name: 'Me' }, { name: 'Settings' }] });
    addVariant(bp, 'profile', 'settings', { frames: { desktop: html('Settings'), mobile: html('Settings') } }, getSketch(bp, 'profile').stamp);

    const by = Object.fromEntries(sketchList(bp).map((s) => [s.id, s.card]));
    expect(by.onboarding!.cover).toEqual({ screen: 'welcome', version: 1, views: ['desktop'] });
    expect(sketchCover(bp, 'onboarding').frames).toEqual({ desktop: html('Welcome') });
    expect(by.profile!.cover).toBeNull();
    expect(sketchCover(bp, 'profile')).toEqual({ screen: null, version: null, frames: {} });
  });

  it('opening the list and reading a cover writes no file', () => {
    createSketch(bp, { name: 'Checkout', frames: ['desktop', 'mobile'], screens: [{ name: 'Cart' }] });
    addVariant(bp, 'checkout', 'cart', { frames: { desktop: html('Cart'), mobile: html('Cart') } }, getSketch(bp, 'checkout').stamp);
    const shared = snapshot(bp.squadDir);
    const local = snapshot(bp.localDir);
    clock(90);
    sketchList(bp);
    sketchCover(bp, 'checkout');
    expect(snapshot(bp.squadDir)).toEqual(shared);
    expect(snapshot(bp.localDir)).toEqual(local);
  });
});
