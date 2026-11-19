import { asData } from './prompts.js';
import { MAX_SCREENS, MAX_SCREEN_NAME, SCREENS_SCHEMA, type BriefScreen } from './studio-prompts.js';

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
  { id: 'change-screens', words: 'Change screens of the sketch, draw new screens in its frames, or draw 1 to 3 variants of screens to choose from', on: 'sketch', available: true },
  { id: 'rename-sketch', words: 'Rename the sketch: put the new name in "name". A name another sketch uses is refused', on: 'sketch', available: true },
  { id: 'duplicate-sketch', words: 'Duplicate the sketch as "… copy", every screen as Draft at the drawing it shows now, with no conversation', on: 'sketch', available: true },
  { id: 'change-design-system', words: "Change the design system's tokens (colors, fonts, spacing, corners) and its components", on: 'design-system', available: true },
  { id: 'add-frame', words: 'Add a frame to the sketch (mobile, tablet …) or remove one', on: 'sketch', available: false },
  { id: 'export', words: 'Export screens or the design system (PDF, PNG, HTML, code)', on: 'both', available: false },
  { id: 'approve-screen', words: 'Approve a screen, or mark it ready', on: 'sketch', available: false },
  { id: 'pick-variant', words: 'Use another variant of a screen ("Use B"), as its card\'s "Use this one" button does, or an older version', on: 'sketch', available: true },
  { id: 'make-default', words: 'Make a design system the default, or move the sketch to another design system', on: 'both', available: false },
  // Never done from the chat (US-13): the person deletes a sketch from its card's menu, so they see the confirmation.
  { id: 'delete', words: "Delete a sketch, a screen or a design system (a sketch is deleted with Delete in its card's ⋯ menu on the Sketches page, which asks first)", on: 'both', available: false },
  { id: 'make-ticket', words: 'Turn screens into a ticket for the squad to build', on: 'sketch', available: false },
];

/** The actions on the sketch itself (US-13): a change with no screens to draw. Picking a variant (US-17) draws nothing either. */
export const SKETCH_ACTIONS = ['rename-sketch', 'duplicate-sketch', 'pick-variant'] as const;
export type SketchAction = (typeof SKETCH_ACTIONS)[number];

export function isSketchAction(x: unknown): x is SketchAction {
  return (SKETCH_ACTIONS as readonly unknown[]).includes(x);
}

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
    name: STR,
    // The first message of a sketch started from the start page (US-08): the names the Designer suggests.
    sketchName: STR,
    screenName: STR,
    // Variants of the screens listed (US-17): how many were asked for; left out when the message asks for none.
    variants: { type: 'integer' },
    // "pick-variant": the variant's letter, or a version number.
    letter: STR,
    version: { type: 'integer' },
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
  /** A rename's new name. */
  name?: string;
  /** The first message of a started sketch (US-08): the sketch's name and its first screen's name, as suggested. */
  sketchName?: string;
  screenName?: string;
  /** Variants asked for (US-17): how many of each screen listed. Left out, the message asks for one drawing. */
  variants?: number;
  /** "pick-variant": the letter of the variant to use, or its version. */
  letter?: string;
  version?: number;
  screens?: ChatWork[];
}

/** The longest sketch name the Designer may suggest. */
export const MAX_SKETCH_NAME = 60;

/** The most variants one ask draws of a screen, and how many when the person gives no number (US-17). */
export const MAX_ASK_VARIANTS = 3;
export const DEFAULT_ASK_VARIANTS = 2;

/**
 * How many variants of each screen a sorted message asks for (US-17): the number the Designer read, at most 3; 2 when
 * it gave one but no usable number; null when the message asks for no variants, so it makes one drawing as before.
 */
export function variantsAsked(sort: Pick<ChatSort, 'variants'>): number | null {
  const n = sort.variants as unknown;
  if (n === undefined || n === null || n === false || n === 0) return null;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_ASK_VARIANTS;
  return Math.max(1, Math.min(MAX_ASK_VARIANTS, Math.round(n)));
}

/** The longest name and idea of a variant. */
export const MAX_VARIANT_NAME = 40;
export const MAX_VARIANT_IDEA = 200;

