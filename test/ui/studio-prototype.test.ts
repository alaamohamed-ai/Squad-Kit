import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * US-54 Prototype: link the approved screens (AB-179), on the board. The sketch opens on Screens; "Prototype" beside
 * the frame switch hides the chat and shows the approved screens as cards with their links as arrows, the start screen,
 * the button picker, "Generate the prototype" (asking first before it replaces links) and Play: full size, a click on a
 * linked button goes to its screen, Back goes back, Desktop and Mobile switch, and Esc or Close leave. Arabic screens
 * play right to left. Real React in a jsdom page, with the board server answered by the test.
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
const lib = await board('src/lib/studio-prototype.ts');
const h = React.createElement;

const BASE = '/p/mawid/api/v1/studio';
const marked = (body: string, rtl = false) => `<!doctype html><html${rtl ? ' dir="rtl" lang="ar"' : ''}><head></head><body>${body}</body></html>`;
const btn = (name: string, words = name) => `<button data-sq-button="${name}">${words}</button>`;

/** The Booking sketch as the workspace reads it: Form and Confirm approved, Done a draft. */
const sketchOf = (id: string, name: string) => ({
  id,
  name,
  designSystem: null,
  frames: ['desktop', 'mobile'],
  stamp: 'stamp-1',
  screens: [{ id: 'form', name: 'Form', order: 1, status: 'approved', chosen: 2, approved: { version: 2, at: '2026-11-23T10:00:00Z', by: 'Alaa' }, variants: [{ version: 2, frames: ['desktop', 'mobile'], html: { desktop: marked(btn('Continue')), mobile: marked(btn('Continue')) } }] }],
});

type Proto = any;
const booking = (): Proto => ({
  sketch: { id: 'booking', name: 'Booking', frames: ['desktop', 'mobile'], stamp: 'stamp-1' },
  screens: [
    { id: 'form', name: 'Form', version: 2, rtl: false, frames: { desktop: marked(`<h1>Form desktop</h1>${btn('Continue')}<a data-sq-button="Help">Help</a>`), mobile: marked(`<h1>Form mobile</h1>${btn('Continue')}`) }, buttons: [{ name: 'Continue', kind: 'button', frames: ['desktop', 'mobile'] }, { name: 'Help', kind: 'link', frames: ['desktop'] }] },
    { id: 'confirm', name: 'Confirm', version: 1, rtl: false, frames: { desktop: marked(`<h1>Confirm desktop</h1>${btn('Back', '‹')}${btn('Book visit')}`), mobile: marked(`<h1>Confirm mobile</h1>${btn('Back', '‹')}${btn('Book visit')}`) }, buttons: [{ name: 'Back', kind: 'button', frames: ['desktop', 'mobile'] }, { name: 'Book visit', kind: 'button', frames: ['desktop', 'mobile'] }] },
  ],
  links: [
    { screen: 'form', button: 'Continue', to: { screen: 'confirm' } },
    { screen: 'confirm', button: 'Back', to: { back: true } },
    { screen: 'confirm', button: 'Book visit', to: { screen: 'form' }, broken: 'button-gone', warning: '"Book visit" is gone from Confirm. Pick its new button, or take the link away.' },
  ],
  start: 'form',
  markedStart: null,
  left: [{ id: 'done', name: 'Done' }],
  working: null,
  problem: null,
});
const login = (): Proto => ({ sketch: { id: 'login', name: 'Login', frames: ['desktop'], stamp: 'stamp-l' }, screens: [], links: [], start: null, markedStart: null, left: [{ id: 'sign-in', name: 'Sign in' }], working: null, problem: null });
const arabic = (): Proto => ({
  sketch: { id: 'arabic-booking', name: 'الحجز', frames: ['desktop', 'mobile'], stamp: 'stamp-a' },
  screens: [
    { id: 'booking-form', name: 'نموذج الحجز', version: 1, rtl: true, frames: { desktop: marked(`<h1>نموذج</h1>${btn('احجز الزيارة')}`, true), mobile: marked(`<h1>نموذج</h1>${btn('احجز الزيارة')}`, true) }, buttons: [{ name: 'احجز الزيارة', kind: 'button', frames: ['desktop', 'mobile'] }] },
    { id: 'booking-done', name: 'تأكيد الحجز', version: 1, rtl: true, frames: { desktop: marked(`<h1>تأكيد</h1>${btn('رجوع', '›')}`, true), mobile: marked(`<h1>تأكيد</h1>${btn('رجوع', '›')}`, true) }, buttons: [{ name: 'رجوع', kind: 'button', frames: ['desktop', 'mobile'] }] },
  ],
  links: [
    { screen: 'booking-form', button: 'احجز الزيارة', to: { screen: 'booking-done' } },
    { screen: 'booking-done', button: 'رجوع', to: { back: true } },
  ],
  start: 'booking-form',
  markedStart: null,
  left: [],
  working: null,
  problem: null,
});

