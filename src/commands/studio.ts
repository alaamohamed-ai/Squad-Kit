import kleur from 'kleur';
import { Command } from 'commander';
import * as ui from '../ui/index.js';
import type { BoardPaths } from '../board/store.js';
import { studioIdFor, type ChatOwner, type StudioChatMessage } from '../board/studio.js';
import { listDesignSystems, listSketches } from '../board/studio-actions.js';
import { currentConversation, newConversation, readConversation } from '../board/studio-chats.js';
import { sendChatMessage } from '../engine/studio-chat.js';
import { boardApi, type BoardApi } from './app.js';
import { board } from './board.js';
import { wrapArgs } from './wrap.js';

/**
 * `squad studio chat`: the Studio's chat with the AI Designer, from the terminal (US-52, AB-177). With the board open,
 * it is the board's own call, so the board and the terminal show the same conversation as it goes. Without it, the
 * message is answered here, with what the Designer is doing printed as it goes, then its answer. Ctrl-C stops it, and
 * the finished screens are kept, as the chat's Stop does.
 */

const out = (s = '') => process.stdout.write(`${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ChatOpts {
  designSystem?: boolean;
  new?: boolean;
  stop?: boolean;
}

interface ConversationReply {
  id: string;
  messages: StudioChatMessage[];
  working: { doing: string } | null;
}

/** The sketch or design system a name means: its id, or its name in any case. */
function ownerOf(bp: BoardPaths, name: string, designSystem: boolean): ChatOwner {
  const items = designSystem ? listDesignSystems(bp) : listSketches(bp);
  const wanted = name.trim().toLowerCase();
  const found = items.find((i) => i.id === wanted) ?? items.find((i) => i.name.trim().toLowerCase() === wanted) ?? items.find((i) => i.id === studioIdFor(name.trim()));
  const what = designSystem ? 'design system' : 'sketch';
  const many = designSystem ? 'design systems' : 'sketches';
  if (!found) throw new Error(`This project has no ${what} "${name}".${items.length ? ` Its ${many}: ${items.map((i) => i.id).join(', ')}.` : ''}`);
  return { kind: designSystem ? 'design-system' : 'sketch', id: found.id };
}

/** One message as the terminal prints it. */
export function messageLines(m: StudioChatMessage): string {
  const who = m.role === 'person' ? kleur.bold('You') : kleur.magenta().bold('AI Designer');
  const saved = m.saved?.length ? `\n${kleur.gray(`New version: ${m.saved.map((s) => `${s.name ?? s.screen}${s.version ? ` v${s.version}` : ''}`).join(', ')}`)}` : '';
  return `${who}: ${m.text}${saved}`;
}

function printReply(m: StudioChatMessage): void {
  out();
  out(messageLines(m));
  if (m.kind === 'answer' || m.kind === 'ask' || m.kind === 'unavailable') out(kleur.gray('No version was made.'));
}

function pathOf(owner: ChatOwner, rest = ''): string {
  return `/studio/${owner.kind === 'sketch' ? 'sketches' : 'design-systems'}/${encodeURIComponent(owner.id)}/chats${rest}`;
}

/** The board's own calls, so the board shows the same conversation as it goes. */
async function viaBoard(api: BoardApi, owner: ChatOwner, text: string, opts: ChatOpts): Promise<void> {
  if (opts.stop) {
    const { current } = await api.call<{ current: string }>('GET', pathOf(owner));
    const r = await api.call<{ stopped: boolean }>('POST', pathOf(owner, `/${current}/stop`));
    if (r.stopped) ui.success('Stopping the AI Designer. The finished screens are kept.');
    else ui.info('The AI Designer is not working on anything in this conversation.');
    return;
  }
  if (opts.new) {
    await api.call('POST', pathOf(owner));
    ui.success('New conversation started. The old ones stay, and every version too.');
  }
  const { current } = await api.call<{ current: string }>('GET', pathOf(owner));
  if (!text) return showConversation((await api.call<ConversationReply>('GET', pathOf(owner, `/${current}`))).messages, opts);
  let c = await api.call<ConversationReply>('POST', pathOf(owner, `/${current}/messages`), { text });
  const from = c.messages.length;
  let said = '';
  while (c.working) {
    if (c.working.doing !== said) ui.info((said = c.working.doing));
    await sleep(1000);
    c = await api.call<ConversationReply>('GET', pathOf(owner, `/${current}`));
  }
  for (const m of c.messages.slice(from).filter((x) => x.role === 'designer')) printReply(m);
}

/** No board open: the message is answered here. Ctrl-C stops it, keeping the finished screens. */
async function here(bp: BoardPaths, owner: ChatOwner, text: string, opts: ChatOpts): Promise<void> {
  if (opts.stop) {
    ui.info('Nothing to stop here: without the board, an answer runs in the terminal that asked for it. Press Ctrl-C there.');
    return;
  }
  if (opts.new) {
    newConversation(bp, owner);
    ui.success('New conversation started. The old ones stay, and every version too.');
  }
  if (!text) return showConversation(readConversation(bp, owner, currentConversation(bp, owner)).messages, opts);
  const stop = new AbortController();
  const onInt = () => {
    ui.info('Stopping. The finished screens are kept.');
    stop.abort();
  };
  process.once('SIGINT', onInt);
  try {
    const r = await sendChatMessage(bp, { owner, text }, { signal: stop.signal, onProgress: (w) => ui.info(w), onWait: (w) => ui.info(w) });
    printReply(r.reply);
  } finally {
    process.removeListener('SIGINT', onInt);
  }
}

function showConversation(messages: StudioChatMessage[], opts: ChatOpts): void {
  if (!messages.length) {
    if (!opts.new) ui.info('No messages yet. Ask something: squad studio chat <name> "Which variant suits older patients?"');
    return;
  }
  for (const m of messages) {
    out(messageLines(m));
    out();
  }
}

/** The command's work, given the board and the open board's API (null when it is not open). */
export async function studioChat(bp: BoardPaths, api: BoardApi | null, name: string, words: string[], opts: ChatOpts): Promise<void> {
  const owner = ownerOf(bp, name, Boolean(opts.designSystem));
  const text = words.join(' ').trim();
  if (api) await viaBoard(api, owner, text, opts);
  else await here(bp, owner, text, opts);
}

export async function runStudioChat(name: string, words: string[], opts: ChatOpts): Promise<void> {
  const bp = board();
  await studioChat(bp, boardApi(bp), name, words, opts);
}

export function studioCommand(): Command {
  const s = new Command('studio').description("The Studio: talk with the AI Designer about your sketches and design systems");
  s.command('chat <name> [message...]')
    .description('Ask the AI Designer about a sketch, or ask it for a change. Questions change nothing; only a change makes a new version. With no message, it shows the conversation')
    .option('--design-system', 'Talk about a design system instead of a sketch')
    .option('--new', 'Start a new conversation; the old ones and every version stay')
    .option('--stop', 'Stop the answer the AI Designer is working on; the finished screens are kept')
    .action(wrapArgs(runStudioChat));
  return s;
}
