import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * US-18 Pick a variant (AB-143), on the board: the card in use says "Using this one", every other card "Not chosen"
 * beside its own "Use this one". A pick sends the stamp the page read and the conversation open in the chat; the chat
 * then shows its short line between the messages. A refusal shows "Changed elsewhere, reload" and keeps the pick in
 * use; the buttons wait while the AI Designer works. Real React in a jsdom page, with the board server answered by the
 * test.
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

/** Booking's Form with A "One page" (v1) and B "Step by step" (v2); `chosen` is the one in use. */
const sketchWith = (chosen: number, stamp: string) => ({
  id: 'booking',
  name: 'Booking',
  designSystem: { id: 'patient-app', version: 1, name: 'Patient app' },
  frames: ['desktop'],
  stamp,
  screens: [{ id: 'form', name: 'Form', order: 1, status: 'draft', chosen, variants: [variant(1, 'A', 'One page'), variant(2, 'B', 'Step by step')] }],
});

let root: { render(n: unknown): void; unmount(): void } | null = null;
let changes: { method: string; url: string; body: any }[];
let sketch: ReturnType<typeof sketchWith>;
let conversation: { messages: any[]; working: { doing: string; since: string } | null };
/** The board server refuses the next pick as stale. */
let stale: boolean;

async function open() {
  if (root) await act(async () => root!.unmount());
  root = createRoot(page.getElementById('root'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const top = Router.createRootRoute();
  const ws = Router.createRoute({ getParentRoute: () => top, path: '/studio/sketches/$id', component: SketchWorkspacePage });
  const router = Router.createRouter({ routeTree: top.addChildren([ws]), history: Router.createMemoryHistory({ initialEntries: ['/studio/sketches/booking'] }) });
  await act(async () => root!.render(h(QueryClientProvider, { client }, h(Router.RouterProvider, { router }))));
  await until(() => !!page.querySelector('.vc-card') && !!page.querySelector('.dc-msg, .dc-empty, .dc-working, .dc-line'));
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const card = (letter: string) => [...page.querySelectorAll('.vc-card')].find((c: any) => c.getAttribute('aria-label').startsWith(`Variant ${letter} `)) as any;
/** A card's header, part by part: its name, then "Using this one", or "Not chosen" and its button. */
const cardText = (letter: string) =>
  [...card(letter).querySelector('.vc-head').children]
    .map((el: any) => el.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
const press = async (el: any) => {
  await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
};

beforeEach(() => {
  dom.window.sessionStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  changes = [];
  sketch = sketchWith(1, 'stamp-1');
  conversation = { messages: [{ role: 'person', text: 'Draw 2 variants of the Form screen', pictures: [] }, { role: 'designer', kind: 'changed', text: 'Done. 2 variants of Form are drawn.', pictures: [] }], working: null };
  stale = false;
  const fetchSpy = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (method !== 'GET') changes.push({ method, url, body });
    const view = () => ({ id: 'main', owner: { kind: 'sketch', id: 'booking', name: 'Booking' }, startedAt: null, ...conversation });
    if (method === 'GET' && url === `${BASE}/sketches/booking`) return json(sketch);
    if (method === 'GET' && url === `${BASE}/sketches/booking/chats`) return json({ conversations: [{ id: 'main', startedAt: null, messages: conversation.messages.length, first: 'Draw 2 variants', lastAt: null }], current: 'main' });
    if (method === 'GET' && url === `${BASE}/sketches/booking/chats/main`) return json(view());
    if (method === 'POST' && url === `${BASE}/sketches/booking/screens/form/pick`) {
      if (stale) return json({ error: 'Changed elsewhere, reload', changedElsewhere: true }, 409);
      const v = sketch.screens[0]!.variants.find((x) => x.version === body.version)!;
      sketch = sketchWith(body.version, `stamp-${body.version}-after`);
      const picked = { screen: 'form', screenName: 'Form', version: v.version, letter: v.letter, name: v.name, at: '2026-11-19T14:10:00.000Z', by: 'Alaa' };
      conversation = { ...conversation, messages: [...conversation.messages, { role: 'action', text: `You picked Variant ${v.letter} · ${v.name}`, at: picked.at, picked, pictures: [] }] };
      return json({ sketch, picked, conversation: view() });
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

describe('"Use this one" on the variant cards', () => {
  it('done when 1: B becomes "Using this one"; A stays, "Not chosen", with its own button; the chat shows the line', async () => {
    await open();
    expect(cardText('A')).toBe('Variant A · One page Using this one');
    expect(cardText('B')).toBe('Variant B · Step by step Not chosen Use this one');
    await press(card('B').querySelector('.vc-use'));
    // The stamp the page read, and the conversation open beside the cards.
    expect(changes).toEqual([{ method: 'POST', url: `${BASE}/sketches/booking/screens/form/pick`, body: { version: 2, stamp: 'stamp-1', chat: 'main' } }]);
    await until(() => cardText('B').includes('Using this one'));
    expect(cardText('B')).toBe('Variant B · Step by step Using this one');
    expect(cardText('A')).toBe('Variant A · One page Not chosen Use this one');
    expect(page.querySelectorAll('.vc-card')).toHaveLength(2);
    await until(() => !!page.querySelector('.dc-line'));
    const line = page.querySelector('.dc-msgs .dc-line');
    expect(line.querySelector('span').textContent).toBe('You picked Variant B · Step by step');
    // Between the messages, as the last line of the conversation.
    expect([...page.querySelectorAll('.dc-msgs > li:not(.dc-end)')].map((l: any) => l.className.split(' ')[0])).toEqual(['dc-msg', 'dc-msg', 'dc-line']);
  });

  it('done when 3: picking A again sends the new stamp, puts A back in use and adds a second line', async () => {
    await open();
    await press(card('B').querySelector('.vc-use'));
    await until(() => cardText('B').includes('Using this one'));
    await press(card('A').querySelector('.vc-use'));
    expect(changes[1]).toEqual({ method: 'POST', url: `${BASE}/sketches/booking/screens/form/pick`, body: { version: 1, stamp: 'stamp-2-after', chat: 'main' } });
    await until(() => cardText('A').includes('Using this one'));
    expect(cardText('B')).toBe('Variant B · Step by step Not chosen Use this one');
    await until(() => page.querySelectorAll('.dc-line').length === 2);
    expect([...page.querySelectorAll('.dc-line span')].map((s: any) => s.textContent)).toEqual(['You picked Variant B · Step by step', 'You picked Variant A · One page']);
  });

  it('done when 5: a refused pick shows "Changed elsewhere, reload", keeps A in use and adds no line', async () => {
    stale = true;
    await open();
    await press(card('B').querySelector('.vc-use'));
    await until(() => !!page.querySelector('.vc-problem'));
    expect(page.querySelector('.vc-problem').textContent).toBe('Changed elsewhere, reload');
    expect(cardText('A')).toBe('Variant A · One page Using this one');
    expect(cardText('B')).toBe('Variant B · Step by step Not chosen Use this one');
    expect(page.querySelector('.dc-line')).toBeNull();
  });

  it('the buttons wait while the AI Designer works', async () => {
    conversation = { messages: [{ role: 'person', text: 'Which one is easier for older patients?', pictures: [] }], working: { doing: 'Reading your message', since: '' } };
    await open();
    await until(() => card('B').querySelector('.vc-use').disabled);
    expect(card('B').querySelector('.vc-use').disabled).toBe(true);
    expect(card('B').querySelector('.vc-use').getAttribute('title')).toBe('Wait for the AI Designer to finish, then pick');
    expect(changes).toEqual([]);
  });

  it('a pick line after an unanswered message still offers "Answer it"', async () => {
    conversation = { messages: [{ role: 'person', text: 'Make it calmer', pictures: [] }, { role: 'action', text: 'You picked Variant B · Step by step', at: '2026-11-19T14:10:00.000Z', picked: { screen: 'form', screenName: 'Form', version: 2, letter: 'B', name: 'Step by step', at: '2026-11-19T14:10:00.000Z' }, pictures: [] }], working: null };
    await open();
    expect(page.querySelector('.dc-unanswered')?.textContent).toContain('Your last message has no answer yet.');
  });
});
