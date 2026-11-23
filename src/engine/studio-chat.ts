import { readMeta, type BoardPaths } from '../board/store.js';
import {
  AI_DESIGNER,
  CHANGED_ELSEWHERE,
  StudioChangedElsewhere,
  duplicateSketch,
  nameSketchAndFirstScreen,
  newAskId,
  pickVariant,
  readDesignSystem,
  readSketch,
  saveAskVariants,
  saveDesignSystem,
  saveDrawnScreens,
  saveSketch,
  screenNameKey,
  studioIdFor,
  studioStamp,
  variantOfLetter,
  type AskScreen,
  type ChatOwner,
  type ChatReplyKind,
  type DrawnScreen,
  type Sketch,
  type StudioChatMessage,
} from '../board/studio.js';
import {
  addChatMessage,
  addPersonMessage,
  chatOwnerName,
  conversationSession,
  currentConversation,
  messagePictureFiles,
  picksSinceReply,
  readConversation,
  saveConversationSession,
} from '../board/studio-chats.js';
import { checkedStudioId, designSystemVersionDir } from '../board/studio-paths.js';
import { markSketchNamed, startMarkOf, type StartPicture } from '../board/studio-start.js';
import type { AgentResult } from '../modules/ai-tool/types.js';
import { screensProblem } from './answers.js';
import { answerAgainPrompt } from './prompts.js';
import { demoWorker } from './studio-chat-demo.js';
import { SCREENS_SCHEMA, type DesignerAnswer } from './studio-prompts.js';
import {
  DEFAULT_ASK_VARIANTS,
  SORT_SCHEMA,
  VARIANT_LETTERS,
  VARIANT_SCHEMA,
  chatScreenPrompt,
  chatSortPrompt,
  chatSystemPrompt,
  isSketchAction,
  languageOf,
  sortProblem,
  variantProblem,
  variantsAsked,
  type ChatBrief,
  type ChatLanguage,
  type ChatSort,
  type ScreenAsk,
} from './studio-chat-prompts.js';
import { openDesigner, refusedWords, type DesignerOptions } from './studio-designer.js';
import { chosenFiles, flowOf, relative, startOf, workOf, type Work } from './studio-chat-work.js';

export { flowOf } from './studio-chat-work.js';

/**
 * One chat message with the AI Designer (US-52, AB-177.1). The person's message is kept first, then the Designer
 * sorts it: an answer, one short question back, a plain "not available yet", or a change from the Studio's list of
 * actions. Only a change makes a version: the Designer does it one screen at a time in the same session, saying
 * "Changing screen 2 of 2", and the finished screens are saved together as one new version with the stamp read when
 * the message was sent, so a teammate's change in between is refused with "Changed elsewhere, reload". Stop keeps the
 * finished screens. Every run goes through the one Designer runner (AB-141.1); a sample board answers with a few
 * fixed replies instead (studio-chat-demo.ts). The board and `squad studio chat` both call this.
 *
 * Rename and Duplicate (US-13) are on the same list: the Designer does them through the same store calls as the card
 * menu. Delete never is: the reply points to the card menu, so the person always sees the confirmation.
 *
 * A sketch started from the start page (US-08): its first turn also suggests the sketch's name and its first screen's
 * name, saved at once through the one free-name helper (AB-138.1) under the turn's stamp, marked as the AI Designer's
 * work. Questions come back without drawing. Otherwise, and on a later turn while nothing is drawn yet, the first screen
 * is drawn once per variant asked for, in the sketch's frames; Stop keeps the variants already finished.
 */

/** The longest conversation so far a fresh session reads, in messages. */
const EARLIER_MESSAGES = 20;

export interface ChatAsk {
  owner: ChatOwner;
  /** The conversation; left out, the current one. */
  chat?: string;
  /** The person's words. Left out, the conversation's last message is answered, when it is theirs and unanswered. */
  text?: string;
  pictures?: StartPicture[];
  lookingAt?: { screen?: string; frame?: string };
  /** The stamp the person read; left out, the one read now. A change is saved only with it. */
  stamp?: string;
  /**
   * "Skip" on the "no design system" alert (US-17): this one message draws its variants in plain styles. It holds for
   * this message only: the next ask for variants shows the alert again.
   */
  plainStyles?: boolean;
}

/** A message kept and ready for the Designer. */
export interface ChatTurn {
  owner: ChatOwner;
  chat: string;
  text: string;
  pictures: string[];
  lookingAt?: { screen?: string; frame?: string };
  stamp: string | null;
  language: ChatLanguage;
  /** The messages before this one. */
  earlier: { role: 'person' | 'designer'; text: string }[];
  /** Variants are drawn in plain styles with no design system, this once (US-17). */
  plainStyles?: boolean;
  /** The picks made with "Use this one" since the Designer's last reply (US-18), as it is told about them. */
  picked?: string[];
}

export interface ChatOptions extends DesignerOptions {
  /** What the Designer is doing now, in a few words: "Changing screen 2 of 2: Confirmation". */
  onProgress?(words: string): void;
}

