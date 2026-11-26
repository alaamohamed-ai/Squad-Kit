import fs from 'node:fs';
import type { BoardPaths } from './store.js';
import { isPlain } from './shape.js';
import { readChat, saveChat, type ApprovalLine, type ChatOwner, type PickMark, type StudioChat, type StudioChatMessage } from './studio.js';
import { StudioNotFound, getDesignSystem, getSketch } from './studio-actions.js';
import { writeShared } from './studio-files.js';
import { holdStudio } from './studio-lock.js';
import { CHAT_PICTURE, checkedStudioId, ownerChatPictureFile, ownerChatsDir } from './studio-paths.js';
import { FIRST_CHAT, MAX_MESSAGE, MAX_START_PICTURES, PICTURE_KINDS, checkedPictures, pictureKindOf, type StartPicture } from './studio-start.js';

/**
 * Conversations with the AI Designer (US-52, AB-177), kept on this computer only, never in the project (AB-128.2):
 * several per sketch and per design system, each with its messages, the pictures added to them (AB-130.1) and the AI
 * tool's own session, so the next message resumes the same session. The start page's first message is the first one
 * of the sketch's first conversation ("main"). New conversation starts the next one, numbered: "talk-2", "talk-3" …;
 * the old ones stay and can be opened again. None of it is part of any stamp, and no version is touched.
 */

/** A conversation in the list: newest first. */
export interface ConversationRow {
  id: string;
  startedAt: string | null;
  /** How many messages it has. */
  messages: number;
  /** Its first message, to tell conversations apart. */
  first: string | null;
  /** When its last message was written. */
  lastAt: string | null;
}

/** One message as the chat shows it: its pictures are the files that are still there. */
export type ConversationMessage = StudioChatMessage & { pictures: string[] };

export interface ConversationView {
  id: string;
  owner: ChatOwner;
  startedAt: string | null;
  messages: ConversationMessage[];
}

/** The owner must exist: a missing sketch or design system is StudioNotFound. Returns its name. */
export function chatOwnerName(bp: BoardPaths, owner: ChatOwner): string {
  if (owner.kind === 'design-system') return getDesignSystem(bp, owner.id).name;
  if (owner.kind === 'sketch') return getSketch(bp, owner.id).name;
  throw new Error('A chat is about a sketch or a design system.');
}

/** A conversation's place in the list: "main" is the first, "talk-N" the Nth; any other name comes before them. */
function numberOf(chat: string): number {
  if (chat === FIRST_CHAT) return 1;
  const m = /^talk-(\d{1,6})$/.exec(chat);
  return m ? Number(m[1]) : 0;
}

function conversationIds(bp: BoardPaths, owner: ChatOwner): string[] {
  const dir = ownerChatsDir(bp, owner);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter((id) => {
      try {
        return checkedStudioId(id) === id;
      } catch {
        return false;
      }
    });
}

function rowOf(id: string, chat: StudioChat | null): ConversationRow {
  const messages = Array.isArray(chat?.messages) ? chat.messages.filter(isMessage) : [];
  // A pick line (AB-143.1) is not what tells conversations apart: the first message is.
  const first = messages.find((m) => m.role !== 'action');
  return {
    id,
    startedAt: typeof chat?.startedAt === 'string' ? chat.startedAt : (messages[0]?.at ?? null),
    messages: messages.length,
    first: first?.text.slice(0, 120) ?? null,
    lastAt: messages[messages.length - 1]?.at ?? null,
  };
}

/** A message, or a line a Studio button added (a pick, an approval, a save anyway, AB-143.1); anything else is left out. */
function isMessage(m: unknown): m is StudioChatMessage {
  if (!isPlain(m) || typeof m.text !== 'string') return false;
  if (m.role === 'person' || m.role === 'designer') return true;
  return m.role === 'action' && (isPickMark(m.picked) || isApprovalLine(m.approval) || (isPlain(m.savedAnyway) && Array.isArray(m.savedAnyway.saved)));
}

function isApprovalLine(a: unknown): a is ApprovalLine {
  return isPlain(a) && typeof a.screen === 'string' && typeof a.screenName === 'string' && typeof a.version === 'number' && typeof a.at === 'string';
}

function isPickMark(p: unknown): p is PickMark {
  return isPlain(p) && typeof p.screen === 'string' && typeof p.screenName === 'string' && typeof p.version === 'number' && typeof p.at === 'string';
}

