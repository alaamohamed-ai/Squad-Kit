import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * US-16 done when 4 (AB-141): Designer runs share the app's one limit of runs at once with tickets. With a limit of 2,
 * two tickets running and a third waiting, a Designer request stops neither running ticket, takes the next free place
 * before the waiting ticket, and the waiting ticket starts after it. Every agent run here waits until the test ends it.
 */

interface Run {
  opts: RunOptions;
  designer: boolean;
  ended: boolean;
  end(): void;
}
const runs: Run[] = [];
const ANSWER = { screens: [{ name: 'Sign in', frames: [{ frame: 'desktop', html: '<main>Sign in</main>' }] }], note: 'A sign-in screen.' };
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: (opts: RunOptions): Promise<RunResult> =>
    new Promise((resolve) => {
      const designer = Boolean(opts.appendSystemPrompt?.includes('You are the Designer'));
      const run: Run = {
        opts,
        designer,
        ended: false,
        end: () => {
          if (run.ended) return;
          run.ended = true;
          resolve(designer ? ({ ok: true, text: '', structured: ANSWER, sessionId: 'designer-1' } as RunResult) : { ok: false, sessionId: opts.sessionId ?? '', text: '', error: 'Ended by the test.' });
        },
      };
      runs.push(run);
      opts.signal?.addEventListener('abort', () => {
        run.ended = true;
        resolve({ ok: false, sessionId: opts.sessionId ?? '', text: '', error: 'Stopped.' });
      });
    }),
}));

const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
const { createTicket } = await import('../src/board/actions.js');
const { LiveSquad, agentRuns, holdNewRuns } = await import('../src/engine/live.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { setParallelLimit } = await import('../src/core/settings.js');
const { runDesigner, designerWait } = await import('../src/engine/studio-designer.js');
const { studioRunsGoing, studioWaiting } = await import('../src/engine/studio-places.js');
const studio = await import('../src/board/studio.js');

let tmp: string;
const stops: (() => void)[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const tickets = () => runs.filter((r) => !r.designer);
const going = () => runs.filter((r) => !r.ended);

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-designer-queue-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  runs.length = 0;
});

afterEach(() => {
  holdNewRuns(false);
  for (const stop of stops.splice(0)) stop();
  for (const r of runs) r.end();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function project() {
  const dir = path.join(tmp, 'roomflow');
  fs.mkdirSync(dir);
  setupProject(dir);
  const { bp } = ensureLiveBoard(boardPaths(path.join(dir, '.squad')), 'roomflow');
  writeMeta(bp, { ...readMeta(bp), scan: { status: 'done' }, runner: 'direct' });
  return bp;
}

describe('done when 4: the Designer shares the run limit and goes before the tickets that wait', () => {
  it('with a limit of 2, stops no running ticket, takes the next free place, and the waiting ticket starts after it', async () => {
    setParallelLimit(2);
    const bp = project();
    const titles = ['Booking page', 'Rooms list', 'Guest list'];
    for (const title of titles) createTicket(bp, { title });
    const sketch = studio.saveSketch(bp, { name: 'Login', frames: ['desktop'] });
    stops.push(new LiveSquad(bp).start(25));

    await until('two tickets running', () => tickets().length === 2);
    await sleep(300);
    // The third ticket waits in line: both places are taken.
    expect(tickets()).toHaveLength(2);
    const third = titles.find((t) => !tickets().some((r) => r.opts.prompt.includes(t)))!;

    const waits: string[] = [];
    const asked = runDesigner(bp, { step: 'draw', ask: 'Draw a sign-in screen.', target: { kind: 'sketch', id: 'login' }, stamp: sketch.stamp }, { onWait: (w) => waits.push(w) });
    await until('the Designer in line', () => studioWaiting());
    await sleep(300);
    // Asking stops neither running ticket, and the Designer does not start past the limit.
    expect(runs.filter((r) => r.designer)).toHaveLength(0);
    expect(tickets().every((r) => !r.ended)).toBe(true);
    expect(waits[0]).toBe('Next in line: the Designer starts when a place is free (2 of 2 busy).');

    // One ticket's step ends: the free place is the Designer's, not the waiting ticket's.
    tickets()[0]!.end();
    await until('the Designer running', () => runs.some((r) => r.designer));
    expect(studioRunsGoing()).toBe(1);
    expect(agentRuns()).toEqual([{ root: bp.root, keys: [expect.any(String), expect.stringMatching(/^__designer:sketch:login:/)] }]);
    await sleep(400);
    expect(tickets()).toHaveLength(2);
    expect(tickets().some((r) => r.opts.prompt.includes(third))).toBe(false);
    expect(going()).toHaveLength(2);

    // The Designer hands in its screens and gives its place back: now the waiting ticket starts.
    runs.find((r) => r.designer)!.end();
    const done = await asked;
    expect(done).toMatchObject({ ok: true, saved: [{ screen: 'sign-in', version: 1 }] });
    await until('the waiting ticket', () => tickets().some((r) => r.opts.prompt.includes(third)));
    expect(studioRunsGoing()).toBe(0);
    // The ticket that was running all along was never stopped.
    expect(tickets()[1]!.ended).toBe(false);
  });

  it('waits like tickets do while an update waits, and leaves the line when stopped', async () => {
    setParallelLimit(2);
    holdNewRuns(true);
    expect(designerWait(2)).toBe('squad-kit is waiting to update. The Designer starts once it has.');
    holdNewRuns(false);
    expect(designerWait(2)).toBeNull();

    const bp = project();
    const sketch = studio.saveSketch(bp, { name: 'Login', frames: ['desktop'] });
    holdNewRuns(true);
    const stop = new AbortController();
    const asked = runDesigner(bp, { step: 'draw', ask: 'Draw a sign-in screen.', target: { kind: 'sketch', id: 'login' }, stamp: sketch.stamp }, { signal: stop.signal });
    await until('the Designer in line', () => studioWaiting());
    await sleep(300);
    expect(runs).toHaveLength(0);
    stop.abort();
    expect(await asked).toEqual({ ok: false, error: 'You stopped the Designer.' });
    expect(studioWaiting()).toBe(false);
    expect(studio.readSketch(bp, 'login')!.stamp).toBe(sketch.stamp);
  });
});