const WORDS: Record<
  ChatLanguage,
  {
    changed: (list: string) => string;
    stopped: (list: string) => string;
    stoppedNothing: string;
    systemChanged: (v: number) => string;
    partly: (why: string) => string;
    renamed: (from: string, to: string) => string;
    duplicated: (copy: string, screens: number, from: string) => string;
    deleteHere: string;
    named: (sketch: string, screen: string) => string;
    screenNamed: (screen: string) => string;
    drewVariants: (n: number, screen: string | null, list: string) => string;
    stoppedVariants: (list: string) => string;
    offTokens: (variant: string, system: string, values: string) => string;
    plainStyles: string;
    needsDesignSystem: (sketch: string) => string;
    picked: (screen: string, variant: string) => string;
    noVariant: (screen: string, variant: string) => string;
    noScreen: (screen: string) => string;
    approved: (screens: string[]) => string;
  }
> = {
  English: {
    drewVariants: (n, screen, list) =>
      screen
        ? `Done. ${n === 1 ? `1 variant of ${screen} is drawn` : `${n} variants of ${screen} are drawn`}: ${list}. Variant A is in use; pick another with "Use this one".`
        : `Done. ${n} variants are drawn: ${list}. Each screen uses its variant A; pick another with "Use this one".`,
    stoppedVariants: (list) => `Stopped. The finished variants are kept: ${list}. Nothing half drawn was saved.`,
    offTokens: (variant, system, values) => `${variant} uses what "${system}" does not have: ${values}.`,
    plainStyles: 'Drawn in plain styles: the sketch has no design system.',
    needsDesignSystem: (sketch) => `"${sketch}" has no design system selected, so I drew nothing. Select one, then ask again, so the variants use its colors, fonts and sizes. Or skip to draw them in plain styles this once.`,
    picked: (screen, variant) => `Done. ${screen} now uses variant ${variant}. The other variants stay.`,
    noVariant: (screen, variant) => `${screen} has no variant ${variant}. Nothing changed.`,
    noScreen: (screen) => `The sketch has no screen "${screen}". Nothing changed.`,
    approved: (s) => (s.length === 1 ? `${s[0]} is approved, so I did not change it. Reopen it first.` : `${s.slice(0, -1).join(', ')} and ${s[s.length - 1]} are approved, so I did not change them. Reopen them first.`),
    named: (sketch, screen) => `I named the sketch "${sketch}" and its first screen "${screen}". You can rename both later.`,
    screenNamed: (screen) => `I named the new screen "${screen}". You can rename it later.`,
    renamed: (from, to) => `Done. "${from}" is now called "${to}".`,
    duplicated: (copy, n, from) => `Done. I made "${copy}" with ${n === 1 ? '1 screen' : `${n} screens`}, all Draft, and no conversation. "${from}" is unchanged.`,
    deleteHere: "To delete a sketch, use Delete in its ⋯ menu on the Sketches page: it asks first and says how many screens go with it.",
    changed: (list) => `Done. New versions: ${list}.`,
    stopped: (list) => `Stopped. The finished screens are kept as a new version: ${list}.`,
    stoppedNothing: 'Stopped before anything was finished. Nothing changed.',
    systemChanged: (v) => `Done. The design system is now version ${v}.`,
    partly: (why) => `The rest did not get done: ${why}`,
  },
  Arabic: {
    drewVariants: (n, screen, list) =>
      screen
        ? `تم. رسمت ${n} من نسخ "${screen}": ${list}. النسخة A هي المستخدمة؛ اختر غيرها بزر «Use this one».`
        : `تم. رسمت ${n} من النسخ: ${list}. كل شاشة تستخدم نسختها A؛ اختر غيرها بزر «Use this one».`,
    stoppedVariants: (list) => `توقفت. النسخ التي انتهت محفوظة: ${list}. لم يُحفظ شيء نصف مرسوم.`,
    offTokens: (variant, system, values) => `النسخة ${variant} تستخدم ما ليس في "${system}": ${values}.`,
    plainStyles: 'رسمتها بأنماط بسيطة: لا نظام تصميم لهذا المخطط.',
    needsDesignSystem: (sketch) => `لم يُختر نظام تصميم للمخطط "${sketch}"، فلم أرسم شيئًا. اختر نظامًا ثم اطلب مرة أخرى لتستخدم النسخ ألوانه وخطوطه وأحجامه، أو تخطَّ لأرسمها بأنماط بسيطة هذه المرة.`,
    picked: (screen, variant) => `تم. صارت "${screen}" تستخدم النسخة ${variant}. باقي النسخ محفوظة.`,
    noVariant: (screen, variant) => `لا توجد في "${screen}" نسخة ${variant}. لم يتغير شيء.`,
    noScreen: (screen) => `لا توجد في المخطط شاشة "${screen}". لم يتغير شيء.`,
    approved: (s) => (s.length === 1 ? `الشاشة "${s[0]}" معتمدة، فلم أغيّرها. أعد فتحها أولًا.` : `الشاشات ${s.map((x) => `"${x}"`).join(' و')} معتمدة، فلم أغيّرها. أعد فتحها أولًا.`),
    named: (sketch, screen) => `سمّيت المخطط "${sketch}" وشاشته الأولى "${screen}". يمكنك تغيير الاسمين لاحقًا.`,
    screenNamed: (screen) => `سمّيت الشاشة الجديدة "${screen}". يمكنك تغيير اسمها لاحقًا.`,
    renamed: (from, to) => `تم. صار اسم المخطط "${to}" بدل "${from}".`,
    duplicated: (copy, n, from) => `تم. أنشأت "${copy}" وفيه ${n} من الشاشات، كلها مسودة، وبلا محادثة. لم يتغير "${from}".`,
    deleteHere: 'لحذف مخطط، استخدم «حذف» من قائمة ⋯ في بطاقته في صفحة المخططات: يسألك أولًا ويذكر عدد الشاشات التي ستُحذف معه.',
    changed: (list) => `تم. النسخ الجديدة: ${list}.`,
    stopped: (list) => `توقفت. الشاشات التي انتهت محفوظة في نسخة جديدة: ${list}.`,
    stoppedNothing: 'توقفت قبل أن ينتهي أي شيء. لم يتغير شيء.',
    systemChanged: (v) => `تم. نظام التصميم الآن في النسخة ${v}.`,
    partly: (why) => `لم يكتمل الباقي: ${why}`,
  },
};

