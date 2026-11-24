import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * US-46 Export sketch to PDF (AB-171.1) on the board: the sketch's ⋯ menu with its Export group ("Export sketch to PDF"
 * on; PNG, JPG, SVG and HTML off with a small "Future" label), the export window (All screens or Approved screens only,
 * the frames, the screens with Select all, and "Include all variants of draft screens"), the busy "Making the PDF…",
 * and the download named "<sketch name>.pdf". Real React in a jsdom page, with a fake board server.
 */

const { JSDOM } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/jsdom/lib/api.js', import.meta.url).pathname)) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/mawid/studio', pretendToBeVisual: true });
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
const X = await board('src/lib/studio-export.ts');
const { StudioPage } = await board('src/pages/Studio.tsx');
const { SketchWorkspacePage } = await board('src/pages/studio/SketchWorkspace.tsx');
const h = React.createElement;

const drawn = (version: number, words: string, o: object = {}) => ({ version, frames: ['desktop', 'mobile'], html: { desktop: `<h1>${words}</h1>`, mobile: `<h1>${words}</h1>` }, ...o });
const ask = (letter: string, name: string) => ({ ask: 'ask-1', letter, name, idea: `${name} idea` });

/** Booking: Home approved, Form as variants A, B and C, and an empty "New screen". Login: no screen approved. */
const SKETCHES: Record<string, any> = {
  booking: {
    id: 'booking',
    name: 'Booking',
    designSystem: null,
    frames: ['desktop', 'mobile'],
    stamp: 's1',
    screens: [
      { id: 'home', name: 'Home', order: 1, status: 'approved', chosen: 1, approved: { version: 1, at: '2026-11-20T10:00:00Z' }, variants: [drawn(1, 'Home')] },
      { id: 'form', name: 'Form', order: 2, status: 'draft', chosen: 2, variants: [drawn(1, 'A', ask('A', 'One page')), drawn(2, 'B', ask('B', 'Split steps')), drawn(3, 'C', ask('C', 'Calendar first'))] },
      { id: 'new-screen', name: 'New screen', order: 3, status: 'draft', chosen: null, unnamed: true, variants: [] },
    ],
  },
  login: { id: 'login', name: 'Login', designSystem: null, frames: ['desktop', 'mobile'], stamp: 's2', screens: [{ id: 'sign-in', name: 'Sign in', order: 1, status: 'draft', chosen: 1, variants: [drawn(1, 'Sign in')] }] },
  'arabic-booking': { id: 'arabic-booking', name: 'الحجز', designSystem: null, frames: ['desktop'], stamp: 's3', screens: [{ id: 'booking-form', name: 'نموذج الحجز', order: 1, status: 'approved', chosen: 1, approved: { version: 1, at: '2026-11-20T10:00:00Z' }, variants: [drawn(1, 'نموذج')] }] },
};

let exports: { url: string; body: any }[];
let others: { method: string; url: string }[];
/** The PDF answer: held until the test lets it go, to see the busy state. */
let release: (() => void) | null;
let hold: boolean;
let downloads: { name: string; size: number }[];

function fakeServer(url: string, init: RequestInit = {}) {
  const method = init.method ?? 'GET';
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const ex = /^\/p\/mawid\/api\/v1\/studio\/sketches\/([^/]+)\/export\/pdf$/.exec(url);
  if (ex && method === 'POST') {
    exports.push({ url, body: JSON.parse(String(init.body)) });
    const answer = () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'content-type': 'application/pdf' } });
    if (!hold) return answer();
    return new Promise<Response>((r) => (release = () => r(answer())));
  }
  if (method !== 'GET') others.push({ method, url });
  if (url === '/p/mawid/api/v1/studio/sketches') return json({ sketches: Object.values(SKETCHES).map((s) => ({ ...s, card: { cover: null, screens: s.screens.length, approved: 0, designSystem: null, edited: null } })) });
  if (url === '/p/mawid/api/v1/studio/design-systems') return json({ designSystems: [], default: null });
  if (url === '/p/mawid/api/v1/studio/app-picture') return json({ ok: false, why: 'No app.' });
  const m = /^\/p\/mawid\/api\/v1\/studio\/sketches\/([^/]+)(\/chats(?:\/main)?)?$/.exec(url);
  const s = m ? SKETCHES[decodeURIComponent(m[1]!)] : undefined;
  if (!m || !s) return json({ error: 'This project has no sketch.' }, 404);
  if (m[2] === '/chats') return json({ conversations: [], current: 'main' });
  if (m[2] === '/chats/main') return json({ id: 'main', owner: { kind: 'sketch', id: s.id, name: s.name }, startedAt: null, messages: [], working: null });
  return json(s);
}

