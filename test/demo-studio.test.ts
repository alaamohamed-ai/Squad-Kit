import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { createDesignSystem, designSystemList, listSketches } from '../src/board/studio-actions.js';
import { startSketch } from '../src/board/studio-start.js';
import { chatFile, sketchChatsDir } from '../src/board/studio-paths.js';

/**
 * The sample board starts fresh each time (US-05, AB-130): its Studio has no sketch and no design system, so the
 * Sketches tab opens on the start page again. A sketch made on the last run does not stay behind without its first
 * message, which lived with its chat on this computer.
 */

let tmp: string;
let bp: BoardPaths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-demo-studio-'));
  bp = boardPaths(path.join(tmp, '.squad'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a fresh sample board', () => {
  it('has no sketches and no design systems', () => {
    seedDemoBoard(bp, { speed: 50 });
    expect(listSketches(bp)).toEqual([]);
    expect(designSystemList(bp).designSystems).toEqual([]);
    expect(fs.existsSync(bp.studioDir)).toBe(false);
  });

  it('has none again after a sketch was started on the last run: no sketch is kept without its messages', () => {
    seedDemoBoard(bp, { speed: 50 });
    createDesignSystem(bp, { name: 'Patient app' });
    const made = startSketch(bp, { message: 'A page where patients book a visit with their doctor' });
    expect(listSketches(bp).map((s) => s.id)).toEqual([made.id]);
    expect(fs.existsSync(chatFile(bp, made.id, 'main'))).toBe(true);

    // The next start of the sample board.
    seedDemoBoard(bp, { speed: 50 });
    expect(listSketches(bp)).toEqual([]);
    expect(designSystemList(bp).designSystems).toEqual([]);
    expect(fs.existsSync(bp.studioDir)).toBe(false);
    expect(fs.existsSync(sketchChatsDir(bp, made.id))).toBe(false);
  });

  it('has none on its first-run start either', () => {
    seedDemoBoard(bp, { speed: 50 });
    startSketch(bp, { message: 'A login page in Arabic and English' });
    seedDemoBoard(bp, { speed: 50, firstRun: true });
    expect(listSketches(bp)).toEqual([]);
    expect(fs.existsSync(bp.studioDir)).toBe(false);
  });
});
