import path from 'node:path';
import { readMeta, type BoardPaths } from '../board/store.js';
import {
  AI_DESIGNER,
  CHANGED_ELSEWHERE,
  StudioChangedElsewhere,
  duplicateSketch,
  readDesignSystem,
  readSketch,
  saveDesignSystem,
  saveDrawnScreens,
  saveSketch,
  studioIdFor,
  studioStamp,
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
  readConversation,
  saveConversationSession,
} from '../board/studio-chats.js';
import { checkedStudioId, designSystemVersionDir, frameFile } from '../board/studio-paths.js';
import type { StartPicture } from '../board/studio-start.js';
import type { AgentResult } from '../modules/ai-tool/types.js';
import { screensProblem } from './answers.js';
import { answerAgainPrompt } from './prompts.js';
import { demoWorker } from './studio-chat-demo.js';
import { SCREENS_SCHEMA, type DesignerAnswer } from './studio-prompts.js';
import { SORT_SCHEMA, chatScreenPrompt, chatSortPrompt, chatSystemPrompt, isSketchAction, languageOf, sortProblem, type ChatBrief, type ChatLanguage, type ChatSort, type ChatWork } from './studio-chat-prompts.js';
import { openDesigner, refusedWords, type DesignerOptions } from './studio-designer.js';

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
  }
