import { asData } from './prompts.js';
import { MAX_SCREENS, MAX_SCREEN_NAME, type BriefScreen } from './studio-prompts.js';

/**
 * What the AI Designer reads in the Studio's chat (US-52, AB-177.1): each message is first sorted (an answer, a
 * question back, an action that is not available yet, or a change from the Studio's list of actions), then a change
 * is done one screen at a time in the same session. Every reply is in the person's own language.
 */

/** The languages the Designer answers in: the one the person writes in. */
export type ChatLanguage = 'English' | 'Arabic';

/** Arabic when most of the letters are Arabic, English otherwise. */
export function languageOf(text: string): ChatLanguage {
  const arabic = (text.match(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return arabic > 0 && arabic >= latin ? 'Arabic' : 'English';
}

/**
 * Everything a Studio button does, so the chat can do it too (AB-177.1, done when 2 of US-52). An action that is not
 * built yet is listed with `available: false`: the Designer says plainly that it is not available yet. A later story
 * that adds a button (frames in US-14, export) turns its line on and does the action in studio-chat.ts.
 */
export const STUDIO_ACTIONS: readonly { id: string; words: string; on: 'sketch' | 'design-system' | 'both'; available: boolean }[] = [
  { id: 'change-screens', words: 'Change screens of the sketch, or draw new screens in its frames', on: 'sketch', available: true },
  { id: 'change-design-system', words: "Change the design system's tokens (colors, fonts, spacing, corners) and its components", on: 'design-system', available: true },
  { id: 'add-frame', words: 'Add a frame to the sketch (mobile, tablet …) or remove one', on: 'sketch', available: false },
  { id: 'export', words: 'Export screens or the design system (PDF, PNG, HTML, code)', on: 'both', available: false },
  { id: 'approve-screen', words: 'Approve a screen, or mark it ready', on: 'sketch', available: false },
  { id: 'pick-variant', words: 'Use another variant or an older version of a screen', on: 'sketch', available: false },
  { id: 'make-default', words: 'Make a design system the default, or move the sketch to another design system', on: 'both', available: false },
  { id: 'delete', words: 'Delete a sketch, a screen or a design system', on: 'both', available: false },
  { id: 'make-ticket', words: 'Turn screens into a ticket for the squad to build', on: 'sketch', available: false },
];

export type ChatKind = 'answer' | 'ask' | 'unavailable' | 'change';
export const CHAT_KINDS: readonly ChatKind[] = ['answer', 'ask', 'unavailable', 'change'];

const STR = { type: 'string' } as const;

/** The first answer to every message: what kind it is, the reply in the person's language and, for a change, the work. */
export const SORT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...CHAT_KINDS] },
    reply: STR,
    action: STR,
    screens: {
      type: 'array',
      maxItems: MAX_SCREENS,
      items: { type: 'object', properties: { id: STR, name: STR, change: STR }, required: ['name', 'change'] },
    },
  },
  required: ['kind', 'reply'],
} as const;

/** One screen of the work, in the order it is done. `id` names a screen the sketch has; a new screen has none. */
export interface ChatWork {
  id?: string;
  name: string;
  change: string;
}

export interface ChatSort {
  kind: ChatKind;
  reply: string;
  action?: string;
  screens?: ChatWork[];
}

/** Why a sorting answer cannot be used, or null when it can. A change on a sketch must name the screens. */
export function sortProblem(x: unknown, on: 'sketch' | 'design-system'): string | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'the answer is not in the shape asked for';
  const a = x as Record<string, unknown>;
  if (!CHAT_KINDS.includes(a.kind as ChatKind)) return `"kind" must be one of ${CHAT_KINDS.join(', ')}`;
  if (typeof a.reply !== 'string' || !a.reply.trim()) return '"reply" must say something to the person';
  if (a.kind !== 'change' || on === 'design-system') return null;
  if (!Array.isArray(a.screens) || !a.screens.length) return 'a change must list the screens to change or draw, one per item';
  if (a.screens.length > MAX_SCREENS) return `a change may list at most ${MAX_SCREENS} screens`;
  for (const s of a.screens as unknown[]) {
    const w = s as Record<string, unknown>;
    if (!w || typeof w.name !== 'string' || !w.name.trim() || w.name.length > MAX_SCREEN_NAME) return `each screen needs a name of up to ${MAX_SCREEN_NAME} letters`;
    if (typeof w.change !== 'string' || !w.change.trim()) return 'each screen needs the change to make';
  }
  return null;
}

/** Everything the chat's Designer is told about one message, filled in from the Studio store. */
export interface ChatBrief {
  project: string;
  target: { kind: 'sketch'; name: string; frames: string[]; screens: BriefScreen[] } | { kind: 'design-system'; name: string; version: number; dir: string };
  /** The design system a sketch follows, with the folder of its version. */
  designSystem?: { name: string; version: number; dir: string };
  /** What the person was looking at: a screen's name and a frame. */
  lookingAt?: { screen?: string; frame?: string };
  pictures: string[];
  message: string;
  language: ChatLanguage;
  /** The conversation so far, when no session goes on: the run starts fresh and reads it as data. */
  earlier: { role: 'person' | 'designer'; text: string }[];
}

function actionsText(on: 'sketch' | 'design-system'): string {
  return STUDIO_ACTIONS.filter((a) => a.on === on || a.on === 'both')
    .map((a) => `- ${a.id}: ${a.words}${a.available ? '' : ' (not available yet)'}`)
    .join('\n');
}

