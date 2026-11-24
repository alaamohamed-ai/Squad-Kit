import type { Ticket } from '../../board/types.js';
import { designFrameFile, type TicketDesign } from '../../board/ticket-designs.js';

/**
 * The designs from the Studio a ticket builds (US-55, AB-180.1), as the squad reads them: each picked screen's name,
 * version and frames, with the path of each frame's HTML in the ticket's frozen copy, and the rule to match it. The
 * Analyst, the Architect and the Builder read it in the ticket's text; the Architect's plan must name each screen and
 * the page of the app it becomes; the Tester takes one picture of that page per screen and frame, for the proof's
 * design next to the build (live/design-proof.ts). A ticket with no picked screen gets none of this.
 */

/** "desktop" → "Desktop". */
const frameWord = (frame: string) => (frame ? frame[0]!.toUpperCase() + frame.slice(1) : frame);

/** The size the Tester's picture of a frame is taken at: the Studio's desktop and mobile are the browser's desktop and phone. */
export function shotSizeOf(frame: string): 'desktop' | 'phone' {
  return frame === 'mobile' || frame === 'phone' ? 'phone' : 'desktop';
}

/** The names compare as the Studio's names do: no capital letters, no spaces at the ends. */
const key = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

function designLines(designs: TicketDesign[]): string {
  return designs
    .map((d) => `- "${d.name}", version ${d.version}:\n${d.frames.map((f) => `  - ${frameWord(f)}: ${designFrameFile(d, f)}`).join('\n')}`)
    .join('\n');
}

/** The design to follow, for the ticket's text: empty when no screen is picked, so the ticket reads as it always did. */
export function designsText(t: Pick<Ticket, 'designs'>): string {
  if (!t.designs?.length) return '';
  return `\n\nDesigns from the Studio to build: approved screens, each a copy kept with the ticket at its approved version.
Each frame is one HTML file, the design of that screen at that width (Desktop, Mobile). Read them: they are the design
to follow, not a description in words.
${designLines(t.designs)}
Build each screen as a page of the app, in the project's own code (its own components, styles and framework), to match
its design: the layout, the order of the parts, the words, the colours, the fonts and the sizes, at each frame's width.
Where the app already has a button, colour or font that looks almost the same, keep the app's own one. A right-to-left
(Arabic) screen stays right to left (dir="rtl"), as in its design. Never copy the HTML files into the app as they are,
and never load them from the app.`;
}

/**
 * What the spec must say about the designs the person picked: the Analyst writes it with them. It resumes its talk from
 * before the pick, so the screens and their files come with this ask.
 */
export function designsSpecRule(t: Pick<Ticket, 'designs'>): string {
  if (!t.designs?.length) return '';
  return `\n\nThe person picked ${t.designs.length === 1 ? 'an approved screen' : 'approved screens'} from the Studio as the design this ticket builds. Read each frame's
HTML file: it is the design, not a description in words.
${designLines(t.designs)}
Write the story and the "done when" list for these screens: what the person sees and does on each, by its name
("${t.designs[0]!.name}"), in Desktop and Mobile where it has both, and right to left where the screen is in Arabic.
Do not describe the look in words: the screens are the look.`;
}

/** What the plan must say about the designs: each screen by its name, and the page of the app it becomes. */
export function designsPlanRule(t: Pick<Ticket, 'designs'>): string {
  if (!t.designs?.length) return '';
  return `\n- designs: this ticket builds ${t.designs.length === 1 ? 'an approved screen' : 'approved screens'} from the Studio:
${designLines(t.designs)}
  Name each one in the step that builds it, exactly as written, with the page of the app it becomes, like: Build
  "${t.designs[0]!.name}" as the page /${t.designs[0]!.screen}, matching its Desktop and Mobile design. Count each as a screen.`;
}

/** The picked screens a plan's steps do not name, or null when every one is named. squad-kit asks once more. */
export function designsPlanProblem(t: Pick<Ticket, 'designs'>, answer: unknown): string | null {
  if (!t.designs?.length) return null;
  const steps = (answer as { steps?: unknown } | null)?.steps;
  const text = key(Array.isArray(steps) ? steps.filter((s): s is string => typeof s === 'string').join('\n') : '');
  const missing = t.designs.filter((d) => !text.includes(key(d.name)));
  if (!missing.length) return null;
  return `the steps must name each design from the Studio exactly as written, with the page of the app it becomes, and ${missing.map((d) => `"${d.name}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not named`;
}

