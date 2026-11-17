import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * US-13 Manage sketches (AB-138) on the board: the ⋯ menu on each sketch card (Rename in a small box, Duplicate, and
 * Delete with a confirmation naming the sketch and its screens), and the sketch header's name, which a click makes
 * editable (Enter saves, Escape cancels). Each sends the stamp it read; the lists are read again after each, and a
 * refusal shows in the server's own plain words. Real React in a jsdom page, with a fake board server.
 */

const { JSDOM } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/jsdom/lib/api.js', import.meta.url).pathname)) as { JSDOM: new (html: string, opts: object) => { window: any } };
const URL_AT = 'http://127.0.0.1:4809/p/mawid/studio';
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: URL_AT, pretendToBeVisual: true });
const page = dom.window.document;
dom.window.scrollTo = () => undefined;
vi.stubGlobal('self', dom.window);
vi.stubGlobal('window', dom.window);
vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
vi.stubGlobal('document', dom.window.document);
vi.stubGlobal('navigator', dom.window.navigator);
vi.stubGlobal('localStorage', dom.window.localStorage);
vi.stubGlobal('sessionStorage', dom.window.sessionStorage);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const React = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/react/index.js', import.meta.url).pathname)) as { createElement(...a: unknown[]): unknown; act(fn: () => unknown): Promise<void> };
const { createRoot } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/react-dom/client.js', import.meta.url).pathname)) as unknown as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
const { QueryClient, QueryClientProvider } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/@tanstack/react-query/build/modern/index.js', import.meta.url).pathname)) as { QueryClient: new (o: object) => unknown; QueryClientProvider: unknown };
const Router = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/@tanstack/react-router/dist/esm/index.js', import.meta.url).pathname)) as any;
const { act } = React;
const board = (file: string) => import(/* @vite-ignore */ new URL(`../../console-ui/${file}`, import.meta.url).pathname);
const S = await board('src/lib/studio.ts');
const { StudioPage } = await board('src/pages/Studio.tsx');
const { SketchWorkspacePage } = await board('src/pages/studio/SketchWorkspace.tsx');
const h = React.createElement;

interface FakeSketch {
  id: string;
  name: string;
  stamp: string;
  screens: { id: string; name: string; status: string }[];
}
/** What the fake board server holds. */
let sketches: FakeSketch[];
/** Every change the page asked for: method, address and body. */
let changes: { method: string; url: string; body: any }[];
let stampN = 0;
const newStamp = () => `s${++stampN}`;

const nameKey = (n: string) => n.trim().toLowerCase();
const card = (s: FakeSketch) => ({ ...s, designSystem: null, card: { cover: null, screens: s.screens.length, approved: s.screens.filter((x) => x.status === 'approved').length, designSystem: null, edited: null } });

function fakeServer(url: string, init: RequestInit = {}) {
  const method = init.method ?? 'GET';
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const body = init.body ? JSON.parse(String(init.body)) : null;
  if (method !== 'GET') changes.push({ method, url, body });
  if (method === 'GET' && url === '/p/mawid/api/v1/studio/sketches') return json({ sketches: sketches.map(card) });
  if (method === 'GET' && url === '/p/mawid/api/v1/studio/design-systems') return json({ designSystems: [], default: null });
  if (method === 'GET' && url === '/p/mawid/api/v1/studio/app-picture') return json({ ok: false, why: 'No app.' });
  const m = /^\/p\/mawid\/api\/v1\/studio\/sketches\/([a-z0-9-]+)(\/duplicate|\/chats(?:\/main)?)?$/.exec(url);
  const s = m ? sketches.find((x) => x.id === m[1]) : undefined;
  if (!m || !s) return json({ error: 'This project has no sketch.' }, 404);
  const stale = () => body?.stamp !== s.stamp;
  if (m[2] === '/chats') return json({ conversations: [], current: 'main' });
  if (m[2] === '/chats/main') return json({ id: 'main', owner: { kind: 'sketch', id: s.id, name: s.name }, startedAt: null, messages: [], working: null });
  if (method === 'GET') return json({ ...s, designSystem: null, frames: ['desktop'], screens: s.screens.map((x, i) => ({ ...x, order: i + 1, chosen: null, variants: [] })) });
  if (stale()) return json({ error: 'Changed elsewhere, reload', changedElsewhere: true }, 409);
  if (method === 'PATCH') {
    const other = sketches.find((x) => x.id !== s.id && nameKey(x.name) === nameKey(body.name));
    if (other) return json({ error: `A sketch called "${other.name}" already exists. Pick another name.` }, 409);
    s.name = body.name;
    s.stamp = newStamp();
    return json({ ...s });
  }
  if (method === 'POST' && m[2] === '/duplicate') {
    let n = 1;
    const name = () => `${s.name} copy${n === 1 ? '' : ` ${n}`}`;
    while (sketches.some((x) => nameKey(x.name) === nameKey(name()))) n++;
    const copy = { id: name().toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: name(), stamp: newStamp(), screens: s.screens.map((x) => ({ ...x, status: 'draft' })) };
    sketches = [copy, ...sketches];
    return json(copy);
  }
  if (method === 'DELETE') {
    sketches = sketches.filter((x) => x !== s);
    return json({ deleted: s.id, name: s.name, screens: s.screens.length });
  }
  return json({ error: 'not here' }, 404);
}