let root: { render(n: unknown): void; unmount(): void } | null = null;
async function open(at = '/studio') {
  await close();
  root = createRoot(page.getElementById('root'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const top = Router.createRootRoute();
  const studio = Router.createRoute({ getParentRoute: () => top, path: '/studio', component: () => h(StudioPage, { project: 'mawid' }) });
  const sketch = Router.createRoute({ getParentRoute: () => top, path: '/studio/sketches/$id', component: SketchWorkspacePage });
  const router = Router.createRouter({ routeTree: top.addChildren([studio, sketch]), history: Router.createMemoryHistory({ initialEntries: [at] }) });
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
const all = (sel: string, inside: any = page) => [...inside.querySelectorAll(sel)] as any[];
const dialog = () => page.querySelector('[role="dialog"]') as any;
async function press(el: any) {
  await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await settle();
}
const items = () => all('[role="menuitem"]');
const item = (text: string) => items().find((b) => b.textContent.trim().startsWith(text));
const rowOf = (text: string) => all('label.xp-row', dialog()).find((l) => l.textContent.includes(text));
const boxOf = (text: string) => rowOf(text)?.querySelector('input');
const ticked = () => all('.xp-screens label', dialog()).filter((l) => l.querySelector('input').checked).map((l) => l.querySelector('.xp-name').textContent);
const exportButton = () => [...dialog().querySelectorAll('button')].find((b: any) => b.textContent.trim() === 'Export') as any;
async function openMenu(at: string) {
  await open(at);
  await press(page.querySelector(`[aria-label^="More actions for"]`));
}

beforeEach(() => {
  dom.window.sessionStorage.clear();
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  exports = [];
  others = [];
  release = null;
  hold = false;
  downloads = [];
  const spy = vi.fn(async (url: string, init?: RequestInit) => fakeServer(url, init));
  vi.stubGlobal('fetch', spy);
  dom.window.fetch = spy;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:pdf');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  dom.window.HTMLAnchorElement.prototype.click = function (this: any) {
    downloads.push({ name: this.download, size: 4 });
  };
});
afterEach(close);

describe('done when 1: the sketch\'s menu has an Export group', () => {
  it('lists "Export sketch to PDF" on, and PNG, JPG, SVG and HTML off with "Future", in the header and on the card', async () => {
    for (const at of ['/studio/sketches/booking', '/studio']) {
      await openMenu(at);
      expect(page.querySelector('[role="group"][aria-label="Export"]')).not.toBeNull();
      expect(item('Export sketch to PDF').disabled).toBe(false);
      for (const kind of ['PNG', 'JPG', 'SVG', 'HTML']) {
        const b = item(kind);
        expect(b.textContent.trim()).toBe(`${kind}Future`);
        expect(b.querySelector('.sk-future').textContent).toBe('Future');
        expect(b.disabled).toBe(true);
        expect(b.getAttribute('aria-disabled')).toBe('true');
      }
      expect(items().map((b) => b.textContent.trim())).toEqual(['Rename…', 'Duplicate', 'Export sketch to PDF', 'PNGFuture', 'JPGFuture', 'SVGFuture', 'HTMLFuture', 'Delete…']);
    }
  });

  it('does nothing when a Future choice is clicked: no window, no request', async () => {
    await openMenu('/studio/sketches/booking');
    for (const kind of ['PNG', 'JPG', 'SVG', 'HTML']) await press(item(kind));
    expect(dialog()).toBeNull();
    expect(exports).toEqual([]);
    expect(others).toEqual([]);
  });
});

describe('done when 2: All screens, the busy state and the download', () => {
  it('asks All screens or Approved screens only, ticks every drawn screen, marks Form as Draft and leaves "New screen" off', async () => {
    await openMenu('/studio/sketches/booking');
    await press(item('Export sketch to PDF'));
    expect(dialog().getAttribute('aria-label')).toBe('Export sketch to PDF');
    expect(boxOf('All screens').checked).toBe(true);
    expect(boxOf('Approved screens only').disabled).toBe(false);
    expect(all('legend', dialog()).map((l) => l.textContent)).toEqual(['Frames', 'Screens']);
    expect(boxOf('Desktop').checked && boxOf('Mobile').checked).toBe(true);
    expect(ticked()).toEqual(['Home', 'Form']);
    expect(rowOf('Form').querySelector('.xp-draft').textContent).toBe('Draft');
    expect(rowOf('Home').querySelector('.xp-draft')).toBeNull();
    expect(boxOf('New screen').disabled).toBe(true);
    expect(rowOf('New screen').querySelector('.xp-note').textContent).toBe('Not drawn yet');
    expect(boxOf('Include all variants of draft screens').checked).toBe(false);
    expect(boxOf('Select all').checked).toBe(true);
  });

  it('shows "Making the PDF…" while the PDF is made, cannot start it again, then downloads "Booking.pdf"', async () => {
    hold = true;
    await openMenu('/studio/sketches/booking');
    await press(item('Export sketch to PDF'));
    await press(exportButton());
    expect(dialog()).toBeNull();
    expect(exports).toEqual([{ url: '/p/mawid/api/v1/studio/sketches/booking/export/pdf', body: { screens: ['home', 'form'], frames: ['desktop', 'mobile'], allVariants: false } }]);
    expect(page.querySelector('.sk-making').textContent).toBe('Making the PDF…');
    await press(page.querySelector('[aria-label="More actions for Booking"]'));
    const busy = item('Making the PDF…');
    expect(busy.disabled).toBe(true);
    await press(busy);
    expect(dialog()).toBeNull();
    expect(exports).toHaveLength(1);
    expect(downloads).toEqual([]);
    await act(async () => release!());
    await settle();
    expect(downloads).toEqual([{ name: 'Booking.pdf', size: 4 }]);
    expect(page.querySelector('.sk-making')).toBeNull();
    // Nothing else was asked of the server: nothing saved, nothing added to the chat.
    expect(others).toEqual([]);
  });

  it('sends "Include all variants of draft screens" when it is ticked', async () => {
    await openMenu('/studio/sketches/booking');
    await press(item('Export sketch to PDF'));
    await press(boxOf('Include all variants of draft screens'));
    await press(exportButton());
    expect(exports[0]!.body).toEqual({ screens: ['home', 'form'], frames: ['desktop', 'mobile'], allVariants: true });
  });
});

describe('done when 3: Approved screens only, and a sketch with none approved', () => {
  it('ticks only Home for Booking\'s "Approved screens only"', async () => {
    await openMenu('/studio/sketches/booking');
    await press(item('Export sketch to PDF'));
    await press(boxOf('Approved screens only'));
    expect(ticked()).toEqual(['Home']);
    await press(exportButton());
    expect(exports[0]!.body).toEqual({ screens: ['home'], frames: ['desktop', 'mobile'], allVariants: false });
  });

  it('turns "Approved screens only" off for Login, with "No approved screens yet"', async () => {
    await openMenu('/studio/sketches/login');
    await press(item('Export sketch to PDF'));
    expect(boxOf('Approved screens only').disabled).toBe(true);
    expect(rowOf('Approved screens only').querySelector('.xp-note').textContent).toBe('No approved screens yet');
  });

  it('keeps Export off with no screen ticked, and keeps the last frame ticked', async () => {
    await openMenu('/studio/sketches/booking');
    await press(item('Export sketch to PDF'));
    await press(boxOf('Select all'));
    expect(ticked()).toEqual([]);
    expect(exportButton().disabled).toBe(true);
    await press(boxOf('Form'));
    expect(boxOf('Select all').indeterminate).toBe(true);
    expect(exportButton().disabled).toBe(false);
    await press(boxOf('Desktop'));
    await press(boxOf('Mobile'));
    expect(boxOf('Desktop').checked).toBe(false);
    expect(boxOf('Mobile').checked).toBe(true);
    await press(exportButton());
    expect(exports[0]!.body).toEqual({ screens: ['form'], frames: ['mobile'], allVariants: false });
  });
});

describe('done when 5: an Arabic sketch downloads as "الحجز.pdf"', () => {
  it('names the download after the sketch, in Arabic', async () => {
    await openMenu('/studio/sketches/arabic-booking');
    await press(item('Export sketch to PDF'));
    expect(rowOf('نموذج الحجز').querySelector('.xp-name').getAttribute('dir')).toBe('auto');
    await press(exportButton());
    expect(downloads).toEqual([{ name: 'الحجز.pdf', size: 4 }]);
  });
});

describe('the board helpers', () => {
  const screens = SKETCHES.booking.screens;
  it('tick every drawn screen for All screens and the approved ones for Approved screens only', () => {
    expect(X.ticksFor('all', screens)).toEqual(['home', 'form']);
    expect(X.ticksFor('approved', screens)).toEqual(['home']);
    expect(X.hasApprovedScreens(screens)).toBe(true);
    expect(X.hasApprovedScreens(SKETCHES.login.screens)).toBe(false);
    expect(X.isDrawn(screens[2])).toBe(false);
  });

  it('give Select all three states, skipping screens with no drawing', () => {
    expect(X.selectAllState(screens, ['home', 'form'])).toBe('all');
    expect(X.selectAllState(screens, ['form'])).toBe('some');
    expect(X.selectAllState(screens, [])).toBe('none');
    expect(X.toggleAll(screens, ['form'])).toEqual(['home', 'form']);
    expect(X.toggleAll(screens, ['home', 'form'])).toEqual([]);
    expect(X.toggleScreen(screens, ['form'], 'new-screen')).toEqual(['form']);
    expect(X.toggleScreen(screens, ['form'], 'home')).toEqual(['home', 'form']);
  });

  it('keep Export off with nothing ticked, and the last frame ticked', () => {
    expect(X.canExport([], ['desktop'])).toBe(false);
    expect(X.canExport(['home'], [])).toBe(false);
    expect(X.canExport(['home'], ['desktop'])).toBe(true);
    expect(X.canExport(['home'], ['desktop'], true)).toBe(false);
    expect(X.toggleFrame(['desktop', 'mobile'], ['desktop'], 'desktop')).toEqual(['desktop']);
    expect(X.toggleFrame(['desktop', 'mobile'], ['mobile'], 'desktop')).toEqual(['desktop', 'mobile']);
    expect(X.toggleFrame(['desktop', 'mobile'], ['desktop', 'mobile'], 'mobile')).toEqual(['desktop']);
  });

  it('make safe file names and send the variants choice', () => {
    expect(X.pdfFileName('Booking')).toBe('Booking.pdf');
    expect(X.pdfFileName('الحجز')).toBe('الحجز.pdf');
    expect(X.pdfFileName('Booking / v2: "final"?')).toBe('Booking - v2- -final--.pdf');
    expect(X.pdfFileName('   ')).toBe('Sketch.pdf');
    expect(X.exportBody(screens, ['form', 'home'], ['desktop'], true)).toEqual({ screens: ['home', 'form'], frames: ['desktop'], allVariants: true });
    expect(X.exportPdfPath('arabic-booking')).toBe('/api/v1/studio/sketches/arabic-booking/export/pdf');
  });
});
