import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { createDesignSystem, designSystemList, listSketches, sketchCover, sketchList } from '../src/board/studio-actions.js';
import { startSketch } from '../src/board/studio-start.js';
import { chatFile, sketchChatsDir } from '../src/board/studio-paths.js';
import { readSketch } from '../src/board/studio.js';

/**
 * The sample board starts fresh each time (US-05, AB-130), with the same sample Studio (US-06, AB-131): the "Brand"
 * design system and nine sketches ("Feedback" follows none, for US-17; "الحجز" is a long right-to-left form, for US-46; "Follow-up visit" has eight screens, for US-53), so the Sketches home shows its cards. A sketch made on the last run does not stay
 * behind without its first message, which lived with its chat on this computer. Its first-run start has no Studio
 * work, so the Sketches tab opens on the start page there.
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

const SAMPLE = ['checkout', 'booking', 'profile', 'patient-profile', 'onboarding', 'login', 'feedback', 'arabic-booking', 'follow-up-visit'];

describe('a fresh sample board', () => {
  it('has the sample sketches, newest edit first, and the Brand design system', () => {
    seedDemoBoard(bp, { speed: 50 });
    const cards = sketchList(bp);
    expect(cards.map((s) => s.id)).toEqual(SAMPLE);
    expect(designSystemList(bp).designSystems.map((d) => [d.name, d.isDefault])).toEqual([['Brand', true]]);
    const by = Object.fromEntries(cards.map((s) => [s.id, s.card]));
    // Checkout: desktop and mobile, redrawn by the AI Designer for Sara.
    expect(by.checkout).toMatchObject({ cover: { screen: 'cart', version: 2, views: ['desktop', 'mobile'] }, screens: 3, approved: 0, designSystem: 'Brand', edited: { by: 'AI Designer', for: 'Sara' } });
    // Profile: just made by Omar, nothing drawn yet.
    expect(by.profile).toMatchObject({ cover: null, screens: 1, approved: 0, edited: { by: 'Omar' } });
    // Onboarding: desktop only, renamed by Sara, two of five approved.
    expect(by.onboarding).toMatchObject({ cover: { views: ['desktop'] }, screens: 5, approved: 2, edited: { by: 'Sara' } });
    expect(sketchCover(bp, 'checkout').frames.mobile).toContain('Your cart');
  });

  it('has "Follow-up visit" with 8 screens in order, one with a long name, and Confirm approved with its drawing (US-53)', () => {
    seedDemoBoard(bp, { speed: 50 });
    const visit = readSketch(bp, 'follow-up-visit')!;
    expect(visit.name).toBe('Follow-up visit');
    expect(visit.screens.map((s) => s.name)).toEqual(['Choose a doctor', 'Booking follow-up for older patients in Arabic and English', 'Pick a day', 'Pick a time', 'Your details', 'Confirm', 'Reminders', 'Done']);
    const confirm = visit.screens.find((s) => s.name === 'Confirm')!;
    expect(confirm).toMatchObject({ status: 'approved', chosen: 1, approved: { version: 1, by: 'Sara' } });
    expect(visit.screens.filter((s) => s.status === 'approved').map((s) => s.name)).toEqual(['Confirm']);
    const card = sketchList(bp).find((s) => s.id === 'follow-up-visit')!.card;
    expect(card).toMatchObject({ screens: 8, approved: 1, designSystem: 'Brand' });
  });

  it('starts with only the sample sketches again: a sketch started on the last run is not kept without its messages', () => {
    seedDemoBoard(bp, { speed: 50 });
    createDesignSystem(bp, { name: 'Patient app' });
    const made = startSketch(bp, { message: 'A page where patients book a visit with their doctor' });
    expect(listSketches(bp).map((s) => s.id)).toContain(made.id);
    expect(fs.existsSync(chatFile(bp, made.id, 'main'))).toBe(true);

    // The next start of the sample board.
    seedDemoBoard(bp, { speed: 50 });
    expect(sketchList(bp).map((s) => s.id)).toEqual(SAMPLE);
    expect(designSystemList(bp).designSystems.map((d) => d.name)).toEqual(['Brand']);
    expect(fs.existsSync(sketchChatsDir(bp, made.id))).toBe(false);
  });

  it('has none on its first-run start, so the start page shows there', () => {
    seedDemoBoard(bp, { speed: 50 });
    startSketch(bp, { message: 'A login page in Arabic and English' });
    seedDemoBoard(bp, { speed: 50, firstRun: true });
    expect(listSketches(bp)).toEqual([]);
    expect(fs.existsSync(bp.studioDir)).toBe(false);
  });

  it('can leave the Studio empty, for a project with no Studio work', () => {
    seedDemoBoard(bp, { speed: 50, studio: false });
    expect(listSketches(bp)).toEqual([]);
    expect(fs.existsSync(bp.studioDir)).toBe(false);
  });
});