let root: { render(n: unknown): void; unmount(): void } | null = null;
let changes: { method: string; url: string; body: any }[];
let protos: Record<string, Proto>;
/** What the next GET of a prototype answers, once: Generate working, then done. */
let next: Proto[];

async function open(id = 'booking') {
  if (root) await act(async () => root!.unmount());
  root = createRoot(page.getElementById('root'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const top = Router.createRootRoute();
  const ws = Router.createRoute({ getParentRoute: () => top, path: '/studio/sketches/$id', component: SketchWorkspacePage });
  const router = Router.createRouter({ routeTree: top.addChildren([ws]), history: Router.createMemoryHistory({ initialEntries: [`/studio/sketches/${id}`] }) });
  await act(async () => root!.render(h(QueryClientProvider, { client }, h(Router.RouterProvider, { router }))));
  await until(() => !!tab('Prototype'));
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const press = async (el: any) => {
  await act(async () => el.dispatchEvent(new (el.ownerDocument.defaultView.MouseEvent)('click', { bubbles: true, cancelable: true, button: 0 })));
};
const text = (el: any) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const button = (name: string, within: any = page) => [...within.querySelectorAll('button')].find((b: any) => text(b) === name) as any;
const tab = (name: string) => [...page.querySelectorAll('[role="tab"]')].find((b: any) => text(b) === name) as any;
const cards = () => [...page.querySelectorAll('.pt-card')] as any[];
/** A card's head, piece by piece: its name, version and the start mark or button. */
const head = (card: any) => [...card.querySelector('.pt-card-head').children].map(text).filter(Boolean).join(' ');
const picker = (label: string) => page.querySelector(`select[aria-label="${label}"]`) as any;
const choose = async (el: any, value: string) => {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
};
const play = () => page.querySelector('.pp') as any;
const playFrame = () => play()?.querySelector('iframe') as any;
const inFrame = (frame: any, name: string) => frame?.contentDocument?.querySelector(`[data-sq-button="${name}"]`);
const key = async (k: string) => {
  await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true })));
};