function screensText(screens: BriefScreen[]): string {
  if (!screens.length) return 'The sketch has no screens yet.';
  return screens
    .map((s) => {
      const files = Object.entries(s.files).map(([frame, file]) => `${frame}: ${file}`);
      return `- ${s.name} (id ${s.id})${files.length ? `: ${files.join(', ')}` : ', not drawn yet'}`;
    })
    .join('\n');
}

/** The prompt that sorts one message. */
export function chatSortPrompt(b: ChatBrief): string {
  const parts = [`Project: ${b.project}`, 'You are in the Studio chat: the person talks with you about their designs. First decide what their message is.'];
  if (b.target.kind === 'sketch') {
    parts.push(asData('The sketch', `Name: ${b.target.name}\nFrames: ${b.target.frames.join(', ')}\nScreens:\n${screensText(b.target.screens)}`));
  } else {
    parts.push(asData('The design system', `Name: ${b.target.name}\nCurrent version: ${b.target.version}\nIts tokens.json and components/ are in ${b.target.dir}.`));
  }
  if (b.designSystem) parts.push(`The sketch follows the design system "${b.designSystem.name}", version ${b.designSystem.version}: its tokens.json and components/ are in ${b.designSystem.dir}.`);
  if (b.lookingAt?.screen || b.lookingAt?.frame) parts.push(`The person is looking at${b.lookingAt.screen ? ` the screen "${b.lookingAt.screen}"` : ''}${b.lookingAt.frame ? ` in its ${b.lookingAt.frame} frame` : ''}. "This" and "it" mean that, unless they say otherwise.`);
  if (b.earlier.length) parts.push(asData('The conversation so far', b.earlier.map((m) => `${m.role === 'person' ? 'Person' : 'You'}: ${m.text}`).join('\n')));
  if (b.pictures.length) parts.push(`The person added ${b.pictures.length === 1 ? 'a picture' : `${b.pictures.length} pictures`} to this message as a reference. Read ${b.pictures.length === 1 ? 'it' : 'them'} first:\n${b.pictures.map((p) => `- ${p}`).join('\n')}`);
  parts.push(
    `What the Studio can do:\n${actionsText(b.target.kind)}`,
    `Sort the message into one kind:
- answer: a question, or a request for advice or your opinion ("Which variant suits older patients?", "Why this color?"). Answer it in "reply". Change nothing and do not offer to.
- ask: it might want a change but does not clearly ask for one (a maybe, a wish, a half idea: "Maybe a softer blue?"). Put one short question in "reply", like "Do you want me to change it?". Change nothing yet.
- unavailable: it asks for something the list above marks "not available yet". Say plainly in "reply" that this is not available yet, naming it, and put its id in "action".
- change: it clearly asks for a change you can make, or says yes to a change you asked about. ${b.target.kind === 'sketch' ? 'List in "screens" each screen to change or draw, one per item, in order: "id" for a screen the sketch has, a short "name", and in "change" what to do on it. ' : ''}Put one short sentence on what you will do in "reply".`,
    `Write "reply" in ${b.language}, the language the person wrote in, in plain words.`,
    `The person writes:\n${b.message.trim()}`,
  );
  return parts.join('\n\n');
}

/** The prompt for one screen of a change, in the same session as the sorting. */
export function chatScreenPrompt(o: { n: number; of: number; work: ChatWork; frames: string[]; files: Record<string, string>; language: ChatLanguage }): string {
  const files = Object.entries(o.files);
  return [
    `Now screen ${o.n} of ${o.of}: "${o.work.name}"${o.work.id ? ` (id ${o.work.id})` : ', a new screen'}.`,
    files.length ? `Its current pages: ${files.map(([f, file]) => `${f}: ${file}`).join(', ')}. Read them first and keep what was not asked to change.` : 'It has no pages yet: draw it.',
    `What to do: ${o.work.change.trim()}`,
    `Hand in exactly this one screen${o.work.id ? `, with its id "${o.work.id}"` : ''}, with one page for each frame (${o.frames.join(', ')}), named as the frame, and a note of one sentence in ${o.language}.`,
  ].join('\n\n');
}

/** The prompt for a change to a design system, in the same session as the sorting. */
export function chatSystemPrompt(o: { dir: string; language: ChatLanguage }): string {
  return [
    `Now make the change to the design system. Its current tokens.json and components/ are in ${o.dir}: read them first.`,
    'Hand in all of its tokens as named values, with your change, and each component you change as one screen named after it with one page in the frame "desktop". Hand in at least one component: the one that shows the change best. Components you leave out stay as they are.',
    `Write the note in ${o.language}, one sentence.`,
  ].join('\n\n');
}

/** The sorting prompt for the Agents page, filled in from an example. */
export function exampleChatPrompt(project: string): string {
  return chatSortPrompt({
    project,
    target: { kind: 'sketch', name: 'Booking', frames: ['desktop'], screens: [{ id: 'form', name: 'Form', files: { desktop: '.squad/studio/sketches/booking/screens/form/v1/desktop.html' } }] },
    designSystem: { name: 'Patient app', version: 2, dir: '.squad/studio/design-systems/patient-app/v2' },
    lookingAt: { screen: 'Form', frame: 'desktop' },
    pictures: [],
    message: 'Why this color?',
    language: 'English',
    earlier: [],
  });
}
