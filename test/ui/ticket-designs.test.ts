import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * US-55, done when 1 as the person chose it: approved screens are picked only in the design step before the spec. Its
 * card on the Now tab lists the approved screens the server sends ("Booking / Form") with a small picture, to tick, with
 * "Use these designs" and "No design". The Story tab has no picker of its own: it shows the picked screens as cards,
 * with their picture, their frames (Desktop, Mobile) and Remove, and Remove is gone once the build has started. Real
 * React in a jsdom page, with the board server answered by the test. That the server lists approved screens only, and
 * refuses changes once the build has started, is in test/ticket-designs.test.ts.
 */

const file = (f: string) => new URL(`../../console-ui/${f}`, import.meta.url).pathname;
const { JSDOM } = (await import(/* @vite-ignore */ file('node_modules/jsdom/lib/api.js'))) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/mawid/board', pretendToBeVisual: true });
const page = dom.window.document;
dom.window.scrollTo = () => undefined;
const globals = () => {
  vi.stubGlobal('self', dom.window);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('sessionStorage', dom.window.sessionStorage);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
};
globals();

const React = (await import(/* @vite-ignore */ file('node_modules/react/index.js'))) as { createElement(...a: unknown[]): unknown; act(fn: () => unknown): Promise<void> };
const { createRoot } = (await import(/* @vite-ignore */ file('node_modules/react-dom/client.js'))) as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
const { QueryClient, QueryClientProvider } = await import(/* @vite-ignore */ file('node_modules/@tanstack/react-query/build/modern/index.js'));
const { RouterProvider, createRouter, createRootRoute, createMemoryHistory, createRoute } = await import(/* @vite-ignore */ file('node_modules/@tanstack/react-router/dist/esm/index.js'));
const { PrefsProvider } = await import(/* @vite-ignore */ file('src/lib/prefs.tsx'));
const { DesignAskCard } = await import(/* @vite-ignore */ file('src/pages/drawer/DesignAsk.tsx'));
const { TicketDesigns } = await import(/* @vite-ignore */ file('src/pages/drawer/TicketDesigns.tsx'));
const { act } = React;
const h = React.createElement;

const BASE = '/p/mawid/api/v1/tickets/SK-9/designs';
const html = (words: string) => `<!doctype html><html><body><h1>${words}</h1></body></html>`;
const FORM = { sketch: 'booking', screen: 'form', name: 'Booking / Form', version: 2, frames: ['desktop', 'mobile'], html: { desktop: html('Form, wide'), mobile: html('Form, small') } };
const ticket = (more: object = {}) => ({ id: 'SK-9', title: 'Book a visit', ask: 'People book a visit online.', stage: 'specs', live: false, activity: [], waiting: null, ...more });

let root: { render(n: unknown): void; unmount(): void };
let sent: { method: string; url: string; body: any }[];
/** What the board server holds: the ticket's picked screens, and whether its build has started. */
let held: { locked: boolean; designs: (typeof FORM)[] };

