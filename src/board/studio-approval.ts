import type { BoardPaths } from './store.js';
import { checkedStudioId, screenFile } from './studio-paths.js';
import { dumpYaml, writeShared } from './studio-files.js';
import { readSketch, type ApprovalMark, type ScreenFile, type Sketch } from './studio-read.js';
import { changeStudioItem, existingScreen, markNow, type EditBy } from './studio-write.js';

/**
 * Approving and reopening a screen (US-15, AB-140.1). Part of the Studio store: studio.ts gives these out again. The
 * approval is kept on the screen's own screen.yaml (status "approved", with the version, who and when), the file the
 * change already writes (AB-131.1), so a teammate gets it through git. Both run under the sketch's lock and stamp
 * check (AB-129.1): a stale stamp is refused with "Changed elsewhere, reload" and writes nothing.
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
