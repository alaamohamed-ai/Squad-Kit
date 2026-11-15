import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import type { BoardPaths } from '../src/board/store.js';

/**
 * US-04 Studio API (AB-129) through the running board: /p/<id>/api/v1/studio, behind the board's token check. The
 * routes call the same Studio actions as the terminal, so a change the terminal saved first wins and the board's later
 * save from the same version is refused with "Changed elsewhere, reload". No agent ever starts here.
 */

vi.mock('../src/engine/live.js', async (orig) => {
  const actual = await orig<typeof import('../src/engine/live.js')>();
  class QuietSquad {
    start() {
      return () => undefined;
    }
    ticketsRunning() {
      return 0;
    }
  }
  return { ...actual, LiveSquad: QuietSquad };
});
vi.mock('../src/planner/runtimes/auth-probe.js', async (orig) => ({
  ...(await orig<typeof import('../src/planner/runtimes/auth-probe.js')>()),
  probeClaudeAuth: async () => ({ ok: true }),
}));

const { buildPaths } = await import('../src/core/paths.js');
const { boardPaths } = await import('../src/board/store.js');
const { startConsoleServer } = await import('../src/console/server.js');
const actions = await import('../src/board/studio-actions.js');

const TOKEN = 'c'.repeat(64);
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

let tmp: string;
let bp: BoardPaths;
let server: Awaited<ReturnType<typeof startConsoleServer>>;
let api: string;

const call = async <T = Record<string, unknown>>(method: string, p: string, body?: unknown, headers: Record<string, string> = auth) => {
  const res = await fetch(`${api}${p}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: (await res.json()) as T };
};

/** Every file in the project and this computer's folder for it, with its bytes and change time. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out[r] = `${fs.readFileSync(path.join(d, e.name)).toString('base64')}@${fs.statSync(path.join(d, e.name)).mtimeMs}`;
    }
  };
  walk(bp.studioDir, 'studio');
  walk(bp.studioLocalDir, 'local');
  return out;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-studio-api-'));
  const project = path.join(tmp, 'shop');
  const paths = buildPaths(project);
  fs.mkdirSync(paths.squadDir, { recursive: true });
  fs.writeFileSync(paths.configFile, yaml.dump({ version: 1, project: { name: 'shop', primaryLanguage: 'typescript' }, tracker: { type: 'none' }, agents: [] }));
  bp = boardPaths(paths.squadDir);
  server = await startConsoleServer({ paths, requestedPort: 0, token: TOKEN });
  api = `http://127.0.0.1:${server.port}/p/${encodeURIComponent(bp.projectId)}/api/v1/studio`;
});

afterAll(async () => {
  await server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(bp.studioDir, { recursive: true, force: true });
});

interface SketchBody {
  id: string;
  name: string;
  stamp: string;
  designSystem: { id: string; version: number; name: string | null } | null;
  screens: { id: string; name: string; variants: { version: number; frames: string[]; html: Record<string, string> }[] }[];
}