/** The letters of an ask's variants, in order. */
export const VARIANT_LETTERS = ['A', 'B', 'C'] as const;

/**
 * Why a sorting answer cannot be used, or null when it can. A change on a sketch must name the screens. The first
 * message of a started sketch (`naming`) must also suggest the sketch's name and its first screen's name.
 */
export function sortProblem(x: unknown, on: 'sketch' | 'design-system', naming = false): string | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'the answer is not in the shape asked for';
  const a = x as Record<string, unknown>;
  if (!CHAT_KINDS.includes(a.kind as ChatKind)) return `"kind" must be one of ${CHAT_KINDS.join(', ')}`;
  if (typeof a.reply !== 'string' || !a.reply.trim()) return '"reply" must say something to the person';
  if (naming && on === 'sketch') {
    const oneLine = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max && !/[\r\n]/.test(v);
    if (!oneLine(a.sketchName, MAX_SKETCH_NAME)) return `"sketchName" must name the sketch in a few words, up to ${MAX_SKETCH_NAME} letters`;
    if (!oneLine(a.screenName, MAX_SCREEN_NAME)) return `"screenName" must name its first screen in a few words, up to ${MAX_SCREEN_NAME} letters`;
  }
  if (a.kind !== 'change' || on === 'design-system') return null;
  if (a.action === 'rename-sketch') return typeof a.name === 'string' && a.name.trim() ? null : 'a rename must put the new name in "name"';
  if (a.action === 'duplicate-sketch') return null;
  if (a.action === 'pick-variant') {
    if (!Array.isArray(a.screens) || a.screens.length !== 1) return 'to use another variant, list that one screen in "screens"';
    const letter = typeof a.letter === 'string' && /^[A-Za-z]$/.test(a.letter.trim());
    const version = typeof a.version === 'number' && Number.isInteger(a.version) && a.version >= 1;
    return letter || version ? null : 'to use another variant, put its letter (A, B, C) in "letter" or its version in "version"';
  }
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
  /** The first message of a sketch started from the start page: the Designer suggests its names (US-08). */
  naming?: boolean;
  /** The sketch's first screen is still to be drawn, as this many variants (US-08). */
  firstScreen?: { variants: number };
  /**
   * The picks the person made with "Use this one" since your last reply (US-18, AB-143.1), each as "Variant B · Step by
   * step of Form". The screens' current pages are already the picked ones.
   */
  picked?: string[];
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
  if (b.picked?.length) parts.push(`Since your last reply, the person picked ${b.picked.map((p) => `"${p}"`).join(', then ')} with the variant's "Use this one" button. That is the screen's current version now: its pages listed above are the picked one, and any change starts from it.`);
  if (b.pictures.length) parts.push(`The person added ${b.pictures.length === 1 ? 'a picture' : `${b.pictures.length} pictures`} to this message as a reference. Read ${b.pictures.length === 1 ? 'it' : 'them'} first:\n${b.pictures.map((p) => `- ${p}`).join('\n')}`);
  parts.push(
    `What the Studio can do:\n${actionsText(b.target.kind)}`,
    `Sort the message into one kind:
- answer: a question, or a request for advice or your opinion ("Which variant suits older patients?", "Why this color?"). Answer it in "reply". Change nothing and do not offer to.
- ask: it might want a change but does not clearly ask for one (a maybe, a wish, a half idea: "Maybe a softer blue?"). Put one short question in "reply", like "Do you want me to change it?". Change nothing yet.
- unavailable: it asks for something the list above marks "not available yet". Say plainly in "reply" that this is not available yet, naming it, and put its id in "action". A delete is never done here: put "delete" in "action".
- change: it clearly asks for a change you can make, or says yes to a change you asked about. ${
      b.target.kind === 'sketch'
        ? `To rename or duplicate the sketch, put "rename-sketch" (with the new name in "name") or "duplicate-sketch" in "action" and list no screens. To use another variant of a screen ("Use B"), put "pick-variant" in "action", list that one screen in "screens", and put the variant's letter (A, B, C) in "letter". Otherwise list in "screens" each screen to change or draw, one per item, in order: "id" for a screen the sketch has, a short "name", and in "change" what to do on it. When the person asks for variants (alternatives, options) of those screens, put how many of each in "variants": the number they asked for, at most ${MAX_ASK_VARIANTS}, or ${DEFAULT_ASK_VARIANTS} when they give no number. Leave "variants" out when they do not ask for variants. `
        : ''
    }Put one short sentence on what you will do in "reply".`,
    `Write "reply" in ${b.language}, the language the person wrote in, in plain words.`,
  );
  if (b.naming) {
    parts.push(
      `This is the first message of a new sketch, started from the Studio's start page. Suggest a short name for the sketch in "sketchName" (one to three words, like "Booking") and a short name for its first screen in "screenName" (like "Form"), in ${b.language}. The person can rename both later.`,
    );
  }
  if (b.firstScreen) {
    const n = b.firstScreen.variants;
    parts.push(
      `The sketch's first screen is not drawn yet. If you need answers before you can draw it well, use "ask" and put up to three short questions in "reply". Otherwise use "change" and list only that first screen in "screens": you draw it as ${n === 1 ? 'one variant' : `${n} variants`} in its frames (${b.target.kind === 'sketch' ? b.target.frames.join(', ') : 'desktop'}).`,
    );
  }
  parts.push(`The person writes:\n${b.message.trim()}`);
  return parts.join('\n\n');
}

