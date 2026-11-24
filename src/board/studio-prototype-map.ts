import type { Sketch } from './studio-read.js';
import type { LinkTarget, PrototypeFile } from './studio-prototype.js';

/**
 * The prototype's rules (US-54, AB-179.1), worked out on read from what is saved, and writing nothing (AB-127.1):
 *
 * - Its screens: the sketch's approved screens, in the screen order, each at the version it was approved at. A screen
 *   that is not approved (never, or reopened now) is not in it.
 * - Its buttons: every button and link in each screen's drawing, named the same way on every frame, so one link works
 *   on Desktop and on Mobile: by its words; else its label, its title or its picture's text; else by its kind and place
 *   ("Icon button 2"). Arabic words count as words. Two buttons with the same words on one page are "Next" and "Next 2".
 * - Each link: working, or broken when its button is gone from the drawing, or its screen is not approved now. A broken
 *   link stays in the file, says why in a short warning, and Play skips it.
 * - The start screen: the one the person marked while it is approved, else the first approved screen in the screen order.
 *
 * Each drawing is sent to the board with its buttons marked (data-sq-button="<name>"), so the board finds the same button
 * the rules found, with no second way of naming them.
 */

/** The longest button name kept. */
export const MAX_BUTTON_NAME = 80;

/** One button or link found in a drawing. */
export interface FoundButton {
  name: string;
  kind: 'button' | 'link';
}

/** The attribute each found button carries in the drawing sent to the board. */
export const BUTTON_MARK = 'data-sq-button';

