import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Studio (AB-127): its place in the sidebar, its page at /p/<project>/studio, and its two tabs. The last tab is kept
 * in the browser tab's own memory, one per project: it lasts through a reload and ends when the tab closes. The
 * Design systems tab (US-33, AB-158) reads its cards from the board server and only reads: opening the page saves
 * nothing, so it creates nothing in the project. Real React in a jsdom page.
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
vi.stubGlobal('FileReader', dom.window.FileReader);

const React = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/react/index.js', import.meta.url).pathname)) as { createElement(...a: unknown[]): unknown; act(fn: () => unknown): Promise<void> };
const { createRoot } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/react-dom/client.js', import.meta.url).pathname)) as unknown as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
const { QueryClient, QueryClientProvider } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/@tanstack/react-query/build/modern/index.js', import.meta.url).pathname)) as { QueryClient: new (o: object) => unknown; QueryClientProvider: unknown };
const Router = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/@tanstack/react-router/dist/esm/index.js', import.meta.url).pathname)) as any;
const { act } = React;
// The root type check does not read the board's own files, so these are found at run time.
const board = (file: string) => import(/* @vite-ignore */ new URL(`../../console-ui/${file}`, import.meta.url).pathname);
const S = await board('src/lib/studio.ts');
const { StudioPage } = await board('src/pages/Studio.tsx');
const { SketchWorkspacePage } = await board('src/pages/studio/SketchWorkspace.tsx');
const h = React.createElement;

const ROOT = path.resolve(import.meta.dirname, '../..');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let root: { render(n: unknown): void; unmount(): void } | null = null;
let router: any = null;
let fetchSpy: ReturnType<typeof vi.fn>;

interface Card {
  id: string;
  name: string;
  isDefault: boolean;
  version: number;
  colors: unknown;
  sketches: number;
}
/** What the board server's design systems call answers, as the test sets it. */
let systems: Card[];
/** The sketches the board server lists, as the test sets them, in the order it sends them (newest edit first). */
let sketches: { id: string; name: string; designSystem: { id: string; version: number; name: string | null } | null; stamp: string; screens: { id: string; name: string }[]; card?: unknown }[];
/** What GET …/sketches/<id>/cover answers, by sketch. */
let covers: Record<string, { screen: string | null; version: number | null; frames: Record<string, string> }>;
/** What GET /api/v1/studio/app-picture answers. */
let appOption: { ok: boolean; why?: string; app?: string };
/** Every change the page asked the board server for: method, address and body. */
let changes: { method: string; url: string; body: any }[];

