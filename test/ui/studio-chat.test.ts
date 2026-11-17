import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * US-52 Talk with the AI Designer (AB-177), on the board: the chat is always open on the left of a sketch's workspace
 * and of a design system's page, with the Designer's name, what it looks at and whose turn it is; Arabic messages read
 * right to left; while it works, what it is doing and Stop; New conversation; and the screen and frame picked stay in
 * the browser tab. Real React in a jsdom page, with the board server answered by the test.
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
const S = await board('src/lib/studio.ts');
const { SketchWorkspacePage } = await board('src/pages/studio/SketchWorkspace.tsx');
const { DesignSystemPageRoute } = await board('src/pages/studio/DesignSystemPage.tsx');
const h = React.createElement;

const BASE = '/p/mawid/api/v1/studio';
const html = (words: string) => `<!doctype html><html><body><button>${words}</button></body></html>`;

let root: { render(n: unknown): void; unmount(): void } | null = null;
/** Every change the page asked for: method, address and body. */
let changes: { method: string; url: string; body: any }[];
/** The conversation the board server sends back, as the test sets it. */
let conversation: { messages: any[]; working: { doing: string; since: string } | null };
let conversations: { id: string; startedAt: string | null; messages: number; first: string | null; lastAt: string | null }[];

const sketch = {
  id: 'booking',
  name: 'Booking',
  designSystem: { id: 'patient-app', version: 2, name: 'Patient app' },
  frames: ['desktop', 'mobile'],
  stamp: 'stamp-1',
  screens: [
    { id: 'form', name: 'Form', order: 1, status: 'draft', chosen: 1, variants: [{ version: 1, frames: ['desktop', 'mobile'], html: { desktop: html('Book visit'), mobile: html('Book') } }] },
    { id: 'confirmation', name: 'Confirmation', order: 2, status: 'draft', chosen: 1, variants: [{ version: 1, frames: ['desktop'], html: { desktop: html('Done') } }] },
  ],
};

