import type { ScreenVariant, Sketch, SketchScreen } from './studio-read.js';
import type { LinkTarget, PrototypeFile } from './studio-prototype.js';
import { askVariantsOf, shownVariant } from './studio-export.js';

/**
 * The prototype's rules (US-54, US-58, AB-179.1, AB-183.1), worked out on read from what is saved, and writing nothing
 * (AB-127.1):
 *
 * - Its screens: every screen with a drawing, in the screen order, with one rule for every screen, approved or not:
 *   every option of the ask its drawing in use came from (A, B, C, grouped as the PDF export groups them), or its one
 *   drawing. The drawing in use is the one the Screens view shows as in use: an approved screen's approved version,
 *   else the one marked "Use this one" (AB-140.1). A screen with no drawing is left out.
 * - Its tabs, for the whole flow: "In use", every screen at its drawing in use, then "Option A", "Option B" …, each
 *   with only the screens that have a drawing of that letter, at it, so options are never mixed. A drawing with no
 *   letter is in "In use" only.
 * - Its buttons: every button and link in each drawing, named the same way on every frame, so one link works on Desktop
 *   and on Mobile: by its words; else its label, its title or its picture's text; else by its kind and place ("Icon
 *   button 2"). Arabic words count as words. Two buttons with the same words on one page are "Next" and "Next 2".
 * - Each link belongs to the screen and the button's name, so it is the same on every option. On each tab it is
 *   working, or broken where the drawing shown lacks its button or the screen it leads to is not in that tab. A broken
 *   link stays in the file, says why in a short warning, and Play skips it there.
 * - The start screen: the one the person marked while it is in the tab, else the tab's first screen.
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


/** One drawing of a screen in the prototype: its one drawing, or one of its options (A, B, C). */
export interface PrototypeDrawing {
  /** The saved version it shows. */
  version: number;
  /** Its option's letter (A, B, C), when it was drawn as a variant of an ask; left out on a drawing with no letter. */
  letter?: string;
  /** Its option's short name ("Split steps"), when it has one. */
  name?: string;
  /** Frame id → its page, with each button marked. */
  frames: Record<string, string>;
  /** Every button on it, in page order over its frames, each with the frames it is on. */
  buttons: (FoundButton & { frames: string[] })[];
  /** Its pages are laid out right to left (Arabic). */
  rtl: boolean;
}

/** One screen in the prototype: a screen with a drawing, approved or not, by the same rule. */
export interface PrototypeScreen {
  id: string;
  name: string;
  /** The version in use: the approved one, else the one marked "Use this one", as the Screens view shows it. */
  version: number;
  /** Its drawings: its options A first, or its one drawing. */
  drawings: PrototypeDrawing[];
  /** Every button over all its drawings, in page order, each once: a link belongs to the screen and the button's name. */
  buttons: (FoundButton & { frames: string[] })[];
  /** Its drawing in use is laid out right to left (Arabic). */
  rtl: boolean;
}

/** Why a link does not work: its button is not on the drawing shown, or the screen it leads to is not there. */
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

/** The tab "In use" holds every screen at its drawing in use. */
export const IN_USE_TAB = 'in-use';

/**
 * One tab of the prototype, for the whole flow: "In use", or one option's letter. Each holds its screens at the drawing
 * that tab shows, its own start screen, and the links checked on it.
 */
export interface PrototypeTab {
  /** "in-use", or the option's letter. */
  id: string;
  /** "In use", "Option B": the client's words, as the PDF export says them. */
  label: string;
  /**
   * Its screens in the screen order, each at the version this tab shows. "In use" holds every screen; an "Option" tab
   * only the screens with a drawing of that letter, at it, approved or not, one drawing or several (tabDrawing).
   */
  screens: { id: string; version: number }[];
  /** Where Play starts on this tab: the marked start when it is in the tab, else the tab's first screen. */
  start: string | null;
  /** The links of the screens in this tab, each working or broken on it. */
  links: PrototypeMapLink[];
}

export interface PrototypeMap {
  /** Every screen with a drawing, in the screen order. */
  screens: PrototypeScreen[];
  /** The links of the screens in the prototype, as saved: broken when no drawing has the button, or the screen is out. */
  links: PrototypeMapLink[];
  /** "In use" first, then one "Option" tab per letter any screen's drawings have. */
  tabs: PrototypeTab[];
  /** Where Play starts on "In use": the marked start while it is in the prototype, else the first screen; null with none. */
  start: string | null;
  /** The start screen the person marked, as saved, in the prototype now or not. */
  markedStart: string | null;
}

function drawingOf(sketch: Sketch, v: ScreenVariant): PrototypeDrawing {
  const frames: Record<string, string> = {};
  const buttons: PrototypeDrawing['buttons'] = [];
  const order = [...sketch.frames.filter((f) => f in v.frames), ...Object.keys(v.frames).filter((f) => !sketch.frames.includes(f))];
  for (const f of order) {
    const page = findButtons(v.frames[f]!);
    frames[f] = page.marked;
    for (const b of page.buttons) {
      const had = buttons.find((x) => x.name.toLowerCase() === b.name.toLowerCase());
      if (had) had.frames.push(f);
      else buttons.push({ ...b, frames: [f] });
    }
  }
  const first = order[0] ? v.frames[order[0]]! : '';
  return { version: v.version, ...(v.letter ? { letter: v.letter, ...(v.name ? { name: v.name } : {}) } : {}), frames, buttons, rtl: isRightToLeft(first) };
}

