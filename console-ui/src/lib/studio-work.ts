/* ── The AI Designer's work in progress (US-57, AB-182.1) ──
   While the Designer works, the board server sends its steps ("Read your message", "Planned 2 variants", "Drawing
   variant B: Form", "Saving"), in the language of the message, and one frame per variant or screen of the work, each
   "waiting", "drawing" or "done" with its finished drawing, before the one save at the end. A reply keeps its steps and
   its time, folded into one line ("6 steps, 2 min"). A reply that could not save keeps its drawings on this computer,
   "Not saved", until "Save them anyway". The marks on the page (Waiting, Drawing, Redrawing, Not saved) stay in English
   like the rest of the board. */

export type StepState = 'done' | 'now' | 'next' | 'stopped';

export interface ChatStepView {
  id?: string;
  words: string;
  state: StepState;
  /** Why it waits, in English. */
  detail?: string;
}

export type DraftState = 'waiting' | 'drawing' | 'done' | 'stopped';

/** One frame of the work: a variant (A, B, C) or one screen drawn or redrawn. */
export interface ChatDraftView {
  key: string;
  screen?: string;
  name: string;
  letter?: string;
  variantName?: string;
  redraw?: boolean;
  state: DraftState;
  /** The finished drawing, by frame. */
  pages?: Record<string, string>;
}

/** What the Designer is doing now: its words, since when, its steps and its frames. */
export interface ChatWorkingView {
  doing: string;
  since: string;
  language?: 'English' | 'Arabic';
  steps?: ChatStepView[];
  drafts?: ChatDraftView[];
}

/** A reply that could not save: its drawings kept on this computer. `gone` once they are not there any more. */
export interface UnsavedView {
  id: string;
  screens: string[];
  drafts?: ChatDraftView[];
  gone?: boolean;
}

/** What the page shows over a screen: the frames of the work going on, or the drawings kept "Not saved". */
export interface DraftsView {
  state: 'working' | 'not-saved';
  drafts: ChatDraftView[];
  /** The step going on now, for "Redrawing · …". */
  step?: string;
  /** The kept drawings, for "Save them anyway". */
  unsaved?: string;
}

/** The time so far, as a clock: "0:42", "2:05". */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** How long the work took, in a few words: "45 s", "2 min"; in Arabic for an Arabic reply. */
export function tookText(ms: number, rtl = false): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return rtl ? `${s} ثانية` : `${s} s`;
  const m = Math.round(s / 60);
  return rtl ? `${m} دقيقة` : `${m} min`;
}

/** The folded line under a reply: "6 steps, 2 min", or in Arabic "خطوات: 6، المدة: 2 دقيقة". */
export function foldText(steps: number, took: number, rtl = false): string {
  if (rtl) return `خطوات: ${steps}، المدة: ${tookText(took, true)}`;
  return `${steps} ${steps === 1 ? 'step' : 'steps'}, ${tookText(took)}`;
}

/** Where "Save them anyway" goes. */
export const saveAnywayPath = (chatsBase: string, chat: string, id: string) => `${chatsBase}/${encodeURIComponent(chat)}/unsaved/${encodeURIComponent(id)}/save`;

/**
 * The page's frames from a conversation: the work going on, or else the last reply's drawings kept "Not saved". Null
 * when there is nothing to show.
 */
export function draftsOf(
  working: ChatWorkingView | null | undefined,
  messages: { role: string; unsaved?: UnsavedView }[],
): DraftsView | null {
  if (working) {
    if (!working.drafts?.length) return null;
    const now = working.steps?.find((s) => s.state === 'now');
    return { state: 'working', drafts: working.drafts, ...(now ? { step: now.words } : {}) };
  }
  const last = [...messages].reverse().find((m) => m.role === 'designer');
  if (!last?.unsaved?.drafts?.length) return null;
  return { state: 'not-saved', drafts: last.unsaved.drafts, unsaved: last.unsaved.id };
}

/**
 * The frames that belong over one screen: those drawing it, or, when none do, those drawing a screen the sketch does
 * not have yet (shown over any screen, since a new one has no tab yet).
 */
export function draftsFor(view: DraftsView | null, screen: string | undefined, known: string[]): ChatDraftView[] {
  if (!view) return [];
  const mine = screen ? view.drafts.filter((d) => d.screen === screen) : [];
  if (mine.length) return mine;
  const fresh = view.drafts.filter((d) => !d.screen || !known.includes(d.screen));
  if (!fresh.length) return [];
  // One new screen at a time: the first one's frames.
  const first = fresh[0]!.screen ?? `new:${fresh[0]!.name}`;
  return fresh.filter((d) => (d.screen ?? `new:${d.name}`) === first);
}

/** A stable key for a drafts view, so the page is told only when something changed. */
export function draftsKey(view: DraftsView | null): string {
  if (!view) return '';
  return `${view.state}|${view.step ?? ''}|${view.unsaved ?? ''}|${view.drafts.map((d) => `${d.key}:${d.state}:${d.variantName ?? ''}`).join(',')}`;
}
