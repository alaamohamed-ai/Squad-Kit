import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * US-57 Show the work while the AI Designer draws (AB-182.1), on the board: the steps as a list with the time so far,
 * folded under the reply when it is done; a frame per variant at once, marked Waiting or Drawing, each drawing as soon
 * as it is done; "Redrawing" on a screen being changed; "Not saved" with "Save them anyway"; the reveal that plays once,
 * only in the tab that watched the drawing, and not when the computer asks for less motion; Arabic steps right to left;
 * and grey placeholder shapes where the Studio reads. Real React in a jsdom page, the board server answered by the test.
 */

const { JSDOM } = (await import(/* @vite-ignore */ new URL('../../console-ui/node_modules/jsdom/lib/api.js', import.meta.url).pathname)) as { JSDOM: new (html: string, opts: object) => { window: any } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4809/p/mawid/studio', pretendToBeVisual: true });
const page = dom.window.document;
dom.window.scrollTo = () => undefined;
let lessMotion = false;
dom.window.matchMedia = (q: string) => ({ matches: lessMotion && /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
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
const { SketchWorkspacePage } = await board('src/pages/studio/SketchWorkspace.tsx');
const { StudioPage } = await board('src/pages/Studio.tsx');
const { PrototypeView } = await board('src/pages/studio/PrototypeView.tsx');
const R = await board('src/lib/studio-reveal.ts');
const W = await board('src/lib/studio-work.ts');
const h = React.createElement;

const BASE = '/p/mawid/api/v1/studio';
const html = (words: string) => `<!doctype html><html><body><button>${words}</button></body></html>`;

let root: { render(n: unknown): void; unmount(): void } | null = null;
let changes: { method: string; url: string; body: any }[];
let conversation: { messages: any[]; working: any; justDrawn?: any[] };
/** Requests the test holds back, to see the page while it reads. */
let hold: RegExp | null;

const sketch = () => ({
  id: 'booking',
  name: 'Booking',
  designSystem: { id: 'patient-app', version: 2, name: 'Patient app' },
  frames: ['desktop', 'mobile'],
  stamp: 'stamp-1',
  screens: [
    { id: 'form', name: 'Form', order: 1, status: 'draft', chosen: 1, variants: [{ version: 1, frames: ['desktop'], html: { desktop: html('Book visit') } }] },
    { id: 'confirmation', name: 'Confirmation', order: 2, status: 'draft', chosen: 1, variants: [{ version: 1, frames: ['desktop'], html: { desktop: html('Done') } }] },
  ],
});
let current = sketch();

async function open(at: string, ready = () => !!page.querySelector('.dc-head') && !!page.querySelector('.dc-msg, .dc-empty, .dc-working')) {
  await close();
  root = createRoot(page.getElementById('root'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const top = Router.createRootRoute();
  const ws = Router.createRoute({ getParentRoute: () => top, path: '/studio/sketches/$id', component: SketchWorkspacePage });
  const studio = Router.createRoute({ getParentRoute: () => top, path: '/studio', component: () => h(StudioPage, { project: 'mawid' }) });
  const proto = Router.createRoute({ getParentRoute: () => top, path: '/proto', component: () => h(PrototypeView, { project: 'mawid', sketch: 'booking', frame: 'desktop', onChanged: () => undefined }) });
  const router = Router.createRouter({ routeTree: top.addChildren([studio, ws, proto]), history: Router.createMemoryHistory({ initialEntries: [at] }) });
  await act(async () => root!.render(h(QueryClientProvider, { client }, h(Router.RouterProvider, { router }))));
  await until(ready);
}
async function close() {
  if (root) await act(async () => root!.unmount());
  root = null;
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const all = (sel: string) => [...page.querySelectorAll(sel)] as any[];
const text = (sel: string) => page.querySelector(sel)?.textContent?.trim();
const button = (name: string) => [...page.querySelectorAll('button')].find((b: any) => b.textContent.trim() === name || b.getAttribute('aria-label') === name) as any;
const press = async (el: any) => {
  await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
  await until(() => false);
};
const since = (sAgo: number) => new Date(Date.now() - sAgo * 1000).toISOString();

const steps = (now: string) => [
  { id: 'wait', words: 'Waited for a free place', state: 'done' },
  { id: 'read', words: 'Read your message', state: 'done' },
  { id: 'plan', words: 'Planned 2 variants', state: 'done' },
  { id: 'draw:form:A', words: 'Drew variant A: Form', state: 'done' },
  { id: 'draw:form:B', words: now, state: 'now' },
  { id: 'save', words: 'Saving', state: 'next' },
];
const drafts = (b: 'drawing' | 'done' = 'drawing') => [
  { key: 'form:A', screen: 'form', name: 'Form', letter: 'A', variantName: 'One page', state: 'done', pages: { desktop: html('A one page'), mobile: html('A small') } },
  { key: 'form:B', screen: 'form', name: 'Form', letter: 'B', state: b, ...(b === 'done' ? { variantName: 'Step by step', pages: { desktop: html('B steps') } } : {}) },
  { key: 'form:C', screen: 'form', name: 'Form', letter: 'C', state: 'waiting' },
];

beforeEach(() => {
  dom.window.sessionStorage.clear();
  dom.window.localStorage.setItem('squad.console.token', 'a-token');
  changes = [];
  hold = null;
  lessMotion = false;
  current = sketch();
  conversation = { messages: [{ role: 'person', text: 'Draw 3 variants of the Form screen', pictures: [] }], working: null };
  R.forgetReveals();
  const fetchSpy = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (method !== 'GET') changes.push({ method, url, body });
    if (hold?.test(url)) return new Promise<Response>(() => undefined);
    if (method === 'GET' && url === `${BASE}/sketches/booking`) return json(current);
    if (method === 'GET' && url === `${BASE}/sketches`) return json({ sketches: [] });
    if (method === 'GET' && url === `${BASE}/design-systems`) return json({ designSystems: [], default: null });
    const chats = /^\/p\/mawid\/api\/v1\/studio\/sketches\/booking\/chats(?:\/([a-z0-9-]+))?(\/.*)?$/.exec(url);
    if (chats) {
      const [, chat, action] = chats;
      const view = () => json({ id: 'main', owner: { kind: 'sketch', id: 'booking', name: 'Booking' }, startedAt: null, ...conversation });
      if (method === 'GET' && !chat) return json({ conversations: [{ id: 'main', startedAt: null, messages: 1, first: 'x', lastAt: null }], current: 'main' });
      if (method === 'GET') return view();
      if (action === '/unsaved/u-1/save') {
        conversation = { messages: [...conversation.messages.map((m: any) => (m.unsaved ? { ...m, unsaved: undefined, kind: 'changed' } : m)), { role: 'action', text: 'You saved them anyway: Form A v2 · Form B v3', pictures: [], savedAnyway: { saved: [], at: '' } }], working: null };
        return view();
      }
      if (action === '/stop') return json({ stopped: true });
    }
    throw new Error(`The page must not call ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchSpy);
  dom.window.fetch = fetchSpy;
});
afterEach(close);

describe('done when 1: the steps as a list, with the time so far; folded under the reply when it is done', () => {
  it('done steps have a check, the current one moves, the next ones wait, and the time so far shows', async () => {
    conversation.working = { doing: 'Drawing variant 2 of 2: Form', since: since(42), language: 'English', steps: steps('Drawing variant B: Form'), drafts: [] };
    await open('/studio/sketches/booking');
    expect(text('.dc-doing')).toBe('Working');
    expect(text('.dc-clock')).toMatch(/^0:4\d$/);
    expect(all('.dc-steps .dc-step').map((li) => [li.className.replace('dc-step ', ''), li.textContent.trim()])).toEqual([
      ['done', 'Waited for a free place'],
      ['done', 'Read your message'],
      ['done', 'Planned 2 variants'],
      ['done', 'Drew variant A: Form'],
      ['now', 'Drawing variant B: Form'],
      ['next', 'Saving'],
    ]);
    expect(all('.dc-step.done .dc-step-mark svg')).toHaveLength(4);
    expect(page.querySelector('.dc-step.now .dc-step-spin')).toBeTruthy();
    expect(page.querySelector('.dc-step.now').getAttribute('aria-current')).toBe('step');
    expect(page.querySelector('.dc-steps').getAttribute('dir')).toBe('ltr');
    expect(button('Stop')).toBeTruthy();
  });

  it('a wait for a free place is its own step, with why it waits', async () => {
    conversation.working = { doing: 'Next in line', since: since(3), language: 'English', steps: [{ id: 'wait', words: 'Waiting for a free place', state: 'now', detail: 'Next in line: the Designer starts when a place is free (2 of 2 busy).' }, { id: 'read', words: 'Reading your message', state: 'next' }], drafts: [] };
    await open('/studio/sketches/booking');
    expect(text('.dc-step.now .dc-step-words')).toBe('Waiting for a free place');
    expect(text('.dc-step.now .dc-step-detail')).toBe('Next in line: the Designer starts when a place is free (2 of 2 busy).');
  });

  it('when it is done, the list folds into "6 steps, 2 min" under the reply, and a click opens it again', async () => {
    const done = steps('x').map((s) => ({ words: s.words === 'x' ? 'Drew variant B: Form' : s.words === 'Saving' ? 'Saved' : s.words, state: 'done' }));
    conversation.messages.push({ role: 'designer', kind: 'changed', text: 'Done. 2 variants of Form are drawn.', pictures: [], steps: done, took: 118_000 });
    await open('/studio/sketches/booking');
    const line = page.querySelector('.dc-msg.designer .dc-fold-line');
    expect(line.textContent).toBe('6 steps, 2 min');
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(page.querySelector('.dc-fold .dc-steps')).toBeNull();
    await press(line);
    expect(all('.dc-fold .dc-step').map((li) => li.textContent.trim())).toEqual(['Waited for a free place', 'Read your message', 'Planned 2 variants', 'Drew variant A: Form', 'Drew variant B: Form', 'Saved']);
    await press(line);
    expect(page.querySelector('.dc-fold .dc-steps')).toBeNull();
    expect(W.foldText(1, 45_000)).toBe('1 step, 45 s');
  });
});

describe('done when 2: frames A, B and C at once; each drawing before the save; "Not saved" and "Save them anyway"', () => {
  it('shows a frame per variant at once, marked Waiting or Drawing, and A\'s drawing as soon as it is done', async () => {
    conversation.working = { doing: 'Drawing variant 2 of 3: Form', since: since(5), language: 'English', steps: steps('Drawing variant B: Form'), drafts: drafts() };
    await open('/studio/sketches/booking', () => all('.df-card').length === 3);
    const cards = all('.df-card');
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Variant A · One page', 'Variant B', 'Variant C']);
    expect(cards.map((c) => c.querySelector('.df-mark')?.textContent ?? null)).toEqual([null, 'Drawing', 'Waiting']);
    expect(cards[0].querySelector('iframe').getAttribute('sandbox')).toBe('');
    expect(cards[0].querySelector('iframe').getAttribute('srcdoc')).toContain('A one page');
    expect(cards[1].querySelector('.df-blank.drawing')).toBeTruthy();
    expect(cards[2].querySelector('.df-blank:not(.drawing)')).toBeTruthy();
  });

  it('drawings that could not save stay on the page marked "Not saved"; "Save them anyway" saves them with the stamp read', async () => {
    conversation.messages.push({
      role: 'designer',
      kind: 'not-saved',
      text: 'Not saved: Form was changed elsewhere while I drew.',
      pictures: [],
      unsaved: { id: 'u-1', screens: ['Form'], drafts: drafts('done').slice(0, 2).map((d) => ({ ...d, state: 'done', pages: d.pages ?? { desktop: html('B steps') } })) },
    });
    await open('/studio/sketches/booking', () => all('.df-card').length === 2);
    expect(all('.df-card .df-mark').map((m) => m.textContent)).toEqual(['Not saved', 'Not saved']);
    expect(text('.dc-msg.designer .dc-kind')).toBe('Not saved');
    expect(all('button').filter((b) => b.textContent.trim() === 'Save them anyway')).toHaveLength(2);
    await press(page.querySelector('.df-bar button'));
    expect(changes).toEqual([{ method: 'POST', url: `${BASE}/sketches/booking/chats/main/unsaved/u-1/save`, body: { stamp: 'stamp-1' } }]);
    await until(() => !page.querySelector('.df-card'));
    expect(page.querySelector('.df-card')).toBeNull();
    expect(text('.dc-line')).toBe('You saved them anyway: Form A v2 · Form B v3');
  });
});

describe('done when 3: a screen being changed is dimmed and marked "Redrawing" until the new drawing is ready', () => {
  it('shows the current drawing dimmed with "Redrawing" and the step; then the new drawing, with no mark', async () => {
    dom.window.sessionStorage.setItem('squad-studio-view:mawid:booking', JSON.stringify({ screen: 'confirmation', frame: 'desktop' }));
    const working = (state: string, pages?: object) => ({
      doing: 'Changing screen 1 of 1: Confirmation',
      since: since(8),
      language: 'English',
      steps: [{ id: 'draw:confirmation', words: 'Redrawing Confirmation', state: state === 'done' ? 'done' : 'now' }],
      drafts: [{ key: 'confirmation', screen: 'confirmation', name: 'Confirmation', redraw: true, state, ...(pages ? { pages } : {}) }],
    });
    conversation.working = working('drawing');
    await open('/studio/sketches/booking', () => !!page.querySelector('.df-redraw-mark'));
    expect(text('.df-redraw-mark strong')).toBe('Redrawing');
    expect(text('.df-redraw-mark .df-step')).toBe('Redrawing Confirmation');
    expect(page.querySelector('.df-dim .ws-frame').getAttribute('srcdoc')).toBe(html('Done'));
    conversation.working = working('done', { desktop: html('Calm') });
    await until(() => !page.querySelector('.df-redraw-mark'));
    expect(page.querySelector('.df-redraw-mark')).toBeNull();
    expect(page.querySelector('.ws-frame').getAttribute('srcdoc')).toContain(html('Calm').replace('<!doctype html>', ''));
  });
});

describe('done when 4: the new drawing reveals from top to bottom, once, only for the designer who watched it', () => {
  it('plays when the drawing first shows in the tab that watched it, not when the screen is opened again', async () => {
    conversation.working = { doing: 'x', since: since(5), language: 'English', steps: steps('Drawing variant B: Form'), drafts: drafts() };
    await open('/studio/sketches/booking', () => all('.df-card iframe').length === 1);
    const first = page.querySelector('.df-card iframe').getAttribute('srcdoc');
    expect(first).toContain('data-squad-reveal');
    expect(first).toContain('@keyframes squad-reveal');
    expect(first).toContain('prefers-reduced-motion:no-preference');
    // The same drawing, saved and shown again: no second reveal.
    await open('/studio/sketches/booking', () => all('.df-card iframe').length === 1);
    expect(page.querySelector('.df-card iframe').getAttribute('srcdoc')).not.toContain('data-squad-reveal');
  });

  it('a teammate who opens the drawing, never watched here, gets no reveal', async () => {
    current.screens[0]!.variants[0]!.html.desktop = html('A one page');
    await open('/studio/sketches/booking', () => !!page.querySelector('.ws-frame'));
    expect(page.querySelector('.ws-frame').getAttribute('srcdoc')).toBe(html('A one page'));
  });

  it('the last drawing, saved before the tab read it as done, still reveals the first time it shows', async () => {
    conversation.working = { doing: 'x', since: since(5), language: 'English', steps: steps('Drawing variant B: Form'), drafts: drafts() };
    await open('/studio/sketches/booking', () => all('.df-card').length === 3);
    // The answer ends: the board reads the drawings just finished once, and the saved sketch shows them.
    conversation = { messages: conversation.messages, working: null, justDrawn: drafts('done').slice(0, 2) };
    current.screens[0]!.variants[0]!.html.desktop = html('B steps');
    await until(() => !page.querySelector('.df-card') && !!page.querySelector('.ws-frame')?.getAttribute('srcdoc').includes('B steps'));
    expect(page.querySelector('.ws-frame').getAttribute('srcdoc')).toContain('data-squad-reveal');
  });

  it('when the computer asks for less motion, the drawing shows at once with no reveal', async () => {
    lessMotion = true;
    conversation.working = { doing: 'x', since: since(5), language: 'English', steps: steps('Drawing variant B: Form'), drafts: drafts() };
    await open('/studio/sketches/booking', () => all('.df-card iframe').length === 1);
    expect(page.querySelector('.df-card iframe').getAttribute('srcdoc')).not.toContain('data-squad-reveal');
  });

  it('the reveal is only CSS before the page, so a right-to-left page keeps its direction', () => {
    const rtl = '<!doctype html><html dir="rtl" lang="ar"><body><h1>احجز موعدك</h1></body></html>';
    const out = R.revealHtml(rtl);
    expect(out.startsWith('<!doctype html><style data-squad-reveal>')).toBe(true);
    expect(out.endsWith(rtl.replace('<!doctype html>', ''))).toBe(true);
    expect(R.REVEAL_CSS).toContain('to bottom');
    expect(R.REVEAL_CSS).not.toMatch(/left|right/);
  });
});

describe('done when 5: grey placeholder shapes while the Studio reads; Arabic steps right to left; the marks in English', () => {
  it('the sketches grid and the design systems list show grey shapes, not "Reading..."', async () => {
    hold = /\/studio\/(sketches|design-systems)$/;
    await open('/studio', () => !!page.querySelector('.skel'));
    expect(page.querySelector('.skel').getAttribute('aria-label')).toBe('Loading the sketches');
    expect(page.querySelectorAll('.skel-card').length).toBeGreaterThan(0);
    expect(page.body.textContent).not.toMatch(/Reading/);
    const tab = [...page.querySelectorAll('[role="tab"]')].find((t: any) => t.textContent === 'Design systems') as any;
    await press(tab);
    await until(() => page.querySelector('.skel')?.getAttribute('aria-label') === 'Loading the design systems');
    expect(page.querySelector('.skel').getAttribute('aria-label')).toBe('Loading the design systems');
    expect(page.body.textContent).not.toMatch(/Reading/);
  });

  it('a sketch while it opens, and its prototype, show grey shapes', async () => {
    hold = /\/studio\/sketches\/booking(\/prototype)?$/;
    await open('/studio/sketches/booking', () => !!page.querySelector('.skel'));
    expect(page.querySelector('.skel').getAttribute('aria-label')).toBe('Loading the sketch');
    expect(page.body.textContent).not.toMatch(/Reading/);
    await open('/proto', () => !!page.querySelector('.skel'));
    expect(page.querySelector('.skel').getAttribute('aria-label')).toBe('Loading the prototype');
  });

  it('an Arabic message\'s steps read right to left, while Waiting, Drawing, Not saved and Save them anyway stay in English', async () => {
    conversation.messages = [{ role: 'person', text: 'ارسم ثلاث نسخ من شاشة النموذج', pictures: [] }];
    conversation.working = {
      doing: 'Drawing variant 2 of 3: Form',
      since: since(5),
      language: 'Arabic',
      steps: [
        { words: 'قرأت رسالتك', state: 'done' },
        { words: 'خطّطت لعدد 3 من النسخ', state: 'done' },
        { words: 'رسمت النسخة A من "Form"', state: 'done' },
        { words: 'أرسم النسخة B من "Form"', state: 'now' },
        { words: 'أحفظ', state: 'next' },
      ],
      drafts: drafts(),
    };
    await open('/studio/sketches/booking', () => all('.df-card').length === 3);
    expect(page.querySelector('.dc-steps').getAttribute('dir')).toBe('rtl');
    expect(text('.dc-step.now')).toBe('أرسم النسخة B من "Form"');
    expect(all('.df-mark').map((m) => m.textContent)).toEqual(['Drawing', 'Waiting']);
    expect(W.foldText(5, 120_000, true)).toBe('خطوات: 5، المدة: 2 دقيقة');
  });
});
