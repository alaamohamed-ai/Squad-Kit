import fs from 'node:fs';
import type { BoardPaths } from './store.js';
import { isPlain } from './shape.js';
import { DEFAULT_FRAMES, freeSketchId, freeSketchName, readChat, saveChat, type StartMark, type StudioChat } from './studio.js';
import { createSketch, getSketch, listDesignSystems, newSketchDesignSystem } from './studio-actions.js';
import { writeShared } from './studio-files.js';
import { CHAT_PICTURE, chatPictureFile } from './studio-paths.js';

export { freeSketchId } from './studio.js';

/**
 * The first message on the Studio's start page (US-05, AB-130): it makes the sketch and keeps the message.
 *
 * The sketch is made through the Studio actions (AB-128.2): its first name comes from the message's first words (with
 * 2, 3 … when another sketch has it, AB-138.1), its id from the name (with -2, -3 … when taken). It follows the design
 * system the start page's chip picked (the project's default unless changed, US-08), in the frames left on. The
 * message, its pictures and the variants asked for are kept only in this computer's chat folder for the sketch
 * (AB-130.1), never in the project. The board then starts the AI Designer's first turn on it, through the one Designer
 * runner (AB-141.1): it names the sketch and its first screen, and asks or draws (engine/studio-chat.ts).
 */

/** The chat the start page's first message opens. */
export const FIRST_CHAT = 'main';
export const MAX_MESSAGE = 4000;
export const MAX_START_PICTURES = 4;
export const MAX_PICTURE_BYTES = 10 * 1024 * 1024;
/** How many of the message's first words name the sketch. */
const NAME_WORDS = 6;
const NAME_MAX = 60;

export const PICTURE_KINDS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
type PictureKind = keyof typeof PICTURE_KINDS;

/** What the bytes are, from their first bytes: a file is never taken for what its name or its type says. */
export function pictureKindOf(bytes: Buffer): PictureKind | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export interface StartPicture {
  name?: string;
  type?: string;
  /** data:image/png;base64,… as the browser read it. */
  data: string;
}

export interface StartSketchInput {
  message: string;
  pictures?: StartPicture[];
  /** The design system the sketch follows, by id (US-08). Left out, the project's default; null, none. */
  designSystem?: string | null;
  /** The frames to draw in: at least one, all of them the design system's. Left out, all of its frames. */
  frames?: string[];
  /** How many variants of the first screen the AI Designer draws: 1 to 3. Left out, 2. */
  variants?: number;
}

/** How many variants of the first screen the start page asks for (US-08): 2 unless the person picks 1 or 3. */
export const DEFAULT_VARIANTS = 2;
export const MIN_VARIANTS = 1;
export const MAX_VARIANTS = 3;

/** "Desktop and Mobile", "Desktop, Tablet and Mobile". */
function framesWords(frames: readonly string[]): string {
  const words = frames.map((f) => f[0]!.toUpperCase() + f.slice(1));
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : (words[0] ?? '');
}

/**
 * What the start page's chips chose (US-08), checked before anything is written: the design system (the default when
 * left out), its frames (at least one, all of them its own) and the variants (1 to 3). With no design system, the frames
 * come from Desktop and Mobile, what any new design system starts with (AB-133.1).
 */
export function checkedStartChoice(bp: BoardPaths, input: Pick<StartSketchInput, 'designSystem' | 'frames' | 'variants'>): { designSystem: { id: string; version: number } | null; frames: string[]; variants: number } {
  let ds: { id: string; name: string; version: number; frames: string[] } | null;
  if (input.designSystem === undefined) ds = newSketchDesignSystem(bp);
  else if (input.designSystem === null) ds = null;
  else {
    const found = typeof input.designSystem === 'string' ? listDesignSystems(bp).find((d) => d.id === input.designSystem) : undefined;
    if (!found) throw new Error(`This project has no design system "${String(input.designSystem).slice(0, 60)}". Reload and pick another.`);
    ds = found;
  }
  const allowed = ds ? ds.frames : [...DEFAULT_FRAMES];
  let frames = allowed;
  if (input.frames !== undefined) {
    if (!Array.isArray(input.frames) || !input.frames.length || input.frames.some((f) => typeof f !== 'string')) throw new Error('Keep at least one frame on.');
    frames = [...new Set(input.frames)];
    const other = frames.find((f) => !allowed.includes(f));
    if (other) throw new Error(`"${other.slice(0, 40)}" is not a frame of ${ds ? ds.name : 'a new sketch'}. Its frames: ${framesWords(allowed)}.`);
    // In the design system's own order.
    frames = allowed.filter((f) => frames.includes(f));
  }
  const variants = input.variants ?? DEFAULT_VARIANTS;
  if (typeof variants !== 'number' || !Number.isInteger(variants) || variants < MIN_VARIANTS || variants > MAX_VARIANTS) throw new Error(`Variants go from ${MIN_VARIANTS} to ${MAX_VARIANTS}.`);
  return { designSystem: ds ? { id: ds.id, version: ds.version } : null, frames, variants };
}

/** The pictures of the message, as bytes, checked before anything is written. */
export function checkedPictures(pictures: unknown): { kind: PictureKind; bytes: Buffer }[] {
  if (pictures === undefined || pictures === null) return [];
  if (!Array.isArray(pictures)) throw new Error('The pictures must be a list.');
  if (pictures.length > MAX_START_PICTURES) throw new Error(`Add at most ${MAX_START_PICTURES} pictures to one message.`);
  return pictures.map((p, i) => {
    const data = isPlain(p) && typeof p.data === 'string' ? p.data : '';
    const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]*)$/.exec(data);
    if (!m) throw new Error(`Picture ${i + 1} could not be read. Add it again.`);
    const bytes = Buffer.from(m[2]!, 'base64');
    if (bytes.length > MAX_PICTURE_BYTES) throw new Error(`Picture ${i + 1} is larger than 10 MB.`);
    const kind = pictureKindOf(bytes);
    if (!kind) throw new Error(`Picture ${i + 1} is not a PNG, JPEG or WebP picture.`);
    return { kind, bytes };
  });
}