/**
 * Keeps the person's message at the end of the conversation (or finds the unanswered last one) and reads the stamp to
 * save a change with. What the person can fix (an empty message, a picture that is not one) throws before anything is
 * written; the board answers it as a refusal.
 */
export function startChatTurn(bp: BoardPaths, a: ChatAsk): ChatTurn {
  chatOwnerName(bp, a.owner);
  const chat = checkedStudioId(a.chat ?? currentConversation(bp, a.owner));
  const before = readConversation(bp, a.owner, chat).messages;
  const stamp = typeof a.stamp === 'string' && a.stamp ? a.stamp : studioStamp(bp, a.owner);
  // Pick lines (AB-143.1) are not messages: the Designer is told about the ones since its last reply on their own.
  const earlier = (msgs: StudioChatMessage[]) =>
    msgs
      .filter((m): m is StudioChatMessage & { role: 'person' | 'designer' } => m.role !== 'action')
      .slice(-EARLIER_MESSAGES)
      .map((m) => ({ role: m.role, text: m.text.slice(0, 2000) }));
  const text = typeof a.text === 'string' ? a.text.trim() : '';
  const picked = picksSinceReply(before);
  const plain = { ...(a.plainStyles === true ? { plainStyles: true } : {}), ...(picked.length ? { picked } : {}) };
  if (!text && !a.pictures?.length) {
    // The last message, past any pick line after it (AB-143.1).
    let at = before.length - 1;
    while (at >= 0 && before[at]!.role === 'action') at--;
    const last = before[at];
    if (!last || last.role !== 'person') throw new Error('Write a message first.');
    return { owner: a.owner, chat, text: last.text, pictures: messagePictureFiles(bp, a.owner, last), ...(last.lookingAt ? { lookingAt: last.lookingAt } : {}), stamp, language: languageOf(last.text), earlier: earlier(before.slice(0, at)), ...plain };
  }
  const kept = addPersonMessage(bp, a.owner, chat, { text, ...(a.pictures ? { pictures: a.pictures } : {}), ...(a.lookingAt ? { lookingAt: a.lookingAt } : {}) });
  return { owner: a.owner, chat, text: kept.message.text, pictures: kept.pictureFiles, ...(kept.message.lookingAt ? { lookingAt: kept.message.lookingAt } : {}), stamp, language: languageOf(kept.message.text), earlier: earlier(before), ...plain };
}

/** What does the work of one message: the one Designer runner, or the sample board's fixed replies. */
export interface ChatWorker {
  sort(brief: ChatBrief): Promise<ChatSort | { error: string }>;
  /** One screen. A variant of an ask (US-17) also comes back with its short name and its one-line idea. */
  screen(o: ScreenAsk): Promise<{ frames: Record<string, string>; note: string; variantName?: string; idea?: string } | { error: string }>;
  system(o: { dir: string; language: ChatLanguage; current: { tokens: Record<string, unknown>; components: Record<string, string> } }): Promise<{ components: Record<string, string>; tokens?: Record<string, unknown>; note: string } | { error: string }>;
  release(): void;
}