async function open(at: string) {
  await close();
  root = createRoot(page.getElementById('root'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const top = Router.createRootRoute();
  const ws = Router.createRoute({ getParentRoute: () => top, path: '/studio/sketches/$id', component: SketchWorkspacePage });
  const ds = Router.createRoute({ getParentRoute: () => top, path: '/studio/design-systems/$id', component: DesignSystemPageRoute });
  const studio = Router.createRoute({ getParentRoute: () => top, path: '/studio', component: () => null });
  const router = Router.createRouter({ routeTree: top.addChildren([studio, ws, ds]), history: Router.createMemoryHistory({ initialEntries: [at] }) });
  await act(async () => root!.render(h(QueryClientProvider, { client }, h(Router.RouterProvider, { router }))));
  // Open once the conversation is read: its messages, the empty line or the working line show.
  await until(() => !!page.querySelector('.dc-head') && !page.querySelector('h1')?.textContent.includes('…') && !!page.querySelector('.dc-msg, .dc-empty, .dc-working'));
}
async function close() {
  if (root) await act(async () => root!.unmount());
  root = null;
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const text = (sel: string) => page.querySelector(sel)?.textContent?.trim();
const button = (name: string) => [...page.querySelectorAll('button')].find((b: any) => b.textContent.trim() === name || b.getAttribute('aria-label') === name) as any;
const press = async (el: any) => {
  await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
  await until(() => false === false);
};
const type = async (value: string) => {
  const box = page.querySelector('.dc-box textarea');
  const set = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    set.call(box, value);
    box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
};

beforeEach(() => {
  dom.window.sessionStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  changes = [];
  conversation = { messages: [], working: null };
  conversations = [];
  const fetchSpy = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (method !== 'GET') changes.push({ method, url, body });
    if (method === 'GET' && url === `${BASE}/sketches/booking`) return json(sketch);
    if (method === 'GET' && url === `${BASE}/design-systems/patient-app`)
      return json({ id: 'patient-app', name: 'Patient app', isDefault: true, version: 2, stamp: 'ds-1', versions: [{ version: 2, tokens: { color: { primary: '#1f6fb2' } }, components: ['button'], html: { button: html('Go') } }] });
    const chats = /^\/p\/mawid\/api\/v1\/studio\/(sketches|design-systems)\/([a-z-]+)\/chats(?:\/([a-z0-9-]+))?(\/messages|\/stop)?$/.exec(url);
    if (chats) {
      const [, , , chat, action] = chats;
      if (method === 'GET' && !chat) return json({ conversations, current: conversations[0]?.id ?? 'main' });
      if (method === 'POST' && !chat) {
        conversations = [{ id: 'talk-2', startedAt: '2026-11-16T10:00:00Z', messages: 0, first: null, lastAt: null }, ...conversations];
        conversation = { messages: [], working: null };
        return json(conversations[0]);
      }
      if (method === 'GET') return json({ id: chat, owner: { kind: 'sketch', id: 'booking', name: 'Booking' }, startedAt: null, ...conversation });
      if (action === '/messages') {
        conversation = { messages: [...conversation.messages, { role: 'person', text: body.text, pictures: [] }], working: { doing: 'Reading your message', since: '' } };
        return json({ id: chat, owner: { kind: 'sketch', id: 'booking', name: 'Booking' }, startedAt: null, ...conversation });
      }
      if (action === '/stop') return json({ stopped: true });
    }
    throw new Error(`The page must not call ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchSpy);
  dom.window.fetch = fetchSpy;
});
afterEach(close);

describe('the chat on the left of the sketch workspace', () => {
  it("done when 1: shows the AI Designer's name, what it looks at and whose turn it is, beside the chosen screen", async () => {
    await open('/studio/sketches/booking');
    const ws = page.querySelector('.ws');
    expect(ws.firstElementChild.getAttribute('aria-label')).toBe('Chat with the AI Designer');
    expect(text('.dc-who strong')).toBe('AI Designer');
    expect(text('.dc-at')).toBe('Booking / Form, desktop');
    expect(text('.dc-turn')).toBe('Your turn');
    expect(page.querySelector('.ws-frame').getAttribute('srcdoc')).toBe(html('Book visit'));
    expect(page.querySelector('.ws-frame').getAttribute('sandbox')).toBe('');
    expect(page.querySelector('.dc-box textarea').getAttribute('placeholder')).toBe('Ask, or ask for a change…');
  });

  it('picking a screen and a frame changes what it looks at, and the choice stays in this browser tab only', async () => {
    await open('/studio/sketches/booking');
    await press(button('Confirmation'));
    expect(text('.dc-at')).toBe('Booking / Confirmation, desktop');
    await press(button('Form'));
    await press(button('Mobile'));
    expect(text('.dc-at')).toBe('Booking / Form, mobile');
    expect(page.querySelector('.ws-frame').getAttribute('srcdoc')).toBe(html('Book'));
    expect(JSON.parse(dom.window.sessionStorage.getItem(S.workspaceViewKey('mawid', 'booking')))).toEqual({ screen: 'form', frame: 'mobile' });
    expect(changes).toEqual([]);
    await open('/studio/sketches/booking');
    expect(text('.dc-at')).toBe('Booking / Form, mobile');
  });

  it('sends the message with what the person looks at and the stamp read, then shows "Working"', async () => {
    await open('/studio/sketches/booking');
    await type('Why this color?');
    await press(button('Send'));
    expect(changes).toEqual([{ method: 'POST', url: `${BASE}/sketches/booking/chats/main/messages`, body: { text: 'Why this color?', pictures: [], lookingAt: { screen: 'form', frame: 'desktop' }, stamp: 'stamp-1' } }]);
    await until(() => text('.dc-turn') === 'Working');
    expect(text('.dc-turn')).toBe('Working');
    expect(text('.dc-msg.person .dc-text')).toBe('Why this color?');
  });

  it('done when 2: while it works, shows what it is doing and a Stop button; Stop asks the board to stop', async () => {
    conversation = { messages: [{ role: 'person', text: 'Make the buttons bigger', pictures: [] }], working: { doing: 'Changing screen 2 of 2: Confirmation', since: '' } };
    conversations = [{ id: 'main', startedAt: null, messages: 1, first: 'Make the buttons bigger', lastAt: null }];
    await open('/studio/sketches/booking');
    expect(text('.dc-doing')).toBe('Changing screen 2 of 2: Confirmation');
    expect(text('.dc-turn')).toBe('Working');
    expect(button('Send').disabled).toBe(true);
    await press(button('Stop'));
    expect(changes).toEqual([{ method: 'POST', url: `${BASE}/sketches/booking/chats/main/stop`, body: {} }]);
  });

  it('done when 3: Arabic messages and answers read right to left, English left to right, and pictures show in the message', async () => {
    conversation = {
      messages: [
        { role: 'person', text: 'لماذا هذا اللون؟', pictures: ['/api/v1/studio/sketches/booking/chats/main/pictures/main-m1-1.png'] },
        { role: 'designer', kind: 'answer', text: 'الأزرق هادئ وواضح.', pictures: [] },
        { role: 'person', text: 'Why this color?', pictures: [] },
        { role: 'designer', kind: 'answer', text: 'It is calm and clear.', pictures: [] },
      ],
      working: null,
    };
    conversations = [{ id: 'main', startedAt: null, messages: 4, first: 'لماذا هذا اللون؟', lastAt: null }];
    await open('/studio/sketches/booking');
    expect([...page.querySelectorAll('.dc-text')].map((t: any) => t.getAttribute('dir'))).toEqual(['rtl', 'rtl', 'ltr', 'ltr']);
    expect(page.querySelector('.dc-msg.person img').getAttribute('src')).toBe('/p/mawid/api/v1/studio/sketches/booking/chats/main/pictures/main-m1-1.png?t=a-token');
    expect(S.textDir('اجعل الزر أكبر')).toBe('rtl');
    expect(S.textDir('Make it bigger')).toBe('ltr');
  });

  it('done when 4: New conversation starts an empty chat; the old one stays in the list and can be opened again', async () => {
    conversation = { messages: [{ role: 'person', text: 'Make it calmer', pictures: [] }, { role: 'designer', kind: 'changed', text: 'Done.', saved: [{ screen: 'form', name: 'Form', version: 2 }], pictures: [] }], working: null };
    conversations = [{ id: 'main', startedAt: '2026-11-16T09:00:00Z', messages: 2, first: 'Make it calmer', lastAt: null }];
    await open('/studio/sketches/booking');
    expect(text('.dc-saved')).toBe('Form v2');
    await press(button('New conversation'));
    await until(() => !page.querySelector('.dc-msg'));
    expect(changes).toEqual([{ method: 'POST', url: `${BASE}/sketches/booking/chats`, body: {} }]);
    expect(page.querySelectorAll('.dc-msg')).toHaveLength(0);
    expect([...page.querySelectorAll('.dc-convos option')].map((o: any) => o.value)).toEqual(['talk-2', 'main']);
    expect(dom.window.sessionStorage.getItem(S.pickedChatKey('mawid', 'sketch', 'booking'))).toBe('"talk-2"');
  });
});

describe('the chat on the left of the design system page', () => {
  it('done when 1: the same chat is on the left, looking at the design system, with its components beside it', async () => {
    await open('/studio/design-systems/patient-app');
    expect(page.querySelector('.ws').firstElementChild.getAttribute('aria-label')).toBe('Chat with the AI Designer');
    expect(text('.dc-who strong')).toBe('AI Designer');
    expect(text('.dc-at')).toBe('Patient app / version 2');
    expect(text('.dc-turn')).toBe('Your turn');
    expect(page.querySelector('.ds-comps iframe').getAttribute('title')).toBe('button');
    await type('Why this blue?');
    await press(button('Send'));
    expect(changes[0]).toMatchObject({ method: 'POST', url: `${BASE}/design-systems/patient-app/chats/main/messages`, body: { text: 'Why this blue?', stamp: 'ds-1' } });
  });
});