beforeEach(() => {
  dom.window.sessionStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  changes = [];
  next = [];
  protos = { booking: booking(), login: login(), 'arabic-booking': arabic() };
  const fetchSpy = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (method !== 'GET') changes.push({ method, url, body });
    const m = /^\/p\/mawid\/api\/v1\/studio\/sketches\/([^/]+)(\/.*)?$/.exec(url);
    const id = m ? decodeURIComponent(m[1]!) : '';
    const rest = m?.[2] ?? '';
    if (method === 'GET' && rest === '') return json(sketchOf(id, protos[id]?.sketch.name ?? id));
    if (method === 'GET' && rest === '/chats') return json({ conversations: [], current: 'main' });
    if (method === 'GET' && rest === '/chats/main') return json({ id: 'main', owner: { kind: 'sketch', id, name: id }, startedAt: null, messages: [], working: null });
    if (method === 'GET' && rest === '/prototype') return json(next.length ? (protos[id] = next.shift()) : protos[id]);
    if (method === 'PUT' && rest === '/prototype/link') {
      const p = protos[id];
      const links = p.links.filter((l: any) => !(l.screen === body.screen && l.button === body.button));
      if (body.back) links.push({ screen: body.screen, button: body.button, to: { back: true } });
      else if (body.to) links.push({ screen: body.screen, button: body.button, to: { screen: body.to } });
      protos[id] = { ...p, links, sketch: { ...p.sketch, stamp: `${p.sketch.stamp}+` } };
      return json(protos[id]);
    }
    if (method === 'PUT' && rest === '/prototype/start') {
      protos[id] = { ...protos[id], start: body.screen, markedStart: body.screen, sketch: { ...protos[id].sketch, stamp: 'stamp-2' } };
      return json(protos[id]);
    }
    if (method === 'POST' && rest === '/prototype/generate') return json({ working: { since: '2026-11-24T10:00:00Z', doing: 'Linking the screens' } });
    throw new Error(`The page must not call ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchSpy);
  dom.window.fetch = fetchSpy;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

describe('done when 1: the Prototype tab', () => {
  it('opens on Screens with the chat; Prototype hides the chat and shows Form and Confirm at their approved versions, Done left out, Form the start', async () => {
    await open();
    expect(tab('Screens').getAttribute('aria-selected')).toBe('true');
    expect(page.querySelector('.ws').className).toBe('ws');
    // One fixed place in the header, right after the sketch's name, Screens first; the screen tabs keep their row.
    const view = page.querySelector('[role="tablist"][aria-label="View"]');
    expect(view.parentElement.className).toBe('top');
    expect(view.previousElementSibling.textContent).toContain('Booking');
    expect([...view.querySelectorAll('[role="tab"]')].map(text)).toEqual(['Screens', 'Prototype']);
    expect(page.querySelector('.ws-bar [aria-label="View"]')).toBeNull();
    await press(tab('Prototype'));
    await until(() => cards().length === 2);
    expect(page.querySelector('.ws').className).toBe('ws proto');
    expect(page.querySelector('.top [aria-label="View"]')).toBe(view);
    expect(text(page.querySelector('.pt-line'))).toBe('2 approved screens: Form and Confirm. Done is not approved, so it is not in the prototype.');
    expect(cards().map(head)).toEqual(['Form v2 Start', 'Confirm v1 Make start']);
    // One arrow: Form's Continue to Confirm. Back has no card to point to, and a broken link draws none.
    expect(page.querySelectorAll('.pt-arrows path:not(marker path)').length).toBe(1);
    expect(text(page.querySelector('.pt-arrows text'))).toBe('Continue');
  });

  it('marks Confirm as the start screen with the stamp read', async () => {
    await open();
    await press(tab('Prototype'));
    await until(() => cards().length === 2);
    await press(button('Make start', cards()[1]));
    expect(changes).toEqual([{ method: 'PUT', url: `${BASE}/sketches/booking/prototype/start`, body: { stamp: 'stamp-1', screen: 'confirm' } }]);
    await until(() => head(cards()[1]) === 'Confirm v1 Start');
    expect(head(cards()[0])).toBe('Form v2 Make start');
  });

  it('says "Approve a screen to start the prototype" for Login, with Generate and Play off', async () => {
    await open('login');
    await press(tab('Prototype'));
    await until(() => !!page.querySelector('.pt-none'));
    expect(text(page.querySelector('.pt-none'))).toContain('Approve a screen to start the prototype');
    expect(button('Generate the prototype').disabled).toBe(true);
    expect(button('Play').disabled).toBe(true);
  });
});

describe('done when 2: Generate the prototype', () => {
  it('asks first when there are links: Cancel sends nothing; after confirming it shows it is working, then what went wrong', async () => {
    await open();
    await press(tab('Prototype'));
    await until(() => cards().length === 2);
    await press(button('Generate the prototype'));
    expect(text(page.querySelector('.modal'))).toContain(lib.REPLACE_TITLE);
    await press(button('Cancel', page.querySelector('.modal')));
    expect(page.querySelector('.modal')).toBeNull();
    expect(changes).toEqual([]);

    next = [{ ...booking(), working: { since: '2026-11-24T10:00:00Z', doing: 'Linking the screens' } }, { ...booking(), problem: 'The Designer stopped before it answered.' }];
    await press(button('Generate the prototype'));
    await press(button('Replace the links', page.querySelector('.modal')));
    expect(changes).toEqual([{ method: 'POST', url: `${BASE}/sketches/booking/prototype/generate`, body: { stamp: 'stamp-1' } }]);
    await until(() => !!page.querySelector('.pt-working'));
    expect(text(page.querySelector('.pt-working'))).toContain('The AI Designer is linking the screens');
    expect(button('Generating…').disabled).toBe(true);
    await until(() => !!page.querySelector('.pt-problem'));
    expect(text(page.querySelector('.pt-problem'))).toBe('Generating did not work: The Designer stopped before it answered. The links stay as they were.');
    expect(button('Generate the prototype').disabled).toBe(false);
  });

  it('starts at once, without asking, when there are no links yet', async () => {
    protos.booking = { ...booking(), links: [] };
    await open();
    await press(tab('Prototype'));
    await until(() => cards().length === 2);
    await press(button('Generate the prototype'));
    expect(page.querySelector('.modal')).toBeNull();
    expect(changes.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${BASE}/sketches/booking/prototype/generate`]);
  });
});