/** Every conversation about a sketch or a design system, newest first. Reading writes nothing (AB-127.1). */
export function listConversations(bp: BoardPaths, owner: ChatOwner): ConversationRow[] {
  chatOwnerName(bp, owner);
  return conversationIds(bp, owner)
    .sort((a, b) => numberOf(b) - numberOf(a) || b.localeCompare(a))
    .map((id) => rowOf(id, readChat(bp, owner, id)));
}

/** The conversation a chat opens on: the newest, or the first one ("main") when there is none yet. */
export function currentConversation(bp: BoardPaths, owner: ChatOwner): string {
  return listConversations(bp, owner)[0]?.id ?? FIRST_CHAT;
}

/**
 * New conversation: an empty chat after the others, which all stay. When the newest one is still empty, it is the one,
 * so pressing it twice does not pile up empty chats. Versions are never touched.
 */
export function newConversation(bp: BoardPaths, owner: ChatOwner): ConversationRow {
  const list = listConversations(bp, owner);
  if (list[0] && list[0].messages === 0) return list[0];
  const next = Math.max(1, ...list.map((c) => numberOf(c.id))) + 1;
  const id = list.length ? `talk-${next}` : FIRST_CHAT;
  const chat: StudioChat = { startedAt: new Date().toISOString(), messages: [] };
  saveChat(bp, owner, id, chat);
  return rowOf(id, chat);
}

/** One conversation as the chat shows it. The first one is empty until its first message; any other must exist. */
export function readConversation(bp: BoardPaths, owner: ChatOwner, chat: string): ConversationView {
  chatOwnerName(bp, owner);
  checkedStudioId(chat);
  const saved = readChat(bp, owner, chat);
  if (!saved && chat !== FIRST_CHAT) throw new StudioNotFound('This conversation is not here any more.');
  const messages = Array.isArray(saved?.messages) ? saved.messages.filter(isMessage) : [];
  return {
    id: chat,
    owner,
    startedAt: saved?.startedAt ?? messages[0]?.at ?? null,
    messages: messages.map((m) => ({
      ...m,
      pictures: (Array.isArray(m.pictures) ? m.pictures : []).filter((f): f is string => typeof f === 'string' && CHAT_PICTURE.test(f) && fs.existsSync(ownerChatPictureFile(bp, owner, f))),
    })),
  };
}

/** The AI tool's session of a conversation, when it has one. */
export function conversationSession(bp: BoardPaths, owner: ChatOwner, chat: string): string | undefined {
  const s = readChat(bp, owner, chat)?.session;
  return typeof s === 'string' && s ? s : undefined;
}

/**
 * Reads, changes and saves a conversation under the project's Studio lock, so a pick's line (AB-143.1) and a reply
 * written by another process at the same moment never write over each other.
 */
export function updateChat(bp: BoardPaths, owner: ChatOwner, chat: string, change: (c: StudioChat) => void): void {
  holdStudio(bp, () => {
    const saved = readChat(bp, owner, chat);
    const c: StudioChat = saved && Array.isArray(saved.messages) ? saved : { startedAt: new Date().toISOString(), messages: [] };
    change(c);
    saveChat(bp, owner, chat, c);
  });
}

/** Adds one message at the end of a conversation, made when it has none yet. */
export function addChatMessage(bp: BoardPaths, owner: ChatOwner, chat: string, message: StudioChatMessage): void {
  updateChat(bp, owner, chat, (c) => {
    c.messages.push({ ...message, at: message.at ?? new Date().toISOString() });
  });
}

/** The words of a pick line: "You picked Variant B · Step by step", or "You picked Form v3" for a variant with no letter. */
export function pickWords(p: PickMark): string {
  if (!p.letter) return `You picked ${p.screenName} v${p.version}`;
  return `You picked Variant ${p.letter}${p.name ? ` · ${p.name}` : ''}`;
}

/**
 * Adds the short line a pick made with "Use this one" leaves in a conversation (US-18, AB-143.1), on this computer only.
 * The pick's caller adds it only after the pick was saved, so a refused pick adds nothing.
 */
export function addPickLine(bp: BoardPaths, owner: ChatOwner, chat: string, picked: PickMark): StudioChatMessage {
  checkedStudioId(chat);
  const line: StudioChatMessage = { role: 'action', text: pickWords(picked), at: picked.at, picked };
  addChatMessage(bp, owner, chat, line);
  return line;
}

/** The words of an approval line (US-15): "Alaa approved Form at v3", "Alaa reopened Form"; "You …" when no name is set. */
export function approvalWords(a: ApprovalLine): string {
  const who = a.by?.trim() || 'You';
  return a.reopened ? `${who} reopened ${a.screenName}` : `${who} approved ${a.screenName} at v${a.version}`;
}

