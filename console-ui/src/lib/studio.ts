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

/** When a change was made and by whom (AB-131.1): the person, or "AI Designer" for the person who asked. */
export interface EditMark {
  at: string;
  by?: string;
  for?: string;
}

/** What a sketch's card shows (US-06), as the server works it out. */
export interface SketchCardInfo {
  /** The first screen's chosen drawing and its views (desktop, mobile) to show, or null when it has none yet. */
  cover: { screen: string; version: number; views: string[] } | null;
  screens: number;
  /** Screens marked Approved; Ready ones do not count. */
  approved: number;
  designSystem: string | null;
  edited: EditMark | null;
}

/** One sketch in the list, as GET /api/v1/studio/sketches sends it: newest edit first. */
export interface SketchRow {
  id: string;
  name: string;
  designSystem: { id: string; version: number; name: string | null } | null;
  stamp: string;
  screens: { id: string; name: string }[];
  card?: SketchCardInfo;
}

export const SKETCHES_PATH = '/api/v1/studio/sketches';
/** A card's thumbnail: the first screen's HTML by view. It only reads. */
export const coverPath = (id: string) => `/api/v1/studio/sketches/${encodeURIComponent(id)}/cover`;

/** What GET …/cover sends: the HTML by view, or null fields when the first screen has no drawing yet. */
export interface SketchCover {
  screen: string | null;
  version: number | null;
  frames: Record<string, string>;
}

/** "3 screens", "1 screen", "No screens yet". */
export function screensText(n: number): string {
  if (!n) return 'No screens yet';
  return `${n} ${n === 1 ? 'screen' : 'screens'}`;
}

/** "2 of 5 approved", or null while none is approved: a card with none says nothing about approving. */
export function approvedText(approved: number, screens: number): string | null {
  return approved > 0 ? `${approved} of ${screens} approved` : null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "just now", "10 minutes ago", "2 hours ago", "yesterday", "3 days ago", "on 4 Oct". */
export function agoText(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${plural(Math.floor(s / 60), 'minute')} ago`;
  if (s < 86400) return `${plural(Math.floor(s / 3600), 'hour')} ago`;
  if (s < 2 * 86400) return 'yesterday';
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return `on ${new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(new Date(t).getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }) })}`;
}

/** "Edited 2 hours ago by Sara", "Edited 10 minutes ago by AI Designer for Sara"; empty with no mark. */
export function editedText(mark: EditMark | null | undefined, now = Date.now()): string {
  const when = mark ? agoText(mark.at, now) : '';
  if (!mark || !when) return '';
  const who = mark.by ? ` by ${mark.by}${mark.for ? ` for ${mark.for}` : ''}` : '';
  return `Edited ${when}${who}`;
}

/** The size each view of a thumbnail is drawn at, before it is made small. */
export const VIEW_SIZES: Record<string, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
};

/**
 * A drawing's HTML for a thumbnail: the board's frame is sandboxed with no scripts, and this policy, first in the
 * page, lets it reach no network either. Its own inline styles and data: pictures still show.
 */
export const THUMB_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

export function sealedHtml(html: string): string {
  // The policy always comes first, before anything the drawing says, so no comment or trick in it can come before it.
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${THUMB_POLICY}">${html.replace(/^\s*<!doctype[^>]*>/i, '')}`;
}
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

/* ── Rename, Duplicate and Delete a sketch (US-13, AB-138) ── */

/** One sketch on the board server: PATCH renames it, DELETE deletes it. Each brings the stamp it read (AB-129.1). */
export const sketchApiPath = (id: string) => `/api/v1/studio/sketches/${encodeURIComponent(id)}`;
export const duplicatePath = (id: string) => `${sketchApiPath(id)}/duplicate`;
/** Where one sketch is read for its workspace. */
export const sketchKey = (project: string, id: string) => ['studio', project, 'sketch', id];

/** What a delete answers: the sketch's name and how many screens went with it. */
export interface DeletedSketch {
  deleted: string;
  name: string;
  screens: number;
}

/** The delete confirmation's question and its line about the screens. */
export function deleteQuestion(name: string, screens: number): { title: string; holds: string } {
  return {
    title: `Delete "${name}"?`,
    holds: screens
      ? `It holds ${screens === 1 ? '1 screen' : `${screens} screens`}. ${screens === 1 ? 'It goes' : 'They go'} with it, every version too, and the sketch cannot be brought back.`
      : 'It holds no screens yet. The sketch cannot be brought back.',
  };
}

/** The sketch workspace's address, under the project's base. */
export const sketchPath = (id: string) => `/studio/sketches/${encodeURIComponent(id)}`;