function briefOf(bp: BoardPaths, turn: ChatTurn, sketch: Sketch | null): ChatBrief {
  const project = readMeta(bp).project;
  const common = { project, pictures: turn.pictures, message: turn.text, language: turn.language, earlier: conversationSession(bp, turn.owner, turn.chat) ? [] : turn.earlier, ...(turn.picked?.length ? { picked: turn.picked } : {}) };
  if (!sketch) {
    const ds = readDesignSystem(bp, turn.owner.id)!;
    return { ...common, target: { kind: 'design-system', name: ds.name, version: ds.version, dir: relative(bp, designSystemVersionDir(bp, ds.id, ds.version)) } };
  }
  const follows = sketch.designSystem ? readDesignSystem(bp, sketch.designSystem.id) : null;
  const screenName = turn.lookingAt?.screen ? sketch.screens.find((s) => s.id === turn.lookingAt!.screen)?.name : undefined;
  const lookingAt = screenName || turn.lookingAt?.frame ? { ...(screenName ? { screen: screenName } : {}), ...(turn.lookingAt?.frame ? { frame: turn.lookingAt.frame } : {}) } : undefined;
  return {
    ...common,
    target: { kind: 'sketch', name: sketch.name, frames: sketch.frames, screens: sketch.screens.map((s) => ({ id: s.id, name: s.name, files: chosenFiles(bp, sketch, s.id), ...(s.status === 'approved' ? { approved: true } : {}) })) },
    ...(follows && sketch.designSystem ? { designSystem: { name: follows.name, version: sketch.designSystem.version, dir: relative(bp, designSystemVersionDir(bp, follows.id, sketch.designSystem.version)) } } : {}),
    ...(lookingAt ? { lookingAt } : {}),
  };
}

/** The live worker: every run through the one Designer runner, in the conversation's own session. */
async function liveWorker(bp: BoardPaths, turn: ChatTurn, o: ChatOptions): Promise<ChatWorker | { error: string }> {
  const d = await openDesigner(bp, { step: 'chat', target: turn.owner, pictures: turn.pictures }, o);
  if ('error' in d) return d;
  let session = conversationSession(bp, turn.owner, turn.chat);
  const run = async (prompt: string, schema: object, problemOf: (x: unknown) => string | null): Promise<{ value: unknown } | { error: string }> => {
    const once = async (p: string): Promise<AgentResult> => {
      const r = await d.run(p, { schema, ...(session ? { resume: session } : {}) });
      if (r.sessionId && r.sessionId !== session) {
        session = r.sessionId;
        saveConversationSession(bp, turn.owner, turn.chat, session);
      }
      return r;
    };
    let r = await once(prompt);
    if (!r.ok) return { error: d.failed(r) };
    let problem = problemOf(r.structured);
    if (problem) {
      // A broken answer is asked for once more, in the same session; then it is refused.
      r = await once(answerAgainPrompt(problem));
      if (!r.ok) return { error: d.failed(r) };
      problem = problemOf(r.structured);
      if (problem) return { error: refusedWords(problem) };
    }
    return { value: r.structured };
  };
  return {
    release: d.release,
    async sort(brief) {
      const r = await run(chatSortPrompt(brief), SORT_SCHEMA, (x) => sortProblem(x, turn.owner.kind, brief.naming, Boolean(brief.newScreen)));
      return 'error' in r ? r : (r.value as ChatSort);
    },
    async screen(w) {
      // A variant of an ask (US-17) also names itself and says its idea.
      const one = (x: unknown) => screensProblem(x, { frames: w.frames, maxScreens: 1 }) ?? (w.variant ? variantProblem(x) : null);
      const r = await run(chatScreenPrompt(w), w.variant ? VARIANT_SCHEMA : SCREENS_SCHEMA, one);
      if ('error' in r) return r;
      const a = r.value as DesignerAnswer & { variantName?: string; idea?: string };
      return {
        frames: Object.fromEntries(a.screens[0]!.frames.map((f) => [f.frame.trim(), f.html])),
        note: a.note.trim(),
        ...(w.variant && a.variantName && a.idea ? { variantName: a.variantName.trim(), idea: a.idea.trim() } : {}),
      };
    },
    async system(w) {
      const r = await run(chatSystemPrompt(w), SCREENS_SCHEMA, (x) => screensProblem(x, { frames: ['desktop'] }));
      if ('error' in r) return r;
      const a = r.value as DesignerAnswer;
      const tokens = a.tokens && typeof a.tokens === 'object' && !Array.isArray(a.tokens) ? a.tokens : undefined;
      return { components: Object.fromEntries(a.screens.map((s) => [studioIdFor(s.name.trim()), s.frames[0]!.html])), ...(tokens ? { tokens } : {}), note: a.note.trim() };
    },
  };
}

type Reply = Pick<StudioChatMessage, 'text' | 'kind' | 'saved'>;

/**
 * The work without the sketch's approved screens (US-15, AB-140.1): they stay at their version until they are
 * reopened, as the store's lock says. Gives back the rest of the work and the approved screens' names, for the reply.
 */
export function withoutApproved<T extends { screen?: string }>(sketch: Sketch, work: T[]): { work: T[]; locked: string[] } {
  const locked: string[] = [];
  const open = work.filter((w) => {
    const s = w.screen ? sketch.screens.find((x) => x.id === w.screen) : undefined;
    if (s?.status !== 'approved') return true;
    if (!locked.includes(s.name)) locked.push(s.name);
    return false;
  });
  return { work: open, locked };
}

