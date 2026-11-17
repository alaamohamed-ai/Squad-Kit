import fs from 'node:fs';
import path from 'node:path';
import { rulesFor } from '../board/additions.js';
import { readMeta, type BoardPaths } from '../board/store.js';
import {
  AI_DESIGNER,
  CHANGED_ELSEWHERE,
  StudioChangedElsewhere,
  checkStudioStamp,
  readDesignSystem,
  readSketch,
  saveDesignSystem,
  saveDrawnScreens,
  studioIdFor,
  type DesignSystem,
  type Sketch,
  type StudioItem,
} from '../board/studio.js';
import { chatsDir, designSystemVersionDir, frameFile } from '../board/studio-paths.js';
import { recordUsage } from '../board/usage.js';
import { writeLog } from '../core/app-log.js';
import { parallelLimit } from '../core/settings.js';
import type { AgentResult, AgentRun, PermissionSet } from '../modules/ai-tool/types.js';
import { AI_TOOLS, aiTool } from '../modules/registry.js';
import { agentInstructions, readAgent } from './agents.js';
import { screensProblem } from './answers.js';
import { DEFAULT_QUALITY, describeLevel, effortOn, personLevels, resolveLevel, stepCaps } from './levels.js';
import { newRunsHeld, secretFiles, ticketsRunning } from './live.js';
import { ownRunWords } from './plain-stop.js';
import { agentPrivatePlaces } from './project-guard.js';
import { answerAgainPrompt } from './prompts.js';
import { selfRule } from './self-project.js';
import { DESIGNER_STEPS, SCREENS_SCHEMA, designerPrompt, designerRules, type DesignerAnswer, type DesignerBrief, type DesignerStep } from './studio-prompts.js';
import { studioRunsGoing, takeStudioPlace, type StudioPlace } from './studio-places.js';
import { activePause, startPause } from './usage-limit.js';

/**
 * The one Designer runner (AB-141.1): every AI action in the Studio goes through here, and no Studio story calls an
 * AI tool itself. One run waits for a place in the app's one limit of runs at once, shared with tickets and ahead of
 * the tickets waiting (studio-places.ts); it reads the team's rules for the Designer; it runs the AI tool with read
 * files only on the project, the Studio files and the pictures from the message; it checks the answer against
 * SCREENS_SCHEMA, asking once more when it does not fit; then squad-kit saves the screens as a new version through
 * the Studio store, with the change stamp the person read at the start (AB-128.1, AB-129.1). The chat with the
 * Designer (studio-chat.ts) opens this same runner (openDesigner) for each message.
 */

/** The Designer's role, in usage lines and levels. */
export const DESIGNER_ROLE = 'designer';
/** What it may do: read, find and search files, and nothing else. No shell, no file writes, no web pages. */
export const DESIGNER_PERMISSIONS: PermissionSet[] = ['files'];
/** The longest one Designer run may take. */
export const DESIGNER_RUN_MS = 10 * 60_000;
/** The most pictures one message may bring. */
export const MAX_DESIGNER_PICTURES = 6;

export interface DesignerAsk {
  step: DesignerStep;
  /** The person's own words. */
  ask: string;
  /** A sketch for Draw and Change, a design system for Design system. */
  target: StudioItem;
  /** The stamp the person read; null only for a design system that is new. */
  stamp: string | null;
  /** A new design system's name; left out, it is its id. */
  name?: string;
  /** The pictures added to the message, as saved with the chat on this computer (AB-130.1). */
  pictures?: string[];
  /** The person who asked; left out, the person in the project settings. The drawing is marked as theirs (AB-131.1). */
  for?: string;
}

export type DesignerResult =
  | { ok: true; note: string; sketch?: Sketch; designSystem?: DesignSystem; saved: { screen: string; version?: number }[]; model: string; costUsd?: number }
  | { ok: false; error: string; model?: string; costUsd?: number };

export interface DesignerOptions {
  signal?: AbortSignal;
  /** Says why the run waits for a place, while it waits: the shared limit, the usage limit, an update. */
  onWait?(words: string): void;
  /** Tests take a place their own way. */
  place?: (o: { root: string; key: string; signal?: AbortSignal; onWait?: (words: string) => void }) => Promise<StudioPlace>;
}