/** One variant of an ask (US-17): which of the screen's variants it is, and its letter. */
export interface VariantWork {
  n: number;
  of: number;
  letter: string;
  /** The tokens folder of the design system it must keep to; left out, it has none and is drawn in plain styles. */
  tokensDir?: string;
}

/** The answer for one variant: the screens shape, with the variant's short name and its idea (US-17). */
export const VARIANT_SCHEMA = {
  ...SCREENS_SCHEMA,
  properties: { ...SCREENS_SCHEMA.properties, variantName: STR, idea: STR },
  required: [...SCREENS_SCHEMA.required, 'variantName', 'idea'],
} as const;

/** Why a variant's name and idea cannot be used, or null when they can. */
export function variantProblem(x: unknown): string | null {
  const a = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const line = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max && !/[\r\n]/.test(v);
  if (!line(a.variantName, MAX_VARIANT_NAME)) return `"variantName" must name the variant in one to three words, up to ${MAX_VARIANT_NAME} letters, like "One page"`;
  if (!line(a.idea, MAX_VARIANT_IDEA)) return `"idea" must say the variant's idea in one line, up to ${MAX_VARIANT_IDEA} letters`;
  return null;
}

/** The prompt for one screen of a change, in the same session as the sorting. A screen drawn as variants says which one. */
export function chatScreenPrompt(o: { n: number; of: number; work: ChatWork; frames: string[]; files: Record<string, string>; language: ChatLanguage; variant?: VariantWork }): string {
  const files = Object.entries(o.files);
  const v = o.variant;
  const current = files.map(([f, file]) => `${f}: ${file}`).join(', ');
  return [
    `Now screen ${o.n} of ${o.of}: "${o.work.name}"${o.work.id ? ` (id ${o.work.id})` : ', a new screen'}.`,
    ...(v && v.of > 1 ? [`Draw it as variant ${v.n} of ${v.of} (variant ${v.letter}): ${v.n === 1 ? 'your best answer.' : 'a real alternative to the variants before it (another layout or flow), not a copy of them.'}`] : []),
    files.length ? (v ? `Its current pages, as a reference for its content: ${current}. Read them first.` : `Its current pages: ${current}. Read them first and keep what was not asked to change.`) : 'It has no pages yet: draw it.',
    ...(v ? [v.tokensDir ? `Use only the colors, fonts and sizes in the design system's tokens (${v.tokensDir}/tokens.json): nothing else.` : 'The sketch has no design system: use plain, neutral styles.'] : []),
    `What to do: ${o.work.change.trim()}`,
    `Hand in exactly this one screen${o.work.id ? `, with its id "${o.work.id}"` : ''}, with one page for each frame (${o.frames.join(', ')}), named as the frame, and a note of one sentence in ${o.language}.`,
    ...(v ? [`Also give this variant a short name of one to three words in "variantName" (like "One page" or "Step by step") and its idea in one line in "idea", both in ${o.language}.`] : []),
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