/** The Studio page and a sketch's workspace, in a router of their own, as the board serves them. */
async function open(project: string, at = '/studio') {
  await close();
  root = createRoot(page.getElementById('root'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const top = Router.createRootRoute();
  const studio = Router.createRoute({ getParentRoute: () => top, path: '/studio', component: () => h(StudioPage, { project }) });
  const sketch = Router.createRoute({ getParentRoute: () => top, path: '/studio/sketches/$id', component: SketchWorkspacePage });
  router = Router.createRouter({ routeTree: top.addChildren([studio, sketch]), history: Router.createMemoryHistory({ initialEntries: [at] }) });
  await act(async () => root!.render(h(QueryClientProvider, { client }, h(Router.RouterProvider, { router }))));
  await settle();
}
async function close() {
  if (root) await act(async () => root!.unmount());
  root = null;
}
const tabs = () => [...page.querySelectorAll('[role="tab"]')] as { textContent: string; getAttribute(n: string): string | null; dispatchEvent(e: unknown): void }[];
const openTab = () => tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.textContent;
async function click(label: string) {
  const tab = tabs().find((t) => t.textContent === label)!;
  await act(async () => tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await settle();
}
/** Waits until the open tab, or the workspace, has its answers. */
async function settle() {
  const busy = () => {
    const panel = page.getElementById('studio-panel');
    if (panel) return /^Reading the /.test(panel.textContent) || !!panel.querySelector('.sk-status:not(.bad)');
    return !page.querySelector('h1') || /Reading the /.test(page.body.textContent) || page.querySelector('h1').textContent === '…';
  };
  for (let i = 0; i < 100 && busy(); i++) await act(() => new Promise((r) => setTimeout(r, 5)));
  await act(() => new Promise((r) => setTimeout(r, 0)));
}

/** A fresh browser tab: the same computer, a new tab's own memory. */
function newBrowserTab() {
  const fresh = new JSDOM('<!doctype html>', { url: URL_AT });
  vi.stubGlobal('sessionStorage', fresh.window.sessionStorage);
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', dom.window.sessionStorage);
  dom.window.sessionStorage.clear();
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  systems = [];
  sketches = [];
  covers = {};
  appOption = { ok: false, why: 'This project has no app to take a picture of yet.' };
  changes = [];
  // The board server: the Studio's lists, the app picture option, and the start page's two changes.
  fetchSpy = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (method === 'GET' && url === '/p/mawid/api/v1/studio/design-systems') {
      const def = systems.find((d) => d.isDefault);
      return json({ designSystems: systems, default: def ? { id: def.id, name: def.name, version: def.version } : null });
    }
    if (method === 'GET' && url === '/p/mawid/api/v1/studio/sketches') return json({ sketches });
    if (method === 'GET' && url === '/p/mawid/api/v1/studio/app-picture') return json(appOption);
    const cover = /^\/p\/mawid\/api\/v1\/studio\/sketches\/([a-z0-9-]+)\/cover$/.exec(url);
    if (method === 'GET' && cover) return covers[cover[1]!] ? json(covers[cover[1]!]) : json({ error: 'not here' }, 404);
    // A sketch, and its conversations with the AI Designer (US-52): the start page's message is the first one.
    const one = /^\/p\/mawid\/api\/v1\/studio\/sketches\/([a-z0-9-]+)(\/chats(\/main)?)?$/.exec(url);
    if (method === 'GET' && one) {
      const s = sketches.find((x) => x.id === one[1]);
      if (!s) return json({ error: 'not here' }, 404);
      // One sketch read on its own, as the server sends it: its frames, and each screen with its variants.
      if (!one[2]) return json({ ...s, frames: ['desktop'], screens: (s.screens as { id: string }[]).map((sc) => ({ variants: [], chosen: null, ...sc })) });
      const sent = changes.find((c) => c.url.endsWith('/sketches/start'));
      const messages = sent ? [{ role: 'person', text: sent.body.message, pictures: sent.body.pictures.map((_: unknown, i: number) => `/api/v1/studio/sketches/${s.id}/chats/main/pictures/m1-${i + 1}.png`) }] : [];
      if (!one[3]) return json({ conversations: messages.length ? [{ id: 'main', startedAt: null, messages: 1, first: messages[0]!.text, lastAt: null }] : [], current: 'main' });
      return json({ id: 'main', owner: { kind: 'sketch', id: s.id, name: s.name }, startedAt: null, messages, working: null });
    }
    if (method === 'POST' && url === '/p/mawid/api/v1/studio/sketches/start') {
      const body = JSON.parse(String(init.body));
      changes.push({ method, url, body });
      if (!body.message?.trim()) return json({ error: 'Write what you want to design first.' }, 400);
      const made = { id: 'a-page-where-patients-book', name: 'A page where patients book', designSystem: null, stamp: 's1', screens: [] as [] };
      sketches = [made];
      return json({ id: made.id, name: made.name });
    }
    if (method === 'POST' && url === '/p/mawid/api/v1/studio/app-picture') {
      changes.push({ method, url, body: null });
      return json({ picture: { name: 'Mawid.png', type: 'image/png', data: `data:image/png;base64,${PNG.toString('base64')}` } });
    }
    throw new Error(`The Studio must not call ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchSpy);
  dom.window.fetch = fetchSpy;
});
afterEach(close);

describe('the Studio in the sidebar', () => {
  const nav = () => {
    const shell = read('console-ui/src/components/Shell.tsx');
    const list = /const NAV = \[([\s\S]*?)\n\];/.exec(shell)![1]!;
    return [...list.matchAll(/\{ to: '([^']+)', label: '([^']+)', icon: (\w+)([^}]*)\}/g)].map((m) => ({ to: m[1], label: m[2], icon: m[3], rest: m[4] }));
  };

  it('shows Studio with the palette icon right after Architecture, with no switch and no counter', () => {
    const items = nav();
    const at = items.findIndex((n) => n.label === 'Architecture');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(items[at + 1]).toEqual({ to: '/studio', label: 'Studio', icon: 'Palette', rest: ' ' });
    expect(read('console-ui/src/components/Shell.tsx')).toMatch(/import \{[^}]*\bPalette\b[^}]*\} from 'lucide-react'/);
  });

  it('opens at /p/<project>/studio, with the tab not in the address', () => {
    const router = read('console-ui/src/router.tsx');
    expect(router).toContain("const studio = createRoute({ getParentRoute: () => rootRoute, path: '/studio', component: StudioPage });");
    expect(router).toMatch(/rootRoute\.addChildren\(\[[^\]]*\barchitecture, studio\b/);
    // Every board page sits under /p/<project>: the router's base.
    expect(router).toContain("basepath: PROJECT_BASE || '/'");
  });
});

describe('the Studio page', () => {
  it('opens on Sketches the first time, with its title, its line and the two tabs', async () => {
    await open('mawid');
    expect(page.querySelector('h1').textContent).toBe('Studio');
    expect(page.querySelector('.top .note').textContent).toBe('Your sketches and design systems for this project.');
    expect(tabs().map((t) => t.textContent)).toEqual(['Sketches', 'Design systems']);
    expect(openTab()).toBe('Sketches');
  });

  it('shows the start page on an empty Sketches tab, and only a short message on an empty Design systems tab', async () => {
    await open('mawid');
    const panel = () => page.querySelector('[role="tabpanel"]');
    expect(panel().querySelector('textarea')).not.toBeNull();
    expect(panel().textContent).not.toContain('Nothing here yet');
    await click('Design systems');
    expect(panel().textContent).toBe('No design systems yet.');
    expect(panel().children).toHaveLength(1);
  });

  it('remembers the last tab per project, also after a reload', async () => {
    await open('mawid');
    await click('Design systems');
    await open('shop');
    expect(openTab()).toBe('Sketches');
    await click('Design systems');
    await click('Sketches');

    // A reload: the page mounts again in the same browser tab.
    await open('mawid');
    expect(openTab()).toBe('Design systems');
    await open('shop');
    expect(openTab()).toBe('Sketches');
    expect(S.readStudioTab('mawid')).toBe('systems');
    expect(S.readStudioTab('shop')).toBe('sketches');
  });

  it('opens every project on Sketches again in a new browser tab', async () => {
    await open('mawid');
    await click('Design systems');
    await close();
    newBrowserTab();
    await open('mawid');
    expect(openTab()).toBe('Sketches');
    // Nothing lasts past the tab: the computer's lasting storage holds no Studio choice, only the board's sign-in.
    expect(Object.keys(dom.window.localStorage)).toEqual(['squad.console.token']);
  });

  it('falls back to Sketches when the saved value is unknown or unreadable', async () => {
    dom.window.sessionStorage.setItem(S.studioTabKey('mawid'), 'colors');
    await open('mawid');
    expect(openTab()).toBe('Sketches');

    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('storage is off');
      },
      setItem: () => {
        throw new Error('storage is off');
      },
    });
    expect(S.readStudioTab('mawid')).toBe('sketches');
    expect(() => S.saveStudioTab('mawid', 'systems')).not.toThrow();
    await open('mawid');
    expect(openTab()).toBe('Sketches');
    await click('Design systems');
    expect(openTab()).toBe('Design systems');
  });

  it('only reads, so opening it and switching tabs creates nothing', async () => {
    const xhr = vi.spyOn(dom.window.XMLHttpRequest.prototype, 'open');
    await open('mawid');
    await click('Design systems');
    await click('Sketches');
    const calls = fetchSpy.mock.calls.map(([url, init]) => [(init as RequestInit | undefined)?.method ?? 'GET', url]);
    expect(new Set(calls.map((c) => c.join(' ')))).toEqual(new Set(['GET /p/mawid/api/v1/studio/sketches', 'GET /p/mawid/api/v1/studio/design-systems', 'GET /p/mawid/api/v1/studio/app-picture']));
    expect(changes).toEqual([]);
    expect(xhr).not.toHaveBeenCalled();
    // The page itself only reads: the start page's Send is the one change, in its own file.
    for (const file of ['console-ui/src/pages/Studio.tsx', 'console-ui/src/lib/studio.ts'])
      expect(read(file)).not.toMatch(/lib\/data|useAct|apiFetch|fetch\(|useMutation|\bsend\b|method:/);
    expect([...read('console-ui/src/pages/Studio.tsx').matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['react', '@tanstack/react-query', '@tanstack/react-router', '../api/client', '../lib/studio', './studio/StartSketch']);
  });
});

describe('the Design systems tab (US-33)', () => {
  const cards = () => [...page.querySelectorAll('.ds-card')] as any[];
  const card = (el: any) => ({
    name: el.querySelector('h4').textContent,
    isDefault: !!el.querySelector('.pill'),
    badge: el.querySelector('.pill')?.textContent ?? null,
    version: el.querySelector('.ds-v').textContent,
    colors: [...el.querySelectorAll('.ds-color')].map((c: any) => c.getAttribute('title')),
    painted: [...el.querySelectorAll('.ds-color')].map((c: any) => c.style.background),
    used: el.querySelector('.ds-used').textContent,
  });

  it('shows one card per design system: name, version, colours and how many sketches use it, with only the default marked', async () => {
    systems = [
      { id: 'patient-app', name: 'Patient app', isDefault: true, version: 2, colors: ['#1d6fb8', '#e6f0fa', 'rgb(34 160 90)', '#0f1f33', '#dfe5ec'], sketches: 4 },
      { id: 'admin-dashboard', name: 'Admin dashboard', isDefault: false, version: 1, colors: ['#5b47d6', '#eeeaff'], sketches: 1 },
      { id: 'kiosk', name: 'Kiosk', isDefault: false, version: 1, colors: [], sketches: 0 },
    ];
    dom.window.sessionStorage.setItem(S.studioTabKey('mawid'), 'systems');
    await open('mawid');
    expect(openTab()).toBe('Design systems');
    expect(cards().map(card)).toEqual([
      { name: 'Patient app', isDefault: true, badge: 'Default', version: 'v2', colors: ['#1d6fb8', '#e6f0fa', 'rgb(34 160 90)', '#0f1f33', '#dfe5ec'], painted: ['rgb(29, 111, 184)', 'rgb(230, 240, 250)', 'rgb(34, 160, 90)', 'rgb(15, 31, 51)', 'rgb(223, 229, 236)'], used: 'Used by 4 sketches' },
      { name: 'Admin dashboard', isDefault: false, badge: null, version: 'v1', colors: ['#5b47d6', '#eeeaff'], painted: ['rgb(91, 71, 214)', 'rgb(238, 234, 255)'], used: 'Used by 1 sketch' },
      { name: 'Kiosk', isDefault: false, badge: null, version: 'v1', colors: [], painted: [], used: 'Not used by any sketch yet' },
    ]);
    expect(page.querySelectorAll('.ds-card .pill')).toHaveLength(1);
    // Nothing to make one here: those come in later stories.
    const panel = page.getElementById('studio-panel');
    expect(panel.querySelectorAll('button, textarea, input')).toHaveLength(0);
    // Each card's name opens its page, with the chat beside it (US-52).
    expect([...panel.querySelectorAll('a')].map((a: any) => a.getAttribute('href'))).toEqual(['/studio/design-systems/patient-app', '/studio/design-systems/admin-dashboard', '/studio/design-systems/kiosk']);
    expect(panel.textContent).not.toMatch(/New design system|Describe your brand|coming soon/i);
  });

  it('skips colour values that are not plain colours, so a token never puts anything else in the page', async () => {
    systems = [{ id: 'brand', name: 'Brand', isDefault: true, version: 1, colors: ['#2563eb', 'url(https://example.com/x.png)', 'red; background: blue', 'var(--accent)', 42, '#12', 'hsl(210 20% 88%)'], sketches: 2 }];
    dom.window.sessionStorage.setItem(S.studioTabKey('mawid'), 'systems');
    await open('mawid');
    expect(cards().map(card)[0]).toMatchObject({ colors: ['#2563eb', 'hsl(210 20% 88%)'], used: 'Used by 2 sketches' });
    expect(S.isColorValue('oklch(62% 0.19 255 / 80%)')).toBe(true);
    expect(S.isColorValue('rgb()')).toBe(false);
    expect(S.isColorValue('rgb(1 2 3) url(x)')).toBe(false);
    // A list that is not a list shows no colours, and the card still shows.
    systems = [{ id: 'brand', name: 'Brand', isDefault: true, version: 1, colors: 'teal', sketches: 1 }];
    await open('mawid');
    expect(cards().map(card)).toEqual([{ name: 'Brand', isDefault: true, badge: 'Default', version: 'v1', colors: [], painted: [], used: 'Used by 1 sketch' }]);
  });

  it('with none, shows only "No design systems yet.": no chat box, no ways to make one, nothing "coming soon"', async () => {
    await open('mawid');
    await click('Design systems');
    const panel = page.getElementById('studio-panel');
    expect(panel.textContent).toBe('No design systems yet.');
    expect(panel.querySelectorAll('button, textarea, input, a, .ds-card')).toHaveLength(0);
  });

  it('says so when the list cannot be read', async () => {
    fetchSpy.mockImplementation(async () => new Response('{"error":"broken"}', { status: 500, statusText: 'Internal Server Error' }));
    await open('mawid');
    await click('Design systems');
    expect(page.querySelector('#studio-panel .note.bad').textContent).toContain('500');
  });
});

describe('the start page on an empty Sketches tab (US-05)', () => {
  const panel = () => page.getElementById('studio-panel');
  const box = () => page.querySelector('textarea') as any;
  const button = (name: string) => [...page.querySelectorAll('button')].find((b: any) => b.textContent.trim() === name || b.getAttribute('aria-label') === name) as any;
  const press = async (el: any) => {
    await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    await settle();
  };
  const type = async (text: string) => {
    const set = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      set.call(box(), text);
      box().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const pick = async (files: unknown[]) => {
    const input = page.querySelector('input[type="file"]') as any;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
    for (let i = 0; i < 100 && page.querySelectorAll('.sk-pics img').length < files.length && !page.querySelector('[role="alert"]'); i++) await act(() => new Promise((r) => setTimeout(r, 5)));
  };
  const previews = () => [...page.querySelectorAll('.sk-box .sk-pics img')].map((i: any) => i.getAttribute('alt'));
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 5)));
  };

  it('shows the start page only while the project has no sketch; with one, the cards of the sketches', async () => {
    await open('mawid');
    expect(box()).not.toBeNull();
    sketches = [{ id: 'login', name: 'Login', designSystem: { id: 'brand', version: 1, name: 'Brand' }, stamp: 's', screens: [] }];
    await open('shop');
    expect(box()).toBeNull();
    const rows = [...page.querySelectorAll('.sk-card')].map((li: any) => [li.querySelector('.sk-card-name').textContent, li.querySelector('a').getAttribute('href'), li.querySelector('.sk-card-ds').textContent]);
    expect(rows).toEqual([['Login', '/studio/sketches/login', 'Brand']]);
  });

  it('done when 1: the chat box is the main thing, focused, with an image button and Send; the options sit under it', async () => {
    await open('mawid');
    expect(box().getAttribute('placeholder')).toBe('Describe what you want to design');
    expect(box().getAttribute('aria-label')).toBe('Describe what you want to design');
    expect(page.activeElement).toBe(box());
    expect(button('Add a picture')).toBeTruthy();
    expect(button('Send')).toBeTruthy();
    expect(button('Send').disabled).toBe(true);
    // The box comes before the options, which are smaller and under it.
    const order = [box(), ...page.querySelectorAll('.sk-chip'), button('Start from an image'), button('A screen from your app')];
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...page.querySelectorAll('.sk-chip')].map((c: any) => c.textContent)).toEqual(['A login page in Arabic and English', "An admin dashboard with today's visits", 'A profile page for patients']);
    expect([...S.EXAMPLE_PROMPTS]).toEqual(['A login page in Arabic and English', "An admin dashboard with today's visits", 'A profile page for patients']);
    expect(panel().textContent).not.toContain('Nothing here yet');
  });

  it('done when 2: a prompt fills the box and a picked picture shows as a small preview, with nothing sent', async () => {
    await open('mawid');
    await press(button('A login page in Arabic and English'));
    expect(box().value).toBe('A login page in Arabic and English');
    expect(page.activeElement).toBe(box());

    await pick([new dom.window.File([PNG], 'old-login.png', { type: 'image/png' })]);
    expect(previews()).toEqual(['old-login.png']);
    expect(page.querySelector('.sk-box .sk-pics img').getAttribute('src')).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(box().value).toBe('A login page in Arabic and English');
    // Nothing is sent: the page only read.
    expect(changes).toEqual([]);
    expect(fetchSpy.mock.calls.every(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET')).toBe(true);

    // "Start from an image" opens the same picker.
    const input = page.querySelector('input[type="file"]') as any;
    const opened = vi.fn();
    input.addEventListener('click', opened);
    await press(button('Start from an image'));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(input.getAttribute('accept')).toBe('image/png,image/jpeg,image/webp');

    // A file that is not a picture is refused, and a picture can be removed again.
    await pick([new dom.window.File(['hi'], 'notes.txt', { type: 'text/plain' })]);
    expect(page.querySelector('[role="alert"]').textContent).toBe('"notes.txt" is not a PNG, JPEG or WebP picture.');
    expect(previews()).toEqual(['old-login.png']);
    await press(button('Remove old-login.png'));
    expect(previews()).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('takes at most four pictures of up to 10 MB each', () => {
    expect(S.pictureProblem({ name: 'a.png', type: 'image/png', size: 1000 }, 3)).toBeNull();
    expect(S.pictureProblem({ name: 'a.png', type: 'image/png', size: 1000 }, 4)).toBe('Add at most 4 pictures to one message.');
    expect(S.pictureProblem({ name: 'big.jpg', type: 'image/jpeg', size: 10 * 1024 * 1024 + 1 }, 0)).toBe('"big.jpg" is larger than 10 MB.');
    expect(S.pictureProblem({ name: 'a.webp', type: 'image/webp', size: 1 }, 0)).toBeNull();
    expect(S.pictureProblem({ name: 'a.gif', type: 'image/gif', size: 1 }, 0)).toBe('"a.gif" is not a PNG, JPEG or WebP picture.');
  });

  it('done when 3: Send makes the sketch and opens its workspace with the message; back on Sketches, the list shows', async () => {
    await open('mawid');
    await type('A page where patients book a visit with their doctor');
    expect(button('Send').disabled).toBe(false);
    await pick([new dom.window.File([PNG], 'idea.png', { type: 'image/png' })]);
    await press(button('Send'));
    await until(() => router.state.location.pathname === '/studio/sketches/a-page-where-patients-book' && !!page.querySelector('.dc-msg'));

    expect(changes).toEqual([{ method: 'POST', url: '/p/mawid/api/v1/studio/sketches/start', body: { message: 'A page where patients book a visit with their doctor', pictures: [{ name: 'idea.png', type: 'image/png', data: `data:image/png;base64,${PNG.toString('base64')}` }] } }]);
    expect(router.state.location.pathname).toBe('/studio/sketches/a-page-where-patients-book');
    expect(page.querySelector('h1').textContent).toBe('A page where patients book');
    // The first message opens the chat with the AI Designer, on the left of the workspace.
    expect(page.querySelector('.dc-msg.person .dc-text').textContent).toBe('A page where patients book a visit with their doctor');
    expect([...page.querySelectorAll('.dc-msg img')].map((i: any) => i.getAttribute('src'))).toEqual(['/p/mawid/api/v1/studio/sketches/a-page-where-patients-book/chats/main/pictures/m1-1.png?t=a-token']);

    // Back to the Sketches tab: a sketch exists now, so the list shows instead of the start page.
    const back = page.querySelector('.sk-back');
    expect(back.textContent.trim()).toBe('Sketches');
    await press(back);
    await until(() => !!page.querySelector('.sk-cards'));
    expect(router.state.location.pathname).toBe('/studio');
    expect(openTab()).toBe('Sketches');
    expect(box()).toBeNull();
    expect([...page.querySelectorAll('.sk-cards .sk-card-name')].map((a: any) => a.textContent)).toEqual(['A page where patients book']);
  });

  it('Enter sends too, and an empty box sends nothing', async () => {
    await open('mawid');
    await act(async () => box().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(changes).toEqual([]);
    await type('A profile page for patients');
    await act(async () => box().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await until(() => changes.length > 0);
    expect(changes.map((c) => c.body.message)).toEqual(['A profile page for patients']);
  });

  it('done when 5: with no design system, a small line offers to set one up and opens the Design systems tab; Send still works', async () => {
    await open('mawid');
    await until(() => !!page.querySelector('.sk-ds'));
    const line = page.querySelector('.sk-ds');
    expect(line.textContent).toBe('No design system yet. Set up a design system');
    // It sits under the options.
    expect(button('A screen from your app').compareDocumentPosition(line) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await type('A login page');
    expect(button('Send').disabled).toBe(false);
    await press(button('Set up a design system'));
    expect(openTab()).toBe('Design systems');
    expect(changes).toEqual([]);

    // Once a design system exists, the line is gone.
    systems = [{ id: 'patient-app', name: 'Patient app', isDefault: true, version: 1, colors: [], sketches: 0 }];
    dom.window.sessionStorage.clear();
    await open('shop');
    await until(() => fetchSpy.mock.calls.some(([url]) => url === '/p/mawid/api/v1/studio/design-systems'));
    await settle();
    expect(box()).not.toBeNull();
    expect(page.querySelector('.sk-ds')).toBeNull();
  });

  it('done when 4: "A screen from your app" is greyed out with the reason when there is no app, and adds a picture when there is one', async () => {
    await open('mawid');
    await until(() => !!page.querySelector('#sk-app-why'));
    expect(button('A screen from your app').disabled).toBe(true);
    expect(page.querySelector('#sk-app-why').textContent).toBe('This project has no app to take a picture of yet.');
    expect(button('A screen from your app').getAttribute('aria-describedby')).toBe('sk-app-why');

    appOption = { ok: true, app: 'Mawid' };
    await open('shop');
    await until(() => button('A screen from your app') && !button('A screen from your app').disabled);
    expect(page.querySelector('#sk-app-why')).toBeNull();
    await press(button('A screen from your app'));
    await until(() => previews().length > 0);
    expect(changes).toEqual([{ method: 'POST', url: '/p/mawid/api/v1/studio/app-picture', body: null }]);
    expect(previews()).toEqual(['Mawid.png']);
    // Ready to send with a few words.
    await type('Make this calmer');
    expect(button('Send').disabled).toBe(false);
  });
});

describe('the Sketches home: the grid (US-06)', () => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const brand = { id: 'brand', version: 1, name: 'Brand' };
  const screensOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, name: `Screen ${i + 1}` }));
  const desktopAndMobile = { cover: { screen: 's1', version: 1, views: ['desktop', 'mobile'] } };
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 5)));
  };
  const cards = () => [...page.querySelectorAll('.sk-card')] as any[];
  const card = (el: any) => ({
    name: el.querySelector('.sk-card-name').textContent,
    views: [...el.querySelectorAll('.sk-thumb')].map((t: any) => t.getAttribute('data-view')),
    screens: el.querySelector('.sk-card-screens').textContent,
    approved: el.querySelector('.sk-card-approved')?.textContent ?? null,
    designSystem: el.querySelector('.sk-card-ds').textContent,
    edited: el.querySelector('.sk-card-edited')?.textContent ?? null,
  });
  /** The three sketches of done when 3, in the order the server sends them: newest edit first. */
  function three() {
    sketches = [
      { id: 'checkout', name: 'Checkout', designSystem: brand, stamp: 'c1', screens: screensOf(3), card: { ...desktopAndMobile, screens: 3, approved: 0, designSystem: 'Brand', edited: { at: ago(10), by: 'AI Designer', for: 'Sara' } } },
      { id: 'profile', name: 'Profile', designSystem: brand, stamp: 'p1', screens: screensOf(1), card: { cover: null, screens: 1, approved: 0, designSystem: 'Brand', edited: { at: ago(60), by: 'Omar' } } },
      { id: 'onboarding', name: 'Onboarding', designSystem: brand, stamp: 'o1', screens: screensOf(5), card: { cover: { screen: 's1', version: 1, views: ['desktop'] }, screens: 5, approved: 2, designSystem: 'Brand', edited: { at: ago(26 * 60), by: 'Sara' } } },
    ];
    covers = {
      checkout: { screen: 's1', version: 1, frames: { desktop: '<!doctype html><h1>Cart</h1><img src="https://example.com/x.png">', mobile: '<h1>Cart, small</h1>' } },
      onboarding: { screen: 's1', version: 1, frames: { desktop: '<h1>Welcome</h1>' } },
    };
  }

  it('done when 1: the Checkout card shows desktop and mobile, its name, "3 screens", "Brand" and its last edit, and no approved count', async () => {
    sketches = [{ id: 'checkout', name: 'Checkout', designSystem: brand, stamp: 'c1', screens: screensOf(3), card: { ...desktopAndMobile, screens: 3, approved: 0, designSystem: 'Brand', edited: { at: ago(120), by: 'Sara' } } }];
    covers = { checkout: { screen: 's1', version: 1, frames: { desktop: '<h1>Cart</h1>', mobile: '<h1>Cart, small</h1>' } } };
    await open('mawid');
    await until(() => page.querySelectorAll('.sk-thumb-frame').length === 2);
    expect(cards().map(card)).toEqual([{ name: 'Checkout', views: ['desktop', 'mobile'], screens: '3 screens', approved: null, designSystem: 'Brand', edited: 'Edited 2 hours ago by Sara' }]);
    expect(page.querySelector('.sk-card').textContent).not.toMatch(/approved/i);
  });

  it('done when 2: a card with 2 of its 5 screens approved says "2 of 5 approved"', async () => {
    sketches = [{ id: 'onboarding', name: 'Onboarding', designSystem: brand, stamp: 'o1', screens: screensOf(5), card: { cover: null, screens: 5, approved: 2, designSystem: 'Brand', edited: { at: ago(5), by: 'Sara' } } }];
    await open('mawid');
    expect(card(cards()[0]).approved).toBe('2 of 5 approved');
    expect(S.approvedText(0, 5)).toBeNull();
    expect(S.approvedText(2, 5)).toBe('2 of 5 approved');
  });

  it('done when 3: the cards come newest edit first, and Checkout says "by AI Designer for Sara"', async () => {
    three();
    await open('mawid');
    expect(cards().map(card)).toEqual([
      { name: 'Checkout', views: ['desktop', 'mobile'], screens: '3 screens', approved: null, designSystem: 'Brand', edited: 'Edited 10 minutes ago by AI Designer for Sara' },
      { name: 'Profile', views: [null], screens: '1 screen', approved: null, designSystem: 'Brand', edited: 'Edited 1 hour ago by Omar' },
      { name: 'Onboarding', views: ['desktop'], screens: '5 screens', approved: '2 of 5 approved', designSystem: 'Brand', edited: 'Edited yesterday by Sara' },
    ]);
  });

  it('done when 4: a click on the card opens the sketch', async () => {
    three();
    await open('mawid');
    const link = cards()[0].querySelector('a');
    // The whole card is the one link: its picture, name and facts.
    expect(cards()[0].querySelectorAll('a')).toHaveLength(1);
    expect(link.getAttribute('href')).toBe('/studio/sketches/checkout');
    expect(link.querySelector('.sk-thumbs')).not.toBeNull();
    await act(async () => link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    await until(() => router.state.location.pathname === '/studio/sketches/checkout' && page.querySelector('h1')?.textContent === 'Checkout');
    expect(router.state.location.pathname).toBe('/studio/sketches/checkout');
    expect(page.querySelector('h1').textContent).toBe('Checkout');
  });

  it('done when 5: desktop only shows one picture with no empty mobile spot; no drawing yet shows a plain placeholder, never a broken image', async () => {
    three();
    await open('mawid');
    await until(() => page.querySelectorAll('.sk-thumb-frame').length === 3);
    const [, profile, onboarding] = cards();
    expect(onboarding.querySelectorAll('.sk-thumb')).toHaveLength(1);
    expect(onboarding.querySelector('.sk-thumb.mobile')).toBeNull();
    expect(onboarding.querySelector('.sk-thumb').getAttribute('data-view')).toBe('desktop');
    // Profile's first screen has no picture: one plain placeholder, no frame and no image to break.
    expect(profile.querySelectorAll('.sk-thumb')).toHaveLength(1);
    expect(profile.querySelector('.sk-thumb-wait').getAttribute('aria-label')).toBe('No picture yet');
    expect(profile.querySelectorAll('iframe, img')).toHaveLength(0);
    // No page asked for a cover it does not have.
    expect(fetchSpy.mock.calls.map(([url]) => url).filter((u: string) => u.endsWith('/cover')).sort()).toEqual(['/p/mawid/api/v1/studio/sketches/checkout/cover', '/p/mawid/api/v1/studio/sketches/onboarding/cover']);
  });

  it('keeps the placeholder until a picture has loaded, and draws it sealed: no scripts, no network', async () => {
    three();
    // The cover answer is held back: the card shows its placeholders meanwhile, and no frame.
    let letThrough: () => void = () => undefined;
    const held = new Promise<void>((r) => (letThrough = r));
    const answer = fetchSpy.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/checkout/cover')) await held;
      return answer(url, init);
    });
    await open('mawid');
    const checkout = () => cards()[0];
    expect(checkout().querySelectorAll('.sk-thumb')).toHaveLength(2);
    expect(checkout().querySelectorAll('.sk-thumb .sk-thumb-wait')).toHaveLength(2);
    expect(checkout().querySelectorAll('iframe, img')).toHaveLength(0);

    await act(async () => letThrough());
    await until(() => checkout().querySelectorAll('.sk-thumb-frame').length === 2);
    const desktop = checkout().querySelector('.sk-thumb[data-view="desktop"]');
    const frame = desktop.querySelector('iframe');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toBe(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${S.THUMB_POLICY}"><h1>Cart</h1><img src="https://example.com/x.png">`);
    expect(S.THUMB_POLICY).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:");
    expect(frame.getAttribute('tabindex')).toBe('-1');
    // Once loaded, the picture shows in place of the placeholder.
    await act(async () => frame.dispatchEvent(new dom.window.Event('load')));
    expect(desktop.querySelector('.sk-thumb-wait')).toBeNull();
    // The policy always comes first, whatever the drawing starts with.
    expect(S.sealedHtml('<!-- <head> --><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>')).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
  });

  it('keeps the placeholder when the picture cannot be read', async () => {
    three();
    covers = {};
    await open('mawid');
    await until(() => fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/checkout/cover')));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(page.querySelectorAll('.sk-thumb-frame')).toHaveLength(0);
    expect(cards()[0].querySelectorAll('.sk-thumb .sk-thumb-wait')).toHaveLength(2);
  });

  it('words a card the same way every time', () => {
    const now = Date.parse('2026-11-16T12:00:00.000Z');
    const m = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    expect(S.screensText(0)).toBe('No screens yet');
    expect(S.screensText(1)).toBe('1 screen');
    expect(S.screensText(3)).toBe('3 screens');
    expect(S.editedText({ at: m(0.5), by: 'Sara' }, now)).toBe('Edited just now by Sara');
    expect(S.editedText({ at: m(1), by: 'Sara' }, now)).toBe('Edited 1 minute ago by Sara');
    expect(S.editedText({ at: m(10), by: 'AI Designer', for: 'Sara' }, now)).toBe('Edited 10 minutes ago by AI Designer for Sara');
    expect(S.editedText({ at: m(150), by: 'Sara' }, now)).toBe('Edited 2 hours ago by Sara');
    expect(S.editedText({ at: m(30 * 60), by: 'Sara' }, now)).toBe('Edited yesterday by Sara');
    expect(S.editedText({ at: m(3 * 24 * 60) }, now)).toBe('Edited 3 days ago');
    expect(S.editedText({ at: '2026-10-04T10:00:00.000Z', by: 'Omar' }, now)).toBe('Edited on 4 Oct by Omar');
    expect(S.editedText({ at: '2025-10-04T10:00:00.000Z' }, now)).toBe('Edited on 4 Oct 2025');
    expect(S.editedText(null, now)).toBe('');
    expect(S.editedText({ at: 'soon', by: 'Sara' }, now)).toBe('');
  });
});
