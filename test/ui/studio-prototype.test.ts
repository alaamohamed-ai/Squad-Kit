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
/**
 * The prototype as the server sends it (US-58): each screen with its drawings, and the tabs. A screen written the
 * US-54 way (its one drawing's frames and buttons on it) becomes one screen with that one drawing, and the
 * prototype gets its one tab, "In use".
 */
const shaped = (p: Proto): Proto => {
  const screens = p.screens.map((s: any) => (s.drawings ? s : { id: s.id, name: s.name, version: s.version, rtl: s.rtl, buttons: s.buttons, drawings: [{ version: s.version, frames: s.frames, buttons: s.buttons, rtl: s.rtl }] }));
  const tabs = p.tabs ?? [{ id: 'in-use', label: 'In use', screens: screens.map((s: any) => ({ id: s.id, version: s.version })), start: p.start, links: p.links }];
  return { ...p, screens, tabs };
};
const booking = (): Proto => shaped({
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
const login = (): Proto => shaped({ sketch: { id: 'login', name: 'Login', frames: ['desktop'], stamp: 'stamp-l' }, screens: [], links: [], start: null, markedStart: null, left: [{ id: 'sign-in', name: 'Sign in' }], working: null, problem: null });
const arabic = (): Proto => shaped({
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

/**
 * US-58's Booking, by the rules the server works out: Form approved at v2 with one drawing and no letter (so in "In use"
 * only); Confirm drawn as Options A (v1), B (v2, in use) and C (v3), with "Pay now" on A and B only. Done: no drawing
 * ("none"), one drawing with no letter ("one"), Options A and B ("ab") or Options A, B and C ("abc"), A in use.
 */
const options = (done: 'none' | 'one' | 'ab' | 'abc' = 'none', start = 'form'): Proto => {
  const B = (name: string) => ({ name, kind: 'button', frames: ['desktop', 'mobile'] });
  const two = (body: string) => ({ desktop: marked(`${body}<p>desktop</p>`), mobile: marked(`${body}<p>mobile</p>`) });
  const form = { id: 'form', name: 'Form', version: 2, rtl: false, buttons: [B('Continue')], drawings: [{ version: 2, frames: two(`<h1>Form</h1>${btn('Continue')}`), buttons: [B('Continue')], rtl: false }] };
  const opt = (letter: string, version: number, pay: boolean) => ({ version, letter, name: `Idea ${letter}`, frames: two(`<h1>Confirm ${letter}</h1>${btn('Back', '‹')}${pay ? btn('Pay now') : ''}`), buttons: [B('Back'), ...(pay ? [B('Pay now')] : [])], rtl: false });
  const confirm = { id: 'confirm', name: 'Confirm', version: 2, rtl: false, buttons: [B('Back'), B('Pay now')], drawings: [opt('A', 1, true), opt('B', 2, true), opt('C', 3, false)] };
  const doneDrawing = (version: number, letter?: string) => ({ version, ...(letter ? { letter } : {}), frames: two(`<h1>Done ${letter ?? ''}</h1>${btn('Back', '‹')}`), buttons: [B('Back')], rtl: false });
  const doneLetters = done === 'ab' ? ['A', 'B'] : done === 'abc' ? ['A', 'B', 'C'] : [];
  const doneScreen = done === 'none' ? null : { id: 'done', name: 'Done', version: 1, rtl: false, buttons: [B('Back')], drawings: done === 'one' ? [doneDrawing(1)] : doneLetters.map((l, i) => doneDrawing(i + 1, l)) };
  const screens: any[] = [form, confirm, ...(doneScreen ? [doneScreen] : [])];
  const links: any[] = [{ screen: 'form', button: 'Continue', to: { screen: 'confirm' } }, { screen: 'confirm', button: 'Back', to: { back: true } }, ...(doneScreen ? [{ screen: 'confirm', button: 'Pay now', to: { screen: 'done' } }, { screen: 'done', button: 'Back', to: { back: true } }] : [])];
  // As the server: "In use" holds every screen at its drawing in use, an Option tab only the drawings of its letter.
  const tabOf = (id: string) => {
    const shown = screens.flatMap((x) => {
      const d = id === 'in-use' ? x.drawings.find((v: any) => v.version === x.version) : x.drawings.find((v: any) => v.letter === id);
      return d ? [{ x, d }] : [];
    });
    const label = id === 'in-use' ? 'In use' : `Option ${id}`;
    const tabLinks = links.flatMap((l) => {
      const at = shown.find((y) => y.x.id === l.screen);
      if (!at) return [];
      if (!at.d.buttons.some((b: any) => b.name === l.button)) return [{ ...l, broken: 'button-gone', warning: `"${l.button}" is not on Option ${at.d.letter} of ${at.x.name}, so Play skips it here.` }];
      if ('screen' in l.to && !shown.some((y) => y.x.id === l.to.screen)) return [{ ...l, broken: 'screen-off', warning: `Done has no ${label}, so this link is off here.` }];
      return [l];
    });
    return { id, label, screens: shown.map((y) => ({ id: y.x.id, version: y.d.version })), start: shown.some((y) => y.x.id === start) ? start : shown[0]!.x.id, links: tabLinks };
  };
  const tabs = ['in-use', 'A', 'B', 'C'].map(tabOf);
  return { sketch: { id: 'options', name: 'Booking', frames: ['desktop', 'mobile'], stamp: 'stamp-o' }, screens, links, tabs, start, markedStart: start === 'form' ? null : start, left: doneScreen ? [] : [{ id: 'done', name: 'Done' }], working: null, problem: null };
};

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
  protos = { booking: booking(), login: login(), 'arabic-booking': arabic(), options: options() };
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
    if (method === 'GET' && rest === '/prototype') return json(next.length ? (protos[id] = shaped(next.shift())) : protos[id]);
    if (method === 'PUT' && rest === '/prototype/link') {
      const p = protos[id];
      const links = p.links.filter((l: any) => !(l.screen === body.screen && l.button === body.button));
      if (body.back) links.push({ screen: body.screen, button: body.button, to: { back: true } });
      else if (body.to) links.push({ screen: body.screen, button: body.button, to: { screen: body.to } });
      // The tabs follow the links, as the server works them out again.
      const tabs = p.tabs.map((t: any) => ({ ...t, links: [...t.links.filter((l: any) => !(l.screen === body.screen && l.button === body.button)), ...links.filter((l: any) => l.screen === body.screen && l.button === body.button)] }));
      protos[id] = { ...p, links, tabs, sketch: { ...p.sketch, stamp: `${p.sketch.stamp}+` } };
      return json(protos[id]);
    }
    if (method === 'PUT' && rest === '/prototype/start') {
      const p = protos[id];
      const tabs = p.tabs.map((t: any) => ({ ...t, start: t.screens.some((x: any) => x.id === body.screen) ? body.screen : t.start }));
      protos[id] = { ...p, tabs, start: body.screen, markedStart: body.screen, sketch: { ...p.sketch, stamp: 'stamp-2' } };
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
    expect(text(page.querySelector('.pt-line'))).toBe('2 screens');
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

  it('says "Draw a screen to start the prototype" for Login, with Generate and Play off', async () => {
    await open('login');
    await press(tab('Prototype'));
    await until(() => !!page.querySelector('.pt-none'));
    expect(text(page.querySelector('.pt-none'))).toContain('Draw a screen to start the prototype');
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

const tabs = (label: string, within: any = page) => [...within.querySelectorAll(`[role="tablist"][aria-label="${label}"] [role="tab"]`)] as any[];
const tabIn = (label: string, name: string, within: any = page) => tabs(label, within).find((b) => text(b) === name);
const cardFrame = (i: number) => cards()[i]?.querySelector('iframe');
const bodyOf = (frame: any) => frame?.contentDocument?.body?.textContent ?? '';
const playing = () => text(play()?.querySelector('.pp-screen'));

describe('US-58 done when 1: every drawn screen, with its options, under one top row', () => {
  it('shows Form at v2 and Confirm with its options and no approval mark, Done left out, and one row: count, tabs, Generate, Play, frames', async () => {
    await open('options');
    await press(tab('Prototype'));
    await until(() => cards().length === 2);
    // The workspace's second row is gone: the prototype's own row holds everything.
    expect(page.querySelector('.ws-bar')).toBeNull();
    const row = page.querySelector('.pt-row');
    // It counts screens only.
    expect(text(row.querySelector('.pt-line'))).toBe('2 screens');
    expect(tabs('Options').map(text)).toEqual(['In use', 'Option A', 'Option B', 'Option C']);
    expect(tabIn('Options', 'In use').getAttribute('aria-selected')).toBe('true');
    const parts = [...row.children].filter((el: any) => el.tagName === 'BUTTON' || el.getAttribute('role') === 'tablist');
    expect(parts.map((el: any) => el.getAttribute('aria-label') ?? text(el))).toEqual(['Options', 'Generate the prototype', 'Play', 'Frames']);
    // "Generate the prototype" is the filled main button, like "Approve screen"; the frame switch is at the far right.
    expect(button('Generate the prototype').className).toBe('btn pri');
    expect(button('Play').className).toBe('btn');
    expect(row.lastElementChild.getAttribute('aria-label')).toBe('Frames');
    expect(cards().map(head)).toEqual(['Form v2 Start', 'Confirm v2 Make start']);
    expect(text(page.querySelector('.pt'))).not.toContain('approved');
    expect([...cards()[1].querySelectorAll('.pt-options button')].map(text)).toEqual(['Option A', 'Option B', 'Option C']);
    expect(text(cards()[1].querySelector('.pt-options button[aria-pressed="true"]'))).toBe('Option B');
    expect(cards()[0].querySelector('.pt-options')).toBeNull();
  });
});

describe('US-58 done when 3: the map per tab', () => {
  it('shows Option C with only the screens that have it, "Pay now" broken there and working on A, and changes no file', async () => {
    protos.options = options('abc');
    await open('options');
    await press(tab('Prototype'));
    await until(() => cards().length === 3);
    expect(text(page.querySelector('.pt-line'))).toBe('3 screens');
    await press(tabIn('Options', 'Option C'));
    // Form has no Option C: the tab holds Confirm and Done, each at its Option C.
    await until(() => cards().length === 2 && bodyOf(cardFrame(0)).includes('Confirm C'));
    expect(cards().map(head)).toEqual(['Confirm v3 Start', 'Done v3 Make start']);
    const missing = cards()[0].querySelector('.pt-btn.broken');
    expect(text(missing)).toContain('"Pay now" is not on Option C of Confirm, so Play skips it here.');
    // Its button is on other options: it is not taken away from here.
    expect(button('Take the link away', missing)).toBeUndefined();
    // A card's option picks that tab for the whole map.
    await press(button('Option A', cards()[0]));
    expect(tabIn('Options', 'Option A').getAttribute('aria-selected')).toBe('true');
    await until(() => bodyOf(cardFrame(0)).includes('Confirm A'));
    expect(picker('Pay now on Confirm leads to').value).toBe('screen:done');
    expect(cards()[0].querySelector('.pt-btn.broken')).toBeNull();
    expect(changes).toEqual([]);
  });
});

describe('US-58 done when 2, 3 and 5: Play with tabs', () => {
  it('opens on "In use" with the tabs on every screen; an option picked shows at once and stays while playing; "Pay now" is skipped on C', async () => {
    protos.options = options('abc');
    await open('options');
    await press(tab('Prototype'));
    await until(() => cards().length === 3);
    await press(button('Play'));
    await until(() => !!inFrame(playFrame(), 'Continue'));
    expect(playing()).toBe('Form');
    // The tabs are for the whole flow: Form shows them too. No screen shows an approval mark.
    expect(tabs('Options', play()).map(text)).toEqual(['In use', 'Option A', 'Option B', 'Option C']);
    expect(tabIn('Options', 'In use', play()).getAttribute('aria-selected')).toBe('true');
    expect(text(play())).not.toContain('approved');
    await press(inFrame(playFrame(), 'Continue'));
    await until(() => bodyOf(playFrame()).includes('Confirm B'));
    expect(playing()).toBe('Confirm');
    await press(tabIn('Options', 'Option C', play()));
    await until(() => bodyOf(playFrame()).includes('Confirm C'));
    expect(playing()).toBe('Confirm');
    expect(inFrame(playFrame(), 'Pay now')).toBeNull();
    // On Option A, "Pay now" opens Done at its Option A; Back comes to Confirm, still at Option A.
    await press(tabIn('Options', 'Option A', play()));
    await until(() => !!inFrame(playFrame(), 'Pay now'));
    await press(inFrame(playFrame(), 'Pay now'));
    await until(() => playing() === 'Done' && bodyOf(playFrame()).includes('Done A'));
    await press(inFrame(playFrame(), 'Back'));
    await until(() => playing() === 'Confirm');
    await until(() => bodyOf(playFrame()).includes('Confirm A'));
    expect(tabIn('Options', 'Option A', play()).getAttribute('aria-selected')).toBe('true');
    expect(changes).toEqual([]);
  });

  it('goes to the tab\'s start screen when the screen shown is not in the new tab', async () => {
    protos.options = options('ab');
    await open('options');
    await press(tab('Prototype'));
    await until(() => cards().length === 3);
    await press(button('Play'));
    await until(() => !!inFrame(playFrame(), 'Continue'));
    await press(inFrame(playFrame(), 'Continue'));
    await until(() => !!inFrame(playFrame(), 'Pay now'));
    await press(inFrame(playFrame(), 'Pay now'));
    await until(() => playing() === 'Done');
    // Done has no Option C, and the marked start, Form, has none either: Play goes to Option C's first screen.
    await press(tabIn('Options', 'Option C', play()));
    await until(() => playing() === 'Confirm');
    await until(() => bodyOf(playFrame()).includes('Confirm C'));
    expect(changes).toEqual([]);
  });

  it('starts on Confirm when it is the marked start, and picking Option C sends nothing', async () => {
    protos.options = options('none', 'confirm');
    await open('options');
    await press(tab('Prototype'));
    await until(() => cards().length === 2);
    expect(head(cards()[1])).toBe('Confirm v2 Start');
    await press(button('Play'));
    await until(() => bodyOf(playFrame()).includes('Confirm B'));
    expect(playing()).toBe('Confirm');
    await press(tabIn('Options', 'Option C', play()));
    await until(() => bodyOf(playFrame()).includes('Confirm C'));
    await key('Escape');
    // Back on the map, Option B is still the one shown in use.
    expect(text(cards()[1].querySelector('.pt-options button[aria-pressed="true"]'))).toBe('Option B');
    expect(changes).toEqual([]);
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

  it('switches tab in Play: the same screen when it is in the tab, else the tab\'s start; Back skips screens out of the tab', () => {
    const C = { id: 'C', label: 'Option C', screens: [{ id: 'form', version: 2 }, { id: 'confirm', version: 3 }], start: 'confirm', links: [] };
    expect(lib.switchTab(['form', 'confirm'], C)).toEqual(['form', 'confirm']);
    expect(lib.switchTab(['form', 'confirm', 'done'], C)).toEqual(['form', 'confirm', 'done', 'confirm']);
    const inC = (id: string) => C.screens.some((x) => x.id === id);
    expect(lib.playStep(['form', 'done', 'confirm'], { screen: 'confirm', button: 'Back', to: { back: true } }, inC)).toEqual(['form']);
    expect(lib.playStep(['done', 'confirm'], { screen: 'confirm', button: 'Back', to: { back: true } }, inC)).toBeNull();
    expect(lib.countLine([{}, {}, {}])).toBe('3 screens');
    expect(lib.countLine([{}])).toBe('1 screen');
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