/** One button on one screen, as links compare them: its screen, and its name without capitals or spaces at the ends. */
export function buttonKey(screen: string, button: string): string {
  return `${screen}\n${button.trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Their text is not markup: it is read up to their end tag. */
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp']);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decoded(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

const oneLine = (x: string) => decoded(x).replace(/\s+/g, ' ').trim();
const hasWords = (x: string) => /[\p{L}\p{N}]/u.test(x);

function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const name = m[1]!.toLowerCase();
    if (!(name in out)) out[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/** What kind of button an element is, or null when it is none. */
function kindOf(tag: string, a: Record<string, string>): FoundButton['kind'] | null {
  if ('hidden' in a) return null;
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'input') return ['button', 'submit', 'reset', 'image'].includes((a.type ?? '').toLowerCase()) ? 'button' : null;
  const role = (a.role ?? '').toLowerCase();
  if (role === 'link') return 'link';
  if (role === 'button' || role === 'tab' || role === 'menuitem') return 'button';
  const classes = (a.class ?? '').toLowerCase().split(/\s+/);
  if (classes.some((c) => c === 'btn' || c === 'button' || c === 'cta' || /^btn[-_]/.test(c))) return 'button';
  return null;
}

interface Capture {
  depth: number;
  at: number;
  kind: FoundButton['kind'];
  words: string[];
  label: string;
  title: string;
  pictures: string[];
}

/** The end of a start tag that begins at `from` (after its name): the index of its ">", past quoted values. */
function tagEnd(html: string, from: number): number {
  let quote = '';
  for (let i = from; i < html.length; i++) {
    const ch = html[i]!;
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

const escapeAttr = (x: string) => x.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Every button and link in one drawing, in page order, with its name, and the drawing with each one marked
 * (data-sq-button="<name>"). A mark the drawing wrote itself is renamed first, so only squad-kit's marks count.
 */
export function findButtons(html: string): { buttons: FoundButton[]; marked: string } {
  const src = html.replace(/(\s)data-sq-button(\s*=|[\s>/])/gi, '$1data-was-sq-button$2');
  const stack: string[] = [];
  const found: { at: number; kind: FoundButton['kind']; name: string | null }[] = [];
  let cap: Capture | null = null;
  let svgDepth = -1;

  const finish = () => {
    if (!cap) return;
    const words = oneLine(cap.words.join(' '));
    const label = oneLine(cap.label);
    const title = oneLine(cap.title);
    const picture = oneLine(cap.pictures.join(' '));
    const name = hasWords(words) ? words : label || title || picture || null;
    found.push({ at: cap.at, kind: cap.kind, name });
    cap = null;
  };
  const text = (t: string) => {
    if (cap && svgDepth < 0) cap.words.push(t);
  };

  let i = 0;
  const n = src.length;
  const endTag = /<\/([a-zA-Z][a-zA-Z0-9:-]*)[^>]*>/y;
  const startTag = /<([a-zA-Z][a-zA-Z0-9:-]*)/y;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      text(src.slice(i));
      break;
    }
    if (lt > i) text(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      const end = src.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    endTag.lastIndex = lt;
    const close = endTag.exec(src);
    if (close) {
      i = endTag.lastIndex;
      const tag = close[1]!.toLowerCase();
      const at = stack.lastIndexOf(tag);
      if (at < 0) continue;
      stack.length = at;
      if (svgDepth >= stack.length) svgDepth = -1;
      if (cap && stack.length <= cap.depth) finish();
      continue;
    }
    startTag.lastIndex = lt;
    const open = startTag.exec(src);
    if (!open) {
      text('<');
      i = lt + 1;
      continue;
    }
    const tag = open[1]!.toLowerCase();
    const end = tagEnd(src, startTag.lastIndex);
    if (end < 0) break;
    const attrText = src.slice(startTag.lastIndex, end);
    const selfClosing = attrText.trimEnd().endsWith('/');
    const a = attributes(attrText);
    i = end + 1;
    if (RAW.has(tag)) {
      const closeAt = src.toLowerCase().indexOf(`</${tag}`, i);
      const inside = src.slice(i, closeAt < 0 ? n : closeAt);
      if (tag === 'title' && cap && svgDepth >= 0) cap.pictures.push(inside);
      const after = closeAt < 0 ? -1 : src.indexOf('>', closeAt);
      i = after < 0 ? n : after + 1;
      continue;
    }
    if (tag === 'svg' && svgDepth < 0 && !selfClosing) svgDepth = stack.length;
    if (cap) {
      if (tag === 'img' && a.alt) cap.pictures.push(a.alt);
      if (a['aria-label'] && !cap.label) cap.pictures.push(a['aria-label']);
    } else {
      const kind = kindOf(tag, a);
      if (kind) {
        // The mark goes just before the tag's ">" (or its "/>").
        const at = selfClosing ? src.lastIndexOf('/', end) : end;
        cap = { depth: stack.length, at, kind, words: tag === 'input' ? [a.value ?? ''] : [], label: a['aria-label'] ?? '', title: a.title ?? '', pictures: tag === 'input' && a.alt ? [a.alt] : [] };
      }
    }
    if (VOID.has(tag) || selfClosing) {
      if (cap && stack.length <= cap.depth) finish();
      continue;
    }
    stack.push(tag);
  }
  finish();

  // Names: the words found, else by kind and place; the same name twice on one page gets "2", "3" ….
  const used = new Map<string, number>();
  const unnamed = { button: 0, link: 0 };
  const buttons: FoundButton[] = [];
  const marks: { at: number; name: string }[] = [];
  for (const f of found) {
    let base = f.name?.slice(0, MAX_BUTTON_NAME).trim() || '';
    if (!base) base = f.kind === 'link' ? `Icon link ${++unnamed.link}` : `Icon button ${++unnamed.button}`;
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base} ${k}`;
    used.set(name.toLowerCase(), 1);
    buttons.push({ name, kind: f.kind });
    marks.push({ at: f.at, name });
  }
  let marked = src;
  for (const m of [...marks].sort((x, y) => y.at - x.at)) marked = `${marked.slice(0, m.at)} ${BUTTON_MARK}="${escapeAttr(m.name)}"${marked.slice(m.at)}`;
  return { buttons, marked };
}