let root: { render(n: unknown): void; unmount(): void } | null = null;
let router: any = null;

async function open(at = '/studio') {
  await close();
  root = createRoot(page.getElementById('root'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const top = Router.createRootRoute();
  const studio = Router.createRoute({ getParentRoute: () => top, path: '/studio', component: () => h(StudioPage, { project: 'mawid' }) });
  const sketch = Router.createRoute({ getParentRoute: () => top, path: '/studio/sketches/$id', component: SketchWorkspacePage });
  router = Router.createRouter({ routeTree: top.addChildren([studio, sketch]), history: Router.createMemoryHistory({ initialEntries: [at] }) });
  await act(async () => root!.render(h(QueryClientProvider, { client }, h(Router.RouterProvider, { router }))));
  await settle();
}
async function close() {
  if (root) await act(async () => root!.unmount());
  root = null;
}
async function settle(ms = 40) {
  for (let i = 0; i < ms; i++) await act(() => new Promise((r) => setTimeout(r, 2)));
}

const all = (sel: string) => [...page.querySelectorAll(sel)] as any[];
const cardNames = () => all('.sk-card-name').map((n) => n.textContent);
const cardOf = (name: string) => all('.sk-card').find((c) => c.querySelector('.sk-card-name').textContent === name);
const dialog = () => page.querySelector('[role="dialog"]') as any;
async function press(el: any) {
  await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await settle();
}
async function type(input: any, value: string) {
  const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function key(el: any, k: string) {
  await act(async () => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true })));
  await settle();
}
const button = (inside: any, name: string) => [...inside.querySelectorAll('button')].find((b: any) => b.textContent.trim() === name) as any;
async function menu(name: string, item: string) {
  await press(cardOf(name).querySelector(`[aria-label="More actions for ${name}"]`));
  const items = all('[role="menuitem"]').map((b) => b.textContent.trim());
  expect(items).toEqual(['Rename…', 'Duplicate', 'Delete…']);
  await press(all('[role="menuitem"]').find((b) => b.textContent.trim() === item));
}

beforeEach(() => {
  dom.window.sessionStorage.clear();
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  stampN = 0;
  changes = [];
  sketches = [
    { id: 'booking', name: 'Booking', stamp: newStamp(), screens: [{ id: 'form', name: 'Form', status: 'approved' }, { id: 'confirmation', name: 'Confirmation', status: 'draft' }] },
    { id: 'login', name: 'Login', stamp: newStamp(), screens: [{ id: 'sign-in', name: 'Sign in', status: 'draft' }] },
    { id: 'patient-profile', name: 'Patient profile', stamp: newStamp(), screens: ['Overview', 'Visits', 'Edit details'].map((n) => ({ id: n.toLowerCase().replace(/ /g, '-'), name: n, status: 'draft' })) },
  ];
  const spy = vi.fn(async (url: string, init?: RequestInit) => fakeServer(url, init));
  vi.stubGlobal('fetch', spy);
  dom.window.fetch = spy;
});
afterEach(close);

