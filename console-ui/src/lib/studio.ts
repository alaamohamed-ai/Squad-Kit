/**
 * The Studio's last tab, one per project, kept in this browser tab's own memory (sessionStorage, AB-127.1): it lasts
 * through a reload and ends when squad-kit's tab closes. Nothing goes to the board server or the project's files: those
 * appear only when the person makes a sketch or a design system.
 *
 * The Design systems tab reads its cards from the board server, and only reads: it saves nothing. The Sketches tab
 * reads the sketches; with none it shows the start page (US-05), where only Send makes something: the sketch.
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

/* ── The Sketches tab and its start page (US-05, AB-130) ── */

/** One sketch in the list, as GET /api/v1/studio/sketches sends it. */
export interface SketchRow {
  id: string;
  name: string;
  designSystem: { id: string; version: number; name: string | null } | null;
  stamp: string;
  screens: { id: string; name: string }[];
}

export const SKETCHES_PATH = '/api/v1/studio/sketches';
/** Sending the first message: it makes the sketch and keeps the message with its chat on this computer. */
export const START_SKETCH_PATH = '/api/v1/studio/sketches/start';
/** GET says whether a picture of the running app can be taken, and why not; POST takes one. */
export const APP_PICTURE_PATH = '/api/v1/studio/app-picture';

/** The query keys the Studio's lists are read under, so a new sketch shows in them at once. */
export const sketchesKey = (project: string) => ['studio', project, 'sketches'];
export const designSystemsKey = (project: string) => ['studio', project, 'design-systems'];

/** The same three example prompts in every project: a click fills the chat box, it never sends. */
export const EXAMPLE_PROMPTS = ['A login page in Arabic and English', "An admin dashboard with today's visits", 'A profile page for patients'] as const;

/** A picture added to a message: kept in the browser as a data address until Send (AB-130.1). */
export interface MessagePicture {
  name: string;
  type: string;
  /** data:image/…;base64,… */
  data: string;
}

export const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_PICTURES = 4;
export const MAX_PICTURE_BYTES = 10 * 1024 * 1024;

/** Why a picked file cannot be added, in plain words, or null when it can. `count` is how many are added already. */
export function pictureProblem(file: { name: string; type: string; size: number }, count: number): string | null {
  if (count >= MAX_PICTURES) return `Add at most ${MAX_PICTURES} pictures to one message.`;
  if (!(PICTURE_TYPES as readonly string[]).includes(file.type)) return `"${file.name}" is not a PNG, JPEG or WebP picture.`;
  if (file.size > MAX_PICTURE_BYTES) return `"${file.name}" is larger than 10 MB.`;
  return null;
}

/** Whether a picture of the project's running app can be added, as GET /api/v1/studio/app-picture says. */
export interface AppPictureOption {
  ok: boolean;
  /** Why not, in one plain sentence. */
  why?: string;
  /** The app the picture is of. */
  app?: string;
}

/** What Send gives back: the new sketch, whose workspace opens next. */
export interface StartedSketch {
  id: string;
  name: string;
}

/** The sketch workspace's address, under the project's base. */
export const sketchPath = (id: string) => `/studio/sketches/${encodeURIComponent(id)}`;

/** One message of a sketch's chat, as GET /api/v1/studio/sketches/<id>/chat sends it. */
export interface ChatMessageView {
  role: 'person' | 'designer';
  text: string;
  at?: string;
  /** Addresses of the message's pictures, served from this computer's chat folder. */
  pictures: string[];
}
