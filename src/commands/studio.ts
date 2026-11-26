import kleur from 'kleur';
import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import type { BoardPaths } from '../board/store.js';
import { approvedWords, screenNameKey, sketchNameKey, studioIdFor, variantOfLetter, type ApprovalLine, type ChatOwner, type PickMark, type SketchScreen, type StudioChatMessage } from '../board/studio.js';
import { addScreen, approveSketchScreen, changeSketch, deleteScreen, deleteSketch, duplicateSketch, listDesignSystems, listSketches, pickScreenVariant, reopenSketchScreen, sketchList, type SketchView } from '../board/studio-actions.js';
import { approvalWords, currentConversation, newConversation, pickWords, readConversation } from '../board/studio-chats.js';
import { sendChatMessage } from '../engine/studio-chat.js';
import { saveUnsaved } from '../engine/studio-chat-save.js';
import { boardApi, type BoardApi } from './app.js';
import { board } from './board.js';
import { wrapArgs } from './wrap.js';

/**
 * `squad studio chat`: the Studio's chat with the AI Designer, from the terminal (US-52, AB-177). With the board open,
 * it is the board's own call, so the board and the terminal show the same conversation as it goes. Without it, the
 * message is answered here, with what the Designer is doing printed as it goes, then its answer. Ctrl-C stops it, and
 * the finished screens are kept, as the chat's Stop does.
 *
 * `squad studio sketch list|rename|duplicate|delete` (US-13, AB-138): the card menu's actions, calling the same Studio
 * actions the board calls, so a used name, a copy's name and a stale stamp follow the same rules (AB-138.1, AB-129.1).
 *
 * `squad studio sketch screen add|delete` (US-11, AB-136): Add screen and a tab's Delete, with the same screen-name rule
 * (AB-136.1): through the board when it is open, and through the Studio store when it is not.
 *
 * `squad studio sketch screen approve|reopen` (US-15, AB-140): Approve screen and Reopen, with the same lock: while a
 * screen is approved, a pick, a delete or a change to it from the terminal is refused with "Form is approved. Reopen it
 * first."
 */