> = {
  English: {
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
  const earlier = (msgs: StudioChatMessage[]) => msgs.slice(-EARLIER_MESSAGES).map((m) => ({ role: m.role, text: m.text.slice(0, 2000) }));
  const text = typeof a.text === 'string' ? a.text.trim() : '';
  if (!text && !a.pictures?.length) {
    const last = before[before.length - 1];
    if (!last || last.role !== 'person') throw new Error('Write a message first.');
    return { owner: a.owner, chat, text: last.text, pictures: messagePictureFiles(bp, a.owner, last), ...(last.lookingAt ? { lookingAt: last.lookingAt } : {}), stamp, language: languageOf(last.text), earlier: earlier(before.slice(0, -1)) };
  }
  const kept = addPersonMessage(bp, a.owner, chat, { text, ...(a.pictures ? { pictures: a.pictures } : {}), ...(a.lookingAt ? { lookingAt: a.lookingAt } : {}) });
  return { owner: a.owner, chat, text: kept.message.text, pictures: kept.pictureFiles, ...(kept.message.lookingAt ? { lookingAt: kept.message.lookingAt } : {}), stamp, language: languageOf(kept.message.text), earlier: earlier(before) };
}

/** What does the work of one message: the one Designer runner, or the sample board's fixed replies. */
export interface ChatWorker {
  sort(brief: ChatBrief): Promise<ChatSort | { error: string }>;
  screen(o: { n: number; of: number; work: ChatWork; frames: string[]; files: Record<string, string>; language: ChatLanguage }): Promise<{ frames: Record<string, string>; note: string } | { error: string }>;
  system(o: { dir: string; language: ChatLanguage; current: { tokens: Record<string, unknown>; components: Record<string, string> } }): Promise<{ components: Record<string, string>; tokens?: Record<string, unknown>; note: string } | { error: string }>;
  release(): void;
}

function relative(bp: BoardPaths, file: string): string {
  return path.relative(bp.root, file).split(path.sep).join('/');
}

/** The chosen variant's pages of a screen, relative to the project folder, by frame. */
function chosenFiles(bp: BoardPaths, sketch: Sketch, screen: string): Record<string, string> {
  const s = sketch.screens.find((x) => x.id === screen);
  const v = s?.variants.find((x) => x.version === s.chosen);
  return v ? Object.fromEntries(Object.keys(v.frames).map((f) => [f, relative(bp, frameFile(bp, sketch.id, s!.id, v.version, f))])) : {};
}

function briefOf(bp: BoardPaths, turn: ChatTurn, sketch: Sketch | null): ChatBrief {
  const project = readMeta(bp).project;
  const common = { project, pictures: turn.pictures, message: turn.text, language: turn.language, earlier: conversationSession(bp, turn.owner, turn.chat) ? [] : turn.earlier };
  if (!sketch) {
    const ds = readDesignSystem(bp, turn.owner.id)!;
    return { ...common, target: { kind: 'design-system', name: ds.name, version: ds.version, dir: relative(bp, designSystemVersionDir(bp, ds.id, ds.version)) } };
  }
  const follows = sketch.designSystem ? readDesignSystem(bp, sketch.designSystem.id) : null;
  const screenName = turn.lookingAt?.screen ? sketch.screens.find((s) => s.id === turn.lookingAt!.screen)?.name : undefined;
  const lookingAt = screenName || turn.lookingAt?.frame ? { ...(screenName ? { screen: screenName } : {}), ...(turn.lookingAt?.frame ? { frame: turn.lookingAt.frame } : {}) } : undefined;
  return {
    ...common,
    target: { kind: 'sketch', name: sketch.name, frames: sketch.frames, screens: sketch.screens.map((s) => ({ id: s.id, name: s.name, files: chosenFiles(bp, sketch, s.id) })) },
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
      const r = await run(chatSortPrompt(brief), SORT_SCHEMA, (x) => sortProblem(x, turn.owner.kind));
      return 'error' in r ? r : (r.value as ChatSort);
    },
    async screen(w) {
      const one = (x: unknown) => screensProblem(x, { frames: w.frames, maxScreens: 1 });
      const r = await run(chatScreenPrompt(w), SCREENS_SCHEMA, one);
      if ('error' in r) return r;
      const a = r.value as DesignerAnswer;
      return { frames: Object.fromEntries(a.screens[0]!.frames.map((f) => [f.frame.trim(), f.html])), note: a.note.trim() };
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

/** The screens of a change, in order, each with the screen it changes when the sketch has it. */
function workOf(sketch: Sketch, sort: ChatSort): (ChatWork & { screen?: string })[] {
  const seen = new Set<string>();
  return (sort.screens ?? []).flatMap((w) => {
    const name = w.name.trim();
    const found = sketch.screens.find((s) => (w.id && s.id === w.id) || s.name.trim().toLowerCase() === name.toLowerCase());
    const key = found?.id ?? studioIdFor(name);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ name: found?.name ?? name, change: w.change, ...(found ? { id: found.id, screen: found.id } : {}) }];
  });
}

async function changeSketch(bp: BoardPaths, turn: ChatTurn, sketch: Sketch, sort: ChatSort, worker: ChatWorker, o: ChatOptions): Promise<Reply> {
  const W = WORDS[turn.language];
  const work = workOf(sketch, sort);
  const done: DrawnScreen[] = [];
  const notes: string[] = [];
  let why: string | null = null;
  for (const [i, w] of work.entries()) {
    if (o.signal?.aborted) break;
    o.onProgress?.(`${w.screen ? 'Changing' : 'Drawing'} screen ${i + 1} of ${work.length}: ${w.name}`);
    const r = await worker.screen({ n: i + 1, of: work.length, work: w, frames: sketch.frames, files: w.screen ? chosenFiles(bp, sketch, w.screen) : {}, language: turn.language });
    if ('error' in r) {
      why = r.error;
      break;
    }
    done.push({ ...(w.screen ? { id: w.screen } : {}), name: w.name, frames: r.frames });
    if (r.note) notes.push(r.note);
  }
  const stopped = Boolean(o.signal?.aborted);
  if (!done.length) return stopped ? { kind: 'stopped', text: W.stoppedNothing } : { kind: 'failed', text: why ?? W.stoppedNothing };
  o.onProgress?.('Saving the new version');
  // One new version for the finished screens, with the stamp read when the message was sent (AB-129.1).
  // Marked as the AI Designer's work for the person who asked (AB-131.1).
  const asker = readMeta(bp).user?.name?.trim();
  const saved = saveDrawnScreens(bp, sketch.id, done, turn.stamp ?? '', { madeBy: AI_DESIGNER, ...(asker ? { madeFor: asker } : {}), ...(notes.length ? { note: notes.join(' ') } : {}) });
  const rows = saved.saved.map((s) => ({ screen: s.screen, name: saved.sketch.screens.find((x) => x.id === s.screen)?.name ?? s.screen, version: s.version }));
  const list = rows.map((s) => `${s.name} v${s.version}`).join(', ');
  if (stopped) return { kind: 'stopped', text: W.stopped(list), saved: rows };
  const text = [sort.reply.trim(), ...notes, W.changed(list), ...(why ? [W.partly(why)] : [])].filter(Boolean).join('\n\n');
  return { kind: 'changed', text, saved: rows };
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
  try {
    o.onProgress?.('Reading your message');
    const sketch = turn.owner.kind === 'sketch' ? readSketch(bp, turn.owner.id) : null;
    const brief = briefOf(bp, turn, sketch);
    const w = readMeta(bp).engine === 'live' ? await liveWorker(bp, turn, o) : demoWorker(bp, turn, sketch, o);
    if ('error' in w) reply = { kind: 'failed', text: w.error };
    else {
      worker = w;
      const sort = await w.sort(brief);
      if ('error' in sort) reply = o.signal?.aborted ? { kind: 'stopped', text: WORDS[turn.language].stoppedNothing } : { kind: 'failed', text: sort.error };
      else if (sort.kind === 'unavailable' && sort.action === 'delete' && sketch) reply = { kind: 'unavailable', text: [sort.reply.trim(), WORDS[turn.language].deleteHere].filter(Boolean).join('\n\n') };
      else if (sort.kind !== 'change') reply = { kind: sort.kind as ChatReplyKind, text: sort.reply.trim() };
      else if (sketch && isSketchAction(sort.action)) reply = sketchAction(bp, turn, sketch, sort);
      else if (sketch) reply = await changeSketch(bp, turn, sketch, sort, w, o);
      else reply = await changeSystem(bp, turn, sort, w, o);
    }
  } catch (err) {
    if (err instanceof StudioChangedElsewhere) reply = { kind: 'failed', text: CHANGED_ELSEWHERE };
    else if (o.signal?.aborted) reply = { kind: 'stopped', text: WORDS[turn.language].stoppedNothing };
    else reply = { kind: 'failed', text: err instanceof Error ? err.message : String(err) };
  } finally {
    worker?.release();
  }
  const message: StudioChatMessage = { role: 'designer', text: reply.text, at: new Date().toISOString(), ...(reply.kind ? { kind: reply.kind } : {}), ...(reply.saved?.length ? { saved: reply.saved } : {}) };
  addChatMessage(bp, turn.owner, turn.chat, message);
  return message;
}

/** Keeps the message and answers it: what `squad studio chat` does when the board is not open. */
export async function sendChatMessage(bp: BoardPaths, a: ChatAsk, o: ChatOptions = {}): Promise<{ chat: string; reply: StudioChatMessage }> {
  const turn = startChatTurn(bp, a);
  return { chat: turn.chat, reply: await answerChatTurn(bp, turn, o) };
}
