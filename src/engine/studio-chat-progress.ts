import type { ChatStepMark } from '../board/studio.js';
import type { ChatLanguage } from './studio-chat-prompts.js';

/**
 * The work in progress of one chat message with the AI Designer (US-57, AB-182.1), kept in the running answer's memory
 * only: the project stays untouched until the one save at the end. It holds the steps ("Read your message", "Planned 2
 * variants", "Drawing variant B: Form", "Saving"), each in the language of the message, and one frame per variant or
 * screen of the work (A, B, C), "waiting", "drawing" or "done" with its finished drawing. The board reads it with the
 * conversation (studio-chat-runs.ts), so each drawing shows on the page as soon as it is done. When the answer ends, its
 * steps and its time are kept on the reply in the chat on this computer, so the folded line "6 steps, 2 min" stays.
 * Later stories that make the Designer do longer work report their steps and drafts here the same way.
 */

export type StepState = 'done' | 'now' | 'next' | 'stopped';

/** One step as the board shows it. `detail` says why it waits, in English only, like the rest of the board. */
export interface ChatStep {
  id: string;
  words: string;
  state: StepState;
  detail?: string;
}

export type DraftState = 'waiting' | 'drawing' | 'done' | 'stopped';

/** One frame of the work: a variant of a screen (A, B, C), or one screen drawn or redrawn. */
export interface ChatDraft {
  key: string;
  /** The screen it draws, when the sketch has it. */
  screen?: string;
  name: string;
  /** A variant's letter. */
  letter?: string;
  /** A variant's short name, once drawn. */
  variantName?: string;
  /** An existing screen changed: its current drawing shows as "Redrawing" until this one is done. */
  redraw?: boolean;
  state: DraftState;
  /** The finished drawing, by frame. */
  pages?: Record<string, string>;
}

/** What the board reads while the Designer works. */
export interface ChatWorkView {
  since: string;
  language: ChatLanguage;
  steps: ChatStep[];
  drafts: ChatDraft[];
}

/** One piece of the plan: a frame on the page. */
export interface DraftPlan {
  key: string;
  screen?: string;
  name: string;
  letter?: string;
  redraw?: boolean;
}

interface Step {
  id: string;
  now: string;
  done: string;
  state: StepState;
  detail?: string;
}

type Pair = [now: string, done: string];

const STEP_WORDS: Record<
  ChatLanguage,
  {
    read: Pair;
    wait: Pair;
    planned: (n: number, variants: boolean) => string;
    variant: (letter: string, screen: string) => Pair;
    change: (screen: string) => Pair;
    draw: (screen: string) => Pair;
    system: Pair;
    save: Pair;
    notSaved: string;
  }
> = {
  English: {
    read: ['Reading your message', 'Read your message'],
    wait: ['Waiting for a free place', 'Waited for a free place'],
    planned: (n, variants) => `Planned ${n} ${variants ? (n === 1 ? 'variant' : 'variants') : n === 1 ? 'screen' : 'screens'}`,
    variant: (letter, screen) => [`Drawing variant ${letter}: ${screen}`, `Drew variant ${letter}: ${screen}`],
    change: (screen) => [`Redrawing ${screen}`, `Redrew ${screen}`],
    draw: (screen) => [`Drawing ${screen}`, `Drew ${screen}`],
    system: ['Changing the design system', 'Changed the design system'],
    save: ['Saving', 'Saved'],
    notSaved: 'Not saved: changed elsewhere',
  },
  Arabic: {
    read: ['أقرأ رسالتك', 'قرأت رسالتك'],
    wait: ['أنتظر مكانًا متاحًا', 'انتظرت مكانًا متاحًا'],
    planned: (n, variants) => (variants ? `خطّطت لعدد ${n} من النسخ` : `خطّطت لعدد ${n} من الشاشات`),
    variant: (letter, screen) => [`أرسم النسخة ${letter} من "${screen}"`, `رسمت النسخة ${letter} من "${screen}"`],
    change: (screen) => [`أعيد رسم "${screen}"`, `أعدت رسم "${screen}"`],
    draw: (screen) => [`أرسم "${screen}"`, `رسمت "${screen}"`],
    system: ['أغيّر نظام التصميم', 'غيّرت نظام التصميم'],
    save: ['أحفظ', 'حفظت'],
    notSaved: 'لم تُحفظ: تغيّرت في مكان آخر',
  },
};

export class ChatProgress {
  readonly since: string;
  private readonly started: number;
  private readonly W: (typeof STEP_WORDS)[ChatLanguage];
  private steps: Step[];
  private drafts: ChatDraft[] = [];

  constructor(
    readonly language: ChatLanguage,
    at = new Date(),
  ) {
    this.since = at.toISOString();
    this.started = at.getTime();
    this.W = STEP_WORDS[language];
    this.steps = [this.step('read', this.W.read, 'now')];
  }

  private step(id: string, [now, done]: Pair, state: StepState): Step {
    return { id, now, done, state };
  }

  private find(id: string): Step | undefined {
    return this.steps.find((s) => s.id === id);
  }

  private set(id: string, state: StepState): void {
    const s = this.find(id);
    if (s && s.state !== 'done') s.state = state;
  }

