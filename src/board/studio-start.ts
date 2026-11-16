import fs from 'node:fs';
import type { BoardPaths } from './store.js';
import { isPlain } from './shape.js';
import { readChat, saveChat, studioIdFor, type StudioChat } from './studio.js';
import { createSketch, getSketch, newSketchDesignSystem } from './studio-actions.js';
import { writeShared } from './studio-files.js';
import { CHAT_PICTURE, chatPictureFile, sketchDir } from './studio-paths.js';

/**
 * The first message on the Studio's start page (US-05, AB-130): it makes the sketch and keeps the message.
 *
 * The sketch is made through the Studio actions (AB-128.2): its name comes from the message's first words, its id from
 * the name (with -2, -3 … when taken), and it follows the project's Default design system, or none. The message and
 * its pictures are kept only in this computer's chat folder for the sketch (AB-130.1), never in the project. Nothing
 * calls the AI Designer yet: its answer comes in a later story, through the one Designer runner (AB-141.1).
 */

/** The chat the start page's first message opens. */
export const FIRST_CHAT = 'main';
export const MAX_MESSAGE = 4000;
export const MAX_START_PICTURES = 4;
export const MAX_PICTURE_BYTES = 10 * 1024 * 1024;
/** How many of the message's first words name the sketch. */
const NAME_WORDS = 6;
const NAME_MAX = 60;
/** The id is kept short, so -2, -3 … always fit. */
const ID_MAX = 40;

const KINDS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
type PictureKind = keyof typeof KINDS;

/** What the bytes are, from their first bytes: a file is never taken for what its name or its type says. */
function kindOf(bytes: Buffer): PictureKind | null {
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
}

/** The pictures of the message, as bytes, checked before anything is written. */
function checkedPictures(pictures: unknown): { kind: PictureKind; bytes: Buffer }[] {
  if (pictures === undefined || pictures === null) return [];
  if (!Array.isArray(pictures)) throw new Error('The pictures must be a list.');
  if (pictures.length > MAX_START_PICTURES) throw new Error(`Add at most ${MAX_START_PICTURES} pictures to one message.`);
  return pictures.map((p, i) => {
    const data = isPlain(p) && typeof p.data === 'string' ? p.data : '';
    const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]*)$/.exec(data);
    if (!m) throw new Error(`Picture ${i + 1} could not be read. Add it again.`);
    const bytes = Buffer.from(m[2]!, 'base64');
    if (bytes.length > MAX_PICTURE_BYTES) throw new Error(`Picture ${i + 1} is larger than 10 MB.`);
    const kind = kindOf(bytes);
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

/** A short id from the name, with -2, -3 … when the project already has a sketch by it. */
export function freeSketchId(bp: BoardPaths, name: string): string {
  const base = studioIdFor(name).slice(0, ID_MAX).replace(/-+$/, '') || 'sketch';
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!fs.existsSync(sketchDir(bp, id))) return id;
  }
  throw new Error('This project has too many sketches with that name. Use other words.');
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

  const name = sketchNameFrom(message);
  const def = newSketchDesignSystem(bp);
  const sketch = createSketch(bp, { id: freeSketchId(bp, name), name, designSystem: def ? { id: def.id, version: def.version } : null });

  // This computer's part: the pictures, then the chat that names them.
  const files = pictures.map((p, i) => {
    const file = `m1-${i + 1}.${KINDS[p.kind]}`;
    writeShared(chatPictureFile(bp, sketch.id, file), p.bytes);
    return file;
  });
  saveChat(bp, sketch.id, FIRST_CHAT, { messages: [{ role: 'person', text: message, at: new Date().toISOString(), ...(files.length ? { pictures: files } : {}) }] });
  return { id: sketch.id, name: sketch.name };
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
  const kind = kindOf(bytes);
  return kind ? { bytes, type: kind } : null;
}