const out = (s = '') => process.stdout.write(`${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ChatOpts {
  designSystem?: boolean;
  new?: boolean;
  stop?: boolean;
  saveAnyway?: boolean;
}

/** The newest reply in a conversation whose drawings were kept "Not saved" (US-57), or null. */
function lastUnsaved(messages: StudioChatMessage[]): string | null {
  return [...messages].reverse().find((m) => m.role === 'designer' && m.unsaved)?.unsaved?.id ?? null;
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
  // A Studio button's line (AB-143.1): "You picked Variant B · Step by step".
  if (m.role === 'action') return kleur.gray(`· ${m.text}`);
  const who = m.role === 'person' ? kleur.bold('You') : kleur.magenta().bold('AI Designer');
  const saved = m.saved?.length ? `\n${kleur.gray(`New version: ${m.saved.map((s) => `${s.name ?? s.screen}${s.version ? ` v${s.version}` : ''}`).join(', ')}`)}` : '';
  return `${who}: ${m.text}${saved}`;
}

function printReply(m: StudioChatMessage): void {
  out();
  out(messageLines(m));
  if (m.kind === 'answer' || m.kind === 'ask' || m.kind === 'unavailable') out(kleur.gray('No version was made.'));
  if (m.unsaved) out(kleur.gray('To save them anyway, as a new version on top: add --save-anyway to this command, with no message.'));
}

function pathOf(owner: ChatOwner, rest = ''): string {
  return `/studio/${owner.kind === 'sketch' ? 'sketches' : 'design-systems'}/${encodeURIComponent(owner.id)}/chats${rest}`;
}

/** The board's own calls, so the board shows the same conversation as it goes. */
async function viaBoard(api: BoardApi, owner: ChatOwner, text: string, opts: ChatOpts): Promise<void> {
  if (opts.saveAnyway) {
    const { current } = await api.call<{ current: string }>('GET', pathOf(owner));
    const id = lastUnsaved((await api.call<ConversationReply>('GET', pathOf(owner, `/${current}`))).messages);
    if (!id) {
      ui.info('Nothing is waiting to be saved in this conversation.');
      return;
    }
    const c = await api.call<ConversationReply>('POST', pathOf(owner, `/${current}/unsaved/${encodeURIComponent(id)}/save`), {});
    ui.success(c.messages[c.messages.length - 1]?.text ?? 'Saved.');
    return;
  }
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
  if (opts.saveAnyway) {
    const current = currentConversation(bp, owner);
    const id = lastUnsaved(readConversation(bp, owner, current).messages);
    if (id) ui.success(saveUnsaved(bp, owner, current, id).text);
    else ui.info('Nothing is waiting to be saved in this conversation.');
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

/* ── squad studio sketch: list, rename, duplicate, delete (US-13, AB-138) ── */

interface SketchOpts {
  stamp?: string;
  yes?: boolean;
}

/**
 * The sketch a word means: its id, or its name in any case and without spaces at the ends. Two sketches a merge left
 * with one name are not guessed between: the person names one by its id.
 */
export function sketchNamed(bp: BoardPaths, word: string): SketchView {
  const sketches = listSketches(bp);
  const byId = sketches.find((s) => s.id === word.trim());
  if (byId) return byId;
  const named = sketches.filter((s) => sketchNameKey(s.name) === sketchNameKey(word));
  if (named.length > 1) throw new Error(`${named.length} sketches are called "${named[0]!.name}": ${named.map((s) => s.id).join(', ')}. Name one by its id.`);
  if (named[0]) return named[0];
  throw new Error(`This project has no sketch "${word}".${sketches.length ? ` Its sketches: ${sketches.map((s) => s.id).join(', ')}.` : ''} See them: squad studio sketch list`);
}

/** The stamp a change brings (AB-129.1): the one given with --stamp, or else the one just read. */
function stampFor(sketch: SketchView, opts: SketchOpts): string {
  return opts.stamp?.trim() || sketch.stamp;
}

function screensWord(n: number): string {
  return `${n} screen${n === 1 ? '' : 's'}`;
}

/** `squad studio sketch list`: each sketch's id, name, screens and stamp, the way the Sketches home lists them. */
export function studioSketchList(bp: BoardPaths): void {
  const cards = sketchList(bp);
  if (!cards.length) {
    ui.info('No sketches yet. Start one on the Studio page of the board.');
    return;
  }
  for (const s of cards) {
    const approved = s.card.approved ? `, ${s.card.approved} approved` : '';
    out(`  ${kleur.bold(s.name)}  ${kleur.gray(`${s.id} · ${screensWord(s.card.screens)}${approved} · stamp ${s.stamp}`)}`);
  }
}

/** `squad studio sketch rename <sketch> <new name>`: the same rule as the board's: a used name is refused. */
export function studioSketchRename(bp: BoardPaths, word: string, newName: string[], opts: SketchOpts): void {
  const sketch = sketchNamed(bp, word);
  const name = newName.join(' ').trim();
  if (!name) throw new Error('Give the new name: squad studio sketch rename <sketch> <new name>');
  const renamed = changeSketch(bp, sketch.id, { name }, stampFor(sketch, opts));
  ui.success(`Renamed "${sketch.name}" to "${renamed.name}".`);
}

/** `squad studio sketch duplicate <sketch>`: "… copy" with every screen as Draft at the drawing it shows now. */
export function studioSketchDuplicate(bp: BoardPaths, word: string, opts: SketchOpts): void {
  const sketch = sketchNamed(bp, word);
  const copy = duplicateSketch(bp, sketch.id, stampFor(sketch, opts));
  ui.success(`Made "${copy.name}" (${copy.id}) from "${sketch.name}": ${screensWord(copy.screens.length)}, all Draft.`);
}

/**
 * `squad studio sketch delete <sketch>`: asks first, naming the sketch and its screens, unless --yes. The stamp is the
 * one read before asking, so a change made while the question waits is refused.
 */
export async function studioSketchDelete(bp: BoardPaths, word: string, opts: SketchOpts, ask: (q: string) => Promise<boolean> = askYesNo): Promise<void> {
  const sketch = sketchNamed(bp, word);
  const stamp = stampFor(sketch, opts);
  if (!opts.yes) {
    if (!ui.isInteractive() && ask === askYesNo) throw new Error(`Add --yes to delete "${sketch.name}" and its ${screensWord(sketch.screens.length)} without asking.`);
    if (!(await ask(`Delete "${sketch.name}" and its ${screensWord(sketch.screens.length)}?`))) {
      ui.info('Not deleted.');
      return;
    }
  }
  const r = deleteSketch(bp, sketch.id, stamp);
  ui.success(`Deleted "${r.name}" and its ${screensWord(r.screens)}. It cannot be brought back.`);
}

/** The saved variant a word means on a screen: a letter (A, B, C) as "Use B" means it, or a version ("3" or "v3"). */
function variantNamed(screen: SketchScreen, word: string): number {
  const w = word.trim();
  if (/^[a-z]$/i.test(w)) {
    const v = variantOfLetter(screen, w.toUpperCase());
    if (!v) throw new Error(`${screen.name} has no variant ${w.toUpperCase()}.`);
    return v.version;
  }
  const n = /^v?(\d{1,6})$/i.exec(w);
  if (!n) throw new Error('Name the variant by its letter (A, B, C) or its version (v3).');
  return Number(n[1]);
}

/**
 * `squad studio sketch pick <sketch> <screen> <variant>` (US-18): the card's "Use this one". With the board open it is
 * the board's own call, so the pick line shows in its open conversation and a pick while the AI Designer works is
 * refused; without it, the same action runs here and the line goes to the sketch's current conversation.
 */
export async function studioSketchPick(bp: BoardPaths, api: BoardApi | null, word: string, screenWord: string, variantWord: string, opts: SketchOpts): Promise<void> {
  const sketch = sketchNamed(bp, word);
  const screen = screenOf(sketch, screenWord);
  // The lock (US-15): said plainly before anything else. The store refuses it too.
  if (screen.status === 'approved') throw new Error(approvedWords(screen.name));
  const version = variantNamed(screen, variantWord);
  const stamp = stampFor(sketch, opts);
  const owner: ChatOwner = { kind: 'sketch', id: sketch.id };
  let picked: PickMark | null;
  if (api) {
    const { current } = await api.call<{ current: string }>('GET', pathOf(owner));
    picked = (await api.call<{ picked: PickMark | null }>('POST', `/studio/sketches/${encodeURIComponent(sketch.id)}/screens/${encodeURIComponent(screen.id)}/pick`, { version, stamp, chat: current })).picked;
  } else picked = pickScreenVariant(bp, sketch.id, screen.id, version, stamp, { chat: currentConversation(bp, owner) }).picked;
  if (!picked) ui.info(`${screen.name} already uses that variant. Nothing changed.`);
  else ui.success(`${pickWords(picked)} for ${screen.name}. The other variants stay.`);
}

/** A screen of a sketch a word means: its id, or its name as the screen-name rule compares them (AB-136.1). */
function screenOf(sketch: SketchView, word: string): SketchScreen {
  const screen = sketch.screens.find((s) => s.id === word.trim()) ?? sketch.screens.find((s) => screenNameKey(s.name) === screenNameKey(word));
  if (!screen) throw new Error(`"${sketch.name}" has no screen "${word}".${sketch.screens.length ? ` Its screens: ${sketch.screens.map((s) => s.name).join(', ')}.` : ''}`);
  return screen;
}

function screensApi(sketch: string, screen?: string): string {
  return `/studio/sketches/${encodeURIComponent(sketch)}/screens${screen ? `/${encodeURIComponent(screen)}` : ''}`;
}

/**
 * `squad studio sketch screen add <sketch> [name...]` (US-11): Add screen from the terminal. With a name, a name another
 * screen of the sketch has is refused with 'A screen called "Form" already exists in Booking' and nothing is saved; with none, it is "New
 * screen" (then "New screen 2" …), named by the AI Designer's first drawing of it.
 */
export async function studioScreenAdd(bp: BoardPaths, api: BoardApi | null, word: string, name: string[], opts: SketchOpts): Promise<void> {
  const sketch = sketchNamed(bp, word);
  const wanted = name.join(' ').trim();
  const stamp = stampFor(sketch, opts);
  const input = wanted ? { name: wanted } : {};
  const r = api ? await api.call<SketchView & { added: string }>('POST', screensApi(sketch.id), { ...input, stamp }) : addScreen(bp, sketch.id, input, stamp);
  const added = r.screens.find((s) => s.id === r.added);
  ui.success(`Added "${sketch.name} / ${added?.name ?? r.added}".${wanted ? '' : ' Ask the AI Designer to draw it: it names it from what it shows.'}`);
}

/**
 * `squad studio sketch screen delete <sketch> <screen>` (US-11): a tab's Delete from the terminal. It asks first, naming
 * the screen, unless --yes; the stamp is the one read before asking.
 */
export async function studioScreenDelete(bp: BoardPaths, api: BoardApi | null, word: string, screenWord: string, opts: SketchOpts, ask: (q: string) => Promise<boolean> = askYesNo): Promise<void> {
  const sketch = sketchNamed(bp, word);
  const screen = screenOf(sketch, screenWord);
  // The lock (US-15): refused before the question. The store refuses it too.
  if (screen.status === 'approved') throw new Error(approvedWords(screen.name));
  const stamp = stampFor(sketch, opts);
  if (!opts.yes) {
    if (!ui.isInteractive() && ask === askYesNo) throw new Error(`Add --yes to delete "${screen.name}" and its drawings without asking.`);
    if (!(await ask(`Delete "${screen.name}" and its drawings? This cannot be undone.`))) {
      ui.info('Not deleted.');
      return;
    }
  }
  if (api) await api.call('DELETE', screensApi(sketch.id, screen.id), { stamp });
  else deleteScreen(bp, sketch.id, screen.id, stamp);
  ui.success(`Deleted "${sketch.name} / ${screen.name}" and its drawings. The other screens stay.`);
}

/** When an approval was made, as the terminal says it: "23 Nov, 14:05". */
function approvalTime(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * `squad studio sketch screen approve <sketch> <screen>` (US-15): Approve screen from the terminal. The screen is frozen
 * at the version it shows now, Approved with who and when, and the line "Alaa approved Form at v3" goes to the
 * sketch's conversation: the board's open one when the board is open, else its current one.
 */
export async function studioScreenApprove(bp: BoardPaths, api: BoardApi | null, word: string, screenWord: string, opts: SketchOpts): Promise<void> {
  const sketch = sketchNamed(bp, word);
  const screen = screenOf(sketch, screenWord);
  const stamp = stampFor(sketch, opts);
  const done = await approvalCall(bp, api, sketch, screen, stamp, 'approve');
  if (!done) ui.info(`${screen.name} is already approved. Nothing changed.`);
  else ui.success(`${approvalWords(done)}, ${approvalTime(done.at)}. It is locked until it is reopened: squad studio sketch screen reopen ${sketch.id} ${screen.id}`);
}

/**
 * `squad studio sketch screen reopen <sketch> <screen>` (US-15): Reopen from the terminal. It asks "Are you sure?" first,
 * unless --yes; No leaves the screen Approved. The stamp is the one read before asking.
 */
export async function studioScreenReopen(bp: BoardPaths, api: BoardApi | null, word: string, screenWord: string, opts: SketchOpts, ask: (q: string) => Promise<boolean> = askYesNo): Promise<void> {
  const sketch = sketchNamed(bp, word);
  const screen = screenOf(sketch, screenWord);
  if (screen.status !== 'approved') {
    ui.info(`${screen.name} is not approved. Nothing changed.`);
    return;
  }
  const stamp = stampFor(sketch, opts);
  if (!opts.yes) {
    if (!ui.isInteractive() && ask === askYesNo) throw new Error(`Add --yes to reopen "${screen.name}" without asking.`);
    if (!(await ask(`Reopen "${screen.name}"? It goes back to Draft, and the next change makes a new version. Are you sure?`))) {
      ui.info(`Not reopened. ${screen.name} stays Approved.`);
      return;
    }
  }
  const done = await approvalCall(bp, api, sketch, screen, stamp, 'reopen');
  if (!done) ui.info(`${screen.name} is not approved. Nothing changed.`);
  else ui.success(`${approvalWords(done)}. It is Draft again: the next change makes a new version, and v${done.version} stays.`);
}

/** Approve or Reopen: the board's own call when it is open, so its line shows in its open conversation; else here. */
async function approvalCall(bp: BoardPaths, api: BoardApi | null, sketch: SketchView, screen: SketchScreen, stamp: string, what: 'approve' | 'reopen'): Promise<ApprovalLine | null> {
  const owner: ChatOwner = { kind: 'sketch', id: sketch.id };
  if (api) {
    const { current } = await api.call<{ current: string }>('GET', pathOf(owner));
    return (await api.call<{ done: ApprovalLine | null }>('POST', `${screensApi(sketch.id, screen.id)}/${what}`, { stamp, chat: current })).done;
  }
  const act = what === 'approve' ? approveSketchScreen : reopenSketchScreen;
  return act(bp, sketch.id, screen.id, stamp, { chat: currentConversation(bp, owner) }).done;
}

/** Asks the question with (y/N) after it; Enter alone is No. */
function askYesNo(q: string): Promise<boolean> {
  return confirm({ message: q, default: false });
}

function sketchCommand(): Command {
  const k = new Command('sketch').description('List, rename, duplicate and delete sketches, with the same rules as the board');
  const stamp = ['--stamp <stamp>', 'The stamp you read (squad studio sketch list); refused with "Changed elsewhere, reload" when the sketch changed since'] as const;
  k.command('list')
    .description('Each sketch with its id, screens and stamp')
    .action(wrapArgs(async () => studioSketchList(board())));
  k.command('rename <sketch> <name...>')
    .description('Rename a sketch, named by its id or its name. A name another sketch uses is refused')
    .option(...stamp)
    .action(wrapArgs(async (word: string, name: string[], opts: SketchOpts) => studioSketchRename(board(), word, name, opts)));
  k.command('duplicate <sketch>')
    .description('Copy a sketch as "… copy", every screen as Draft at the drawing it shows now, with no conversation')
    .option(...stamp)
    .action(wrapArgs(async (word: string, opts: SketchOpts) => studioSketchDuplicate(board(), word, opts)));
  k.command('delete <sketch>')
    .description('Delete a sketch and its screens for good. It asks first, unless --yes')
    .option(...stamp)
    .option('--yes', 'Delete without asking')
    .action(wrapArgs(async (word: string, opts: SketchOpts) => studioSketchDelete(board(), word, opts)));
  k.command('pick <sketch> <screen> <variant>')
    .description("Use one variant of a screen, by its letter (A, B, C) or its version (v3), as its card's \"Use this one\" does. The other variants stay")
    .option(...stamp)
    .action(
      wrapArgs(async (word: string, screen: string, variant: string, opts: SketchOpts) => {
        const bp = board();
        await studioSketchPick(bp, boardApi(bp), word, screen, variant, opts);
      }),
    );
  const screen = new Command('screen').description('Add, delete, approve or reopen a screen of a sketch, with the same rules as the board');
  screen
    .command('add <sketch> [name...]')
    .description('Add a screen. With no name it is "New screen", named by the AI Designer\'s first drawing of it. A name the sketch has is refused')
    .option(...stamp)
    .action(
      wrapArgs(async (word: string, name: string[], opts: SketchOpts) => {
        const bp = board();
        await studioScreenAdd(bp, boardApi(bp), word, name ?? [], opts);
      }),
    );
  screen
    .command('delete <sketch> <screen>')
    .description('Delete a screen and its drawings for good. It asks first, unless --yes')
    .option(...stamp)
    .option('--yes', 'Delete without asking')
    .action(
      wrapArgs(async (word: string, screenWord: string, opts: SketchOpts) => {
        const bp = board();
        await studioScreenDelete(bp, boardApi(bp), word, screenWord, opts);
      }),
    );
  screen
    .command('approve <sketch> <screen>')
    .description('Approve a screen: it is frozen at the version it shows, with who and when, and locked until it is reopened')
    .option(...stamp)
    .action(
      wrapArgs(async (word: string, screenWord: string, opts: SketchOpts) => {
        const bp = board();
        await studioScreenApprove(bp, boardApi(bp), word, screenWord, opts);
      }),
    );
  screen
    .command('reopen <sketch> <screen>')
    .description('Reopen an approved screen: back to Draft, so it can change again. It asks first, unless --yes')
    .option(...stamp)
    .option('--yes', 'Reopen without asking')
    .action(
      wrapArgs(async (word: string, screenWord: string, opts: SketchOpts) => {
        const bp = board();
        await studioScreenReopen(bp, boardApi(bp), word, screenWord, opts);
      }),
    );
  k.addCommand(screen);
  return k;
}

export function studioCommand(): Command {
  const s = new Command('studio').description('The Studio: your sketches, and talking with the AI Designer about them and your design systems');
  s.addCommand(sketchCommand());
  s.command('chat <name> [message...]')
    .description('Ask the AI Designer about a sketch, or ask it for a change. Questions change nothing; only a change makes a new version. With no message, it shows the conversation')
    .option('--design-system', 'Talk about a design system instead of a sketch')
    .option('--new', 'Start a new conversation; the old ones and every version stay')
    .option('--stop', 'Stop the answer the AI Designer is working on; the finished screens are kept')
    .option('--save-anyway', 'Save the drawings the last reply kept "Not saved" as a new version on top; the other version stays in the history')
    .action(wrapArgs(runStudioChat));
  return s;
}