async function show(node: () => unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const top = createRootRoute();
  const route = createRoute({ getParentRoute: () => top, path: '/', component: node });
  const router = createRouter({ routeTree: top.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  await act(async () => root.render(h(QueryClientProvider, { client }, h(PrefsProvider, null, h(RouterProvider, { router })))));
  await settle();
}
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await act(async () => new Promise((r) => dom.window.setTimeout(r, 5)));
};
const buttons = () => [...page.querySelectorAll('button')].map((b: any) => b.textContent.trim());
const button = (name: string) => [...page.querySelectorAll('button')].find((b: any) => b.textContent.trim() === name) as any;
const press = async (el: any) => {
  await act(async () => el.click());
  await settle();
};

beforeEach(() => {
  globals();
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  sent = [];
  held = { locked: false, designs: [] };
  const fetchSpy = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    const path = String(url).split('?')[0]!;
    if (method !== 'GET') sent.push({ method, url: path, body: init.body ? JSON.parse(String(init.body)) : null });
    // The server lists approved screens only: "Booking / Summary" is a draft, so it is not sent.
    if (method === 'GET' && path === `${BASE}/approved`) return json({ locked: held.locked, screens: [{ ...FORM, picked: false }] });
    if (method === 'GET' && path === BASE) return json(held);
    if (method === 'POST' && path === `${BASE}/answer`) {
      held = { locked: false, designs: [FORM] };
      return json(held);
    }
    if (method === 'DELETE' && path === `${BASE}/booking/form`) {
      held = { locked: false, designs: [] };
      return json(held);
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchSpy);
  dom.window.fetch = fetchSpy;
  root = createRoot(page.getElementById('root'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  globals();
});

describe('done when 1: the approved screens are picked in the design step, and show on the Story tab', () => {
  it('the design step lists "Booking / Form" with a small picture; ticking it and "Use these designs" picks it', async () => {
    await show(() => h(DesignAskCard, { t: ticket({ waiting: { kind: 'design', summary: 'Does this ticket follow a design from the Studio?' } }) }));
    expect(page.body.textContent).toContain('Does this ticket follow a design from the Studio?');
    const options = [...page.querySelectorAll('.td-option')] as any[];
    expect(options.map((o) => o.querySelector('.td-name').textContent)).toEqual(['Booking / Form']);
    expect(page.body.textContent).not.toContain('Booking / Summary');
    // The small picture: the approved version's own page, sealed, with no scripts.
    const picture = options[0].querySelector('iframe');
    expect(picture.getAttribute('sandbox')).toBe('');
    expect(picture.getAttribute('srcdoc')).toContain('Form, wide');
    expect(buttons()).toEqual(expect.arrayContaining(['Use these designs', 'No design']));
    // Nothing ticked yet: "Use these designs" waits for a tick.
    expect(button('Use these designs').disabled).toBe(true);
    await act(async () => options[0].querySelector('input[type=checkbox]').click());
    expect(button('Use these designs').disabled).toBe(false);
    await press(button('Use these designs'));
    expect(sent).toEqual([{ method: 'POST', url: `${BASE}/answer`, body: { picks: [{ sketch: 'booking', screen: 'form' }] } }]);
  });

  it('"No design" answers with no screen', async () => {
    await show(() => h(DesignAskCard, { t: ticket({ waiting: { kind: 'design', summary: 'Does this ticket follow a design from the Studio?' } }) }));
    await press(button('No design'));
    expect(sent).toEqual([{ method: 'POST', url: `${BASE}/answer`, body: { none: true } }]);
  });

  it('the Story tab shows the picked screen with its picture, its frames and Remove, and has no picker of its own', async () => {
    held = { locked: false, designs: [FORM] };
    await show(() => h(TicketDesigns, { t: ticket() }));
    const card = page.querySelector('.td-card') as any;
    expect(card.querySelector('.td-name').textContent).toBe('Booking / Form');
    expect([...card.querySelectorAll('.td-frame')].map((f: any) => f.textContent)).toEqual(['Desktop', 'Mobile']);
    expect(card.querySelector('iframe').getAttribute('srcdoc')).toContain('Form, wide');
    expect(page.body.textContent).not.toContain('Add a design from the Studio');
    expect(buttons()).toEqual(['Remove']);
    await press(button('Remove'));
    expect(sent).toEqual([{ method: 'DELETE', url: `${BASE}/booking/form`, body: {} }]);
  });

  it('once the build has started, the Story tab still shows the screen, and Remove is gone', async () => {
    held = { locked: true, designs: [FORM] };
    await show(() => h(TicketDesigns, { t: ticket({ stage: 'implement' }) }));
    expect(page.querySelector('.td-card .td-name').textContent).toBe('Booking / Form');
    expect(buttons()).toEqual([]);
  });

  it('a ticket with no picked screen shows nothing on the Story tab', async () => {
    await show(() => h(TicketDesigns, { t: ticket() }));
    expect(page.querySelector('.td')).toBeNull();
    expect(buttons()).toEqual([]);
  });
});