describe('done when 3: a link by hand', () => {
  it('picks Back, then no link, then Confirm for "Continue", each saved and the arrow following', async () => {
    await open();
    await press(tab('Prototype'));
    await until(() => cards().length === 2);
    const label = 'Continue on Form leads to';
    expect(picker(label).value).toBe('screen:confirm');
    await choose(picker(label), 'back');
    await until(() => picker(label).value === 'back');
    expect(page.querySelectorAll('.pt-arrows path:not(marker path)').length).toBe(0);
    await choose(picker(label), '');
    await until(() => picker(label).value === '');
    await choose(picker(label), 'screen:confirm');
    await until(() => picker(label).value === 'screen:confirm');
    expect(page.querySelectorAll('.pt-arrows path:not(marker path)').length).toBe(1);
    expect(changes).toEqual([
      { method: 'PUT', url: `${BASE}/sketches/booking/prototype/link`, body: { stamp: 'stamp-1', screen: 'form', button: 'Continue', back: true } },
      { method: 'PUT', url: `${BASE}/sketches/booking/prototype/link`, body: { stamp: 'stamp-1+', screen: 'form', button: 'Continue' } },
      { method: 'PUT', url: `${BASE}/sketches/booking/prototype/link`, body: { stamp: 'stamp-1++', screen: 'form', button: 'Continue', to: 'confirm' } },
    ]);
  });

  it('selects a button by clicking it in the drawing, on Desktop and on Mobile, and shows a broken link\'s warning', async () => {
    await open();
    await press(tab('Prototype'));
    await until(() => cards().length === 2);
    const frame = cards()[0].querySelector('iframe');
    await until(() => !!inFrame(frame, 'Continue'));
    await press(inFrame(frame, 'Continue'));
    expect(page.querySelector('.pt-btn.on .pt-btn-name').getAttribute('aria-pressed')).toBe('true');
    expect(text(page.querySelector('.pt-btn.on .pt-btn-name'))).toBe('Continue');
    expect(inFrame(frame, 'Continue').hasAttribute('data-sq-picked')).toBe(true);
    // Help is on the Desktop page only; on Mobile the same Continue link is shown.
    await press(tab('Mobile'));
    await until(() => (cards()[0].querySelector('iframe')?.contentDocument?.body?.textContent ?? '').includes('Form mobile'));
    expect(text(cards()[0].querySelectorAll('.pt-btn')[1])).toContain('Desktop only');
    expect(picker('Continue on Form leads to').value).toBe('screen:confirm');
    expect(text(cards()[1].querySelector('.pt-btn.broken'))).toContain('"Book visit" is gone from Confirm.');
  });
});