async function changeSketch(bp: BoardPaths, turn: ChatTurn, sketch: Sketch, sort: ChatSort, worker: ChatWorker, o: ChatOptions): Promise<Reply> {
  const W = WORDS[turn.language];
  // An approved screen is left out and said so; the other screens change as asked (US-15).
  const { work, locked } = withoutApproved(sketch, workOf(sketch, sort));
  if (!work.length) return { kind: 'answer', text: W.approved(locked) };
  const done: DrawnScreen[] = [];
  const notes: string[] = [];
  let why: string | null = null;
  for (const [i, w] of work.entries()) {
    if (o.signal?.aborted) break;
    o.onProgress?.(`${w.screen ? 'Changing' : 'Drawing'} screen ${i + 1} of ${work.length}: ${w.name}`);
    const r = await worker.screen({ n: i + 1, of: work.length, work: w, frames: sketch.frames, files: w.screen ? chosenFiles(bp, sketch, w.screen) : {}, language: turn.language, ...startOf(bp, sketch, w), flow: flowOf(bp, sketch, w.screen) });
    if ('error' in r) {
      why = r.error;
      break;
    }
    done.push({ ...(w.screen ? { id: w.screen } : {}), name: w.name, frames: r.frames });
    if (r.note) notes.push(r.note);
  }
  const stopped = Boolean(o.signal?.aborted);
  if (!done.length) return stopped ? { kind: 'stopped', text: W.stoppedNothing } : { kind: 'failed', text: why ?? W.stoppedNothing };
  const lockedWords = locked.length ? [W.approved(locked)] : [];
  o.onProgress?.('Saving the new version');
  // One new version for the finished screens, with the stamp read when the message was sent (AB-129.1).
  // Marked as the AI Designer's work for the person who asked (AB-131.1).
  const asker = readMeta(bp).user?.name?.trim();
  const saved = saveDrawnScreens(bp, sketch.id, done, turn.stamp ?? '', { madeBy: AI_DESIGNER, ...(asker ? { madeFor: asker } : {}), ...(notes.length ? { note: notes.join(' ') } : {}) });
  const rows = saved.saved.map((s) => ({ screen: s.screen, name: saved.sketch.screens.find((x) => x.id === s.screen)?.name ?? s.screen, version: s.version }));
  const list = rows.map((s) => `${s.name} v${s.version}`).join(', ');
  if (stopped) return { kind: 'stopped', text: [W.stopped(list), ...lockedWords].join('\n\n'), saved: rows };
  // With an approved screen left out, the plan said in the sorting no longer holds: what was done is said instead.
  const text = [locked.length ? '' : sort.reply.trim(), ...notes, W.changed(list), ...lockedWords, ...(why ? [W.partly(why)] : [])].filter(Boolean).join('\n\n');
  return { kind: 'changed', text, saved: rows };
}

/**
 * The variants of one ask (US-17, AB-142.1), and the first screen of a sketch started from the start page (US-08): each
 * screen of the work is drawn `each` times (A, B, C), one variant at a time and screen by screen, in every frame of the
 * sketch, with its short name and its idea ("Drawing variant 2 of 4: Form"). The finished variants are saved together
 * in one change with the stamp of the turn, each screen's variant A in use, and their pages checked against the
 * design system's tokens as they are saved. Stop keeps the finished variants only: the one being drawn is dropped.
 */
