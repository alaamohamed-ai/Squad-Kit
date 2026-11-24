import path from 'node:path';
import { readMeta, type BoardPaths } from '../board/store.js';
import {
  AI_DESIGNER,
  CHANGED_ELSEWHERE,
  StudioChangedElsewhere,
  checkStudioStamp,
  prototypeMap,
  readPrototypeFile,
  readSketch,
  replacePrototypeLinks,
  type PrototypeLink,
  type PrototypeMap,
  type PrototypeSaved,
} from '../board/studio.js';
import { checkedStudioId, frameFile } from '../board/studio-paths.js';
import { writeLog } from '../core/app-log.js';
import { answerAgainPrompt } from './prompts.js';
import { openDesigner, refusedWords, type DesignerOptions } from './studio-designer.js';
import { LINKS_SCHEMA, LINK_STEP, checkedLinks, linkPrompt, linksProblem, type CheckedLinks } from './studio-link-prompts.js';
import type { StudioPlace } from './studio-places.js';

/**
 * "Generate the prototype" (US-54): the AI Designer links each button on the sketch's approved screens to the screen it
 * should lead to, or Back. It goes through the one Designer runner (AB-141.1), as its own step, "link": it waits for a
 * place in the shared limit, reads files only, and its answer is checked (studio-link-prompts.ts) and asked for once
 * more when it does not fit. squad-kit then saves the links whole, replacing the old ones, with the sketch's stamp the
 * person read when they pressed the button (AB-129.1): a change made meanwhile is refused with "Changed elsewhere,
 * reload", and the old links stay. Nothing is added to the chat.
 *
 * It runs in the background, one per sketch, so the board shows it is working and the button cannot start a second
 * one; when it fails, the old links stay and the board reads what went wrong. On a sample board there is no AI: a
 * simple linker links the flow from the buttons' words instead (demoLinks).
 */

/** How long the sample board's linker takes, so "working" can be seen. */
export const DEMO_LINK_MS = 2500;
let demoWait = DEMO_LINK_MS;
/** Tests make the sample linker quicker. */
export function setDemoLinkWait(ms: number): void {
  demoWait = ms;
}

export type LinkResult = ({ ok: true } & PrototypeSaved & { note: string }) | { ok: false; error: string };

