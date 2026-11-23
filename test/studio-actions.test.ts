import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { boardPaths, type BoardPaths } from '../src/board/store.js';
import { CHANGED_ELSEWHERE, StudioChangedElsewhere, StudioInUse, addVariant, readSketch, readStudio, saveChat, saveThumbnail } from '../src/board/studio.js';
import {
  StudioNotFound,
  addScreen,
  changeDesignSystem,
  changeScreen,
  changeSketch,
  createDesignSystem,
  createSketch,
  deleteDesignSystem,
  deleteScreen,
  deleteSketch,
  designSystemList,
  getDesignSystem,
  getSketch,
  listDesignSystems,
  listSketches,
  newSketchDesignSystem,
} from '../src/board/studio-actions.js';
import { chatFile, designSystemFile, screenDir, sketchDir, thumbnailFile } from '../src/board/studio-paths.js';

/**
 * US-04 Studio API (AB-129): the shared Studio actions that the board's Studio API and the `squad studio` commands
 * both call. Every change brings the stamp it started from, and a stale one is refused with "Changed elsewhere,
 * reload" (AB-129.1).
 */

let tmp: string;
let bp: BoardPaths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-studio-actions-'));
  fs.mkdirSync(path.join(tmp, 'project', '.squad'), { recursive: true });
  bp = boardPaths(path.join(tmp, 'project', '.squad'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Every file under a folder, as paths inside it, with its bytes and change time. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out[r] = `${fs.readFileSync(path.join(d, e.name)).toString('base64')}@${fs.statSync(path.join(d, e.name)).mtimeMs}`;
    }
  };
  walk(dir, '');
  return out;
}

/** "Brand", and "Login" following it with two screens. */
function brandAndLogin() {
  const brand = createDesignSystem(bp, { name: 'Brand', tokens: { colors: { primary: '#2563eb' } }, components: { button: '<button>Go</button>' } });
  const login = createSketch(bp, { name: 'Login', designSystem: { id: 'brand' }, frames: ['desktop', 'mobile'], screens: [{ name: 'Sign in' }, { name: 'Forgot password' }] });
  return { brand, login };
}

describe('done when 1: listing and reading give back what is really saved', () => {
  it('lists the saved sketches and design systems, and reading "Login" gives its screens and names "Brand"', () => {
    brandAndLogin();
    // Drawn straight through the store, as another tab or the terminal would.
    addVariant(bp, 'login', 'sign-in', { frames: { desktop: '<main>Sign in</main>' } }, readSketch(bp, 'login')!.stamp);
    const before = snapshot(bp.squadDir);

    const sketches = listSketches(bp);
    expect(sketches.map((s) => [s.id, s.name, s.designSystem])).toEqual([['login', 'Login', { id: 'brand', version: 1, name: 'Brand' }]]);
    expect(sketches[0]!.stamp).toBe(readSketch(bp, 'login')!.stamp);

    const systems = listDesignSystems(bp);
    expect(systems.map((d) => [d.id, d.name, d.isDefault, d.version])).toEqual([['brand', 'Brand', true, 1]]);
    expect(systems[0]!.stamp).toBe(readStudio(bp).designSystems[0]!.stamp);

    const login = getSketch(bp, 'login');
    expect(login.designSystem).toEqual({ id: 'brand', version: 1, name: 'Brand' });
    expect(login.frames).toEqual(['desktop', 'mobile']);
    expect(login.screens.map((s) => [s.id, s.name, s.order, s.chosen])).toEqual([
      ['sign-in', 'Sign in', 1, 1],
      ['forgot-password', 'Forgot password', 2, null],
    ]);
    expect(login.screens[0]!.variants[0]!.frames).toEqual({ desktop: '<main>Sign in</main>' });
    expect(getDesignSystem(bp, 'brand').versions[0]!.components).toEqual({ button: '<button>Go</button>' });

    // Reading and listing write nothing (AB-127.1).
    expect(snapshot(bp.squadDir)).toEqual(before);
  });

  it('lists nothing and makes no folder in a project with no Studio work, and says plainly what is not there', () => {
    expect(listSketches(bp)).toEqual([]);
    expect(listDesignSystems(bp)).toEqual([]);
    expect(() => getSketch(bp, 'login')).toThrow(StudioNotFound);
    expect(() => getDesignSystem(bp, 'brand')).toThrow('This project has no design system "brand".');
    expect(fs.existsSync(bp.studioDir)).toBe(false);
  });
});