async function drawVariants(bp: BoardPaths, turn: ChatTurn, sketch: Sketch, sort: ChatSort, asked: Work[], each: number, worker: ChatWorker, o: ChatOptions, first = false): Promise<Reply> {
  const W = WORDS[turn.language];
  // An approved screen gets no new variants until it is reopened (US-15): it is left out and said so.
  const { work, locked } = withoutApproved(sketch, asked);
  if (!work.length) return { kind: 'answer', text: W.approved(locked) };
  const lockedWords = locked.length ? [W.approved(locked)] : [];
  const total = work.length * each;
  const ds = sketch.designSystem;
  const tokensDir = ds ? relative(bp, designSystemVersionDir(bp, ds.id, ds.version)) : undefined;
  const done: AskScreen[] = work.map((w) => ({ ...(w.screen ? { id: w.screen } : {}), name: w.name, variants: [] }));
  const notes: string[] = [];
  let why: string | null = null;
  let k = 0;
  drawing: for (const [i, w] of work.entries()) {
    for (let j = 0; j < each; j++) {
      if (o.signal?.aborted) break drawing;
      k += 1;
      const letter = VARIANT_LETTERS[j]!;
      o.onProgress?.(first && total === 1 ? `Drawing screen 1 of 1: ${w.name}` : `Drawing variant ${k} of ${total}: ${w.name}`);
      const r = await worker.screen({
        n: i + 1,
        of: work.length,
        work: w,
        frames: sketch.frames,
        files: w.screen ? chosenFiles(bp, sketch, w.screen) : {},
        language: turn.language,
        variant: { n: j + 1, of: each, letter, ...(tokensDir ? { tokensDir } : {}) },
        // A copy of another screen to start from, and the flow to match (US-11).
        ...startOf(bp, sketch, w),
        flow: flowOf(bp, sketch, w.screen),
      });
      // A variant cut short by Stop is not finished: nothing half drawn is saved.
      if ('error' in r || o.signal?.aborted) {
        if ('error' in r) why = r.error;
        break drawing;
      }
      done[i]!.variants.push({ letter, name: r.variantName || `Variant ${letter}`, idea: r.idea || r.note || `${w.name}, variant ${letter}.`, frames: r.frames });
      if (r.note) notes.push(r.note);
    }
  }
  const stopped = Boolean(o.signal?.aborted);
  const finished = done.filter((s) => s.variants.length);
  if (!finished.length) return stopped ? { kind: 'stopped', text: W.stoppedNothing } : { kind: 'failed', text: why ?? W.stoppedNothing };
  o.onProgress?.('Saving the new version');
  // One change for every finished variant, with the stamp read when the message was sent (AB-129.1), marked as the AI
  // Designer's work for the person who asked (AB-131.1).
  const asker = readMeta(bp).user?.name?.trim();
  const saved = saveAskVariants(bp, sketch.id, { id: newAskId(), words: turn.text }, finished, turn.stamp ?? '', { madeBy: AI_DESIGNER, ...(asker ? { madeFor: asker } : {}), ...(notes.length ? { note: notes.join(' ') } : {}) });
  const nameOf = (screen: string) => saved.sketch.screens.find((x) => x.id === screen)?.name ?? screen;
  const oneScreen = new Set(saved.saved.map((s) => s.screen)).size === 1;
  const label = (s: { screen: string; letter: string; name: string }) => `${oneScreen ? '' : `${nameOf(s.screen)} `}${s.letter} · ${s.name}`;
  const list = saved.saved.map(label).join(', ');
  // What the token check found, as it was saved (AB-142.1).
  const checks: string[] = [];
  let plain = false;
  for (const s of saved.saved) {
    const v = saved.sketch.screens.find((x) => x.id === s.screen)?.variants.find((x) => x.version === s.version);
    if (v?.noDesignSystem) plain = true;
    if (v?.warnings?.length && v.checkedWith) checks.push(W.offTokens(label(s), v.checkedWith.name, v.warnings.map((x) => x.value).join(', ')));
  }
  const rows = saved.saved.map((s) => ({ screen: s.screen, name: nameOf(s.screen), version: s.version }));
  const found = [...checks, ...(plain ? [W.plainStyles] : []), ...lockedWords];
  if (stopped) return { kind: 'stopped', text: [W.stoppedVariants(list), ...found].join('\n\n'), saved: rows };
  const text = [locked.length ? '' : sort.reply.trim(), W.drewVariants(rows.length, oneScreen ? nameOf(saved.saved[0]!.screen) : null, list), ...found, ...(why ? [W.partly(why)] : [])];
  return { kind: 'changed', text: text.filter(Boolean).join('\n\n'), saved: rows };
}

/** The first screen of a sketch started from the start page (US-08): drawn as the variants the start page asked for. */
async function drawFirstScreen(bp: BoardPaths, turn: ChatTurn, sketch: Sketch, sort: ChatSort, variants: number, worker: ChatWorker, o: ChatOptions): Promise<Reply> {
  const first = sketch.screens[0];
  const asked = sort.screens?.[0];
  const name = first?.name ?? asked?.name.trim() ?? sort.screenName?.trim() ?? 'Screen 1';
  const work = { ...(first ? { id: first.id, screen: first.id } : {}), name, change: asked?.change.trim() || turn.text };
  return drawVariants(bp, turn, sketch, sort, [work], Math.max(1, Math.min(VARIANT_LETTERS.length, variants)), worker, o, true);
}

/**
 * A screen added with Add screen and not named yet (US-11, AB-136.1), selected when the message was sent: its variants
 * are drawn in the sketch's design system and frames (the number asked for, or 2), and the name the AI Designer gives
 * it from the description is saved with them, in the one save under the turn's stamp, through the one free-name helper
 * ("Form 2" when "Form" is used), as the AI Designer's work for the person who asked (AB-131.1). A drawing that fails
 * or is stopped before its first variant saves nothing, so the tab keeps "New screen" and its mark. With no design
 * system selected, nothing is drawn: the "select one or skip" alert shows. Null when no screen of the work goes to it.
 */
async function drawNewScreen(bp: BoardPaths, turn: ChatTurn, sketch: Sketch, sort: ChatSort, newScreen: { id: string; name: string }, worker: ChatWorker, o: ChatOptions): Promise<{ reply: Reply; named: string | null } | null> {
  const W = WORDS[turn.language];
  const work = workOf(sketch, sort, newScreen);
  if (!work.some((w) => w.naming)) return null;
  if (!sketch.designSystem && !turn.plainStyles) return { reply: { kind: 'needs-design-system', text: W.needsDesignSystem(sketch.name) }, named: null };
  const reply = await drawVariants(bp, turn, sketch, sort, work, variantsAsked(sort) ?? DEFAULT_ASK_VARIANTS, worker, o);
  // Said only when the screen was drawn, and so named, with the name as saved.
  const saved = reply.saved?.find((s) => s.screen === newScreen.id);
  return { reply, named: saved?.name && screenNameKey(saved.name) !== screenNameKey(newScreen.name) ? W.screenNamed(saved.name) : null };
}

