import type { BoardPaths } from '../board/store.js';
import type { ChatOwner } from '../board/studio.js';
import { currentConversation } from '../board/studio-chats.js';
import { checkedStudioId } from '../board/studio-paths.js';
import { writeLog } from '../core/app-log.js';
import { answerChatTurn, startChatTurn, type ChatAsk } from './studio-chat.js';
import { ChatProgress, type ChatWorkView } from './studio-chat-progress.js';

/**
 * The board's chat messages with the AI Designer, each answered in the background (US-52, AB-177): one at a time per
 * conversation, so a second message waits for the answer or for Stop. While one works, the board reads what it is
 * doing ("Changing screen 2 of 2: Confirmation"), with its steps and each finished drawing so far (US-57, AB-182.1),
 * all kept in this memory until the one save at the end; Stop ends it, and the finished screens are kept.
 */

interface ChatJob {
  doing: string;
  since: string;
  progress: ChatProgress;
  controller: AbortController;
  done: Promise<void>;
}

const jobs = new Map<string, ChatJob>();

/** How long an answer's finished drawings stay readable after it ends, for the tab that watched it (US-57). */
const JUST_DRAWN_MS = 15_000;
const justDrawn = new Map<string, { drafts: ChatWorkView['drafts']; until: number }>();

const keyOf = (bp: BoardPaths, owner: ChatOwner, chat: string) => `${bp.root}\n${owner.kind}\n${owner.id}\n${chat}`;

/** What the board reads while a message is answered: what it does now, since when, its steps and its frames. */
export type ChatWorking = { doing: string; since: string } & Omit<ChatWorkView, 'since'>;

/** The message answered now in a conversation: what the Designer is doing and since when, its steps and frames, or null. */
export function chatWorking(bp: BoardPaths, owner: ChatOwner, chat: string): ChatWorking | null {
  const job = jobs.get(keyOf(bp, owner, chat));
  if (!job) return null;
  const { since: _since, ...work } = job.progress.view();
  return { doing: job.doing, since: job.since, ...work };
}

/**
 * The drawings an answer finished, for a short while after it ended: the save can come before the board's next read,
 * and the tab that watched the work still reveals the last drawing the first time it shows. Undefined after that.
 */
export function chatJustDrawn(bp: BoardPaths, owner: ChatOwner, chat: string): ChatWorkView['drafts'] | undefined {
  const key = keyOf(bp, owner, chat);
  const d = justDrawn.get(key);
  if (d && d.until < Date.now()) justDrawn.delete(key);
  return d && d.until >= Date.now() && d.drafts.length ? d.drafts : undefined;
}

/** A conversation already has a message being answered. Nothing was written. */
export class ChatBusy extends Error {
  constructor() {
    super('The AI Designer is still answering in this conversation. Wait for its answer, or press Stop.');
    this.name = 'ChatBusy';
  }
}

/**
 * Keeps the person's message and starts its answer in the background. A conversation answers one message at a time:
 * while one works, the next is refused with ChatBusy before anything is written.
 */
export function startChatJob(bp: BoardPaths, ask: ChatAsk): { chat: string; working: ChatWorking } {
  const chat = checkedStudioId(ask.chat ?? currentConversation(bp, ask.owner));
  const key = keyOf(bp, ask.owner, chat);
  if (jobs.has(key)) throw new ChatBusy();
  const turn = startChatTurn(bp, { ...ask, chat });
  const controller = new AbortController();
  const progress = new ChatProgress(turn.language);
  const job: ChatJob = { doing: 'Reading your message', since: progress.since, progress, controller, done: Promise.resolve() };
  jobs.set(key, job);
  job.done = answerChatTurn(bp, turn, {
    signal: controller.signal,
    progress,
    onProgress: (words) => {
      job.doing = words;
    },
    onWait: (words) => {
      job.doing = words;
    },
  })
    .then(() => undefined)
    .catch((err: unknown) => {
      writeLog({ level: 'warn', text: `The AI Designer's answer could not be kept: ${err instanceof Error ? err.message : String(err)}` });
    })
    .finally(() => {
      justDrawn.set(key, { drafts: progress.finished(), until: Date.now() + JUST_DRAWN_MS });
      jobs.delete(key);
    });
  return { chat, working: chatWorking(bp, ask.owner, chat)! };
}

/** Stops the answer a conversation is working on. The finished screens are kept. False when nothing works there. */
export function stopChatJob(bp: BoardPaths, owner: ChatOwner, chat: string): boolean {
  const job = jobs.get(keyOf(bp, owner, chat));
  if (!job) return false;
  job.doing = 'Stopping';
  job.controller.abort();
  return true;
}

/** Stops every answer going now, in every project: for tests, and for a board that closes. The finished screens are kept. */
export function stopChatJobs(): void {
  for (const job of jobs.values()) {
    job.doing = 'Stopping';
    job.controller.abort();
  }
}

/** Waits until every answer going now has ended: for tests, and for a board that closes. */
export async function chatJobsDone(): Promise<void> {
  await Promise.all([...jobs.values()].map((j) => j.done));
}