describe('done when 2: each step answers with what is saved, and a deleted screen is gone for good', () => {
  it('creates a design system, a sketch that follows it, then adds, renames and deletes a screen', () => {
    const brand = createDesignSystem(bp, { name: 'Brand' });
    expect(brand).toMatchObject({ id: 'brand', name: 'Brand', isDefault: true, version: 1 });
    expect(getDesignSystem(bp, 'brand')).toEqual(brand);

    const login = createSketch(bp, { name: 'Login', designSystem: { id: 'brand' } });
    expect(login).toMatchObject({ id: 'login', name: 'Login', frames: ['desktop'], screens: [], designSystem: { id: 'brand', version: 1, name: 'Brand' } });
    expect(getSketch(bp, 'login')).toEqual(login);

    const added = addScreen(bp, 'login', { name: 'Sign in' }, login.stamp);
    expect(added.screens.map((s) => [s.id, s.name, s.order, s.status, s.chosen])).toEqual([['sign-in', 'Sign in', 1, 'draft', null]]);
    // The answer is the sketch as saved, with the new screen's id (US-11).
    expect({ ...getSketch(bp, 'login'), added: 'sign-in' }).toEqual(added);
    expect(added.stamp).not.toBe(login.stamp);

    const renamed = changeScreen(bp, 'login', 'sign-in', { name: 'Log in' }, added.stamp);
    expect(renamed.screens.map((s) => [s.id, s.name])).toEqual([['sign-in', 'Log in']]);
    expect(getSketch(bp, 'login')).toEqual(renamed);

    const deleted = deleteScreen(bp, 'login', 'sign-in', renamed.stamp);
    expect(deleted.screens).toEqual([]);
    expect(getSketch(bp, 'login')).toEqual(deleted);
    // Gone for good: no folder, no bin anywhere in the project.
    expect(fs.existsSync(screenDir(bp, 'login', 'sign-in'))).toBe(false);
    expect(Object.keys(snapshot(bp.squadDir)).filter((f) => /sign-in|bin|trash/i.test(f))).toEqual([]);
  });

  it('a second screen goes after the first, and a screen can be marked ready and moved', () => {
    const { login } = brandAndLogin();
    const more = addScreen(bp, 'login', { name: 'Welcome' }, login.stamp);
    expect(more.screens.map((s) => [s.id, s.order])).toEqual([['sign-in', 1], ['forgot-password', 2], ['welcome', 3]]);
    const moved = changeScreen(bp, 'login', 'welcome', { order: 0, status: 'ready' }, more.stamp);
    expect(moved.screens.map((s) => [s.id, s.status])).toEqual([['welcome', 'ready'], ['sign-in', 'draft'], ['forgot-password', 'draft']]);
    expect(() => addScreen(bp, 'login', { name: 'Welcome' }, moved.stamp)).toThrow('A screen called "Welcome" already exists in Login. Pick another name.');
    expect(() => changeScreen(bp, 'login', 'nope', { name: 'X' }, moved.stamp)).toThrow(StudioNotFound);
  });

  it('renames a sketch and a design system, and new tokens become the next design system version', () => {
    const { brand, login } = brandAndLogin();
    const sketch = changeSketch(bp, 'login', { name: 'Log in' }, login.stamp);
    expect(sketch).toMatchObject({ name: 'Log in', frames: ['desktop', 'mobile'], designSystem: { id: 'brand', version: 1 } });
    expect(sketch.screens).toHaveLength(2);
    const ds = changeDesignSystem(bp, 'brand', { tokens: { colors: { primary: '#000000' } } }, brand.stamp);
    expect(ds).toMatchObject({ name: 'Brand', version: 2, isDefault: true });
    expect(ds.versions.map((v) => v.version)).toEqual([1, 2]);
    const renamed = changeDesignSystem(bp, 'brand', { name: 'Brand 2' }, ds.stamp);
    expect(renamed).toMatchObject({ name: 'Brand 2', version: 2 });
    expect(getSketch(bp, 'login').designSystem).toEqual({ id: 'brand', version: 1, name: 'Brand 2' });
  });

  it('deletes a sketch for good, with this computer\'s thumbnails and chats for it', () => {
    const { login } = brandAndLogin();
    const drawn = addVariant(bp, 'login', 'sign-in', { frames: { desktop: '<main/>' } }, login.stamp);
    saveThumbnail(bp, 'login', 'sign-in', 1, Buffer.from('png'));
    saveChat(bp, 'login', 'talk', { messages: [{ role: 'person', text: 'Hi' }] });
    expect(deleteSketch(bp, 'login', drawn.stamp)).toEqual({ deleted: 'login', name: 'Login', screens: 2 });
    expect(fs.existsSync(sketchDir(bp, 'login'))).toBe(false);
    expect(fs.existsSync(thumbnailFile(bp, 'login', 'sign-in', 1))).toBe(false);
    expect(fs.existsSync(chatFile(bp, 'login', 'talk'))).toBe(false);
    expect(listSketches(bp)).toEqual([]);
  });

  it('refuses a change without a stamp, and writes nothing', () => {
    const { login } = brandAndLogin();
    const before = snapshot(bp.squadDir);
    expect(() => changeSketch(bp, 'login', { name: 'X' }, undefined)).toThrow('Send the stamp of what you started from. Reload and try again.');
    expect(() => deleteSketch(bp, 'login', '')).toThrow('Send the stamp');
    // A name another screen of the sketch has (US-11, AB-136.1); with no name at all, it would be "New screen".
    expect(() => addScreen(bp, 'login', { name: 'sign in ' }, login.stamp)).toThrow('A screen called "Sign in" already exists in Login. Pick another name.');
    expect(() => createSketch(bp, { name: 'Pay', designSystem: { id: 'ocean' } })).toThrow('This project has no design system "ocean".');
    expect(snapshot(bp.squadDir)).toEqual(before);
  });
});

