import fs from 'node:fs';
import type { BoardPaths } from './store.js';
import { checkedStudioId, designSystemFile, ownerChatFile, screenFile, sketchFile, thumbnailFile, type ChatOwner } from './studio-paths.js';
import { plainFile, writeShared } from './studio-files.js';
import { readScreenFile } from './studio-read.js';

/**
 * The Studio's part that stays on this computer (AB-128.2): thumbnails and the AI Designer chats, outside the project
 * and in no stamp. Part of the Studio store: later stories import these through studio.ts.
 */

export type { ChatOwner } from './studio-paths.js';

const KIND_WORDS: Record<ChatOwner['kind'], string> = { 'design-system': 'design system', sketch: 'sketch' };


/**
 * A thumbnail of one variant of a screen. It goes only into this computer's folder for the project, never into
 * `.squad/`, and is not part of any stamp: a teammate makes their own.
 */
export function saveThumbnail(bp: BoardPaths, sketch: string, screen: string, version: number, png: Buffer): string {
  const at = screenFile(bp, checkedStudioId(sketch), checkedStudioId(screen));
  if (!plainFile(at)) throw new Error(`The sketch "${sketch}" has no screen "${screen}".`);
  readScreenFile(at);
  if (!Buffer.isBuffer(png) || !png.length) throw new Error('The thumbnail is empty.');
  const file = thumbnailFile(bp, sketch, screen, version);
  writeShared(file, png);
  return file;
}

export function readThumbnail(bp: BoardPaths, sketch: string, screen: string, version: number): Buffer | null {
  const file = thumbnailFile(bp, sketch, screen, version);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

/**
 * What the AI Designer did with a message (AB-177.1). "needs-design-system": variants were asked for on a sketch with
 * no design system, so nothing was drawn (US-17); the board shows it as an alert to select one, or to skip.
 */
export type ChatReplyKind = 'answer' | 'ask' | 'unavailable' | 'changed' | 'stopped' | 'failed' | 'needs-design-system';

/**
 * A pick made with a Studio button (US-18, AB-143.1): the screen, the version now in use, the variant's letter and short
 * name when it has them, who picked it and when, as the screen file's mark says.
 */
export interface PickMark {
  screen: string;
  screenName: string;
  version: number;
  letter?: string;
  name?: string;
  at: string;
  by?: string;
}

/**
 * One line of a chat. "person" and "designer" are the messages; "action" is a short line a Studio button added after
 * its save (AB-143.1), such as "You picked Variant B · Step by step". The Designer is told about those on its next turn.
 */
export interface StudioChatMessage {
  role: 'person' | 'designer' | 'action';
  text: string;
  at?: string;
  /** The message's picture files in its chats' pictures folder (ownerChatPictureFile, AB-130.1). */
  pictures?: string[];
  /** A Designer reply: what it did with the message. Only "changed" and "stopped" ever saved a version. */
  kind?: ChatReplyKind;
  /** A Designer reply that saved work: each screen (or component) with its new version. */
  saved?: { screen: string; name?: string; version?: number }[];
  /** A person's message: the screen and frame they were looking at. */
  lookingAt?: { screen?: string; frame?: string };
  /** The start page's first message (US-08): the variants asked for, and whether the sketch is still to be named. */
  start?: StartMark;
  /** An "action" line for "Use this one" (US-18): what was picked, by whom and when. */
  picked?: PickMark;
}

/** What the start page keeps on a sketch's first message (US-08), on this computer only. */
export interface StartMark {
  /** How many variants of the first screen the AI Designer draws: 1 to 3. */
  variants: number;
  /** The AI Designer has not named the sketch and its first screen yet. */
  unnamed?: boolean;
}

export interface StudioChat {
  /** What the chat is about, when it is about one screen. */
  screen?: string;
  /** When the conversation was started. */
  startedAt?: string;
  /** The AI tool's own session for this conversation: the next message resumes it. */
  session?: string;
  messages: StudioChatMessage[];
}

/** A sketch id alone means the sketch. */
function chatOwner(owner: string | ChatOwner): ChatOwner {
  return typeof owner === 'string' ? { kind: 'sketch', id: owner } : owner;
}

/**
 * An AI Designer chat about a sketch or a design system. Like thumbnails, it stays on this computer and is not part of
 * any stamp.
 */
export function saveChat(bp: BoardPaths, owner: string | ChatOwner, chat: string, contents: StudioChat): string {
  const o = chatOwner(owner);
  checkedStudioId(o.id);
  const saved = o.kind === 'design-system' ? designSystemFile(bp, o.id) : sketchFile(bp, o.id);
  if (!plainFile(saved)) throw new Error(`This project has no ${KIND_WORDS[o.kind]} "${o.id}".`);
  if (contents.screen !== undefined) checkedStudioId(contents.screen);
  if (!Array.isArray(contents.messages)) throw new Error('A chat is a list of messages.');
  const file = ownerChatFile(bp, o, chat);
  writeShared(file, `${JSON.stringify(contents, null, 2)}\n`);
  return file;
}

export function readChat(bp: BoardPaths, owner: string | ChatOwner, chat: string): StudioChat | null {
  const file = ownerChatFile(bp, chatOwner(owner), chat);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as StudioChat;
  } catch {
    return null;
  }
}