/** A page laid out right to left: its html or body, or the first element in its body, says dir="rtl". */
export function isRightToLeft(html: string): boolean {
  const page = html.replace(/<!--[\s\S]*?-->/g, '');
  const rtl = (tag: string | undefined) => /\bdir\s*=\s*["']?rtl/i.test(tag ?? '');
  const body = /<body\b[^>]*>/i.exec(page);
  const inside = body ? page.slice(body.index + body[0].length) : page.replace(/^[\s\S]*?<\/head>/i, '');
  return rtl(/<html\b[^>]*>/i.exec(page)?.[0]) || rtl(body?.[0]) || rtl(/<[a-z][^>]*>/i.exec(inside)?.[0]);
}

/** One screen in the prototype: an approved screen at the version it was approved at. */
export interface PrototypeScreen {
  id: string;
  name: string;
  /** The version it was approved at. */
  version: number;
  /** Frame id → its drawing, with each button marked. */
  frames: Record<string, string>;
  /** Every button on it, in page order over its frames, each with the frames it is on. */
  buttons: (FoundButton & { frames: string[] })[];
  /** Its pages are laid out right to left (Arabic). */
  rtl: boolean;
}

/** Why a link does not work now. */
export type LinkProblem = 'button-gone' | 'screen-off';

export interface PrototypeMapLink {
  screen: string;
  /** The button's name, as its drawing names it now (or as saved, when it is gone). */
  button: string;
  to: LinkTarget;
  /** Working, or broken with why: Play skips a broken link. */
  broken?: LinkProblem;
  /** A short warning for a broken link. */
  warning?: string;
}

export interface PrototypeMap {
  screens: PrototypeScreen[];
  /** The links of the screens in the prototype, as saved, each working or broken. */
  links: PrototypeMapLink[];
  /** Where Play starts: the marked start while it is approved, else the first approved screen; null with none. */
  start: string | null;
  /** The start screen the person marked, as saved, approved now or not. */
  markedStart: string | null;
}

/** The prototype of a sketch, worked out from its screens and its prototype file. Writes nothing. */
export function prototypeMap(sketch: Sketch, file: PrototypeFile): PrototypeMap {
  const screens: PrototypeScreen[] = [];
  for (const s of sketch.screens) {
    if (s.status !== 'approved') continue;
    const version = s.approved?.version ?? s.chosen;
    const variant = s.variants.find((v) => v.version === version);
    if (!variant || version === null) continue;
    const frames: Record<string, string> = {};
    const buttons: PrototypeScreen['buttons'] = [];
    const order = [...sketch.frames.filter((f) => f in variant.frames), ...Object.keys(variant.frames).filter((f) => !sketch.frames.includes(f))];
    for (const f of order) {
      const page = findButtons(variant.frames[f]!);
      frames[f] = page.marked;
      for (const b of page.buttons) {
        const had = buttons.find((x) => x.name.toLowerCase() === b.name.toLowerCase());
        if (had) had.frames.push(f);
        else buttons.push({ ...b, frames: [f] });
      }
    }
    const first = order[0] ? variant.frames[order[0]]! : '';
    screens.push({ id: s.id, name: s.name, version, frames, buttons, rtl: isRightToLeft(first) });
  }
  const inPrototype = new Map(screens.map((s) => [s.id, s]));
  const nameOf = (id: string) => sketch.screens.find((s) => s.id === id)?.name ?? id;
  const links: PrototypeMapLink[] = [];
  for (const l of file.links) {
    const from = inPrototype.get(l.screen);
    if (!from) continue;
    const button = from.buttons.find((b) => buttonKey(from.id, b.name) === buttonKey(l.screen, l.button));
    if (!button) {
      links.push({ ...l, broken: 'button-gone', warning: `"${l.button}" is gone from ${from.name}. Pick its new button, or take the link away.` });
      continue;
    }
    if ('screen' in l.to && !inPrototype.has(l.to.screen)) {
      const exists = sketch.screens.some((s) => s.id === (l.to as { screen: string }).screen);
      links.push({ ...l, button: button.name, broken: 'screen-off', warning: exists ? `${nameOf(l.to.screen)} is not approved now, so this link is off.` : 'Its screen is gone from the sketch.' });
      continue;
    }
    links.push({ ...l, button: button.name });
  }
  const markedStart = file.start ?? null;
  const start = markedStart && inPrototype.has(markedStart) ? markedStart : (screens[0]?.id ?? null);
  return { screens, links, start, markedStart };
}
