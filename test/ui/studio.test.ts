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
const Seen = await board('src/lib/studio-seen.ts');
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
async function open(project: string, at = '/studio', opts: { side?: boolean } = {}) {
  await close();
  root = createRoot(page.getElementById('root'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const top = Router.createRootRoute();
  const studio = Router.createRoute({ getParentRoute: () => top, path: '/studio', component: () => h(StudioPage, { project }) });
  const sketch = Router.createRoute({ getParentRoute: () => top, path: '/studio/sketches/$id', component: SketchWorkspacePage });
  const boardPage = Router.createRoute({ getParentRoute: () => top, path: '/board', component: () => h('p', { className: 'board-page' }, 'Board') });
  router = Router.createRouter({ routeTree: top.addChildren([studio, sketch, boardPage]), history: Router.createMemoryHistory({ initialEntries: [at] }) });
  const app = h(Router.RouterProvider, { router });
  // The sidebar's Studio badge, as the Shell shows it (US-53): New, or nothing.
  const side = opts.side ? h('span', { id: 'studio-new' }, h(SideBadge, { project })) : null;
  await act(async () => root!.render(h(QueryClientProvider, { client }, side, app)));
  if (at === '/board') return;
  await settle();
}
function SideBadge({ project }: { project: string }) {
  return Seen.useStudioNew(project) ? 'New' : '';
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
    // While a Studio place reads, it shows grey placeholder shapes (US-57).
    if (panel) return !!panel.querySelector('.skel') || !!panel.querySelector('.sk-status:not(.bad)');
    return !page.querySelector('h1') || !!page.querySelector('.skel') || page.querySelector('h1').textContent === '…';
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
    // A sketch's screens (US-11): Add screen and a tab's Delete, each with the stamp the page read.
    const screensAt = /^\/p\/mawid\/api\/v1\/studio\/sketches\/([a-z0-9-]+)\/screens(?:\/([a-z0-9-]+))?$/.exec(url);
    if (screensAt && (method === 'POST' || method === 'DELETE')) {
      const body = JSON.parse(String(init.body));
      changes.push({ method, url, body });
      const s = sketches.find((x) => x.id === screensAt[1])!;
      if (method === 'POST') {
        s.screens = [...s.screens, { id: 'new-screen', name: 'New screen', order: s.screens.length + 1, status: 'draft', unnamed: true } as { id: string; name: string }];
        s.stamp = `${s.stamp}+`;
        return json({ added: 'new-screen', stamp: s.stamp });
      }
      s.screens = s.screens.filter((x) => x.id !== screensAt[2]);
      s.stamp = `${s.stamp}-`;
      return json({ deleted: screensAt[2] });
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

  it('done when 1: shows Studio with the palette icon right after Conversations, then Releases, Architecture and Bugs', () => {
    const items = nav();
    const labels = items.map((n) => n.label);
    const at = labels.indexOf('Conversations');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(labels.slice(at, at + 5)).toEqual(['Conversations', 'Studio', 'Releases', 'Architecture', 'Bugs']);
    // Drawn like the other entries, with the New badge the same as Requirements': no switch and no counter.
    expect(items[at + 1]).toEqual({ to: '/studio', label: 'Studio', icon: 'Palette', rest: ", badge: 'studio' as const " });
    const shell = read('console-ui/src/components/Shell.tsx');
    expect(shell).toMatch(/import \{[^}]*\bPalette\b[^}]*\} from 'lucide-react'/);
    expect(shell).toContain(`{n.badge === 'studio' && studioNew && <span className="badge new">New</span>}`);
    expect(shell).toContain(`<span className="badge new">New</span>}`);
    expect(shell).toContain("const studioNew = useStudioNew(PROJECT ?? '');");
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
  it('opens on Sketches the first time, with its title and the two tabs', async () => {
    await open('mawid');
    expect(page.querySelector('h1').textContent).toBe('Studio');
    expect(tabs().map((t) => t.textContent)).toEqual(['Sketches', 'Design systems']);
    expect(openTab()).toBe('Sketches');
  });

  it('done when 2: the title Studio, then one segmented control with two text-only tabs, the selected one raised', async () => {
    await open('mawid');
    const top = page.querySelector('.top');
    expect([...top.children].map((el: any) => el.tagName + (el.className ? `.${el.className.split(' ').join('.')}` : ''))).toEqual(['H1', 'DIV.seg.studio-seg']);
    const seg = top.querySelector('.seg');
    expect(seg.getAttribute('role')).toBe('tablist');
    // Text only, as the person decided: no icon in either tab, Design systems included. No subtitle line and no
    // underline tabs any more.
    expect(seg.querySelectorAll('svg')).toHaveLength(0);
    expect(page.querySelector('.ptabs')).toBeNull();
    expect(top.querySelector('.note')).toBeNull();
    // The selected tab is the raised one: the .seg look's "on", the same in light and dark.
    expect([...seg.querySelectorAll('button')].map((b: any) => [b.textContent, b.className, b.getAttribute('aria-selected')])).toEqual([
      ['Sketches', 'on', 'true'],
      ['Design systems', '', 'false'],
    ]);
    await click('Design systems');
    expect([...seg.querySelectorAll('button.on')].map((b: any) => b.textContent)).toEqual(['Design systems']);
    // Only squad-kit's own look: the shared .seg rule, raised with the theme's own colours, no colour of its own.
    const css = read('console-ui/src/styles/app.css');
    expect(css).toContain('.seg button.on { background: var(--surface); color: var(--text);');
    const studioRules = [...css.matchAll(/^\.studio-[^{]*\{[^}]*\}/gm)].map((m) => m[0]).join('\n');
    expect(studioRules).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });

  it('shows the start page on an empty Sketches tab, and only a short message on an empty Design systems tab', async () => {
    await open('mawid');
    const panel = () => page.querySelector('[role="tabpanel"]');
    expect(panel().querySelector('textarea')).not.toBeNull();
    expect(panel().textContent).not.toContain('Nothing here yet');
    await click('Design systems');
    expect(panel().textContent).toBe('No design systems yet.');
    expect(panel().children).toHaveLength(1);
    // done when 3: centred the same way as the Sketches start page, across the whole content area.
    expect(panel().firstElementChild.className).toBe('studio-empty');
    const css = read('console-ui/src/styles/app.css');
    expect(css).toContain('.studio-empty { max-width: 760px; margin: 48px auto 24px; text-align: center; }');
    expect(css).toContain('.sk-start { max-width: 760px; margin: 48px auto 24px;');
    expect(css).toContain('#studio-panel:has(> .sk-start), #studio-panel:has(> .studio-empty) { max-width: none; }');
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
    // Nothing lasts past the tab: the computer's lasting storage holds no Studio choice, only the board's sign-in and
    // the sidebar's "seen the Studio" mark (AB-178.1).
    expect(Object.keys(dom.window.localStorage).sort()).toEqual(['squad-studio-seen:mawid', 'squad.console.token']);
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
    // The page itself only reads: the start page's Send and the card menu's Rename, Duplicate and Delete (US-13) are the
    // changes, each in its own file. The card menu (SketchMenu.tsx, US-46) also holds Export, which saves nothing.
    for (const file of ['console-ui/src/pages/Studio.tsx', 'console-ui/src/lib/studio.ts'])
      expect(read(file)).not.toMatch(/lib\/data|useAct|apiFetch|fetch\(|useMutation|\bsend\b|method:/);
    expect([...read('console-ui/src/pages/Studio.tsx').matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['react', '@tanstack/react-query', '@tanstack/react-router', '../api/client', '../lib/studio', './studio/SketchMenu', './studio/StartSketch', './studio/Skeletons', '../lib/studio-seen']);
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
    const order = [box(), ...page.querySelectorAll('.sk-chip'), button('An image'), button('A screen from your app')];
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...page.querySelectorAll('.sk-chip')].map((c: any) => c.textContent)).toEqual(['A login page in Arabic and English', "An admin dashboard with today's visits", 'A profile page for patients']);
    expect([...S.EXAMPLE_PROMPTS]).toEqual(['A login page in Arabic and English', "An admin dashboard with today's visits", 'A profile page for patients']);
    expect(panel().textContent).not.toContain('Nothing here yet');
  });

  it('US-53 done when 3: centred, and under the chat box only the options that work today: An image and A screen from your app', async () => {
    await open('mawid');
    expect(panel().firstElementChild.className).toBe('sk-start');
    const from = page.querySelector('.sk-from');
    expect([...from.querySelectorAll('button')].map((b: any) => b.textContent.trim())).toEqual(['An image', 'A screen from your app']);
    expect(from.querySelector('span').textContent).toBe('Or start from');
    expect(panel().textContent).not.toMatch(/Figma|coming soon/i);
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

    // "An image" opens the same picker.
    const input = page.querySelector('input[type="file"]') as any;
    const opened = vi.fn();
    input.addEventListener('click', opened);
    await press(button('An image'));
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

    expect(changes).toEqual([{ method: 'POST', url: '/p/mawid/api/v1/studio/sketches/start', body: { message: 'A page where patients book a visit with their doctor', pictures: [{ name: 'idea.png', type: 'image/png', data: `data:image/png;base64,${PNG.toString('base64')}` }], designSystem: null, frames: ['desktop', 'mobile'], variants: 2 } }]);
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

  /* ── US-08 New sketch from the chat (AB-133): the chips under the box and the line ── */
  const patientApp = { id: 'patient-app', name: 'Patient app', isDefault: true, version: 2, colors: [], sketches: 0, frames: ['desktop', 'mobile'] };
  const admin = { id: 'admin', name: 'Admin', isDefault: false, version: 1, colors: [], sketches: 0, frames: ['desktop'] };
  const chips = () => [...page.querySelectorAll('.sk-chips .sk-opt')].map((c: any) => c.textContent.trim());
  const line = () => page.querySelector('.sk-run')?.textContent;
  const frameChip = (name: string) => [...page.querySelectorAll('.sk-frame')].find((b: any) => b.textContent.trim() === name) as any;
  const openWithChips = async () => {
    systems = [patientApp, admin];
    await open('mawid');
    await until(() => chips()[0] === 'Patient app · default');
  };

  it('US-08 done when 1: a chat box, not a form, with the chips "Patient app · default", Desktop, Mobile and "2 variants", and the line', async () => {
    await openWithChips();
    // No form fields: the only thing to type in is the chat box.
    expect(page.querySelectorAll('.sk-start input:not([type="file"]), .sk-start select')).toHaveLength(0);
    expect(page.querySelectorAll('.sk-start textarea')).toHaveLength(1);
    expect(chips()).toEqual(['Patient app · default', 'Desktop', 'Mobile', '2 variants']);
    expect([frameChip('Desktop'), frameChip('Mobile')].map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
    expect(line()).toBe('1 screen × 2 frames × 2 variants');
    // The chips sit under the box.
    expect(box().compareDocumentPosition(page.querySelector('.sk-chips')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(changes).toEqual([]);
  });

  it('US-08 done when 2: Mobile off, variants to 3, or another design system: the line updates at once, and nothing is saved', async () => {
    await openWithChips();
    await press(frameChip('Mobile'));
    expect(frameChip('Mobile').getAttribute('aria-pressed')).toBe('false');
    expect(line()).toBe('1 screen × 1 frame × 2 variants');
    // At least one frame always stays on.
    expect(frameChip('Desktop').getAttribute('aria-disabled')).toBe('true');
    await press(frameChip('Desktop'));
    expect(frameChip('Desktop').getAttribute('aria-pressed')).toBe('true');
    expect(line()).toBe('1 screen × 1 frame × 2 variants');

    // Variants go only from 1 to 3.
    await press(button('More variants'));
    expect(line()).toBe('1 screen × 1 frame × 3 variants');
    expect(button('More variants').disabled).toBe(true);
    await press(button('Fewer variants'));
    await press(button('Fewer variants'));
    expect(chips()).toContain('1 variant');
    expect(button('Fewer variants').disabled).toBe(true);
    await press(button('More variants'));
    await press(button('More variants'));
    await press(frameChip('Mobile'));
    expect(line()).toBe('1 screen × 2 frames × 3 variants');

    // Another design system, whose only frame is Desktop: its frames, all on.
    const ds = button('Design system: Patient app, default');
    expect(ds.getAttribute('aria-expanded')).toBe('false');
    await press(ds);
    const options = [...page.querySelectorAll('[role="menuitemradio"]')] as any[];
    expect(options.map((o) => o.textContent)).toEqual(['Patient app · default · Desktop, Mobile', 'Admin · Desktop']);
    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    await press(options[1]);
    expect(page.querySelector('[role="menu"]')).toBeNull();
    expect(chips()).toEqual(['Admin', 'Desktop', '3 variants']);
    expect(line()).toBe('1 screen × 1 frame × 3 variants');

    // Nothing was sent: the page only read.
    expect(changes).toEqual([]);
    expect(fetchSpy.mock.calls.every(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('US-08 done when 4: Send takes the chips along, the design system, its frames and the variants', async () => {
    await openWithChips();
    await type('A page where patients book a follow-up visit with their last doctor');
    await press(button('Send'));
    await until(() => changes.length > 0);
    expect(changes[0]!.body).toEqual({ message: 'A page where patients book a follow-up visit with their last doctor', pictures: [], designSystem: 'patient-app', frames: ['desktop', 'mobile'], variants: 2 });
  });

  it('US-08: New sketch on the Sketches home opens the chat box, not a form, and All sketches goes back; nothing is saved', async () => {
    systems = [patientApp, admin];
    sketches = [{ id: 'login', name: 'Login', designSystem: { id: 'patient-app', version: 2, name: 'Patient app' }, stamp: 's', screens: [] }];
    await open('mawid');
    expect(box()).toBeNull();
    await press(button('New sketch'));
    await until(() => chips()[0] === 'Patient app · default');
    expect(box()).not.toBeNull();
    expect(page.querySelectorAll('.sk-start input:not([type="file"]), .sk-start select')).toHaveLength(0);
    expect(line()).toBe('1 screen × 2 frames × 2 variants');
    await press(button('All sketches'));
    expect(box()).toBeNull();
    expect(page.querySelectorAll('.sk-card')).toHaveLength(1);
    expect(changes).toEqual([]);
  });

  it('US-08: the line and the list say it in plain words', () => {
    expect(S.runLine(2, 2)).toBe('1 screen × 2 frames × 2 variants');
    expect(S.runLine(1, 3)).toBe('1 screen × 1 frame × 3 variants');
    expect(S.runLine(1, 1)).toBe('1 screen × 1 frame × 1 variant');
    expect(S.designSystemOption({ name: 'Old', isDefault: false })).toBe('Old · Desktop, Mobile');
    expect(S.framesOf(null)).toEqual(['desktop', 'mobile']);
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

describe('US-17 Draw variants: the variants of an ask side by side (AB-142)', () => {
  const html = (words: string) => `<!doctype html><html><body><h1>${words}</h1></body></html>`;
  const PATIENT_APP = { id: 'patient-app', version: 1, name: 'Patient app' };
  /** "Booking" follows Patient app; its Form screen has variants A and B of one ask, B with a red Patient app lacks. */
  function booking(chosen: number, more: Record<string, unknown> = {}) {
    sketches = [
      {
        id: 'booking',
        name: 'Booking',
        designSystem: PATIENT_APP,
        stamp: 's1',
        screens: [
          {
            id: 'form',
            name: 'Form',
            order: 1,
            status: 'draft',
            chosen,
            variants: [
              { version: 1, frames: ['desktop'], html: { desktop: html('A') }, ask: 'ask-1', letter: 'A', name: 'One page', idea: 'Everything on one page.', checkedWith: PATIENT_APP, ...more },
              { version: 2, frames: ['desktop'], html: { desktop: html('B') }, ask: 'ask-1', letter: 'B', name: 'Step by step', idea: 'Day, then time, then confirm.', checkedWith: PATIENT_APP, warnings: [{ kind: 'color', value: '#dc2626' }], ...more },
            ],
          },
        ],
      },
    ] as never;
  }
  /** The board server also answers the changes this story adds, and a conversation the test sets. */
  function serve(messages: unknown[] = []) {
    const base = fetchSpy.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    fetchSpy.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
      if (method !== 'GET') {
        const body = init.body ? JSON.parse(String(init.body)) : null;
        changes.push({ method, url, body });
        if (url.endsWith('/pick')) return body.stamp === 's1' ? json({}) : json({ error: 'Changed elsewhere, reload', changedElsewhere: true }, 409);
        if (url.endsWith('/chats/main/messages')) return json({ id: 'main', owner: { kind: 'sketch', id: 'booking', name: 'Booking' }, startedAt: null, messages, working: null });
        if (method === 'PATCH') return json({});
      }
      if (messages.length && url.endsWith('/booking/chats')) return json({ conversations: [{ id: 'main', startedAt: null, messages: messages.length, first: null, lastAt: null }], current: 'main' });
      if (messages.length && url.endsWith('/booking/chats/main')) return json({ id: 'main', owner: { kind: 'sketch', id: 'booking', name: 'Booking' }, startedAt: null, messages, working: null });
      return base(url, init);
    });
  }
  const cards = () => [...page.querySelectorAll('.vc-card')] as any[];
  async function press(el: any) {
    await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    for (let i = 0; i < 5; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
  }
  const button = (name: string) => ([...page.querySelectorAll('button')] as any[]).find((b) => b.textContent.trim() === name);

  it('done when 1 and 3: each card has its name, its idea, "Using this one" or "Use this one", and B a warning naming the red', async () => {
    booking(1);
    serve();
    await open('mawid', '/studio/sketches/booking');
    expect(cards().map((c) => c.querySelector('strong').textContent)).toEqual(['Variant A · One page', 'Variant B · Step by step']);
    expect(cards().map((c) => c.querySelector('.vc-idea').textContent)).toEqual(['Everything on one page.', 'Day, then time, then confirm.']);
    expect(cards()[0].querySelector('.vc-using').textContent.trim()).toBe('Using this one');
    expect(cards()[0].querySelector('button.vc-use')).toBeNull();
    expect(cards()[1].querySelector('button.vc-use').textContent).toBe('Use this one');
    // Only B uses what Patient app lacks, and its card names it.
    expect(cards()[0].querySelector('.vc-warn')).toBeNull();
    expect(cards()[1].querySelector('.vc-warn').textContent).toBe('The color #dc2626 is not part of "Patient app".');
    // Each drawing is sealed: no scripts, no network.
    expect(cards().map((c) => c.querySelector('iframe').getAttribute('sandbox'))).toEqual(['', '']);
    expect(cards()[1].querySelector('iframe').getAttribute('srcdoc')).toContain("default-src 'none'");
  });

  it('done when 2: "Use this one" on B sends its version with the stamp the page read; B in use reads "Using this one"', async () => {
    booking(1);
    serve();
    await open('mawid', '/studio/sketches/booking');
    await press(cards()[1].querySelector('button.vc-use'));
    // With the conversation open beside the cards, where the pick's line goes (US-18, AB-143.1).
    expect(changes).toEqual([{ method: 'POST', url: '/p/mawid/api/v1/studio/sketches/booking/screens/form/pick', body: { version: 2, stamp: 's1', chat: 'main' } }]);
    // As the reload reads it: B in use.
    booking(2);
    await open('mawid', '/studio/sketches/booking');
    expect(cards().map((c) => [c.querySelector('strong').textContent, (c.querySelector('.vc-using')?.textContent ?? c.querySelector('button.vc-use').textContent).trim()])).toEqual([
      ['Variant A · One page', 'Use this one'],
      ['Variant B · Step by step', 'Using this one'],
    ]);
  });

  it('a stale stamp: the card says "Changed elsewhere, reload" and nothing changes', async () => {
    booking(1);
    sketches[0]!.stamp = 'old';
    serve();
    await open('mawid', '/studio/sketches/booking');
    await press(cards()[1].querySelector('button.vc-use'));
    expect(page.querySelector('.vc-problem').textContent).toBe('Changed elsewhere, reload');
  });

  it('done when 4: variants drawn with no design system say "No design system"', async () => {
    booking(1, { checkedWith: undefined, warnings: undefined, noDesignSystem: true });
    serve();
    await open('mawid', '/studio/sketches/booking');
    expect(cards().map((c) => c.querySelector('.vc-plain')?.textContent)).toEqual(['No design system', 'No design system']);
    expect(page.querySelectorAll('.vc-warn')).toHaveLength(0);
  });

  it('done when 4: the "no design system" alert selects one for the sketch with its stamp, and Skip sends the same words once in plain styles', async () => {
    booking(1);
    (sketches[0] as any).designSystem = null;
    systems = [{ id: 'patient-app', name: 'Patient app', isDefault: true, version: 1, colors: [], sketches: 0 }];
    const asked = 'Draw 2 variants of the Form screen';
    serve([
      { role: 'person', text: asked, pictures: [] },
      { role: 'designer', kind: 'needs-design-system', text: '"Booking" has no design system selected, so I drew nothing.', pictures: [] },
    ]);
    await open('mawid', '/studio/sketches/booking');
    // The chat is read after the sketch.
    for (let i = 0; i < 100 && !page.querySelector('.dc-alert'); i++) await act(() => new Promise((r) => setTimeout(r, 5)));
    expect(page.querySelector('.dc-alert').textContent).toContain('No design system is selected');
    await press(button('Skip'));
    expect(changes.at(-1)).toMatchObject({ method: 'POST', url: '/p/mawid/api/v1/studio/sketches/booking/chats/main/messages', body: { text: asked, plainStyles: true, stamp: 's1' } });

    await press(button('Select a design system'));
    await press(button('Use it'));
    expect(changes.at(-1)).toEqual({ method: 'PATCH', url: '/p/mawid/api/v1/studio/sketches/booking', body: { designSystem: { id: 'patient-app' }, stamp: 's1' } });
  });

  it('a screen whose drawing came from no ask shows the one drawing, as before', async () => {
    booking(1, { ask: undefined, letter: undefined });
    serve();
    await open('mawid', '/studio/sketches/booking');
    expect(cards()).toHaveLength(0);
    expect(page.querySelector('iframe.ws-frame')).not.toBeNull();
  });

  it('words and groups the cards the same way every time', () => {
    expect(S.warningText([{ kind: 'color', value: '#dc2626' }], 'Patient app')).toBe('The color #dc2626 is not part of "Patient app".');
    expect(S.warningText([{ kind: 'color', value: 'red' }, { kind: 'color', value: '#dc2626' }, { kind: 'font', value: 'Comic Sans MS' }], 'Brand')).toBe('The colors red and #dc2626, the font Comic Sans MS are not part of "Brand".');
    const v = (version: number, letter: string, ask = 'ask-1') => ({ version, frames: [], html: {}, ask, letter, name: `N${version}` });
    // B was changed (v4): its card shows the newest B; the chosen letter shows the chosen drawing; another ask is left out.
    const cardsOf = S.askCards({ chosen: 1, variants: [v(1, 'A'), v(2, 'B'), v(3, 'C'), v(4, 'B'), v(5, 'A', 'ask-2')] });
    expect(cardsOf.map((c: any) => [c.letter, c.version, c.using])).toEqual([
      ['A', 1, true],
      ['B', 4, false],
      ['C', 3, false],
    ]);
    expect(S.askCards({ chosen: 1, variants: [{ version: 1, frames: [], html: {} }] })).toBeNull();
  });
});

describe('US-53 the sidebar\'s New badge on Studio (AB-178.1)', () => {
  const badge = () => page.getElementById('studio-new')?.textContent ?? null;
  const wait = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 5)));
  };
  const listsRead = () => fetchSpy.mock.calls.filter(([url]) => /\/studio\/(sketches|design-systems)$/.test(String(url))).length;
  const go = async (to: string) => {
    await act(async () => {
      await router.navigate({ to });
    });
    await wait(() => to !== '/studio' || !!page.querySelector('h1'));
  };

  it('done when 1: New on a project never opened with nothing in it; gone once the Studio opens, and after a reload', async () => {
    await open('mawid', '/board', { side: true });
    await wait(() => badge() === 'New');
    expect(badge()).toBe('New');
    // Open the Studio, then back to the Board: New is gone, and the mark is in this browser's lasting memory only.
    await go('/studio');
    await wait(() => badge() === '');
    expect(badge()).toBe('');
    await go('/board');
    expect(badge()).toBe('');
    expect(dom.window.localStorage.getItem(S.studioSeenKey('mawid'))).not.toBeNull();
    expect(changes).toEqual([]);
    // A reload: the page mounts again; New stays gone, and the lists are not even read for it.
    await close();
    fetchSpy.mockClear();
    await open('mawid', '/board', { side: true });
    await wait(() => false);
    expect(badge()).toBe('');
    expect(listsRead()).toBe(0);
    // One mark per project: another project never opened still shows New.
    await open('shop', '/board', { side: true });
    await wait(() => badge() === 'New');
    expect(badge()).toBe('New');
  });

  it('never flashes while the lists load: New only once both have come back empty', async () => {
    const real = fetchSpy.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/studio/sketches')) await gate;
      return real(url, init);
    });
    await open('mawid', '/board', { side: true });
    await wait(() => false);
    expect(listsRead()).toBe(2);
    expect(badge()).toBe('');
    release();
    await wait(() => badge() === 'New');
    expect(badge()).toBe('New');
  });

  it('never shows New in a project that already has a sketch or a design system', async () => {
    sketches = [{ id: 'login', name: 'Login', designSystem: null, stamp: 's', screens: [] }];
    await open('mawid', '/board', { side: true });
    await wait(() => listsRead() >= 2);
    await wait(() => false);
    expect(badge()).toBe('');

    sketches = [];
    systems = [{ id: 'brand', name: 'Brand', isDefault: true, version: 1, colors: [], sketches: 0 }];
    fetchSpy.mockClear();
    await open('mawid', '/board', { side: true });
    await wait(() => listsRead() >= 2);
    await wait(() => false);
    expect(badge()).toBe('');
  });

  it('is set by any Studio page, a sketch opened from a link too', async () => {
    sketches = [{ id: 'login', name: 'Login', designSystem: null, stamp: 's', screens: [] }];
    await open('mawid', '/studio/sketches/login');
    expect(dom.window.localStorage.getItem(S.studioSeenKey('mawid'))).not.toBeNull();
    expect(S.hasSeenStudio('shop')).toBe(false);
    // The design system page sets it too.
    expect(read('console-ui/src/pages/studio/DesignSystemPage.tsx')).toContain('useMarkStudioSeen(project);');
  });

  it('counts a browser that cannot keep the mark as seen: no New that never goes away', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage is off');
      },
      setItem: () => {
        throw new Error('storage is off');
      },
    });
    try {
      expect(S.hasSeenStudio('mawid')).toBe(true);
      expect(() => Seen.markStudioSeen('mawid')).not.toThrow();
    } finally {
      vi.stubGlobal('localStorage', dom.window.localStorage);
    }
  });
});

describe('US-53 the screen tabs stay on one row', () => {
  const LONG = 'Booking follow-up for older patients in Arabic and English';
  const NAMES: [string, string][] = [
    ['doctor', 'Choose a doctor'],
    ['older-patients', LONG],
    ['day', 'Pick a day'],
    ['time', 'Pick a time'],
    ['details', 'Your details'],
    ['confirm', 'Confirm'],
    ['reminders', 'Reminders'],
    ['done', 'Done'],
  ];
  let scrolled: string[];
  const press = async (el: any) => {
    await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    await settle();
  };
  const wait = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 5)));
  };
  const tab = (id: string) => page.querySelector(`.ws-tab[data-screen="${id}"]`) as any;
  const selected = () => page.querySelector('.ws-tabs [aria-selected="true"]')?.closest('.ws-tab')?.getAttribute('data-screen');
  const css = () => read('console-ui/src/styles/app.css');
  const rule = (selector: string) => {
    const at = css().split('\n').find((l) => l.startsWith(`${selector} {`));
    expect(at, selector).toBeTruthy();
    return at!;
  };

  beforeEach(() => {
    scrolled = [];
    // A row 300px wide whose tabs are 190px each, 10px apart: only the first fits. Scrolling records the screen it
    // brought into view, so the test sees which tab the row scrolled to, and that only the row scrolled.
    const proto = dom.window.HTMLElement.prototype;
    proto.getBoundingClientRect = function (this: any) {
      if (this.classList.contains('ws-tabs')) return { left: 0, right: 300, top: 0, bottom: 30, width: 300, height: 30 };
      if (this.classList.contains('ws-tab')) {
        const i = [...this.parentElement.children].indexOf(this);
        return { left: i * 200, right: i * 200 + 190, top: 0, bottom: 30, width: 190, height: 30 };
      }
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    };
    proto.scrollBy = function (this: any, by: { left: number }) {
      expect(this.className).toBe('ws-tabs');
      const i = Math.round((by.left - 8 + 300 - 190) / 200);
      scrolled.push(this.children[i]?.getAttribute('data-screen'));
    };
    // The chat keeps its last message in view on its own; a tab never scrolls the page around the row.
    proto.scrollIntoView = function (this: any) {
      if (this.closest('.ws-tabrow')) throw new Error('The page around the row must not scroll');
    };
    sketches = [
      {
        id: 'follow-up-visit',
        name: 'Follow-up visit',
        designSystem: null,
        stamp: 'f1',
        screens: NAMES.map(([id, name], i) => ({
          id,
          name,
          order: i + 1,
          status: id === 'confirm' ? 'approved' : 'draft',
          ...(id === 'confirm' ? { chosen: 1, approved: { version: 1, at: '2026-11-20T10:00:00.000Z', by: 'Sara' }, variants: [{ version: 1, frames: ['desktop'], html: { desktop: '<p>Confirm</p>' } }] } : {}),
        })),
      },
    ];
  });
  afterEach(() => {
    const proto = dom.window.HTMLElement.prototype;
    delete proto.scrollIntoView;
    delete proto.scrollBy;
    delete proto.getBoundingClientRect;
  });

  it('done when 5: all 8 tabs sit on one row that never wraps and scrolls sideways; the long name is cut with … and full on hover', async () => {
    await open('mawid', '/studio/sketches/follow-up-visit');
    expect([...page.querySelectorAll('.ws-tabs .ws-tab-name')].map((n: any) => n.textContent)).toEqual(NAMES.map(([, n]) => n));
    // One row, scrolling sideways; each pill keeps its size and its name on one line, cut at about 200px.
    expect(rule('.ws-tabs')).toMatch(/flex-wrap: nowrap;.*overflow-x: auto;/);
    expect(rule('.ws-tab')).toContain('flex: none;');
    expect(rule('.ws-tab-name')).toMatch(/max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/);
    expect(rule('.ws-tab > button[role=\'tab\']')).toContain('white-space: nowrap;');
    // The full name on hover, written in its own direction.
    const long = tab('older-patients');
    expect(long.querySelector('[role="tab"]').getAttribute('title')).toBe(LONG);
    expect(long.querySelector('.ws-tab-name').getAttribute('dir')).toBe('auto');
    // The pill holds its × at the end; its space is kept in every pill, shown on the selected one and on hover.
    expect([...long.children].map((c: any) => c.className || c.getAttribute('role'))).toEqual(['tab', 'ws-tab-del']);
    expect(rule('.ws-tab-del')).toMatch(/flex: none;.*visibility: hidden;/);
    expect(css()).toContain(".ws-tab:hover .ws-tab-del, .ws-tab:focus-within .ws-tab-del, .ws-tab:has([aria-selected='true']) .ws-tab-del { visibility: visible; }");
    expect(rule('.ws-tabs')).toContain('gap: 8px;');
    // Confirm is approved: its lock, and its full line on hover.
    const confirm = tab('confirm');
    expect(confirm.querySelector('[aria-label="Approved"]')).not.toBeNull();
    expect(confirm.querySelector('[role="tab"]').getAttribute('title')).toMatch(/^Confirm · Approved by Sara/);
    // The first tab is selected and already in view, so the row stays where it is.
    expect(scrolled).toEqual([]);
  });

  it('done when 5: the long-named tab\'s × stays whole and deletes it after asking', async () => {
    await open('mawid', '/studio/sketches/follow-up-visit');
    const del = tab('older-patients').querySelector('.ws-tab-del');
    expect(del.getAttribute('aria-label')).toBe(`Delete ${LONG}`);
    expect(del.disabled).toBe(false);
    await press(del);
    const dialog = page.querySelector('[role="dialog"]');
    expect(dialog.getAttribute('aria-label')).toBe(`Delete "${LONG}" and its drawings?`);
    expect(changes).toEqual([]);
    await press([...dialog.querySelectorAll('button')].find((b: any) => b.textContent === 'Delete'));
    expect(changes).toEqual([{ method: 'DELETE', url: '/p/mawid/api/v1/studio/sketches/follow-up-visit/screens/older-patients', body: { stamp: 'f1' } }]);
    await wait(() => !tab('older-patients'));
    expect(tab('older-patients')).toBeNull();
  });

  it('done when 5: at the end of the row, outside the scrolling part, a divider, All screens and then Add screen; a new screen is scrolled into view', async () => {
    await open('mawid', '/studio/sketches/follow-up-visit');
    const row = page.querySelector('.ws-tabrow');
    expect([...row.children].map((c: any) => c.className)).toEqual(['ws-tabs', 'ws-tabs-div', 'more ws-all', 'ws-add']);
    expect(row.lastElementChild.textContent.trim()).toBe('Add screen');
    expect(page.querySelector('.ws-tabs .ws-add, .ws-tabs .ws-all')).toBeNull();
    for (const end of ['.ws-tabs-div', '.ws-all', '.ws-add']) expect(rule(end)).toContain('flex: none;');
    expect(rule('.ws-tabrow')).toContain('min-width: 0;');

    scrolled = [];
    await press(row.lastElementChild);
    expect(changes).toEqual([{ method: 'POST', url: '/p/mawid/api/v1/studio/sketches/follow-up-visit/screens', body: { stamp: 'f1' } }]);
    await wait(() => selected() === 'new-screen');
    expect(selected()).toBe('new-screen');
    expect(scrolled).toContain('new-screen');
    expect(page.querySelector('.ws-tabrow').lastElementChild.textContent.trim()).toBe('Add screen');
  });

  it('done when 5: All screens lists all 8 in tab order with the approved mark on Confirm and no Delete; a pick selects it and scrolls it into view', async () => {
    await open('mawid', '/studio/sketches/follow-up-visit');
    const all = page.querySelector('button[aria-label="All screens"]');
    expect(all.getAttribute('aria-haspopup')).toBe('menu');
    await press(all);
    const menu = page.querySelector('[role="menu"][aria-label="All screens"]');
    const items = [...menu.querySelectorAll('[role="menuitem"]')] as any[];
    expect(items.map((i) => i.textContent)).toEqual(NAMES.map(([, n]) => n));
    expect(items.map((i) => !!i.querySelector('[aria-label="Approved"]'))).toEqual(NAMES.map(([id]) => id === 'confirm'));
    expect(items[1].getAttribute('title')).toBe(LONG);
    // Only for picking: no Delete in the list.
    expect(menu.querySelector('[aria-label^="Delete"]')).toBeNull();
    expect(menu.textContent).not.toContain('Delete');

    scrolled = [];
    await press(items[1]);
    expect(page.querySelector('[role="menu"]')).toBeNull();
    expect(selected()).toBe('older-patients');
    expect(scrolled).toContain('older-patients');
    // Picking the tab that is already selected still brings it into view.
    scrolled = [];
    await press(page.querySelector('button[aria-label="All screens"]'));
    await press(page.querySelector('[role="menuitem"][aria-current="true"]'));
    expect(scrolled).toEqual(['older-patients']);
    expect(changes).toEqual([]);
  });

  it('shows the version in the top bar before the status, "v1 · Approved", not in the row of tabs', async () => {
    await open('mawid', '/studio/sketches/follow-up-visit');
    await press(page.querySelector('button[aria-label="All screens"]'));
    await press([...page.querySelectorAll('[role="menuitem"]')].find((i: any) => i.textContent === 'Confirm'));
    expect(page.querySelector('.top .ws-status').textContent.replace(/\s+/g, ' ').trim()).toBe('v1 · Approved');
    expect(page.querySelector('.ws-bar .ws-version')).toBeNull();
  });
});