/**
 * "Use B" from the chat (US-17): the same pick as the card's "Use this one", with the stamp read when the message was
 * sent (AB-129.1), marked as the AI Designer's work for the person who asked (AB-131.1).
 */
function pickFromChat(bp: BoardPaths, turn: ChatTurn, sketch: Sketch, sort: ChatSort, who: { by: string; for?: string }): Reply {
  const W = WORDS[turn.language];
  const w = workOf(sketch, sort)[0];
  const screen = w?.screen ? sketch.screens.find((s) => s.id === w.screen) : undefined;
  if (!screen) return { kind: 'failed', text: W.noScreen(w?.name ?? '') };
  // An approved screen keeps the variant it was approved at until it is reopened (US-15).
  if (screen.status === 'approved') return { kind: 'answer', text: W.approved([screen.name]) };
  const letter = sort.letter?.trim().toUpperCase();
  const target = letter ? variantOfLetter(screen, letter) : (screen.variants.find((v) => v.version === sort.version) ?? null);
  const said = letter ?? `v${sort.version}`;
  if (!target) return { kind: 'failed', text: W.noVariant(screen.name, said) };
  pickVariant(bp, sketch.id, screen.id, target.version, turn.stamp ?? '', who);
  const shown = target.letter ? `${target.letter}${target.name ? ` · ${target.name}` : ''}` : `v${target.version}`;
  return { kind: 'changed', text: W.picked(screen.name, shown) };
}

/**
 * Rename or Duplicate from the chat (US-13, AB-177.1): the same store calls as the card menu, with the same name rule
 * (AB-138.1) and the stamp read when the message was sent, marked as the AI Designer's work for the person who asked
 * (AB-131.1). A used name or a stale stamp is the reply, in plain words.
 */
function sketchAction(bp: BoardPaths, turn: ChatTurn, sketch: Sketch, sort: ChatSort): Reply {
  const W = WORDS[turn.language];
  const asker = readMeta(bp).user?.name?.trim();
  const who = { by: AI_DESIGNER, ...(asker ? { for: asker } : {}) };
  if (sort.action === 'pick-variant') return pickFromChat(bp, turn, sketch, sort, who);
  if (sort.action === 'rename-sketch') {
    const name = (sort.name ?? '').trim();
    const saved = saveSketch(bp, { id: sketch.id, name, designSystem: sketch.designSystem, frames: sketch.frames }, turn.stamp ?? '', who);
    return { kind: 'changed', text: W.renamed(sketch.name, saved.name) };
  }
  const copy = duplicateSketch(bp, sketch.id, turn.stamp ?? '', who);
  return { kind: 'changed', text: W.duplicated(copy.name, copy.screens.length, sketch.name) };
}

async function changeSystem(bp: BoardPaths, turn: ChatTurn, sort: ChatSort, worker: ChatWorker, o: ChatOptions): Promise<Reply> {
  const W = WORDS[turn.language];
  const ds = readDesignSystem(bp, turn.owner.id)!;
  const current = ds.versions.find((v) => v.version === ds.version) ?? { tokens: {}, components: {} };
  o.onProgress?.('Changing the design system');
  const r = await worker.system({ dir: relative(bp, designSystemVersionDir(bp, ds.id, ds.version)), language: turn.language, current: { tokens: current.tokens, components: current.components } });
  if (o.signal?.aborted) return { kind: 'stopped', text: W.stoppedNothing };
  if ('error' in r) return { kind: 'failed', text: r.error };
  o.onProgress?.('Saving the new version');
  // Components left out stay as they are; the tokens are handed in whole.
  const saved = saveDesignSystem(bp, { id: ds.id, name: ds.name, components: { ...current.components, ...r.components }, tokens: r.tokens ?? current.tokens }, turn.stamp);
  return { kind: 'changed', text: [sort.reply.trim(), r.note, W.systemChanged(saved.version)].filter(Boolean).join('\n\n'), saved: Object.keys(r.components).map((c) => ({ screen: c, version: saved.version })) };
}

/**
 * Answers one kept message and keeps the reply at the end of the conversation. Never throws: what went wrong is the
 * reply, in plain words. Only a change saves anything, and only with the stamp of the turn.
 */
