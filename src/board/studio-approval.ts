import fs from 'node:fs';
import type { BoardPaths } from './store.js';
import { checkedStudioId, screenDir, screenFile, screenThumbnailsDir, sketchFile } from './studio-paths.js';
import { dumpYaml, versionsIn, writeShared } from './studio-files.js';
import { readSketch, readSketchFile, type ApprovalMark, type ScreenFile, type Sketch } from './studio-read.js';
import { changeStudioItem, checkNotApproved, existingScreen, markNow, writeMarked, type EditBy } from './studio-write.js';

/**
 * Approving and reopening a screen (US-15, AB-140.1), and the two changes its lock guards most plainly: picking the
 * variant a screen uses (the version an approval freezes) and deleting a screen. Part of the Studio store: studio.ts
 * gives these out again. The approval is kept on the screen's own screen.yaml (status "approved", with the version,
 * who and when), the file the change already writes (AB-131.1), so a teammate gets it through git. All of them run
 * under the sketch's lock and stamp check (AB-129.1): a stale stamp is refused with "Changed elsewhere, reload" and
 * writes nothing.
 *
 * While a screen is approved, the store itself refuses every change to it (a new drawing, a pick, a delete, a new
 * status) with "Form is approved. Reopen it first." (studio-write.ts, checkNotApproved), so the board, the terminal and
 * the AI Designer meet the same lock, and later stories (pointing, changes by hand, going back to an older version)
 * get it for free.
 */

/** What Approve or Reopen did: the sketch as saved, and the mark written, or null when nothing changed. */
export interface ApprovalDone {
  sketch: Sketch;
  /** Approve: the approval as saved. Reopen: the version it was approved at, who reopened it and when. */
  mark: ApprovalMark | null;
}

/**
 * Approve screen: freezes the screen at the variant it uses now, as Approved, with who and when. It stays at that
 * version: nothing new is drawn. A screen with no drawing yet cannot be approved. Already approved, nothing is written.
 */
export function approveScreen(bp: BoardPaths, sketch: string, screen: string, stamp: string, who: EditBy = {}): ApprovalDone {
  checkedStudioId(sketch);
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    const before = existingScreen(bp, sketch, screen);
    if (before.status === 'approved') return { sketch: readSketch(bp, sketch)!, mark: null };
    if (before.chosen === null) throw new Error(`${before.name} has no drawing yet. Draw it first, then approve it.`);
    const edited = markNow(who);
    const approved: ApprovalMark = { version: before.chosen, at: edited.at, ...(edited.by ? { by: edited.by } : {}) };
    const next: ScreenFile = { ...before, status: 'approved', approved, edited };
    writeShared(screenFile(bp, sketch, screen), dumpYaml(next));
    return { sketch: readSketch(bp, sketch)!, mark: approved };
  });
}

/**
 * Reopen: the screen goes back to Draft and its lock goes away. Its versions all stay; the next change makes a new
 * one. Not approved, nothing is written.
 */
export function reopenScreen(bp: BoardPaths, sketch: string, screen: string, stamp: string, who: EditBy = {}): ApprovalDone {
  checkedStudioId(sketch);
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    const before = existingScreen(bp, sketch, screen);
    if (before.status !== 'approved') return { sketch: readSketch(bp, sketch)!, mark: null };
    const { approved: was, ...rest } = before;
    const edited = markNow(who);
    const next: ScreenFile = { ...rest, status: 'draft', edited };
    writeShared(screenFile(bp, sketch, screen), dumpYaml(next));
    const version = was?.version ?? before.chosen;
    return { sketch: readSketch(bp, sketch)!, mark: { version: version ?? 0, at: edited.at, ...(edited.by ? { by: edited.by } : {}) } };
  });
}

/** Marks one saved variant of a screen as the chosen one. The others stay, pickable later. The screen file gets the mark. */
export function pickVariant(bp: BoardPaths, sketch: string, screen: string, version: number, stamp: string, who: EditBy = {}): Sketch {
  checkedStudioId(sketch);
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    const before = existingScreen(bp, sketch, screen);
    // An approved screen keeps the variant it was approved at until it is reopened (US-15, AB-140.1).
    checkNotApproved({ id: screen, ...before });
    if (!versionsIn(screenDir(bp, sketch, screen)).includes(version)) throw new Error(`The screen "${screen}" has no variant ${version}.`);
    writeMarked(screenFile(bp, sketch, screen), before, { ...before, chosen: version }, who);
    return readSketch(bp, sketch)!;
  });
}

/**
 * Deletes one screen of a sketch and every variant of it for good, with this computer's thumbnails for it. The sketch
 * file keeps the mark of the delete, since the screen's own files are gone (AB-131.1).
 */
export function deleteScreen(bp: BoardPaths, sketch: string, screen: string, stamp: string, who: EditBy = {}): Sketch {
  checkedStudioId(sketch);
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    // An approved screen is not deleted until it is reopened (US-15, AB-140.1).
    checkNotApproved({ id: screen, ...existingScreen(bp, sketch, screen) });
    fs.rmSync(screenDir(bp, sketch, screen), { recursive: true, force: true });
    fs.rmSync(screenThumbnailsDir(bp, sketch, screen), { recursive: true, force: true });
    writeShared(sketchFile(bp, sketch), dumpYaml({ ...readSketchFile(sketchFile(bp, sketch)), edited: markNow(who) }));
    return readSketch(bp, sketch)!;
  });
}
