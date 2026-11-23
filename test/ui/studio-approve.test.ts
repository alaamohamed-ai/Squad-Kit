import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * US-15 Approve and reopen a screen (AB-140), on the board: "Approve screen" in the workspace's header sends the stamp
 * the page read and the conversation open in the chat; the screen then shows Approved with a lock and "Approved by
 * Alaa · time", its "Use this one" and its tab's Delete are off, and the chat says the AI Designer leaves it. Reopen
 * asks "Are you sure?" first: Cancel sends nothing and Form stays Approved. Real React in a jsdom page, with the board
 * server answered by the test.
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
vi.stubGlobal('FileReader', dom.window.FileReader);

const React = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/react/index.js', import.meta.url).pathname)) as { createElement(...a: unknown[]): unknown; act(fn: () => unknown): Promise<void> };
const { createRoot } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/react-dom/client.js', import.meta.url).pathname)) as unknown as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
const { QueryClient, QueryClientProvider } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/@tanstack/react-query/build/modern/index.js', import.meta.url).pathname)) as { QueryClient: new (o: object) => unknown; QueryClientProvider: unknown };
const Router = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/@tanstack/react-router/dist/esm/index.js', import.meta.url).pathname)) as any;
const { act } = React;
const board = (file: string) => import(/* @vite-ignore */ new URL(`../../console-ui/${file}`, import.meta.url).pathname);
const { SketchWorkspacePage } = await board('src/pages/studio/SketchWorkspace.tsx');
const h = React.createElement;

const BASE = '/p/mawid/api/v1/studio';
const html = (words: string) => `<!doctype html><html><body><button>${words}</button></body></html>`;
const variant = (version: number, letter: string, name: string) => ({ version, frames: ['desktop'], ask: 'ask-1', letter, name, idea: `${name}.`, html: { desktop: html(name) } });
const AT = '2026-11-23T14:05:00.000Z';

/** Booking's Form at v3 (A, B and A again), and Confirmation; Form is approved or not. */
const sketchWith = (approved: boolean, stamp: string) => ({
  id: 'booking',
  name: 'Booking',
  designSystem: { id: 'patient-app', version: 1, name: 'Patient app' },
  frames: ['desktop'],
  stamp,
  screens: [
    { id: 'form', name: 'Form', order: 1, status: approved ? 'approved' : 'draft', chosen: 3, ...(approved ? { approved: { version: 3, at: AT, by: 'Alaa' } } : {}), variants: [variant(1, 'A', 'One page'), variant(2, 'B', 'Step by step'), variant(3, 'A', 'One page')] },
    { id: 'confirmation', name: 'Confirmation', order: 2, status: 'draft', chosen: 1, variants: [{ version: 1, frames: ['desktop'], html: { desktop: html('Done') } }] },
  ],
});

let root: { render(n: unknown): void; unmount(): void } | null = null;
let changes: { method: string; url: string; body: any }[];
let sketch: ReturnType<typeof sketchWith>;
let conversation: { messages: any[]; working: { doing: string; since: string } | null };