describe('done when 3: two changes from the same version, the later one is refused', () => {
  it('keeps the terminal\'s change and refuses the client\'s with "Changed elsewhere, reload", writing nothing', () => {
    const { login } = brandAndLogin();
    // Both start from the same version of "Login".
    const started = getSketch(bp, 'login').stamp;
    expect(started).toBe(login.stamp);

    const terminal = changeSketch(bp, 'login', { name: 'Login (terminal)' }, started);
    const after = snapshot(bp.squadDir);
    for (const change of [
      () => changeSketch(bp, 'login', { name: 'Login (client)' }, started),
      () => addScreen(bp, 'login', { name: 'Welcome' }, started),
      () => changeScreen(bp, 'login', 'sign-in', { name: 'Hello' }, started),
      () => deleteScreen(bp, 'login', 'sign-in', started),
      () => deleteSketch(bp, 'login', started),
    ]) {
      expect(change).toThrow(StudioChangedElsewhere);
      expect(change).toThrow(CHANGED_ELSEWHERE);
    }
    expect(CHANGED_ELSEWHERE).toBe('Changed elsewhere, reload');
    expect(snapshot(bp.squadDir)).toEqual(after);
    expect(getSketch(bp, 'login')).toEqual(terminal);
    expect(terminal.name).toBe('Login (terminal)');
  });

  it('a design system change from an old version is refused the same way', () => {
    const { brand } = brandAndLogin();
    changeDesignSystem(bp, 'brand', { name: 'Brand A' }, brand.stamp);
    const after = snapshot(bp.squadDir);
    expect(() => changeDesignSystem(bp, 'brand', { name: 'Brand B' }, brand.stamp)).toThrow(CHANGED_ELSEWHERE);
    expect(() => deleteDesignSystem(bp, 'brand', brand.stamp)).toThrow(CHANGED_ELSEWHERE);
    expect(snapshot(bp.squadDir)).toEqual(after);
    expect(getDesignSystem(bp, 'brand').name).toBe('Brand A');
  });
});