/**
 * One screen as the prototype holds it, or null when it has no drawing. One rule for every screen, approved or not: its
 * drawings are the options of the ask its drawing in use came from (each letter's newest, and the one in use for its
 * own letter, as the variant cards and the PDF export group them), or its one drawing.
 */
function screenOf(sketch: Sketch, s: SketchScreen): PrototypeScreen | null {
  const used = shownVariant(s);
  if (!used) return null;
  const asked = askVariantsOf(s, used);
  const drawings = (asked.length ? asked : [used]).map((v) => drawingOf(sketch, v));
  const buttons: PrototypeScreen['buttons'] = [];
  for (const d of drawings) {
    for (const b of d.buttons) {
      const had = buttons.find((x) => x.name.toLowerCase() === b.name.toLowerCase());
      if (had) had.frames = [...new Set([...had.frames, ...b.frames])];
      else buttons.push({ ...b, frames: [...b.frames] });
    }
  }
  const inUse = drawings.find((d) => d.version === used.version)!;
  return { id: s.id, name: s.name, version: used.version, drawings, buttons, rtl: inUse.rtl };
}

/** The drawing a tab shows of a screen, or undefined when the screen is left out of it. */
export function tabDrawing(screen: PrototypeScreen, tab: string): PrototypeDrawing | undefined {
  if (tab === IN_USE_TAB) return screen.drawings.find((d) => d.version === screen.version);
  // Only in the tab of its own letter: a drawing with no letter is in "In use" only.
  return screen.drawings.find((d) => d.letter === tab);
}

const sameButton = (screen: string, a: string, b: string) => buttonKey(screen, a) === buttonKey(screen, b);

/**
 * The prototype of a sketch, worked out from its screens and its prototype file (US-54, US-58). Writes nothing.
 *
 * - Its screens: every screen with a drawing, approved or not, by one rule, in the screen order (screenOf).
 * - Its tabs: "In use" holds every screen at its drawing in use; then one "Option" tab per letter, holding only the
 *   screens with a drawing of that letter, at it, so options are never mixed.
 * - Each link, on each tab: broken where the drawing shown lacks its button, or where the screen it leads to is not in
 *   that tab. Play skips it there.
 */
export function prototypeMap(sketch: Sketch, file: PrototypeFile): PrototypeMap {
  const screens = sketch.screens.map((s) => screenOf(sketch, s)).filter((s): s is PrototypeScreen => s !== null);
  const inPrototype = new Map(screens.map((s) => [s.id, s]));
  const nameOf = (id: string) => sketch.screens.find((s) => s.id === id)?.name;
  const outWarning = (id: string) => {
    const name = nameOf(id);
    return name ? `${name} has no drawing yet, so this link is off.` : 'Its screen is gone from the sketch.';
  };

  const links: PrototypeMapLink[] = [];
  for (const l of file.links) {
    const from = inPrototype.get(l.screen);
    if (!from) continue;
    const button = from.buttons.find((b) => sameButton(from.id, b.name, l.button));
    if (!button) {
      links.push({ ...l, broken: 'button-gone', warning: `"${l.button}" is gone from ${from.name}. Pick its new button, or take the link away.` });
      continue;
    }
    if ('screen' in l.to && !inPrototype.has(l.to.screen)) {
      links.push({ ...l, button: button.name, broken: 'screen-off', warning: outWarning(l.to.screen) });
      continue;
    }
    links.push({ ...l, button: button.name });
  }

  const letters = [...new Set(screens.flatMap((s) => s.drawings.flatMap((d) => (d.letter ? [d.letter] : []))))].sort((a, b) => a.localeCompare(b));
  const markedStart = file.start ?? null;
  const tabs: PrototypeTab[] = [IN_USE_TAB, ...letters].map((id) => {
    const label = id === IN_USE_TAB ? 'In use' : `Option ${id}`;
    const shown = screens.flatMap((s) => {
      const d = tabDrawing(s, id);
      return d ? [{ screen: s, drawing: d }] : [];
    });
    const inTab = new Set(shown.map((x) => x.screen.id));
    const tabLinks: PrototypeMapLink[] = [];
    for (const l of links) {
      const at = shown.find((x) => x.screen.id === l.screen);
      if (!at) continue;
      // Broken on every tab: no drawing has its button, or the screen it leads to is not in the prototype.
      if (l.broken) {
        tabLinks.push(l);
        continue;
      }
      const where = at.screen.drawings.length > 1 ? `${at.drawing.letter ? `Option ${at.drawing.letter}` : 'this option'} of ${at.screen.name}` : at.screen.name;
      if (!at.drawing.buttons.some((b) => sameButton(l.screen, b.name, l.button))) {
        tabLinks.push({ ...l, broken: 'button-gone', warning: `"${l.button}" is not on ${where}, so Play skips it here.` });
        continue;
      }
      if ('screen' in l.to && !inTab.has(l.to.screen)) {
        tabLinks.push({ ...l, broken: 'screen-off', warning: `${nameOf(l.to.screen) ?? l.to.screen} has no ${label}, so this link is off here.` });
        continue;
      }
      tabLinks.push(l);
    }
    const start = markedStart && inTab.has(markedStart) ? markedStart : (shown[0]?.screen.id ?? null);
    return { id, label, screens: shown.map((x) => ({ id: x.screen.id, version: x.drawing.version })), start, links: tabLinks };
  });
  return { screens, links, tabs, start: tabs[0]!.start, markedStart };
}
