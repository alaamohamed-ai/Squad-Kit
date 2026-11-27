/**
 * A sketch's prototype on the board (US-54, US-58, AB-179.1, AB-183.1): what the board server sends, the words the
 * Prototype view and Play use, the arrows of the map, and how Play moves from screen to screen. The server works out the
 * screens with their options, the tabs ("In use", "Option A" …) and which links are broken on each tab; each drawing
 * comes with its buttons marked (data-sq-button="<name>"), so the board finds the same buttons the server named, on
 * Desktop and on Mobile. The tab picked stays in the open page only: it is never sent or saved (AB-127.1).
 */

import { sketchApiPath, sketchKey } from './studio';

export interface ProtoButton {
  name: string;
  kind: 'button' | 'link';
  /** The frames it is on. */
  frames: string[];
}

/** One drawing of a screen: its one drawing, or one of its options. */
export interface ProtoDrawing {
  version: number;
  /** Its option's letter, when the screen has options. */
  letter?: string;
  /** Its option's short name. */
  name?: string;
  /** Frame id → its page, with each button marked. */
  frames: Record<string, string>;
  buttons: ProtoButton[];
  rtl: boolean;
}

export interface ProtoScreen {
  id: string;
  name: string;
  /** The version in use: the approved one, else the one marked "Use this one". */
  version: number;
  /** Its options A first, or its one drawing. */
  drawings: ProtoDrawing[];
  /** Every button over all its drawings. */
  buttons: ProtoButton[];
  rtl: boolean;
}

export type LinkTarget = { screen: string } | { back: true };

export interface ProtoLink {
  screen: string;
  button: string;
  to: LinkTarget;
  broken?: 'button-gone' | 'screen-off';
  warning?: string;
}

/** One tab for the whole flow: "In use", or one option. */
export interface ProtoTab {
  id: string;
  label: string;
  /** Its screens in the screen order, each at the version this tab shows. */
  screens: { id: string; version: number }[];
  start: string | null;
  /** The links checked on this tab. */
  links: ProtoLink[];
}

export interface PrototypeData {
  sketch: { id: string; name: string; frames: string[]; stamp: string };
  /** Every screen with a drawing, in the screen order. */
  screens: ProtoScreen[];
  links: ProtoLink[];
  /** "In use" first, then one per option letter. */
  tabs: ProtoTab[];
  /** Where Play starts on "In use". */
  start: string | null;
  /** The start the person marked, in the prototype now or not. */
  markedStart: string | null;
  /** The screens not in the prototype, because they have no drawing yet. */
  left: { id: string; name: string }[];
  working: { since: string; doing: string } | null;
  problem: string | null;
}

export const prototypePath = (sketch: string) => `${sketchApiPath(sketch)}/prototype`;
export const prototypeKey = (project: string, sketch: string) => [...sketchKey(project, sketch), 'prototype'];

/** The attribute each found button carries in its drawing. */
export const BUTTON_MARK = 'data-sq-button';

export const GENERATE = 'Generate the prototype';
export const NO_SCREENS = 'Draw a screen to start the prototype';
export const REPLACE_TITLE = 'Replace the links?';
export const REPLACE_TEXT = 'The AI Designer links every button on every screen and option again. The links you have now, the ones you set by hand too, are replaced.';

/** The line on the left of the prototype's top row: "3 screens". It counts screens only. */
export function countLine(screens: unknown[]): string {
  if (!screens.length) return 'No screens yet';
  return `${screens.length} ${screens.length === 1 ? 'screen' : 'screens'}`;
}

/** The tab with this id, else "In use". */
export function tabOf(data: Pick<PrototypeData, 'tabs'>, id: string | null | undefined): ProtoTab {
  return data.tabs.find((t) => t.id === id) ?? data.tabs[0]!;
}

/** A tab's screens, each with the drawing it shows there. */
export function tabScreens(data: Pick<PrototypeData, 'screens'>, tab: ProtoTab): { screen: ProtoScreen; drawing: ProtoDrawing }[] {
  return tab.screens.flatMap((t) => {
    const screen = data.screens.find((s) => s.id === t.id);
    const drawing = screen?.drawings.find((d) => d.version === t.version);
    return screen && drawing ? [{ screen, drawing }] : [];
  });
}

/** A screen's options, in the client's words: "Option A", "Option B" …; empty for a screen with one drawing. */
export function optionsOf(screen: ProtoScreen): string[] {
  return screen.drawings.length > 1 ? screen.drawings.map((d) => `Option ${d.letter}`) : [];
}

/**
 * Play changes tab: it stays on the same screen when that screen is in the new tab; otherwise it goes to the tab's
 * start screen (the marked one when it is in the tab, else the tab's first).
 */
export function switchTab(history: string[], tab: ProtoTab): string[] {
  const current = history[history.length - 1];
  if (current && tab.screens.some((s) => s.id === current)) return history;
  const start = tab.start ?? tab.screens[0]?.id;
  return start ? [...history, start] : history;
}

const keyOf = (button: string) => button.trim().replace(/\s+/g, ' ').toLowerCase();