/** Small words a name does not end on: "A page where patients book a" reads better as "A page where patients book". */
const TRAILING = /[\s.,;:!?،؛-]+$|\s+(?:a|an|and|at|by|for|in|of|on|or|the|to|with)$/iu;

/** The sketch's name: the message's first words, on one line. "A page where patients book a visit with …" → "A page where patients book". */
export function sketchNameFrom(message: string): string {
  const words = message.trim().split(/\s+/).slice(0, NAME_WORDS).join(' ');
  let name = words.length > NAME_MAX ? words.slice(0, NAME_MAX).replace(/\s+\S*$/, '') || words.slice(0, NAME_MAX) : words;
  for (let next = name.replace(TRAILING, ''); next && next !== name; next = name.replace(TRAILING, '')) name = next;
  return name.replace(/[\s.,;:!?،؛-]+$/u, '') || 'New sketch';
}

/**
 * Makes the sketch from the first message and keeps the message, with its pictures, in the sketch's chat on this
 * computer. An empty message is refused, and so is a picture that is not one, before anything is written.
 */
export function startSketch(bp: BoardPaths, input: StartSketchInput): { id: string; name: string } {
  if (!isPlain(input as unknown)) throw new Error('Write what you want to design first.');
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message) throw new Error('Write what you want to design first.');
  if (message.length > MAX_MESSAGE) throw new Error(`Keep the message under ${MAX_MESSAGE} letters.`);
  const pictures = checkedPictures(input.pictures);
  const choice = checkedStartChoice(bp, input);

  // The same rule as every other name (AB-138.1): a used one becomes "… 2", "… 3". It is a first name only: the AI
  // Designer names the sketch and its first screen on its first turn (US-08).
  const name = freeSketchName(bp, sketchNameFrom(message));
  const sketch = createSketch(bp, { id: freeSketchId(bp, name), name, designSystem: choice.designSystem, frames: choice.frames });

  // This computer's part: the pictures, then the chat that names them.
  const files = pictures.map((p, i) => {
    const file = `m1-${i + 1}.${PICTURE_KINDS[p.kind]}`;
    writeShared(chatPictureFile(bp, sketch.id, file), p.bytes);
    return file;
  });
  // The variants asked for and the "still to be named" mark go with the first message, on this computer only.
  const start: StartMark = { variants: choice.variants, unnamed: true };
  saveChat(bp, sketch.id, FIRST_CHAT, { messages: [{ role: 'person', text: message, at: new Date().toISOString(), ...(files.length ? { pictures: files } : {}), start }] });
  return { id: sketch.id, name: sketch.name };
}

/**
 * The start page's mark on a sketch's first message (US-08): how many variants of the first screen to draw and, until
 * the AI Designer has named the sketch, `unnamed`. Null when the sketch was not started from the start page.
 */
export function startMarkOf(bp: BoardPaths, sketch: string): StartMark | null {
  const first = readChat(bp, sketch, FIRST_CHAT)?.messages?.[0];
  const m = isPlain(first) && first.role === 'person' && isPlain(first.start) ? first.start : null;
  if (!m) return null;
  const variants = typeof m.variants === 'number' && Number.isInteger(m.variants) ? Math.min(MAX_VARIANTS, Math.max(MIN_VARIANTS, m.variants)) : DEFAULT_VARIANTS;
  return { variants, ...(m.unnamed === true ? { unnamed: true } : {}) };
}

/** Takes the "still to be named" mark off the first message, once the AI Designer has named the sketch. */
export function markSketchNamed(bp: BoardPaths, sketch: string): void {
  const chat = readChat(bp, sketch, FIRST_CHAT);
  const first = chat?.messages?.[0];
  if (!chat || !isPlain(first) || !isPlain(first.start) || first.start.unnamed !== true) return;
  const { unnamed: _named, ...rest } = first.start;
  saveChat(bp, sketch, FIRST_CHAT, { ...chat, messages: [{ ...first, start: rest as StartMark }, ...chat.messages.slice(1)] });
}

/** A sketch's chat as the workspace shows it, with each message's picture files that are still there. Empty when there is none. */
export function sketchChat(bp: BoardPaths, sketch: string): StudioChat {
  getSketch(bp, sketch);
  const chat = readChat(bp, sketch, FIRST_CHAT);
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  return {
    messages: messages
      .filter((m) => isPlain(m) && typeof m.text === 'string' && (m.role === 'person' || m.role === 'designer'))
      .map((m) => ({
        role: m.role,
        text: m.text,
        ...(typeof m.at === 'string' ? { at: m.at } : {}),
        pictures: (Array.isArray(m.pictures) ? m.pictures : []).filter((f): f is string => typeof f === 'string' && CHAT_PICTURE.test(f) && fs.existsSync(chatPictureFile(bp, sketch, f))),
      })),
  };
}

/** One picture of a sketch's messages, with its type, or null when it is not there. */
export function sketchChatPicture(bp: BoardPaths, sketch: string, file: string): { bytes: Buffer; type: string } | null {
  if (!CHAT_PICTURE.test(file)) return null;
  const at = chatPictureFile(bp, sketch, file);
  if (!fs.existsSync(at)) return null;
  const bytes = fs.readFileSync(at);
  const kind = pictureKindOf(bytes);
  return kind ? { bytes, type: kind } : null;
}
