import { isPlain } from '../board/shape.js';
import { buttonKey, type PrototypeMap } from '../board/studio-prototype-map.js';
import type { PrototypeLink } from '../board/studio-prototype.js';
import { asData } from './prompts.js';

/**
 * What the AI Designer reads in its Link step (US-54, US-58, "Generate the prototype"), and the one shape its answer
 * comes back in. It is given every screen in the prototype, approved or not, the pages of each of its drawings (every
 * option A, B, C, or its one drawing; an approved screen at its approved version), and the buttons squad-kit found over
 * all of them, by name: a link belongs to the screen and the button's name, so it works the same on every option. It hands in, for each button, the screen it should lead to, Back, or no link; squad-kit checks
 * the answer (linksProblem) and saves it only whole (engine/studio-link.ts). It draws nothing.
 */

/** The Designer's step for linking, as agents.ts lists it. */
export const LINK_STEP = 'link';

/** What `to` says for Back, and for no link. Screen ids are lowercase, so neither is ever a screen's id. */
export const TO_BACK = 'BACK';
export const TO_NONE = 'NONE';

const STR = { type: 'string' } as const;

/** The answer: one entry per button it links, and a short note for the person. */
export const LINKS_SCHEMA = {
  type: 'object',
  properties: {
    links: {
      type: 'array',
      items: { type: 'object', properties: { screen: STR, button: STR, to: STR }, required: ['screen', 'button', 'to'] },
    },
    note: STR,
  },
  required: ['links', 'note'],
} as const;

/** One drawing of a screen in the brief: its option's letter when the screen has options, and its pages. */
export interface LinkBriefDrawing {
  option?: string;
  /** Frame id → the page's file, relative to the project folder. */
  files: Record<string, string>;
}

/** One screen in the brief: its id, its name, the pages of each of its drawings, and its buttons' names over all of them. */
export interface LinkBriefScreen {
  id: string;
  name: string;
  drawings: LinkBriefDrawing[];
  buttons: string[];
}

export interface LinkBrief {
  project: string;
  sketch: string;
  /** In the screen order: the first one is where a user starts. */
  screens: LinkBriefScreen[];
}

/** The prompt of one Link run. */
export function linkPrompt(b: LinkBrief): string {
  const screens = b.screens
    .map((s) => {
      const pages = s.drawings
        .map((d) => {
          const files = Object.entries(d.files).map(([frame, file]) => `${frame}: ${file}`);
          return files.length ? `${d.option ? `Option ${d.option} pages` : 'pages'} ${files.join(', ')}` : '';
        })
        .filter(Boolean);
      const buttons = s.buttons.length ? s.buttons.map((x) => `  - ${JSON.stringify(x)}`).join('\n') : '  (no buttons)';
      return `- ${s.name} (id ${s.id})${pages.length ? `, ${pages.join('; ')}` : ''}\n  Buttons:\n${buttons}`;
    })
    .join('\n');
  return [
    `Project: ${b.project}`,
    'Your step: link the screens of the sketch into a clickable prototype, so the person and the client can click through the whole flow and try each option. You draw nothing and change no page.',
    asData('The sketch', `Name: ${b.sketch}\nScreens, in the order a user meets them:\n${screens}`),
    [
      'Read each page first, every option of a screen too, so you see where each button sits and what it says. Then, for every button squad-kit listed:',
      '- "to" is the id of the screen it should lead to, as a user would expect;',
      `- or "${TO_BACK}" when it goes back to the screen before (a back arrow, Cancel, Edit on a summary);`,
      `- or "${TO_NONE}" when it leads nowhere in these screens (a menu, a help link, a screen that is not drawn).`,
      'Name each button exactly as listed, and each screen by its id. A button never leads to its own screen.',
      'A screen drawn as options (Option A, B, C) has one list of buttons for all its options: a button with the same name leads to the same place on every option that has it, so link each button once.',
      'Hand in your whole answer in the shape squad-kit asks for, with a note of one or two plain sentences on the flow you linked.',
    ].join('\n'),
  ].join('\n\n');
}

/** A brief for the Agents page, so the team sees what the Link step reads before it starts. */
export function exampleLinkBrief(project: string): LinkBrief {
  const page = (screen: string, frame: string, v = 1) => `.squad/studio/sketches/booking/screens/${screen}/v${v}/${frame}.html`;
  return {
    project,
    sketch: 'Booking',
    screens: [
      { id: 'form', name: 'Form', drawings: [{ files: { desktop: page('form', 'desktop'), mobile: page('form', 'mobile') } }], buttons: ['Continue', 'Help'] },
      {
        id: 'confirm',
        name: 'Confirm',
        drawings: ['A', 'B'].map((option, i) => ({ option, files: { desktop: page('confirm', 'desktop', i + 1), mobile: page('confirm', 'mobile', i + 1) } })),
        buttons: ['Icon button 1', 'Edit', 'Book visit', 'Pay now'],
      },
    ],
  };
}

/** The answer, once checked: the links to save, buttons with no link left out. */
export interface CheckedLinks {
  links: PrototypeLink[];
  note: string;
}

/**
 * Why an answer cannot be saved, in words the Designer can fix when it is asked again, or null when it fits: every
 * screen is one of the prototype's, every button one squad-kit found there, every "to" another of its screens, BACK or
 * NONE, and each button once.
 */
export function linksProblem(answer: unknown, map: PrototypeMap): string | null {
  if (!isPlain(answer) || !Array.isArray(answer.links)) return 'the answer has no list of links';
  if (typeof answer.note !== 'string') return 'the answer has no note';
  const seen = new Set<string>();
  for (const [i, x] of answer.links.entries()) {
    if (!isPlain(x) || typeof x.screen !== 'string' || typeof x.button !== 'string' || typeof x.to !== 'string') return `link ${i + 1} needs a screen, a button and a "to"`;
    const screen = x.screen.trim();
    const asked = x.button;
    const from = map.screens.find((s) => s.id === screen);
    if (!from) return `link ${i + 1} names the screen "${screen.slice(0, 40)}", which is not one of the listed screens' ids`;
    const button = from.buttons.find((b) => buttonKey(from.id, b.name) === buttonKey(from.id, asked));
    if (!button) return `link ${i + 1} names the button "${asked.slice(0, 60)}", which ${from.name} does not have`;
    const key = buttonKey(from.id, button.name);
    if (seen.has(key)) return `the button "${button.name}" on ${from.name} is linked twice`;
    seen.add(key);
    const to = x.to.trim();
    if (to === TO_BACK || to === TO_NONE) continue;
    if (!map.screens.some((s) => s.id === to)) return `link ${i + 1} leads to "${to.slice(0, 40)}", which is not a listed screen's id, ${TO_BACK} or ${TO_NONE}`;
    if (to === from.id) return `the button "${button.name}" on ${from.name} leads to its own screen`;
  }
  return null;
}

/** The links of an answer linksProblem passed, in squad-kit's shape. */
export function checkedLinks(answer: { links: { screen: string; button: string; to: string }[]; note: string }, map: PrototypeMap): CheckedLinks {
  const links: PrototypeLink[] = [];
  for (const x of answer.links) {
    const to = x.to.trim();
    if (to === TO_NONE) continue;
    const from = map.screens.find((s) => s.id === x.screen.trim())!;
    const button = from.buttons.find((b) => buttonKey(from.id, b.name) === buttonKey(from.id, x.button))!;
    links.push({ screen: from.id, button: button.name, to: to === TO_BACK ? { back: true } : { screen: to } });
  }
  return { links, note: answer.note.trim() };
}