/**
 * Adds the short line Approve or Reopen leaves in a conversation (US-15, AB-143.1), on this computer only. The caller
 * adds it only after the change was saved, so a refused one adds nothing.
 */
export function addApprovalLine(bp: BoardPaths, owner: ChatOwner, chat: string, approval: ApprovalLine): StudioChatMessage {
  checkedStudioId(chat);
  const line: StudioChatMessage = { role: 'action', text: approvalWords(approval), at: approval.at, approval };
  addChatMessage(bp, owner, chat, line);
  return line;
}

/**
 * The picks made since the AI Designer's last reply in a conversation, as it is told about them on its next turn:
 * "Variant B · Step by step of Form".
 */
export function picksSinceReply(messages: StudioChatMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === 'designer') out.length = 0;
    else if (m.role === 'action' && m.picked) out.push(`${pickWords(m.picked).replace(/^You picked /, '')}${m.picked.letter ? ` of ${m.picked.screenName}` : ''}`);
  }
  return out;
}

/** Keeps the AI tool's session, so the next message in this conversation resumes it. */
export function saveConversationSession(bp: BoardPaths, owner: ChatOwner, chat: string, session: string): void {
  if (!session) return;
  updateChat(bp, owner, chat, (c) => {
    c.session = session;
  });
}

export interface PersonMessageInput {
  text: string;
  pictures?: StartPicture[];
  lookingAt?: { screen?: string; frame?: string };
}

/** What a person's message became: as saved, with its pictures as files on this computer for the Designer to read. */
export interface SavedPersonMessage {
  message: StudioChatMessage;
  pictureFiles: string[];
}

function lookingAtOf(x: unknown): StudioChatMessage['lookingAt'] | undefined {
  if (!isPlain(x)) return undefined;
  const pick = (v: unknown) => (typeof v === 'string' && /^[a-z0-9-]{1,64}$/.test(v) ? v : undefined);
  const screen = pick(x.screen);
  const frame = pick(x.frame);
  return screen || frame ? { ...(screen ? { screen } : {}), ...(frame ? { frame } : {}) } : undefined;
}

/**
 * Checks a person's message and keeps it at the end of the conversation, with its pictures beside the chat. An empty
 * message, one too long or a picture that is not one is refused before anything is written.
 */
export function addPersonMessage(bp: BoardPaths, owner: ChatOwner, chat: string, input: PersonMessageInput): SavedPersonMessage {
  if (!isPlain(input as unknown)) throw new Error('Write a message first.');
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new Error('Write a message first.');
  if (text.length > MAX_MESSAGE) throw new Error(`Keep the message under ${MAX_MESSAGE} letters.`);
  const pictures = checkedPictures(input.pictures);
  if (pictures.length > MAX_START_PICTURES) throw new Error(`Add at most ${MAX_START_PICTURES} pictures to one message.`);
  checkedStudioId(chat);
  chatOwnerName(bp, owner);
  const n = (readChat(bp, owner, chat)?.messages?.length ?? 0) + 1;
  const pictureFiles: string[] = [];
  const names = pictures.map((p, i) => {
    const name = `${chat}-m${n}-${i + 1}.${PICTURE_KINDS[p.kind]}`;
    const file = ownerChatPictureFile(bp, owner, name);
    writeShared(file, p.bytes);
    pictureFiles.push(file);
    return name;
  });
  const lookingAt = lookingAtOf(input.lookingAt);
  const message: StudioChatMessage = { role: 'person', text, at: new Date().toISOString(), ...(names.length ? { pictures: names } : {}), ...(lookingAt ? { lookingAt } : {}) };
  addChatMessage(bp, owner, chat, message);
  return { message, pictureFiles };
}

/** The picture files of a message already kept: the start page's first message, answered later. */
export function messagePictureFiles(bp: BoardPaths, owner: ChatOwner, message: StudioChatMessage): string[] {
  return (message.pictures ?? []).filter((f) => CHAT_PICTURE.test(f)).map((f) => ownerChatPictureFile(bp, owner, f)).filter((f) => fs.existsSync(f));
}

/** One picture of a conversation's messages, with its type, or null when it is not there. */
export function conversationPicture(bp: BoardPaths, owner: ChatOwner, file: string): { bytes: Buffer; type: string } | null {
  if (!CHAT_PICTURE.test(file)) return null;
  const at = ownerChatPictureFile(bp, owner, file);
  if (!fs.existsSync(at)) return null;
  const bytes = fs.readFileSync(at);
  const kind = pictureKindOf(bytes);
  return kind ? { bytes, type: kind } : null;
}
