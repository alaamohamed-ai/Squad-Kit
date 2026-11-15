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
vi.stubGlobal('window', dom.window);
vi.stubGlobal('document', dom.window.document);
vi.stubGlobal('navigator', dom.window.navigator);
vi.stubGlobal('localStorage', dom.window.localStorage);
vi.stubGlobal('sessionStorage', dom.window.sessionStorage);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const React = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/react/index.js', import.meta.url).pathname)) as { createElement(...a: unknown[]): unknown; act(fn: () => unknown): Promise<void> };
const { createRoot } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/react-dom/client.js', import.meta.url).pathname)) as unknown as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
const { QueryClient, QueryClientProvider } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/@tanstack/react-query/build/modern/index.js', import.meta.url).pathname)) as { QueryClient: new (o: object) => unknown; QueryClientProvider: unknown };
const { act } = React;
// The root type check does not read the board's own files, so these are found at run time.
const board = (file: string) => import(/* @vite-ignore */ new URL(`../../console-ui/${file}`, import.meta.url).pathname);
const S = await board('src/lib/studio.ts');
const { StudioPage } = await board('src/pages/Studio.tsx');
const h = React.createElement;

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let root: { render(n: unknown): void; unmount(): void } | null = null;
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

async function open(project: string) {
  await close();
  root = createRoot(page.getElementById('root'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(h(QueryClientProvider, { client }, h(StudioPage, { project }))));
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
/** Waits until the Design systems tab has its answer. */
async function settle() {
  for (let i = 0; i < 50 && page.getElementById('studio-panel')?.textContent === 'Reading the design systems…'; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
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
  // The board server: it answers the design systems list and nothing else.
  fetchSpy = vi.fn(async (url: string, init: RequestInit = {}) => {
    if ((init.method ?? 'GET') === 'GET' && url === '/p/mawid/api/v1/studio/design-systems') {
      const def = systems.find((d) => d.isDefault);
      return new Response(JSON.stringify({ designSystems: systems, default: def ? { id: def.id, name: def.name, version: def.version } : null }), { status: 200 });
    }
    throw new Error(`The Studio must not call ${init.method ?? 'GET'} ${url}`);
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

  it('shows only a short "nothing yet" message on each empty tab', async () => {
    await open('mawid');
    for (const [label, words] of [['Sketches', 'Nothing here yet.'], ['Design systems', 'No design systems yet.']]) {
      await click(label!);
      expect(openTab()).toBe(label);
      const panel = page.querySelector('[role="tabpanel"]');
      expect(panel.textContent).toBe(words);
      expect(panel.children).toHaveLength(1);
    }
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

  it('only reads the design systems list, and saves nothing, so opening it and switching tabs creates nothing', async () => {
    const xhr = vi.spyOn(dom.window.XMLHttpRequest.prototype, 'open');
    await open('mawid');
    // The Sketches tab calls nothing.
    expect(fetchSpy).not.toHaveBeenCalled();
    await click('Design systems');
    await click('Sketches');
    expect(fetchSpy.mock.calls.map(([url, init]) => [(init as RequestInit | undefined)?.method ?? 'GET', url])).toEqual([['GET', '/p/mawid/api/v1/studio/design-systems']]);
    expect(xhr).not.toHaveBeenCalled();
    // No way to save from the page: no sending helper, no change, only the one read.
    for (const file of ['console-ui/src/pages/Studio.tsx', 'console-ui/src/lib/studio.ts'])
      expect(read(file)).not.toMatch(/lib\/data|useAct|apiFetch|fetch\(|useMutation|\bsend\b|method:/);
    expect([...read('console-ui/src/pages/Studio.tsx').matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['react', '@tanstack/react-query', '../api/client', '../lib/studio']);
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
    expect(panel.querySelectorAll('button, textarea, input, a')).toHaveLength(0);
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