export async function answerChatTurn(bp: BoardPaths, turn: ChatTurn, o: ChatOptions = {}): Promise<StudioChatMessage> {
  let worker: ChatWorker | null = null;
  let reply: Reply;
  // The sketch's name, as the Designer gave it on the first turn of a started sketch (US-08), said before the reply.
  let named: string | null = null;
  let drawn: Awaited<ReturnType<typeof drawNewScreen>> = null;
  try {
    o.onProgress?.('Reading your message');
    let sketch = turn.owner.kind === 'sketch' ? readSketch(bp, turn.owner.id) : null;
    // A sketch started from the start page (US-08): its first turn names it, and its first screen is drawn as the
    // variants asked for, as long as no screen of it is drawn yet.
    const start = sketch ? startMarkOf(bp, sketch.id) : null;
    const firstScreen = start && sketch && !sketch.screens.some((s) => s.variants.length) ? { variants: start.variants } : undefined;
    // A screen added with Add screen and not named yet, selected as the message was sent (US-11, AB-136.1). It may have
    // been drawn already from another tab without a name of its own: its mark stays until a drawing names it.
    const looked = sketch && !firstScreen && turn.lookingAt?.screen ? sketch.screens.find((s) => s.id === turn.lookingAt!.screen) : undefined;
    const newScreen = looked?.unnamed ? { id: looked.id, name: looked.name, ...(looked.variants.length ? { drawn: true } : {}) } : undefined;
    const brief: ChatBrief = { ...briefOf(bp, turn, sketch), ...(start?.unnamed ? { naming: true } : {}), ...(firstScreen ? { firstScreen } : {}), ...(newScreen ? { newScreen } : {}) };
    const w = readMeta(bp).engine === 'live' ? await liveWorker(bp, turn, o) : demoWorker(bp, turn, sketch, o);
    if ('error' in w) reply = { kind: 'failed', text: w.error };
    else {
      worker = w;
      const sort = await w.sort(brief);
      if (!('error' in sort) && sketch && brief.naming && sort.sketchName?.trim() && sort.screenName?.trim()) {
        // One change under the turn's stamp, through the one free-name helper (AB-138.1): "Booking" becomes "Booking 2"
        // when another sketch has it. Marked as the AI Designer's work for the person who asked (AB-131.1).
        const asker = readMeta(bp).user?.name?.trim();
        const r = nameSketchAndFirstScreen(bp, sketch.id, { sketch: sort.sketchName, screen: sort.screenName }, turn.stamp ?? '', { by: AI_DESIGNER, ...(asker ? { for: asker } : {}) });
        markSketchNamed(bp, sketch.id);
        sketch = r.sketch;
        turn = { ...turn, stamp: r.sketch.stamp };
        named = WORDS[turn.language].named(r.sketch.name, r.sketch.screens.find((s) => s.id === r.screen)?.name ?? sort.screenName.trim());
      }
      if ('error' in sort) reply = o.signal?.aborted ? { kind: 'stopped', text: WORDS[turn.language].stoppedNothing } : { kind: 'failed', text: sort.error };
      else if (sort.kind === 'unavailable' && sort.action === 'delete' && sketch) reply = { kind: 'unavailable', text: [sort.reply.trim(), WORDS[turn.language].deleteHere].filter(Boolean).join('\n\n') };
      else if (sort.kind !== 'change') reply = { kind: sort.kind as ChatReplyKind, text: sort.reply.trim() };
      else if (sketch && isSketchAction(sort.action)) reply = sketchAction(bp, turn, sketch, sort);
      else if (sketch && firstScreen) reply = await drawFirstScreen(bp, turn, sketch, sort, firstScreen.variants, w, o);
      else if (sketch && newScreen && (drawn = await drawNewScreen(bp, turn, sketch, sort, newScreen, w, o))) {
        reply = drawn.reply;
        named = drawn.named;
      } else if (sketch && variantsAsked(sort) !== null) {
        // Variants keep to the sketch's design system (US-17). With none selected, nothing is drawn: the board shows an
        // alert to select one, or to skip, which sends the message again with plain styles, this once.
        // Every screen asked for is approved (US-15): that is said first, since nothing would be drawn anyway.
        const open = withoutApproved(sketch, workOf(sketch, sort));
        if (!open.work.length) reply = { kind: 'answer', text: WORDS[turn.language].approved(open.locked) };
        else if (!sketch.designSystem && !turn.plainStyles) reply = { kind: 'needs-design-system', text: WORDS[turn.language].needsDesignSystem(sketch.name) };
        else reply = await drawVariants(bp, turn, sketch, sort, workOf(sketch, sort), variantsAsked(sort)!, w, o);
      } else if (sketch) reply = await changeSketch(bp, turn, sketch, sort, w, o);
      else reply = await changeSystem(bp, turn, sort, w, o);
    }
  } catch (err) {
    if (err instanceof StudioChangedElsewhere) reply = { kind: 'failed', text: CHANGED_ELSEWHERE };
    else if (o.signal?.aborted) reply = { kind: 'stopped', text: WORDS[turn.language].stoppedNothing };
    else reply = { kind: 'failed', text: err instanceof Error ? err.message : String(err) };
  } finally {
    worker?.release();
  }
  if (named) reply = { ...reply, text: [named, reply.text].filter(Boolean).join('\n\n') };
  const message: StudioChatMessage = { role: 'designer', text: reply.text, at: new Date().toISOString(), ...(reply.kind ? { kind: reply.kind } : {}), ...(reply.saved?.length ? { saved: reply.saved } : {}) };
  addChatMessage(bp, turn.owner, turn.chat, message);
  return message;
}

/** Keeps the message and answers it: what `squad studio chat` does when the board is not open. */
export async function sendChatMessage(bp: BoardPaths, a: ChatAsk, o: ChatOptions = {}): Promise<{ chat: string; reply: StudioChatMessage }> {
  const turn = startChatTurn(bp, a);
  return { chat: turn.chat, reply: await answerChatTurn(bp, turn, o) };
}