export interface LinkAsk {
  sketch: string;
  /** The sketch's stamp the person read. */
  stamp: string;
  /** The person who asked: the links are marked as the AI Designer's work for them (AB-131.1). */
  for?: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

const BACK_WORDS = /\b(?:back|previous|cancel|close)\b|رجوع|عودة|العودة|السابق|إلغاء|الغاء|إغلاق/i;
const EDIT_WORDS = /\b(?:edit|change)\b|تعديل|تغيير/i;

/**
 * The sample board's linker: no AI. On each approved screen, a button whose words say back (Back, Cancel, رجوع) goes
 * Back, one that says edit (Edit, تعديل) goes to the screen before, and the first other button goes to the next screen.
 * Every other button has no link.
 */
export function demoLinks(map: PrototypeMap): PrototypeLink[] {
  const links: PrototypeLink[] = [];
  map.screens.forEach((s, i) => {
    const next = map.screens[i + 1];
    const before = map.screens[i - 1];
    let forward = false;
    for (const b of s.buttons) {
      if (BACK_WORDS.test(b.name)) links.push({ screen: s.id, button: b.name, to: { back: true } });
      else if (EDIT_WORDS.test(b.name) && before) links.push({ screen: s.id, button: b.name, to: { screen: before.id } });
      else if (!forward && next && b.kind === 'button') {
        forward = true;
        links.push({ screen: s.id, button: b.name, to: { screen: next.id } });
      }
    }
  });
  return links;
}

const relative = (bp: BoardPaths, file: string) => path.relative(bp.root, file).split(path.sep).join('/');

/** The Designer's answer, through the one runner: checked, and asked for once more when it does not fit. */
async function designerLinks(bp: BoardPaths, ask: LinkAsk, map: PrototypeMap, sketchName: string, o: DesignerOptions): Promise<CheckedLinks | { error: string }> {
  const d = await openDesigner(bp, { step: LINK_STEP, target: { kind: 'sketch', id: ask.sketch }, pictures: [] }, o);
  if ('error' in d) return d;
  const release: StudioPlace = d.release;
  try {
    const prompt = linkPrompt({
      project: readMeta(bp).project,
      sketch: sketchName,
      screens: map.screens.map((s) => ({
        id: s.id,
        name: s.name,
        files: Object.fromEntries(Object.keys(s.frames).map((f) => [f, relative(bp, frameFile(bp, ask.sketch, s.id, s.version, f))])),
        buttons: s.buttons.map((b) => b.name),
      })),
    });
    let r = await d.run(prompt, { schema: LINKS_SCHEMA });
    if (!r.ok) return { error: d.failed(r) };
    let problem = linksProblem(r.structured, map);
    if (problem) {
      const again = await d.run(answerAgainPrompt(problem), { schema: LINKS_SCHEMA, ...(r.sessionId ? { resume: r.sessionId } : {}) });
      if (!again.ok) return { error: d.failed(again) };
      r = again;
      problem = linksProblem(r.structured, map);
      if (problem) return { error: refusedWords(problem) };
    }
    return checkedLinks(r.structured as never, map);
  } finally {
    release();
  }
}

/**
 * Links the sketch's approved screens once and saves the links. Never throws for what the person can fix: the result
 * says it in plain words, and nothing is saved unless the whole answer fits and the stamp is still the one read.
 */
export async function runLinker(bp: BoardPaths, ask: LinkAsk, o: DesignerOptions = {}): Promise<LinkResult> {
  try {
    checkStudioStamp(bp, { kind: 'sketch', id: ask.sketch }, ask.stamp);
    const sketch = readSketch(bp, ask.sketch);
    if (!sketch) return { ok: false, error: `This project has no sketch "${ask.sketch}".` };
    const map = prototypeMap(sketch, readPrototypeFile(bp, ask.sketch));
    if (!map.screens.length) return { ok: false, error: 'Approve a screen to start the prototype.' };
    let answer: CheckedLinks | { error: string };
    if (readMeta(bp).engine !== 'live') {
      await sleep(demoWait, o.signal);
      answer = o.signal?.aborted ? { error: 'You stopped the Designer.' } : { links: demoLinks(map), note: 'The sample Designer linked the flow from the buttons’ words.' };
    } else answer = await designerLinks(bp, ask, map, sketch.name, o);
    if ('error' in answer) return { ok: false, error: answer.error };
    const asker = ask.for?.trim() || readMeta(bp).user?.name?.trim();
    const saved = replacePrototypeLinks(bp, ask.sketch, answer.links, ask.stamp, { by: AI_DESIGNER, ...(asker ? { for: asker } : {}) });
    return { ok: true, ...saved, note: answer.note };
  } catch (err) {
    if (err instanceof StudioChangedElsewhere) return { ok: false, error: CHANGED_ELSEWHERE };
    if (o.signal?.aborted) return { ok: false, error: 'You stopped the Designer.' };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ── In the background, one per sketch ── */

interface LinkJob {
  since: string;
  doing: string;
  controller: AbortController;
  done: Promise<void>;
}

const jobs = new Map<string, LinkJob>();
/** What went wrong in the last Generate of a sketch, on this computer, until the next one starts. */
const problems = new Map<string, string>();

const keyOf = (bp: BoardPaths, sketch: string) => `${bp.root}\n${sketch}`;

/** Generate is already working on this sketch. Nothing was started. */
export class LinkBusy extends Error {
  constructor() {
    super('The AI Designer is already linking this prototype. Wait for it to finish.');
    this.name = 'LinkBusy';
  }
}

/** Whether Generate works on a sketch now, and since when, with what it waits for; null when it does not. */
export function linkWorking(bp: BoardPaths, sketch: string): { since: string; doing: string } | null {
  const job = jobs.get(keyOf(bp, sketch));
  return job ? { since: job.since, doing: job.doing } : null;
}

/** What went wrong in the sketch's last Generate, or null. */
export function linkProblem(bp: BoardPaths, sketch: string): string | null {
  return problems.get(keyOf(bp, sketch)) ?? null;
}

/**
 * Starts Generate in the background. Refused at once, with nothing started, while one works on the sketch (LinkBusy),
 * when the stamp is old ("Changed elsewhere, reload") or when the sketch has no approved screen.
 */
export function startLinkJob(bp: BoardPaths, ask: LinkAsk): { since: string; doing: string } {
  checkedStudioId(ask.sketch);
  const key = keyOf(bp, ask.sketch);
  if (jobs.has(key)) throw new LinkBusy();
  checkStudioStamp(bp, { kind: 'sketch', id: ask.sketch }, ask.stamp);
  const sketch = readSketch(bp, ask.sketch);
  if (!sketch) throw new Error(`This project has no sketch "${ask.sketch}".`);
  if (!prototypeMap(sketch, readPrototypeFile(bp, ask.sketch)).screens.length) throw new Error('Approve a screen to start the prototype.');
  problems.delete(key);
  const controller = new AbortController();
  const job: LinkJob = { since: new Date().toISOString(), doing: 'Linking the screens', controller, done: Promise.resolve() };
  jobs.set(key, job);
  job.done = runLinker(bp, ask, {
    signal: controller.signal,
    onWait: (words) => {
      job.doing = words;
    },
  })
    .then((r) => {
      if (!r.ok) problems.set(key, r.error);
    })
    .catch((err: unknown) => {
      const words = err instanceof Error ? err.message : String(err);
      problems.set(key, words);
      writeLog({ level: 'warn', text: `Generate the prototype stopped: ${words}` });
    })
    .finally(() => {
      jobs.delete(key);
    });
  return { since: job.since, doing: job.doing };
}

/** Stops every Generate going now: for tests, and for a board that closes. The old links stay. */
export function stopLinkJobs(): void {
  for (const job of jobs.values()) job.controller.abort();
}

/** Waits until every Generate going now has ended: for tests, and for a board that closes. */
export async function linkJobsDone(): Promise<void> {
  await Promise.all([...jobs.values()].map((j) => j.done));
}
