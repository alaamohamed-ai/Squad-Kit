import type { BoardPaths } from '../board/store.js';
import type { ChatOwner } from '../board/studio.js';
import { currentConversation } from '../board/studio-chats.js';
import { checkedStudioId } from '../board/studio-paths.js';
import { writeLog } from '../core/app-log.js';
import { answerChatTurn, startChatTurn, type ChatAsk } from './studio-chat.js';

/**
 * The board's chat messages with the AI Designer, each answered in the background (US-52, AB-177): one at a time per
 * conversation, so a second message waits for the answer or for Stop. While one works, the board reads what it is
 * doing ("Changing screen 2 of 2: Confirmation"); Stop ends it, and the finished screens are kept (studio-chat.ts).
 */

interface ChatJob {
  doing: string;
  since: string;
  controller: AbortController;
  done: Promise<void>;
}

const jobs = new Map<string, ChatJob>();

const keyOf = (bp: BoardPaths, owner: ChatOwner, chat: string) => `${bp.root}\n${owner.kind}\n${owner.id}\n${chat}`;

/** The message answered now in a conversation: what the Designer is doing and since when, or null. */
export function chatWorking(bp: BoardPaths, owner: ChatOwner, chat: string): { doing: string; since: string } | null {
  const job = jobs.get(keyOf(bp, owner, chat));
  return job ? { doing: job.doing, since: job.since } : null;
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
export function startChatJob(bp: BoardPaths, ask: ChatAsk): { chat: string; working: { doing: string; since: string } } {
  const chat = checkedStudioId(ask.chat ?? currentConversation(bp, ask.owner));
  const key = keyOf(bp, ask.owner, chat);
  if (jobs.has(key)) throw new ChatBusy();
  const turn = startChatTurn(bp, { ...ask, chat });
  const controller = new AbortController();
  const job: ChatJob = { doing: 'Reading your message', since: new Date().toISOString(), controller, done: Promise.resolve() };
  jobs.set(key, job);
  job.done = answerChatTurn(bp, turn, {
    signal: controller.signal,
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
      jobs.delete(key);
    });
  return { chat, working: { doing: job.doing, since: job.since } };
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