describe('done when 1: rename from the card menu and from the sketch header', () => {
  it('renames "Booking" to "Book a visit" from the card menu, with the stamp it read', async () => {
    await open();
    await menu('Booking', 'Rename…');
    expect(dialog().getAttribute('aria-label')).toBe('Rename "Booking"');
    const input = dialog().querySelector('input');
    expect(input.value).toBe('Booking');
    await type(input, 'Book a visit');
    await press(button(dialog(), 'Rename'));
    expect(changes).toEqual([{ method: 'PATCH', url: '/p/mawid/api/v1/studio/sketches/booking', body: { name: 'Book a visit', stamp: 's1' } }]);
    expect(dialog()).toBeNull();
    expect(cardNames()).toContain('Book a visit');
    expect(cardNames()).not.toContain('Booking');
  });

  it('refuses "Login" with the plain message, and the name stays "Booking"', async () => {
    await open();
    await menu('Booking', 'Rename…');
    await type(dialog().querySelector('input'), 'Login');
    await press(button(dialog(), 'Rename'));
    expect(dialog().querySelector('[role="alert"]').textContent).toBe('A sketch called "Login" already exists. Pick another name.');
    await press(button(dialog(), 'Cancel'));
    expect(cardNames()).toContain('Booking');
  });

  it('renames from the header: a click makes the name editable, Enter saves, and Escape cancels', async () => {
    await open('/studio/sketches/booking');
    const name = () => page.querySelector('.sk-name-btn') as any;
    expect(name().textContent).toBe('Booking');
    await press(name());
    let input = page.querySelector('input[aria-label="Sketch name"]') as any;
    await type(input, 'Somewhere else');
    await key(input, 'Escape');
    expect(name().textContent).toBe('Booking');
    expect(changes).toEqual([]);

    await press(name());
    input = page.querySelector('input[aria-label="Sketch name"]');
    await type(input, 'Login');
    await key(input, 'Enter');
    expect(page.querySelector('.sk-name-edit [role="alert"]').textContent).toBe('A sketch called "Login" already exists. Pick another name.');
    expect(sketches[0]!.name).toBe('Booking');

    await type(input, 'Book a visit');
    await key(input, 'Enter');
    await settle();
    expect(name().textContent).toBe('Book a visit');
    expect(changes.at(-1)).toEqual({ method: 'PATCH', url: '/p/mawid/api/v1/studio/sketches/booking', body: { name: 'Book a visit', stamp: 's1' } });

    // Back on the Sketches home, the card shows the new name too.
    await act(async () => router.navigate({ to: '/studio' }));
    await settle();
    expect(cardNames()).toContain('Book a visit');
  });
});

describe('done when 2: Duplicate from the card menu', () => {
  it('makes "Booking copy", then "Booking copy 2", each with 2 screens and no approved count', async () => {
    await open();
    await menu('Booking', 'Duplicate');
    await menu('Booking', 'Duplicate');
    expect(changes.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', '/p/mawid/api/v1/studio/sketches/booking/duplicate', { stamp: 's1' }],
      ['POST', '/p/mawid/api/v1/studio/sketches/booking/duplicate', { stamp: 's1' }],
    ]);
    expect(cardNames()).toEqual(['Booking copy 2', 'Booking copy', 'Booking', 'Login', 'Patient profile']);
    for (const n of ['Booking copy', 'Booking copy 2']) {
      expect(cardOf(n).querySelector('.sk-card-screens').textContent).toBe('2 screens');
      expect(cardOf(n).querySelector('.sk-card-approved')).toBeNull();
    }
    expect(cardOf('Booking').querySelector('.sk-card-approved').textContent).toBe('1 of 2 approved');
  });

  it('shows a refusal in plain words above the cards', async () => {
    await open();
    sketches[0]!.stamp = 'changed-by-a-teammate';
    await menu('Booking', 'Duplicate');
    expect(page.querySelector('.sk-problem').textContent).toBe('Changed elsewhere, reload');
  });
});

describe('done when 3: Delete asks first, with the number of screens', () => {
  it('asks to delete "Patient profile", says it holds 3 screens; Cancel keeps it, Delete removes the card', async () => {
    await open();
    await menu('Patient profile', 'Delete…');
    expect(dialog().getAttribute('aria-label')).toBe('Delete "Patient profile"?');
    expect(dialog().querySelector('.mb p').textContent).toBe('It holds 3 screens. They go with it, every version too, and the sketch cannot be brought back.');
    await press(button(dialog(), 'Cancel'));
    expect(dialog()).toBeNull();
    expect(changes).toEqual([]);
    expect(cardNames()).toContain('Patient profile');

    await menu('Patient profile', 'Delete…');
    await press(button(dialog(), 'Delete'));
    expect(changes).toEqual([{ method: 'DELETE', url: '/p/mawid/api/v1/studio/sketches/patient-profile', body: { stamp: 's3' } }]);
    expect(dialog()).toBeNull();
    expect(cardNames()).toEqual(['Booking', 'Login']);
  });

  it('a stale delete keeps the dialog open with "Changed elsewhere, reload", and the card stays', async () => {
    await open();
    sketches[2]!.stamp = 'changed-by-a-teammate';
    await menu('Patient profile', 'Delete…');
    await press(button(dialog(), 'Delete'));
    expect(dialog().querySelector('[role="alert"]').textContent).toBe('Changed elsewhere, reload');
    expect(cardNames()).toContain('Patient profile');
  });

  it('words the question for one screen and for none', () => {
    expect(S.deleteQuestion('Login', 1)).toEqual({ title: 'Delete "Login"?', holds: 'It holds 1 screen. It goes with it, every version too, and the sketch cannot be brought back.' });
    expect(S.deleteQuestion('Empty', 0).holds).toBe('It holds no screens yet. The sketch cannot be brought back.');
  });
});
