/**
 * The Studio's last tab, one per project, kept in this browser tab's own memory (sessionStorage, AB-127.1): it lasts
 * through a reload and ends when squad-kit's tab closes. Nothing goes to the board server or the project's files: those
 * appear only when the person makes a sketch or a design system.
 *
 * The Design systems tab reads its cards from the board server, and only reads: it saves nothing.
 */

export type StudioTab = 'sketches' | 'systems';

export const STUDIO_TABS: { id: StudioTab; label: string }[] = [
  { id: 'sketches', label: 'Sketches' },
  { id: 'systems', label: 'Design systems' },
];

/** Where one project's last tab is kept. */
export const studioTabKey = (project: string) => `squad-studio-tab:${project}`;

const isTab = (v: unknown): v is StudioTab => STUDIO_TABS.some((t) => t.id === v);

/** The tab this project's Studio opens on: Sketches the first time, and when the saved value is unknown or unreadable. */
export function readStudioTab(project: string): StudioTab {
  try {
    const saved = sessionStorage.getItem(studioTabKey(project));
    return isTab(saved) ? saved : 'sketches';
  } catch {
    return 'sketches';
  }
}

/** Keeps the tab the person chose for this project. A browser that refuses storage just forgets it. */
export function saveStudioTab(project: string, tab: StudioTab): void {
  try {
    sessionStorage.setItem(studioTabKey(project), tab);
  } catch {
    // Private windows and full storage: the Studio opens on Sketches next time.
  }
}

/* ── The Design systems tab (US-33, AB-158) ── */

/** One card, as GET /api/v1/studio/design-systems sends it. */
export interface DesignSystemCard {
  id: string;
  name: string;
  /** The project's one default, worked out on the server (AB-158.1): only one card is ever true. */
  isDefault: boolean;
  version: number;
  colors: string[];
  /** How many sketches follow it. */
  sketches: number;
}

export interface DesignSystemList {
  /** The default first, then the others in the order they were made. */
  designSystems: DesignSystemCard[];
  default: { id: string; name: string; version: number } | null;
}

export const DESIGN_SYSTEMS_PATH = '/api/v1/studio/design-systems';

/**
 * A colour the page paints as it is: #hex, or rgb(), hsl(), hwb(), lab(), lch(), oklab() and oklch() with numbers in
 * them, the same check the server makes. Anything else is left out, so a token can never put a url() in the page.
 */
const COLOR = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?=[^)]*\d)(?:[\d.%\s,/+-]|deg|g?rad|turn|none)*\))$/i;

export function isColorValue(x: unknown): x is string {
  return typeof x === 'string' && x.length <= 80 && COLOR.test(x.trim());
}

/** "Used by 4 sketches", "Used by 1 sketch", "Not used by any sketch yet". */
export function usedByText(sketches: number): string {
  if (!sketches) return 'Not used by any sketch yet';
  return `Used by ${sketches} ${sketches === 1 ? 'sketch' : 'sketches'}`;
}