/** The link of one button on one screen, working or broken. */
export function linkOf(links: ProtoLink[], screen: string, button: string): ProtoLink | undefined {
  return links.find((l) => l.screen === screen && keyOf(l.button) === keyOf(button));
}

/** What a link's picker shows: "" for no link, "back", or "screen:<id>". */
export function pickValue(link: ProtoLink | undefined): string {
  if (!link) return '';
  return 'back' in link.to ? 'back' : `screen:${link.to.screen}`;
}

/** What a pick sends: the screen, Back, or no link (null). */
export function targetOfPick(value: string): LinkTarget | null {
  if (value === 'back') return { back: true };
  if (value.startsWith('screen:')) return { screen: value.slice('screen:'.length) };
  return null;
}

/** Where a link leads, in words: "Confirm", "Back", or "No link". */
export function targetText(link: ProtoLink | undefined, screens: { id: string; name: string }[]): string {
  if (!link) return 'No link';
  if ('back' in link.to) return 'Back';
  const to = (link.to as { screen: string }).screen;
  return screens.find((s) => s.id === to)?.name ?? to;
}

/**
 * One click in Play. `history` is the screens shown so far, the current one last. A working link to a screen goes
 * there; Back goes to the screen before that is in the tab (`inTab`; every screen when left out), and does nothing when
 * there is none. A broken link, or a button with no link, does nothing: null.
 */
export function playStep(history: string[], link: ProtoLink | undefined, inTab?: (screen: string) => boolean): string[] | null {
  if (!link || link.broken) return null;
  if ('back' in link.to) {
    for (let i = history.length - 2; i >= 0; i--) if (!inTab || inTab(history[i]!)) return history.slice(0, i + 1);
    return null;
  }
  return [...history, link.to.screen];
}

/** The buttons Play makes clickable on a screen: those with a working link. */
export function workingButtons(links: ProtoLink[], screen: string): string[] {
  return links.filter((l) => l.screen === screen && !l.broken).map((l) => l.button);
}

/* ── The map's arrows ── */

/** A screen's card on the map: its width, and the gap between two cards. */
export const CARD_W = 280;
export const CARD_GAP = 72;

export interface Arrow {
  screen: string;
  button: string;
  to: string;
  /** The SVG path, from the top of the card the button is on to the top of the card it leads to. */
  d: string;
  /** Where its label sits. */
  labelX: number;
  labelY: number;
}

/**
 * The arrows of the working links between screens, drawn above the cards: the farther apart two cards are, the
 * higher the arc. An arrow to the right leaves and arrives right of a card's middle, one to the left left of it, so
 * the two ways never sit on each other; a second link between the same two cards arcs higher. Right to left, the cards run
 * from the right, and the arrows with them. Back links have no card to point to: their button shows "Back".
 */
export function mapArrows(screens: { id: string }[], links: ProtoLink[], rtl = false): { arrows: Arrow[]; width: number; height: number } {
  const at = new Map(screens.map((s, i) => [s.id, i]));
  const width = Math.max(0, screens.length * CARD_W + (screens.length - 1) * CARD_GAP);
  const x = (i: number) => {
    const middle = i * (CARD_W + CARD_GAP) + CARD_W / 2;
    return rtl ? width - middle : middle;
  };
  const pairs = new Map<string, number>();
  const raw: (Omit<Arrow, 'd' | 'labelY'> & {
    x1: number;
    x2: number;
    h: number;
  })[] = [];
  for (const l of links) {
    if (l.broken || 'back' in l.to) continue;
    const from = at.get(l.screen);
    const to = at.get(l.to.screen);
    if (from === undefined || to === undefined || from === to) continue;
    const pair = `${Math.min(from, to)}:${Math.max(from, to)}:${to > from ? 1 : 0}`;
    const k = pairs.get(pair) ?? 0;
    pairs.set(pair, k + 1);
    const side = (to > from ? 1 : -1) * (rtl ? -1 : 1);
    const x1 = x(from) + side * 16;
    const x2 = x(to) + side * 16;
    const h = 30 + 26 * (Math.abs(to - from) - 1) + 20 * k + (to < from ? 26 : 0);
    raw.push({
      screen: l.screen,
      button: l.button,
      to: l.to.screen,
      x1,
      x2,
      h,
      labelX: (x1 + x2) / 2,
    });
  }
  const top = Math.max(0, ...raw.map((r) => r.h)) + 22;
  const height = raw.length ? top + 6 : 0;
  const base = height;
  return {
    width,
    height,
    arrows: raw.map((r) => ({
      screen: r.screen,
      button: r.button,
      to: r.to,
      d: `M ${r.x1} ${base} C ${r.x1} ${base - r.h * 1.33}, ${r.x2} ${base - r.h * 1.33}, ${r.x2} ${base}`,
      labelX: r.labelX,
      labelY: base - r.h - 4,
    })),
  };
}

/** The map is laid out right to left when most of its screens are. */
export const mapIsRtl = (screens: { rtl: boolean }[]) => screens.length > 0 && screens.filter((s) => s.rtl).length * 2 > screens.length;