describe('done when 4: Play', () => {
  it('opens the start screen full size; Continue goes to Confirm, Back goes back, a broken link is skipped; Mobile works; Esc and Close leave', async () => {
    await open();
    await press(tab('Prototype'));
    await until(() => cards().length === 2);
    await press(button('Play'));
    await until(() => !!inFrame(playFrame(), 'Continue'));
    expect(play().getAttribute('aria-label')).toBe('Play Booking');
    expect(text(play().querySelector('.pp-screen'))).toBe('Form');
    expect(playFrame().className).toBe('pp-frame desktop');
    await press(inFrame(playFrame(), 'Continue'));
    await until(() => text(play().querySelector('.pp-screen')) === 'Confirm');
    // A broken link does nothing.
    await press(inFrame(playFrame(), 'Book visit'));
    expect(text(play().querySelector('.pp-screen'))).toBe('Confirm');
    await press(inFrame(playFrame(), 'Back'));
    await until(() => text(play().querySelector('.pp-screen')) === 'Form');
    // Desktop and Mobile while playing.
    await press(button('Mobile', play()));
    await until(() => playFrame().className === 'pp-frame mobile');
    await until(() => (playFrame().contentDocument?.body?.textContent ?? '').includes('Form mobile'));
    await press(inFrame(playFrame(), 'Continue'));
    await until(() => text(play().querySelector('.pp-screen')) === 'Confirm');
    await key('Escape');
    expect(play()).toBeNull();
    expect(cards()).toHaveLength(2);
    await press(button('Play'));
    await until(() => !!play());
    await press(button('Close', play()));
    expect(play()).toBeNull();
  });

  it('plays Arabic screens the same way, right to left', async () => {
    await open('arabic-booking');
    await press(tab('Prototype'));
    await until(() => cards().length === 2);
    expect(page.querySelector('.pt-map').getAttribute('dir')).toBe('rtl');
    await press(button('Play'));
    await until(() => !!inFrame(playFrame(), 'احجز الزيارة'));
    expect(play().querySelector('.pp-stage').getAttribute('dir')).toBe('rtl');
    expect(playFrame().contentDocument.documentElement.getAttribute('dir')).toBe('rtl');
    await press(inFrame(playFrame(), 'احجز الزيارة'));
    await until(() => text(play().querySelector('.pp-screen')) === 'تأكيد الحجز');
    await press(inFrame(playFrame(), 'رجوع'));
    await until(() => text(play().querySelector('.pp-screen')) === 'نموذج الحجز');
  });
});

describe('the helpers', () => {
  it('moves through Play: a link goes forward, Back goes back, a broken link or none does nothing', () => {
    expect(lib.playStep(['form'], { screen: 'form', button: 'Continue', to: { screen: 'confirm' } })).toEqual(['form', 'confirm']);
    expect(lib.playStep(['form', 'confirm'], { screen: 'confirm', button: 'Back', to: { back: true } })).toEqual(['form']);
    expect(lib.playStep(['form'], { screen: 'form', button: 'Back', to: { back: true } })).toBeNull();
    expect(lib.playStep(['form'], { screen: 'form', button: 'X', to: { screen: 'confirm' }, broken: 'button-gone' })).toBeNull();
    expect(lib.playStep(['form'], undefined)).toBeNull();
  });

  it('draws arrows above the cards, mirrored right to left, and none for Back or broken links', () => {
    const screens = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const links = [
      { screen: 'a', button: 'Go', to: { screen: 'c' } },
      { screen: 'b', button: 'Back', to: { back: true } },
      { screen: 'c', button: 'Edit', to: { screen: 'a' }, broken: 'screen-off' },
    ];
    const ltr = lib.mapArrows(screens, links);
    expect(ltr.width).toBe(3 * lib.CARD_W + 2 * lib.CARD_GAP);
    expect(ltr.arrows).toHaveLength(1);
    const start = (d: string) => Number(/^M (\S+)/.exec(d)![1]);
    expect(start(ltr.arrows[0]!.d)).toBeLessThan(ltr.width / 2);
    const rtl = lib.mapArrows(screens, links, true);
    expect(start(rtl.arrows[0]!.d)).toBeGreaterThan(rtl.width / 2);
    expect(lib.mapArrows(screens, []).height).toBe(0);
  });
});