/** What the AI Designer did with a message: only "changed" and "stopped" saved a version. */
export type ChatReplyKind = 'answer' | 'ask' | 'unavailable' | 'changed' | 'stopped' | 'failed';

/** One message of a chat, as the board server sends it. */
export interface ChatMessageView {
  role: 'person' | 'designer';
  text: string;
  at?: string;
  /** Addresses of the message's pictures, served from this computer's chat folder. */
  pictures: string[];
  kind?: ChatReplyKind;
  /** The screens (or components) a change saved, each with its new version. */
  saved?: { screen: string; name?: string; version?: number }[];
}

/* ── The chat with the AI Designer (US-52, AB-177) ── */

export type ChatOwnerKind = 'sketch' | 'design-system';

/** Where a sketch's or a design system's conversations are, on the board server. */
export const chatsPath = (kind: ChatOwnerKind, id: string) => `/api/v1/studio/${kind === 'sketch' ? 'sketches' : 'design-systems'}/${encodeURIComponent(id)}/chats`;
export const chatsKey = (project: string, kind: ChatOwnerKind, id: string) => ['studio', project, kind, id, 'chats'];

/** A conversation in the list, newest first. */
export interface ConversationRow {
  id: string;
  startedAt: string | null;
  messages: number;
  first: string | null;
  lastAt: string | null;
}

export interface ConversationList {
  conversations: ConversationRow[];
  /** The one the chat opens on: the newest. */
  current: string;
}

/** One conversation, and what the Designer is doing in it now, if anything. */
export interface ConversationData {
  id: string;
  owner: { kind: ChatOwnerKind; id: string; name: string };
  startedAt: string | null;
  messages: ChatMessageView[];
  working: { doing: string; since: string } | null;
}

/** Arabic text reads right to left: the direction of a message, from most of its letters. */
export function textDir(text: string): 'rtl' | 'ltr' {
  const arabic = (text.match(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return arabic > 0 && arabic >= latin ? 'rtl' : 'ltr';
}

/** What the Designer is looking at: "Booking / Form, desktop". */
export function lookingAtText(name: string, screen?: string | null, frame?: string | null): string {
  return `${name}${screen ? ` / ${screen}` : ''}${frame ? `, ${frame}` : ''}`;
}

/** A message's time, like 16:02. */
export function timeOf(at?: string | null): string {
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A conversation's name in the list: "Conversation 2 · 16 Nov, 16:02 · 4 messages". */
export function conversationLabel(row: ConversationRow, n: number): string {
  const d = row.startedAt ? new Date(row.startedAt) : null;
  const when = d && !Number.isNaN(d.getTime()) ? ` · ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${timeOf(row.startedAt)}` : '';
  return `Conversation ${n}${when} · ${row.messages === 1 ? '1 message' : `${row.messages} messages`}`;
}

/** Choices kept in this browser tab only (AB-127.1): the conversation, screen and frame picked, per sketch or design system. */
function readTab<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function saveTab(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows and full storage: the choice is just forgotten.
  }
}

export const pickedChatKey = (project: string, kind: ChatOwnerKind, id: string) => `squad-studio-chat:${project}:${kind}:${id}`;
export const readPickedChat = (project: string, kind: ChatOwnerKind, id: string) => readTab<string>(pickedChatKey(project, kind, id));
export const savePickedChat = (project: string, kind: ChatOwnerKind, id: string, chat: string) => saveTab(pickedChatKey(project, kind, id), chat);

/** The screen and frame shown in a sketch's workspace. */
export interface WorkspaceView {
  screen?: string;
  frame?: string;
}
export const workspaceViewKey = (project: string, sketch: string) => `squad-studio-view:${project}:${sketch}`;
export const readWorkspaceView = (project: string, sketch: string): WorkspaceView => readTab<WorkspaceView>(workspaceViewKey(project, sketch)) ?? {};
export const saveWorkspaceView = (project: string, sketch: string, view: WorkspaceView) => saveTab(workspaceViewKey(project, sketch), view);

/** One sketch read on its own, with each variant's HTML by frame. */
export interface SketchFull {
  id: string;
  name: string;
  designSystem: { id: string; version: number; name: string | null } | null;
  frames: string[];
  stamp: string;
  screens: { id: string; name: string; order: number; status: string; chosen: number | null; variants: { version: number; frames: string[]; madeAt?: string; madeBy?: string; html: Record<string, string> }[] }[];
}

/** One design system read on its own, with each version's components' HTML. */
export interface DesignSystemFull {
  id: string;
  name: string;
  isDefault: boolean;
  version: number;
  stamp: string;
  versions: { version: number; tokens: Record<string, unknown>; components: string[]; html: Record<string, string> }[];
}

export const designSystemPath = (id: string) => `/studio/design-systems/${encodeURIComponent(id)}`;