async function open() {
  if (root) await act(async () => root!.unmount());
  root = createRoot(page.getElementById('root'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const top = Router.createRootRoute();
  const ws = Router.createRoute({ getParentRoute: () => top, path: '/studio/sketches/$id', component: SketchWorkspacePage });
  const router = Router.createRouter({ routeTree: top.addChildren([ws]), history: Router.createMemoryHistory({ initialEntries: ['/studio/sketches/booking'] }) });
  await act(async () => root!.render(h(QueryClientProvider, { client }, h(Router.RouterProvider, { router }))));
  await until(() => !!page.querySelector('.vc-card') && !!page.querySelector('.ws-approval') && !!page.querySelector('.dc-msg, .dc-empty, .dc-working, .dc-line'));
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const press = async (el: any) => {
  await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
};
const button = (name: string, within: any = page) => [...within.querySelectorAll('button')].find((b: any) => b.textContent.replace(/\s+/g, ' ').trim() === name) as any;
/** The header's approval part, piece by piece: the status, who approved it and when, and the button. */
const approval = () =>
  [...page.querySelector('.ws-approval').children]
    .map((el: any) => el.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');

beforeEach(() => {
  dom.window.sessionStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  changes = [];
  sketch = sketchWith(false, 'stamp-1');
  conversation = { messages: [{ role: 'person', text: 'Draw 2 variants of the Form screen', pictures: [] }], working: null };
  const fetchSpy = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (method !== 'GET') changes.push({ method, url, body });
    const view = () => ({ id: 'main', owner: { kind: 'sketch', id: 'booking', name: 'Booking' }, startedAt: null, ...conversation });
    if (method === 'GET' && url === `${BASE}/sketches/booking`) return json(sketch);
    if (method === 'GET' && url === `${BASE}/sketches/booking/chats`) return json({ conversations: [{ id: 'main', startedAt: null, messages: conversation.messages.length, first: 'Draw 2 variants', lastAt: null }], current: 'main' });
    if (method === 'GET' && url === `${BASE}/sketches/booking/chats/main`) return json(view());
    for (const what of ['approve', 'reopen'] as const) {
      if (method === 'POST' && url === `${BASE}/sketches/booking/screens/form/${what}`) {
        sketch = sketchWith(what === 'approve', `stamp-${what}d`);
        const done = { screen: 'form', screenName: 'Form', version: 3, at: AT, by: 'Alaa', ...(what === 'reopen' ? { reopened: true } : {}) };
        const text = what === 'approve' ? 'Alaa approved Form at v3' : 'Alaa reopened Form';
        conversation = { ...conversation, messages: [...conversation.messages, { role: 'action', text, at: AT, approval: done, pictures: [] }] };
        return json({ sketch, done, conversation: view() });
      }
    }
    throw new Error(`The page must not call ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchSpy);
  dom.window.fetch = fetchSpy;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

describe('Approve screen in the workspace', () => {
  it('done when 1: sends the stamp and the conversation; Form shows Approved with a lock, "Approved by Alaa · time", still v3, and the chat line', async () => {
    await open();
    expect(approval()).toBe('Draft Approve screen');
    await press(button('Approve screen'));
    expect(changes).toEqual([{ method: 'POST', url: `${BASE}/sketches/booking/screens/form/approve`, body: { stamp: 'stamp-1', chat: 'main' } }]);
    await until(() => approval().startsWith('Approved'));
    expect(approval()).toMatch(/^Approved Approved by Alaa · .+ Reopen$/);
    expect(page.querySelector('.ws-status.approved svg')).not.toBeNull();
    expect(page.querySelector('.ws-version').textContent).toBe('v3');
    expect(page.querySelector('.ws-version.locked')).not.toBeNull();
    await until(() => !!page.querySelector('.dc-line'));
    expect(page.querySelector('.dc-msgs .dc-line span').textContent).toBe('Alaa approved Form at v3');
  });

  it('done when 2: an approved Form has "Use this one" and its tab\'s Delete off, and the chat says the AI Designer leaves it', async () => {
    sketch = sketchWith(true, 'stamp-1');
    await open();
    const uses = [...page.querySelectorAll('.vc-use')] as any[];
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((b) => b.disabled && b.title === 'Form is approved. Reopen it first.')).toBe(true);
    const del = page.querySelector('[aria-label="Delete Form"]') as any;
    expect(del.disabled).toBe(true);
    expect((page.querySelector('[aria-label="Delete Confirmation"]') as any).disabled).toBe(false);
    expect(page.querySelector('.dc-locked').textContent).toBe('Form is approved: the AI Designer leaves it as it is. Reopen it first to change it.');
    expect(changes).toEqual([]);
  });
});

describe('Reopen asks "Are you sure?" first', () => {
  it('done when 4: Cancel sends nothing and Form stays Approved; Reopen sends the stamp, and Form is Draft again with the line', async () => {
    sketch = sketchWith(true, 'stamp-1');
    await open();
    await press(button('Reopen'));
    const dialog = page.querySelector('[role="dialog"]');
    expect(dialog.getAttribute('aria-label')).toBe('Reopen "Form"?');
    expect(dialog.textContent).toContain('Are you sure? Form goes back to Draft and its lock goes away. The next change makes a new version; v3 stays.');
    await press(button('Cancel', dialog));
    expect(page.querySelector('[role="dialog"]')).toBeNull();
    expect(changes).toEqual([]);
    expect(approval()).toMatch(/^Approved /);

    await press(button('Reopen'));
    await press(button('Reopen', page.querySelector('[role="dialog"]')));
    expect(changes).toEqual([{ method: 'POST', url: `${BASE}/sketches/booking/screens/form/reopen`, body: { stamp: 'stamp-1', chat: 'main' } }]);
    await until(() => approval() === 'Draft Approve screen');
    expect(page.querySelector('[role="dialog"]')).toBeNull();
    expect(page.querySelector('.dc-locked')).toBeNull();
    expect((page.querySelector('[aria-label="Delete Form"]') as any).disabled).toBe(false);
    await until(() => !!page.querySelector('.dc-line'));
    expect(page.querySelector('.dc-msgs .dc-line span').textContent).toBe('Alaa reopened Form');
  });
});