/** The plain words a refused answer ends in. */
export function refusedWords(problem: string): string {
  return `The Designer's answer could not be used: ${problem}. Nothing was saved.`;
}

/** Why the run cannot take a place right now, or null when it can: the usage limit, an update, every place busy. */
export function designerWait(limit: number): string | null {
  const pause = activePause();
  if (pause) return `${pause.name}'s usage limit is reached. The Designer starts by itself once it resets.`;
  if (newRunsHeld()) return 'squad-kit is waiting to update. The Designer starts once it has.';
  const busy = ticketsRunning() + studioRunsGoing();
  return busy < limit ? null : `Next in line: the Designer starts when a place is free (${busy} of ${limit} busy).`;
}

/** A place in the app's one limit, ahead of the tickets that wait, as the project's limit allows. */
function sharedPlace(bp: BoardPaths) {
  return (o: { root: string; key: string; signal?: AbortSignal; onWait?: (words: string) => void }) => takeStudioPlace({ ...o, wait: () => designerWait(parallelLimit(readMeta(bp).parallel)) });
}

/** The pictures of the message: files saved with the chat on this computer, and nothing else. */
export function checkedPictures(bp: BoardPaths, pictures: string[]): string[] {
  if (pictures.length > MAX_DESIGNER_PICTURES) throw new Error(`Add at most ${MAX_DESIGNER_PICTURES} pictures to one message.`);
  const home = path.resolve(chatsDir(bp));
  return pictures.map((p) => {
    const file = path.resolve(String(p));
    const rel = path.relative(home, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error("A picture is not one added to this sketch's messages.");
    return file;
  });
}

function relative(bp: BoardPaths, file: string): string {
  return path.relative(bp.root, file).split(path.sep).join('/');
}

/** The brief of one run, from the Studio as it is now. */
function briefOf(bp: BoardPaths, a: DesignerAsk, project: string, pictures: string[], sketch: Sketch | null, system: DesignSystem | null): DesignerBrief {
  const follows = sketch?.designSystem ? readDesignSystem(bp, sketch.designSystem.id) : null;
  const designSystem = sketch?.designSystem && follows ? { name: follows.name, version: sketch.designSystem.version, dir: relative(bp, designSystemVersionDir(bp, follows.id, sketch.designSystem.version)) } : undefined;
  const target: DesignerBrief['target'] = sketch
    ? {
        kind: 'sketch',
        name: sketch.name,
        frames: sketch.frames,
        screens: sketch.screens.map((s) => ({
          id: s.id,
          name: s.name,
          files: Object.fromEntries(Object.keys(s.variants.find((v) => v.version === s.chosen)?.frames ?? {}).map((f) => [f, relative(bp, frameFile(bp, sketch.id, s.id, s.chosen!, f))])),
        })),
      }
    : { kind: 'design-system', name: system?.name ?? a.name?.trim() ?? a.target.id, version: system?.version ?? null };
  return { step: a.step, ask: a.ask, project, target, ...(designSystem ? { designSystem } : {}), pictures };
}

/** The one Designer runner, opened for one Studio action: its place is taken, its tool, level and rules are set. */
export interface DesignerRunner {
  /** The model, as people read it. */
  model: string;
  /** The most one run may use. */
  caps: { turns: number; spendUsd: number };
  /** One run of the AI tool, read files only, with the answer's shape; `resume` goes on in the same session. */
  run(prompt: string, o: { schema: object; resume?: string }): Promise<AgentResult>;
  /** Why a run that was not ok stopped, in plain words. */
  failed(r: AgentResult): string;
  /** What the runs cost so far, when the tool said. */
  costUsd(): number | undefined;
  /** Gives the place back. */
  release: StudioPlace;
}

/**
 * Opens the Designer for one Studio action (AB-141.1). On a sample board, or with a tool squad-kit cannot run, it says
 * why in plain words. Otherwise it waits for a place in the one limit, ahead of the waiting tickets, and every run it
 * makes reads files only, with the team's rules and the message's pictures. Every Studio AI action comes through here.
 */
export async function openDesigner(bp: BoardPaths, a: { step: string; target: StudioItem; pictures: string[] }, o: DesignerOptions = {}): Promise<DesignerRunner | { error: string }> {
  const meta = readMeta(bp);
  if (meta.engine !== 'live') return { error: 'A sample board has no Designer. Open a real project to draw in the Studio.' };
  const agent = readAgent(bp, DESIGNER_ROLE);
  const tool = aiTool(agent.tool);
  if (!tool?.canRun) {
    const can = AI_TOOLS.filter((t) => t.canRun).map((t) => t.label).join(' or ');
    return { error: `The Designer is set to ${tool?.label ?? agent.tool}, which squad-kit cannot run yet. Switch it to ${can} on the Harness page, under Agents.` };
  }
  // Its place in the one limit, ahead of the tickets that wait. It never stops a run that is going.
  const key = `__designer:${a.target.kind}:${a.target.id}:${Date.now().toString(36)}`;
  const release = await (o.place ?? sharedPlace(bp))({ root: bp.root, key, ...(o.signal ? { signal: o.signal } : {}), ...(o.onWait ? { onWait: o.onWait } : {}) });

  const quality = meta.quality ?? DEFAULT_QUALITY;
  const lv = resolveLevel({ role: DESIGNER_ROLE, step: a.step, quality }, agent.levels, personLevels());
  const effort = effortOn(tool, lv.effort);
  const caps = stepCaps({ role: DESIGNER_ROLE, step: a.step, quality });
  const runCaps = { ...(tool.caps?.turns ? { turns: caps.turns } : {}), ...(tool.caps?.spend ? { spendUsd: caps.spendUsd } : {}) };
  const model = describeLevel(lv, tool);
  // The team's own rules for the Designer (.squad/rules/designer.md, and its step), then the rules added on Harness.
  const instructions = [designerRules(), selfRule(bp), agentInstructions(agent, a.step), rulesFor(bp, DESIGNER_ROLE)].filter(Boolean).join('\n\n');
  const secrets = await secretFiles(bp, bp.root);
  const addDirs = [...new Set(a.pictures.map((p) => path.dirname(p)))];
  const used = { role: DESIGNER_ROLE as 'designer', step: a.step, level: lv.level, model: lv.model || tool.modelFor(lv.level) };
  let cost: number | undefined;
  return {
    model,
    caps,
    release,
    costUsd: () => cost,
    async run(prompt, r) {
      const out: AgentResult = await tool.run({
        cwd: bp.root,
        prompt,
        permissions: DESIGNER_PERMISSIONS,
        schema: r.schema,
        instructions,
        secretFiles: secrets,
        privatePlaces: agentPrivatePlaces(),
        level: lv.level,
        ...(effort ? { effort } : {}),
        ...(lv.model ? { model: lv.model } : {}),
        ...(Object.keys(runCaps).length ? { caps: runCaps } : {}),
        ...(addDirs.length ? { addDirs } : {}),
        timeoutMs: DESIGNER_RUN_MS,
        ...(o.signal ? { signal: o.signal } : {}),
        logDir: bp.chatsDir,
        direct: meta.runner === 'direct',
        ...(r.resume ? { resume: r.resume } : {}),
      } satisfies AgentRun);
      // A Studio run has no ticket: it counts on the project's own line, and in the month.
      recordUsage(bp, undefined, used, out.usage);
      if (typeof out.usage?.costUsd === 'number') cost = (cost ?? 0) + out.usage.costUsd;
      return out;
    },
    failed(r) {
      if (r.limit) {
        startPause(r.limit, { project: meta.project });
        return `Your ${r.limit.name} usage limit is reached, so the Designer stopped. Ask again once it resets.`;
      }
      if (r.capped) return `The Designer used the most one run may use ($${caps.spendUsd} or ${caps.turns} turns), so it stopped. Ask for fewer screens at once.`;
      if (o.signal?.aborted) return 'You stopped the Designer.';
      writeLog({ level: 'warn', project: meta.project, text: `The Designer did not answer: ${r.detail ?? r.error ?? 'no answer'}` });
      return r.error && ownRunWords(r.error, tool) ? r.error : 'The Designer stopped before it answered, on something technical. Ask again.';
    },
  };
}

/**
 * Runs the Designer once and saves what it drew. Never throws for what the person can fix: the result says it in
 * plain words, and nothing is saved unless the whole answer fits and the stamp is still the one read.
 */
export async function runDesigner(bp: BoardPaths, a: DesignerAsk, o: DesignerOptions = {}): Promise<DesignerResult> {
  let release: StudioPlace | null = null;
  try {
    if (!DESIGNER_STEPS.includes(a.step)) return { ok: false, error: `The Designer has no step "${String(a.step)}". Its steps: ${DESIGNER_STEPS.join(', ')}.` };
    if (!a.ask?.trim()) return { ok: false, error: 'Write what the Designer should do first.' };
    const forSystem = a.step === 'system';
    if ((a.target.kind === 'design-system') !== forSystem) return { ok: false, error: forSystem ? 'The Design system step works on a design system.' : 'Draw and Change work on a sketch.' };
    // The stamp is checked now and again when saving: a change made during the run is refused then.
    checkStudioStamp(bp, a.target, a.stamp);
    const sketch = forSystem ? null : readSketch(bp, a.target.id);
    if (!forSystem && !sketch) return { ok: false, error: `This project has no sketch "${a.target.id}".` };
    const system = forSystem ? readDesignSystem(bp, a.target.id) : null;
    const pictures = checkedPictures(bp, a.pictures ?? []);
    const d = await openDesigner(bp, { step: a.step, target: a.target, pictures }, o);
    if ('error' in d) return { ok: false, error: d.error };
    release = d.release;
    const meta = readMeta(bp);
    const prompt = designerPrompt(briefOf(bp, a, meta.project, pictures, sketch, system));
    const priced = () => ({ model: d.model, ...(d.costUsd() !== undefined ? { costUsd: d.costUsd() } : {}) });
    const failed = (r: AgentResult): DesignerResult => ({ ok: false, error: d.failed(r), ...priced() });
    const frames = sketch ? sketch.frames : ['desktop'];
    let r = await d.run(prompt, { schema: SCREENS_SCHEMA });
    if (!r.ok) return failed(r);
    let problem = screensProblem(r.structured, { frames });
    if (problem) {
      // A broken answer is asked for once more, in the same conversation; then it is refused and nothing is saved.
      const again = await d.run(answerAgainPrompt(problem), { schema: SCREENS_SCHEMA, ...(r.sessionId ? { resume: r.sessionId } : {}) });
      if (!again.ok) return failed(again);
      r = again;
      problem = screensProblem(r.structured, { frames });
      if (problem) return { ok: false, error: refusedWords(problem), ...priced() };
    }
    const answer = r.structured as DesignerAnswer;
    const note = answer.note.trim();
    const done = { ok: true as const, note, ...priced() };
    if (sketch) {
      const drawn = answer.screens.map((s) => ({ ...(s.id ? { id: s.id } : {}), name: s.name.trim(), frames: Object.fromEntries(s.frames.map((f) => [f.frame.trim(), f.html])) }));
      // Marked as the AI Designer's work for the person who asked (AB-131.1).
      const asker = a.for?.trim() || meta.user?.name?.trim();
      const saved = saveDrawnScreens(bp, sketch.id, drawn, a.stamp!, { madeBy: AI_DESIGNER, ...(asker ? { madeFor: asker } : {}), ...(note ? { note } : {}) });
      return { ...done, sketch: saved.sketch, saved: saved.saved };
    }
    const components = Object.fromEntries(answer.screens.map((s) => [studioIdFor(s.name.trim()), s.frames[0]!.html]));
    const tokens = answer.tokens && typeof answer.tokens === 'object' && !Array.isArray(answer.tokens) ? answer.tokens : undefined;
    const ds = saveDesignSystem(bp, { id: a.target.id, name: system?.name ?? (a.name?.trim() || a.target.id), components, ...(tokens ? { tokens } : {}) }, a.stamp);
    return { ...done, designSystem: ds, saved: Object.keys(components).map((screen) => ({ screen })) };
  } catch (err) {
    if (err instanceof StudioChangedElsewhere) return { ok: false, error: CHANGED_ELSEWHERE };
    if (o.signal?.aborted) return { ok: false, error: 'You stopped the Designer.' };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    release?.();
  }
}