describe('Studio API', () => {
  it('done when 1: lists what is saved and reads "Login" with its screens and "Brand"', async () => {
    actions.createDesignSystem(bp, { name: 'Brand', components: { button: '<button>Go</button>' } });
    actions.createSketch(bp, { name: 'Login', designSystem: { id: 'brand' }, screens: [{ name: 'Sign in' }] });
    const before = snapshot();

    const sketches = await call<{ sketches: SketchBody[] }>('GET', '/sketches');
    expect(sketches.status).toBe(200);
    expect(sketches.data.sketches.map((s) => [s.id, s.name, s.designSystem])).toEqual([['login', 'Login', { id: 'brand', version: 1, name: 'Brand' }]]);

    const systems = await call<{ designSystems: { id: string; name: string; isDefault: boolean; versions: { components: string[] }[] }[] }>('GET', '/design-systems');
    expect(systems.data.designSystems.map((d) => [d.id, d.name, d.isDefault, d.versions[0]!.components])).toEqual([['brand', 'Brand', true, ['button']]]);

    const login = await call<SketchBody>('GET', '/sketches/login');
    expect(login.status).toBe(200);
    expect(login.data.designSystem).toEqual({ id: 'brand', version: 1, name: 'Brand' });
    expect(login.data.screens.map((s) => [s.id, s.name])).toEqual([['sign-in', 'Sign in']]);
    expect(login.data.stamp).toBe(actions.getSketch(bp, 'login').stamp);

    const brand = await call<{ versions: { html: Record<string, string> }[] }>('GET', '/design-systems/brand');
    expect(brand.data.versions[0]!.html).toEqual({ button: '<button>Go</button>' });

    expect((await call('GET', '/sketches/nope')).status).toBe(404);
    // Reading writes nothing.
    expect(snapshot()).toEqual(before);
  });

  it('done when 2: creates, adds, renames and deletes a screen, each answer the saved result', async () => {
    const ds = await call<{ id: string; isDefault: boolean }>('POST', '/design-systems', { name: 'Brand' });
    expect(ds.status).toBe(200);
    expect(ds.data).toMatchObject({ id: 'brand', isDefault: true });

    const made = await call<SketchBody>('POST', '/sketches', { name: 'Login', designSystem: { id: 'brand' } });
    expect(made.data).toMatchObject({ id: 'login', designSystem: { id: 'brand', version: 1, name: 'Brand' }, screens: [] });
    expect((await call<SketchBody>('GET', '/sketches/login')).data).toEqual(made.data);

    const added = await call<SketchBody>('POST', '/sketches/login/screens', { name: 'Sign in', stamp: made.data.stamp });
    expect(added.status).toBe(200);
    expect(added.data.screens.map((s) => s.name)).toEqual(['Sign in']);
    expect((await call<SketchBody>('GET', '/sketches/login')).data).toEqual(added.data);

    const renamed = await call<SketchBody>('PATCH', '/sketches/login/screens/sign-in', { name: 'Log in', stamp: added.data.stamp });
    expect(renamed.data.screens.map((s) => [s.id, s.name])).toEqual([['sign-in', 'Log in']]);
    expect((await call<SketchBody>('GET', '/sketches/login')).data).toEqual(renamed.data);

    const gone = await call<SketchBody>('DELETE', `/sketches/login/screens/sign-in?stamp=${renamed.data.stamp}`);
    expect(gone.status).toBe(200);
    expect(gone.data.screens).toEqual([]);
    expect((await call<SketchBody>('GET', '/sketches/login')).data).toEqual(gone.data);
    expect(Object.keys(snapshot()).filter((f) => f.includes('sign-in'))).toEqual([]);

    // A plain refusal is a 400 with its words; a change without the stamp is refused too.
    const nameless = await call<{ error: string }>('POST', '/sketches/login/screens', { name: '', stamp: gone.data.stamp });
    expect(nameless).toEqual({ status: 400, data: { error: 'Give the screen a name.' } });
    expect((await call('PATCH', '/sketches/login', { name: 'X' })).status).toBe(400);
  });

  it('done when 3: the terminal saves first, and the board\'s later save from the same version is refused', async () => {
    actions.createSketch(bp, { name: 'Login', screens: [{ name: 'Sign in' }] });
    const started = (await call<SketchBody>('GET', '/sketches/login')).data.stamp;

    // The terminal calls the same action directly.
    const terminal = actions.changeSketch(bp, 'login', { name: 'Login (terminal)' }, started);
    const after = snapshot();

    const client = await call<{ error: string; changedElsewhere: boolean }>('PATCH', '/sketches/login', { name: 'Login (board)', stamp: started });
    expect(client).toEqual({ status: 409, data: { error: 'Changed elsewhere, reload', changedElsewhere: true } });
    const screen = await call('PATCH', '/sketches/login/screens/sign-in', { name: 'Hello', stamp: started });
    expect(screen.status).toBe(409);
    expect((await call('DELETE', '/sketches/login', { stamp: started })).status).toBe(409);
    expect(snapshot()).toEqual(after);
    expect((await call<SketchBody>('GET', '/sketches/login')).data.name).toBe(terminal.name);
  });

  it('done when 4: refuses to delete "Brand" while "Login" and "Checkout" follow it, and keeps it', async () => {
    const brand = actions.createDesignSystem(bp, { name: 'Brand' });
    actions.createSketch(bp, { name: 'Login', designSystem: { id: 'brand' } });
    actions.createSketch(bp, { name: 'Checkout', designSystem: { id: 'brand' } });
    const before = snapshot();

    const refused = await call<{ error: string; followedBy: { id: string; name: string }[] }>('DELETE', `/design-systems/brand?stamp=${brand.stamp}`);
    expect(refused.status).toBe(409);
    expect(refused.data.followedBy.map((s) => s.name).sort()).toEqual(['Checkout', 'Login']);
    expect(refused.data.error).toContain('"Login"');
    expect(refused.data.error).toContain('"Checkout"');
    expect(snapshot()).toEqual(before);
    expect((await call<{ name: string; stamp: string }>('GET', '/design-systems/brand')).data).toMatchObject({ name: 'Brand', stamp: brand.stamp });
  });

  it('done when 5: every Studio call without the token or with a wrong one is refused, and nothing is read or changed', async () => {
    const brand = actions.createDesignSystem(bp, { name: 'Brand' });
    const login = actions.createSketch(bp, { name: 'Login', designSystem: { id: 'brand' }, screens: [{ name: 'Sign in' }] });
    const before = snapshot();
    const calls: [string, string, unknown?][] = [
      ['GET', ''],
      ['GET', '/sketches'],
      ['GET', '/sketches/login'],
      ['POST', '/sketches', { name: 'Pay' }],
      ['PATCH', '/sketches/login', { name: 'X', stamp: login.stamp }],
      ['DELETE', `/sketches/login?stamp=${login.stamp}`],
      ['POST', '/sketches/login/screens', { name: 'Welcome', stamp: login.stamp }],
      ['PATCH', '/sketches/login/screens/sign-in', { name: 'X', stamp: login.stamp }],
      ['DELETE', `/sketches/login/screens/sign-in?stamp=${login.stamp}`],
      ['GET', '/design-systems'],
      ['GET', '/design-systems/brand'],
      ['POST', '/design-systems', { name: 'Ocean' }],
      ['PATCH', '/design-systems/brand', { name: 'X', stamp: brand.stamp }],
      ['DELETE', `/design-systems/brand?stamp=${brand.stamp}`],
    ];
    for (const headers of [{ 'content-type': 'application/json' }, { ...auth, authorization: `Bearer ${'d'.repeat(64)}` }]) {
      for (const [method, p, body] of calls) {
        const res = await call<{ error: string; designSystems?: unknown; sketches?: unknown; name?: unknown }>(method, p, body, headers);
        expect(res.status, `${method} ${p}`).toBe(401);
        expect(res.data).toEqual({ error: 'unauthorized', detail: 'missing or invalid session token' });
      }
    }
    // A wrong token in the address is refused the same way.
    expect((await fetch(`${api}/sketches?t=${'d'.repeat(64)}`)).status).toBe(401);
    expect(snapshot()).toEqual(before);
  });

  it('US-33: the design systems call sends the cards, the Default first, and the default a new sketch starts with', async () => {
    const empty = await call<{ designSystems: unknown[]; default: unknown }>('GET', '/design-systems');
    expect(empty).toEqual({ status: 200, data: { designSystems: [], default: null } });

    const patient = actions.createDesignSystem(bp, { name: 'Patient app', tokens: { colors: { primary: '#2563eb' } } });
    actions.changeDesignSystem(bp, 'patient-app', { tokens: { colors: { primary: '#1d6fb8', soft: '#e6f0fa', name: 'teal', bad: 'url(x.png)' } } }, patient.stamp);
    actions.createDesignSystem(bp, { name: 'Admin dashboard', tokens: { colors: { brand: '#5b47d6' } } });
    for (const name of ['Book a visit', 'My visits', 'Sign in', 'Profile']) actions.createSketch(bp, { name, designSystem: { id: 'patient-app' } });
    actions.createSketch(bp, { name: 'Staff schedule', designSystem: { id: 'admin-dashboard' } });
    const before = snapshot();

    const r = await call<{ designSystems: { id: string; name: string; isDefault: boolean; version: number; colors: string[]; sketches: number; stamp: string }[]; default: unknown }>('GET', '/design-systems');
    expect(r.status).toBe(200);
    expect(r.data.designSystems.map(({ id, name, isDefault, version, colors, sketches }) => ({ id, name, isDefault, version, colors, sketches }))).toEqual([
      { id: 'patient-app', name: 'Patient app', isDefault: true, version: 2, colors: ['#1d6fb8', '#e6f0fa'], sketches: 4 },
      { id: 'admin-dashboard', name: 'Admin dashboard', isDefault: false, version: 1, colors: ['#5b47d6'], sketches: 1 },
    ]);
    expect(r.data.default).toEqual({ id: 'patient-app', name: 'Patient app', version: 2 });
    expect(r.data.default).toEqual(actions.newSketchDesignSystem(bp));
    expect(r.data.designSystems[0]!.stamp).toBe(actions.getDesignSystem(bp, 'patient-app').stamp);
    // Reading the list writes nothing.
    expect(snapshot()).toEqual(before);
  });
});