  /** The run waits for a place in the app's one limit (AB-141.1): its own step, before reading. */
  waiting(reason: string): void {
    let w = this.find('wait');
    if (!w) {
      w = this.step('wait', this.W.wait, 'now');
      this.steps.unshift(w);
      this.set('read', 'next');
    }
    if (this.language === 'English' && reason.trim()) w.detail = reason.trim();
  }

  /** The place is taken: reading starts. */
  placeTaken(): void {
    if (this.find('wait')?.state !== 'now') return;
    this.set('wait', 'done');
    this.set('read', 'now');
  }

  /** The message is read and sorted. */
  read(): void {
    this.placeTaken();
    this.set('read', 'done');
  }

  /** The plan: one frame per variant or screen, all "waiting", each with its drawing step, and the save after them. */
  plan(items: DraftPlan[], variants: boolean): void {
    this.read();
    this.steps.push({ id: 'plan', now: '', done: this.W.planned(items.length, variants), state: 'done' });
    for (const it of items) {
      const words = it.letter ? this.W.variant(it.letter, it.name) : it.redraw ? this.W.change(it.name) : this.W.draw(it.name);
      this.steps.push(this.step(`draw:${it.key}`, words, 'next'));
      this.drafts.push({ key: it.key, ...(it.screen ? { screen: it.screen } : {}), name: it.name, ...(it.letter ? { letter: it.letter } : {}), ...(it.redraw ? { redraw: true } : {}), state: 'waiting' });
    }
    this.steps.push(this.step('save', this.W.save, 'next'));
  }

  /** A design system is changed: one step, then the save. */
  system(): void {
    this.read();
    this.steps.push(this.step('system', this.W.system, 'now'), this.step('save', this.W.save, 'next'));
  }

  systemDone(): void {
    this.set('system', 'done');
  }

  /** One frame starts drawing. */
  start(key: string): void {
    this.set(`draw:${key}`, 'now');
    const d = this.drafts.find((x) => x.key === key);
    if (d) d.state = 'drawing';
  }

  /** One frame is done: its drawing shows in its frame before the one save at the end. */
  finish(key: string, pages: Record<string, string>, variantName?: string): void {
    this.set(`draw:${key}`, 'done');
    const d = this.drafts.find((x) => x.key === key);
    if (!d) return;
    d.state = 'done';
    d.pages = { ...pages };
    if (variantName) d.variantName = variantName;
  }

  saving(): void {
    this.set('save', 'now');
  }

  /**
   * The answer ends: saved, or not. What is not done is left as stopped: after Stop, the frames still waiting or drawing
   * are not kept. Kept with the chat ("Not saved"), the save step says so.
   */
  end(outcome: 'saved' | 'kept' | 'other'): void {
    if (outcome === 'saved') this.set('save', 'done');
    if (outcome === 'kept') {
      const s = this.find('save');
      if (s) s.now = this.W.notSaved;
    }
    for (const s of this.steps) if (s.state === 'now' || s.state === 'next') s.state = 'stopped';
    for (const d of this.drafts) if (d.state !== 'done') d.state = 'stopped';
  }

  /** The finished frames' drawings, by key. */
  finished(): ChatDraft[] {
    return this.drafts.filter((d) => d.state === 'done');
  }

  private wordsOf(s: Step): string {
    return s.state === 'done' ? s.done : s.now;
  }

  view(): ChatWorkView {
    return {
      since: this.since,
      language: this.language,
      steps: this.steps.map((s) => ({ id: s.id, words: this.wordsOf(s), state: s.state, ...(s.detail ? { detail: s.detail } : {}) })),
      drafts: this.drafts.map((d) => ({ ...d, ...(d.pages ? { pages: { ...d.pages } } : {}) })),
    };
  }

  /**
   * What the reply keeps (AB-182.1): its steps and how long the work took, so the folded line stays after a reload. A
   * plain answer with nothing but reading keeps nothing.
   */
  kept(at = new Date()): { steps: ChatStepMark[]; took: number } | null {
    if (this.steps.length < 2) return null;
    return { steps: this.steps.map((s) => ({ words: this.wordsOf(s), state: s.state === 'done' ? 'done' : 'stopped' })), took: Math.max(0, at.getTime() - this.started) };
  }
}

/** The frame key of a piece of work: its screen, or the new screen's name, and a variant's letter. */
export function draftKey(w: { screen?: string; name: string }, letter?: string): string {
  return `${w.screen ?? `new:${w.name.trim().toLowerCase()}`}${letter ? `:${letter}` : ''}`;
}

/**
 * The plan of an ask for variants (US-17): each screen of the work `each` times, A, B, C, in drawing order. A started
 * sketch's one first screen (`single`) is one screen, not a variant.
 */
export function planVariants(p: ChatProgress | undefined, work: { screen?: string; name: string }[], letters: readonly string[], single: boolean): void {
  p?.plan(
    work.flatMap((w) => letters.map((l) => ({ key: draftKey(w, l), ...(w.screen ? { screen: w.screen } : {}), name: w.name, ...(single ? {} : { letter: l }) }))),
    !single,
  );
}

/** The plan of a change: one frame per screen, one with a drawing redrawn, a new or empty one drawn. */
export function planScreens(p: ChatProgress | undefined, work: { screen?: string; name: string; redraw?: boolean }[]): void {
  p?.plan(
    work.map((w) => ({ key: draftKey(w), ...(w.screen ? { screen: w.screen } : {}), ...(w.screen && w.redraw ? { redraw: true } : {}), name: w.name })),
    false,
  );
}