describe('done when 4: a design system that sketches follow is not deleted', () => {
  it('refuses to delete "Brand", lists "Login" and "Checkout", and leaves "Brand" as it was', () => {
    const { brand } = brandAndLogin();
    createSketch(bp, { name: 'Checkout', designSystem: { id: 'brand' } });
    createSketch(bp, { name: 'Notes' });
    const before = snapshot(bp.squadDir);

    let refused: unknown;
    try {
      deleteDesignSystem(bp, 'brand', brand.stamp);
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(StudioInUse);
    const inUse = refused as StudioInUse;
    expect(inUse.sketches.map((s) => s.name).sort()).toEqual(['Checkout', 'Login']);
    expect(inUse.message).toContain('"Login"');
    expect(inUse.message).toContain('"Checkout"');
    expect(snapshot(bp.squadDir)).toEqual(before);
    expect(getDesignSystem(bp, 'brand')).toEqual(brand);
  });

  it('deletes it for good once no sketch follows it, and the next one becomes the default', () => {
    const { login } = brandAndLogin();
    createDesignSystem(bp, { name: 'Ocean' });
    const moved = changeSketch(bp, 'login', { designSystem: { id: 'ocean' } }, login.stamp);
    expect(moved.designSystem).toEqual({ id: 'ocean', version: 1, name: 'Ocean' });
    expect(deleteDesignSystem(bp, 'brand', getDesignSystem(bp, 'brand').stamp)).toEqual({ deleted: 'brand' });
    expect(fs.existsSync(path.join(bp.studioDir, 'design-systems', 'brand'))).toBe(false);
    expect(listDesignSystems(bp).map((d) => [d.id, d.isDefault])).toEqual([['ocean', true]]);
  });
});

/* ── US-33 Several design systems per project (AB-158) ── */

const PATIENT_V2 = {
  colors: { primary: '#1D6FB8', again: '#1d6fb8', soft: '#e6f0fa', success: 'rgb(34 160 90)', ink: '#0f1f33', line: 'hsl(210 20% 88%)', paper: '#ffffff', seventh: '#000' },
  ref: '{colors.primary}',
  named: 'blue',
  bad: 'url(https://example.com/x.png)',
  font: { body: 'Inter' },
};

/** "Patient app" made first, at version 2 and followed by 4 sketches; then "Admin dashboard", version 1, followed by 1. */
function patientAndAdmin() {
  const patient = createDesignSystem(bp, { name: 'Patient app', tokens: { colors: { primary: '#2563eb' } } });
  createSketch(bp, { name: 'Book a visit', designSystem: { id: 'patient-app' } });
  changeDesignSystem(bp, 'patient-app', { tokens: PATIENT_V2 }, patient.stamp);
  for (const name of ['My visits', 'Sign in', 'Profile']) createSketch(bp, { name, designSystem: { id: 'patient-app' } });
  createDesignSystem(bp, { name: 'Admin dashboard', tokens: { color: { brand: { $value: '#5b47d6', $type: 'color' }, mist: { $value: '#eeeaff' } } } });
  createSketch(bp, { name: 'Staff schedule', designSystem: { id: 'admin-dashboard' } });
  createSketch(bp, { name: 'Notes' });
}

const systemYaml = (id: string) => yaml.load(fs.readFileSync(designSystemFile(bp, id), 'utf8')) as Record<string, unknown>;
/** Writes a design system's own file by hand, as a merge or a teammate's edit would. */
function setSystem(id: string, change: Record<string, unknown>) {
  fs.writeFileSync(designSystemFile(bp, id), yaml.dump({ ...systemYaml(id), ...change }));
}

describe('US-33: the first design system made is the one default (AB-158.1)', () => {
  it('marks "Patient app" default and "Admin dashboard" not, and only Patient app is saved as the default', () => {
    const patient = createDesignSystem(bp, { name: 'Patient app' });
    expect(patient.isDefault).toBe(true);
    const admin = createDesignSystem(bp, { name: 'Admin dashboard' });
    expect(admin.isDefault).toBe(false);

    // The saved files: only Patient app's own file says default, and each has the time it was made.
    expect(systemYaml('patient-app')).toEqual({ name: 'Patient app', default: true, version: 1, madeAt: patient.madeAt, frames: ['desktop', 'mobile'] });
    expect(systemYaml('admin-dashboard')).toEqual({ name: 'Admin dashboard', default: false, version: 1, madeAt: admin.madeAt, frames: ['desktop', 'mobile'] });
    expect(Number.isNaN(Date.parse(patient.madeAt))).toBe(false);

    expect(newSketchDesignSystem(bp)).toEqual({ id: 'patient-app', name: 'Patient app', version: 1, frames: ['desktop', 'mobile'] });
    expect(designSystemList(bp).designSystems.filter((d) => d.isDefault).map((d) => d.name)).toEqual(['Patient app']);
  });

  it('keeps the default and the made times through renames and new versions of either one', () => {
    const patient = createDesignSystem(bp, { name: 'Patient app' });
    const admin = createDesignSystem(bp, { name: 'Admin dashboard' });
    changeDesignSystem(bp, 'admin-dashboard', { name: 'Admin', tokens: { colors: { brand: '#5b47d6' } } }, admin.stamp);
    changeDesignSystem(bp, 'patient-app', { tokens: { colors: { brand: '#1d6fb8' } } }, patient.stamp);
    expect(systemYaml('admin-dashboard')).toEqual({ name: 'Admin', default: false, version: 2, madeAt: admin.madeAt, frames: ['desktop', 'mobile'] });
    expect(systemYaml('patient-app')).toEqual({ name: 'Patient app', default: true, version: 2, madeAt: patient.madeAt, frames: ['desktop', 'mobile'] });
    expect(newSketchDesignSystem(bp)).toEqual({ id: 'patient-app', name: 'Patient app', version: 2, frames: ['desktop', 'mobile'] });
  });

  it('gives exactly one Default when two are marked (two first ones merged): the older marked one', () => {
    createDesignSystem(bp, { name: 'Patient app' });
    createDesignSystem(bp, { name: 'Admin dashboard' });
    setSystem('patient-app', { default: true, madeAt: '2026-11-10T09:00:00.000Z' });
    setSystem('admin-dashboard', { default: true, madeAt: '2026-11-09T09:00:00.000Z' });
    const list = designSystemList(bp);
    expect(list.designSystems.map((d) => [d.name, d.isDefault])).toEqual([['Admin dashboard', true], ['Patient app', false]]);
    expect(list.default?.name).toBe('Admin dashboard');
    expect(newSketchDesignSystem(bp)?.id).toBe('admin-dashboard');
  });

  it('gives exactly one Default when none is marked: the oldest one', () => {
    createDesignSystem(bp, { name: 'Patient app' });
    createDesignSystem(bp, { name: 'Admin dashboard' });
    createDesignSystem(bp, { name: 'Kiosk' });
    setSystem('patient-app', { default: false, madeAt: '2026-11-10T09:00:00.000Z' });
    setSystem('admin-dashboard', { default: false, madeAt: '2026-11-11T09:00:00.000Z' });
    setSystem('kiosk', { default: false, madeAt: '2026-11-09T09:00:00.000Z' });
    const list = designSystemList(bp);
    // The Default first, then the others in the order they were made.
    expect(list.designSystems.map((d) => [d.name, d.isDefault])).toEqual([['Kiosk', true], ['Patient app', false], ['Admin dashboard', false]]);
    expect(newSketchDesignSystem(bp)).toEqual({ id: 'kiosk', name: 'Kiosk', version: 1, frames: ['desktop', 'mobile'] });
  });

  it('has no default and no card while the project has no design system', () => {
    expect(designSystemList(bp)).toEqual({ designSystems: [], default: null });
    expect(newSketchDesignSystem(bp)).toBeNull();
    expect(fs.existsSync(bp.studioDir)).toBe(false);
  });
});

describe('US-33: the Design systems list', () => {
  it('gives each one its version, up to six real colours and how many sketches follow it, the Default first', () => {
    patientAndAdmin();
    const list = designSystemList(bp);
    expect(list.designSystems.map((d) => ({ name: d.name, version: d.version, isDefault: d.isDefault, colors: d.colors, sketches: d.sketches }))).toEqual([
      { name: 'Patient app', version: 2, isDefault: true, colors: ['#1D6FB8', '#e6f0fa', 'rgb(34 160 90)', '#0f1f33', 'hsl(210 20% 88%)', '#ffffff'], sketches: 4 },
      { name: 'Admin dashboard', version: 1, isDefault: false, colors: ['#5b47d6', '#eeeaff'], sketches: 1 },
    ]);
    expect(list.default).toEqual({ id: 'patient-app', name: 'Patient app', version: 2, frames: ['desktop', 'mobile'] });
    // Each card keeps the stamp it was read with, for later changes.
    expect(list.designSystems[0]!.stamp).toBe(getDesignSystem(bp, 'patient-app').stamp);
  });

  it('reading the list and the new sketch answer writes nothing, also when it settles a tie', () => {
    patientAndAdmin();
    setSystem('admin-dashboard', { default: true });
    const before = snapshot(bp.squadDir);
    designSystemList(bp);
    newSketchDesignSystem(bp);
    listDesignSystems(bp);
    expect(snapshot(bp.squadDir)).toEqual(before);
  });
});