/** The plan's step that builds a design, when it names it. */
function stepFor(t: Pick<Ticket, 'steps'>, d: TicketDesign): string | undefined {
  return t.steps?.find((s) => key(s.title).includes(key(d.name)))?.title;
}

/** The Tester's ask for the design pictures, after the change: one picture of the page built from each screen, per frame. */
export function designsForTester(t: Pick<Ticket, 'designs' | 'steps'>): string {
  if (!t.designs?.length) return '';
  const lines = t.designs.map((d) => {
    const step = stepFor(t, d);
    return `- "${d.name}": ${d.frames.map((f) => `${frameWord(f)} at size "${shotSizeOf(f)}"`).join(', ')}${step ? `. The plan: ${step}` : ''}`;
  });
  return `\n\nDesigns from the Studio: this story built these approved screens as pages of the app. For each screen and each
of its frames, take one more picture of the page built from it, at that frame's size, and name it in designs: screen
(its name exactly as written here), frame (desktop, mobile …) and file. It sits beside the design on the proof, so show
the whole page as it first opens, with only the steps it needs to show. A right-to-left (Arabic) page stays as it is.
${lines.join('\n')}
The design of each frame is the HTML file in the ticket's designs folder, if you want to see what to compare with:
${t.designs.flatMap((d) => d.frames.map((f) => `- "${d.name}", ${frameWord(f)}: ${designFrameFile(d, f)}`)).join('\n')}`;
}

/** The proof's answer with the design pictures, for a ticket that has designs; the same schema for one that has none. */
export function proofSchemaFor<S extends { properties: Record<string, unknown> }>(t: Pick<Ticket, 'designs'>, schema: S): S {
  if (!t.designs?.length) return schema;
  const designs = {
    type: 'array',
    maxItems: 40,
    items: { type: 'object', properties: { screen: { type: 'string' }, frame: { type: 'string' }, file: { type: 'string' } }, required: ['screen', 'frame', 'file'] },
  };
  return { ...schema, properties: { ...schema.properties, designs } };
}

/** One design picture the Tester named. */
export interface DesignShot {
  screen: string;
  frame: string;
  file: string;
}

/** The design pictures in the Tester's answer, as it named them. */
export function designShotsIn(answer: unknown): DesignShot[] {
  const list = (answer as { designs?: unknown } | null)?.designs;
  if (!Array.isArray(list)) return [];
  return list.flatMap((x) => (x && typeof x === 'object' && typeof x.screen === 'string' && typeof x.frame === 'string' && typeof x.file === 'string' ? [{ screen: x.screen, frame: x.frame.trim().toLowerCase(), file: x.file.split(/[\\/]/).pop()! }] : []));
}

/** The picked design a name means, as the Studio compares names. */
export function designNamed(t: Pick<Ticket, 'designs'>, name: string): TicketDesign | undefined {
  return t.designs?.find((d) => key(d.name) === key(name));
}

/**
 * The screens and frames the Tester's answer has no usable picture for, in words for it, or null. A picture counts
 * when squad-kit took it in this step (`size` gives its size, or undefined) at that frame's size.
 */
export function designShotsProblem(t: Pick<Ticket, 'designs'>, answer: unknown, size: (file: string) => string | undefined): string | null {
  if (!t.designs?.length) return null;
  const shots = designShotsIn(answer);
  const missing: string[] = [];
  for (const d of t.designs) {
    for (const f of d.frames) {
      const ok = shots.some((s) => designNamed(t, s.screen) === d && s.frame === f && size(s.file) === shotSizeOf(f));
      if (!ok) missing.push(`"${d.name}" ${frameWord(f)} (size "${shotSizeOf(f)}")`);
    }
  }
  return missing.length ? `designs needs one picture squad-kit took in this step for each screen and frame, at that frame's size, and it has none for ${missing.join(', ')}` : null;
}
